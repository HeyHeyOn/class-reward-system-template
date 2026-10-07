// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateMixed } from '../../../test-support/task19MixedArchiveV2';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { recoveryProducer } from '../../../test-support/task19MixedRecoveryV2';
import { postcommitChild } from '../../../test-support/task19MixedPostcommitV2';
import { wireChild, wireWorker, wireSave, noWireAck, killWireWorker, cleanupWireWorkers, wireDirectory,
  type WireRequest } from '../../../test-support/task19MixedWireV2';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
let stopped = false;
beforeEach(() => { if (stopped) throw new Error('STOP: previous owned case failed; no further resources allocated'); });
afterEach(async context => {
  if (context.task.result?.state === 'fail') stopped = true;
  await cleanupWireWorkers();
  const cleanup = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close(); wireSave(db.runId, 'cleanup', { evidence: db.evidence, result });
    console.info('TASK19_COMMIT_WIRE_CLEANUP', JSON.stringify(result));
    expect(result.containerRemoved && result.scratchRemoved).toBe(true);
  }));
  const failed = cleanup.filter(row => row.status === 'rejected');
  if (failed.length) { stopped = true; throw new AggregateError(failed, 'Owned cleanup failed'); }
});
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
async function absent() {
  const deadline = Date.now() + 30_000;
  for (const db of databases) {
    while ((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [APPLICATION])).rows.length) {
      if (Date.now() > deadline) throw new Error('Child backend remains; cold proof refused');
      await new Promise(done => setTimeout(done, 50));
    }
  }
}
function distinct(before: { databaseId: string; pid: number; started: string }[], after: typeof before) {
  const keys = new Set(before.map(row => `${row.databaseId}/${row.pid}/${row.started}`));
  expect(before.length).toBeGreaterThanOrEqual(4); expect(after.length).toBeGreaterThanOrEqual(4);
  expect(after.every(row => !keys.has(`${row.databaseId}/${row.pid}/${row.started}`))).toBe(true);
}
async function fixture(tombstone: boolean, outcome: WireRequest['outcome']) {
  const produced = await recoveryProducer(tombstone);
  const ownerId = randomUUID(), source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
  for (const previous of produced.originalPins) for (const fresh of [source.pin, destination.pin]) {
    expect(fresh.containerId).not.toBe(previous.containerId); expect(fresh.databaseId).not.toBe(previous.databaseId);
    expect(fresh.systemIdentifier).not.toBe(previous.systemIdentifier);
  }
  const q: WireRequest = { phase: 'prepare', boundary: 'destination-postcommit', outcome, tombstone, ownerId,
    source: source.pin, destination: destination.pin, binding: produced.binding, pin: produced.pin };
  const prepared = await postcommitChild(q); await absent();
  // Deliberate control fixture, NOT a product defect: actual deferred PG trigger
  // fires on the receipt INSERT only when COMMIT is processed by the server.
  if (outcome === 'rollback') await destination.db.owner.query(`
    CREATE FUNCTION task19_wire_commit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'TASK19_OWNED_COMMIT_REFUSAL' USING ERRCODE='23514'; END $$;
    CREATE CONSTRAINT TRIGGER task19_wire_commit_refusal AFTER INSERT ON migration_local_materializations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task19_wire_commit_refusal()`);
  return { q, produced, prepared, source, destination,
    state: async () => ({ source: await witness(source.db), destination: await witness(destination.db) }) };
}
suite('Task19 mixed V2 actual COMMIT wire response ambiguity', () => {
  const cases = [false, true].flatMap(tombstone => (['commit', 'rollback'] as const).map(outcome => ({ tombstone, outcome })));
  it.each(cases)('withholds real wire response and cold resolves $outcome tombstone=$tombstone', async ({ tombstone, outcome }) => {
    const { q, produced, prepared, source, destination, state } = await fixture(tombstone, outcome);
    const before = await state(); expect(before).toEqual(prepared.after);
    const w = await wireWorker({ ...q, phase: 'crash' }); noWireAck(w.id);
    expect(existsSync(`${wireDirectory}/${w.id}-driver-settled.json`)).toBe(false);
    expect(w.barrier).toMatchObject({ driverSettled: false, driverCommitAcknowledged: false, callerAcknowledged: false,
      wire: { frontend: 'Q', query: 'COMMIT', submitted: true, deliveredCommitResponseBytes: 0, driverResponseInjected: false } });
    expect(w.barrier.wire.withheldBytes).toBeGreaterThan(0);
    expect(w.barrier.wire.frames).toEqual(outcome === 'commit'
      ? [{ type: 'C', bytes: 12, tag: 'COMMIT' }, { type: 'Z', bytes: 6, status: 'I' }]
      : [expect.objectContaining({ type: 'E', sqlState: '23514' }), { type: 'Z', bytes: 6, status: 'I' }]);
    const activitySql = 'SELECT pid,backend_start::text AS started,state,xact_start::text AS xact_start,query,usename,application_name FROM pg_stat_activity WHERE pid=$1';
    const sourceActivity = (await source.db.owner.query(activitySql, [w.barrier.sourceBackend.pid])).rows;
    const destinationActivity = (await destination.db.owner.query(activitySql, [w.barrier.destinationBackend.pid])).rows;
    expect(sourceActivity).toEqual([expect.objectContaining({ state: 'idle in transaction', application_name: APPLICATION })]);
    expect(destinationActivity).toEqual([expect.objectContaining({ state: 'idle', xact_start: null, query: 'COMMIT', usename: 'app_runtime', application_name: APPLICATION })]);
    const xid = (await destination.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.destinationBackend.xid])).rows;
    expect(xid).toEqual([{ status: outcome === 'commit' ? 'committed' : 'aborted' }]);
    const observerBackend = (await destination.db.owner.query('SELECT pg_backend_pid() AS pid')).rows[0];
    expect(observerBackend.pid).not.toBe(w.barrier.destinationBackend.pid);
    const visible = await state(), receipt = (await destination.db.owner.query('SELECT * FROM migration_local_materializations')).rows;
    expect(visible.source).toBe(before.source); expect(receipt).toHaveLength(outcome === 'commit' ? 1 : 0);
    if (outcome === 'commit') {
      expect(visible.destination).not.toBe(before.destination);
      expect(receipt[0]).toMatchObject({ source_database_id: q.source.databaseId, destination_database_id: q.destination.databaseId,
        owner_id: q.ownerId, generation_id: q.binding.generationId, authority: 'NONAUTHORITY', activation_allowed: false,
        domain_readback: w.barrier.callbackResult.readback });
    } else expect(visible).toEqual(before);
    // Barrier is inside the transport BEFORE pg's parser. The parent kills only
    // the exact spawned process; the actual held bytes never reach the driver.
    expect(existsSync(`${wireDirectory}/${w.id}-driver-settled.json`)).toBe(false);
    await killWireWorker(w); await absent();
    expect(existsSync(`${wireDirectory}/${w.id}-driver-settled.json`)).toBe(false);
    const afterDeath = await state(); expect(afterDeath).toEqual(visible);
    wireSave(w.id, 'wire-evidence', { request: q, produced, prepared, before, visible, afterDeath,
      sourceActivity, destinationActivity, observerBackend, xid, receipt, barrier: w.barrier,
      topology: [source.db.evidence, destination.db.evidence], backendAbsenceProven: true });
    const resumed = await wireChild({ ...q, phase: 'resume' }); await absent();
    const retried = await wireChild({ ...q, phase: 'retry' }); await absent();
    for (const result of [resumed, retried]) {
      expect(result.before).toEqual(afterDeath); expect(result.after).toEqual(afterDeath);
      if (outcome === 'commit') expect(result.outcome.value.materialized).toEqual(w.barrier.callbackResult);
      else expect(result.outcome).toEqual({ accepted: false, error: 'UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT' });
    }
    const negatives = outcome === 'commit' ? await postcommitChild({ ...q, phase: 'negatives' }) : null; await absent();
    const finalRetry = outcome === 'commit' ? await wireChild({ ...q, phase: 'retry' }) : null; await absent();
    if (finalRetry) { expect(finalRetry.before).toEqual(negatives.after); expect(finalRetry.after).toEqual(finalRetry.before); }
    const processes = [prepared, { pid: w.child.pid, backends: w.barrier.backends }, resumed, retried, ...(negatives ? [negatives, finalRetry] : [])];
    expect(new Set([produced.pid, ...processes.map(row => row.pid)]).size).toBe(processes.length + 1);
    for (let i = 0; i < processes.length; i++) for (let j = i + 1; j < processes.length; j++) distinct(processes[i].backends, processes[j].backends);
    for (const db of [source.db, destination.db]) {
      expect((await db.owner.query('SELECT count(*)::int AS n FROM migration_authority_receipts')).rows).toEqual([{ n: 0 }]);
      expect((await db.owner.query("SELECT count(*)::int AS n FROM tenants WHERE lifecycle='ACTIVE'")).rows).toEqual([{ n: 0 }]);
    }
    wireSave(w.id, 'replay-evidence', { request: q, prepared, resumed, retried, negatives, finalRetry, backendAbsenceProven: true });
  }, 600_000);
  it.each([false, true])('refuses actual committed partial import tombstone=%s', async tombstone => {
    const { q, produced, prepared } = await fixture(tombstone, 'commit');
    const partial = await postcommitChild({ ...q, phase: 'partial' }); await absent();
    const refused = await wireChild({ ...q, phase: 'resume', expectedReplay: 'refuse' }); await absent();
    expect(refused.before).toEqual(partial.partial); expect(refused.after).toEqual(partial.partial);
    wireSave(randomUUID(), 'partial-evidence', { request: q, produced, prepared, partial, refused });
  }, 600_000);
});
