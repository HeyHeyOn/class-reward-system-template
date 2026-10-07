// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sha256 } from '@/server/migration/validators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateMixed } from '../../../test-support/task19MixedArchiveV2';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { recoveryProducer } from '../../../test-support/task19MixedRecoveryV2';
import { postcommitChild } from '../../../test-support/task19MixedPostcommitV2';
import { sourceTransportChild, sourceTransportWorker, sourceTransportSave, closeSourceTransportAndFinish, cleanupSourceTransportWorkers, sourceTransportDirectory,
  type SourceTransportRequest } from '../../../test-support/task19SourceTransport';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
let stopped = false;
beforeEach(() => { if (stopped) throw new Error('STOP: previous owned case failed; no further resources allocated'); });
afterEach(async context => {
  if (context.task.result?.state === 'fail') stopped = true;
  await cleanupSourceTransportWorkers();
  const cleanup = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close(); sourceTransportSave(db.runId, 'cleanup', { evidence: db.evidence, result });
    console.info('TASK19_SOURCE_TRANSPORT_CLEANUP', JSON.stringify(result));
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
async function fixture(tombstone: boolean, outcome: SourceTransportRequest['outcome'], isolation: SourceTransportRequest['isolation']) {
  const produced = await recoveryProducer(tombstone);
  const ownerId = randomUUID(), source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
  for (const previous of produced.originalPins) for (const fresh of [source.pin, destination.pin]) {
    expect(fresh.containerId).not.toBe(previous.containerId); expect(fresh.databaseId).not.toBe(previous.databaseId);
    expect(fresh.systemIdentifier).not.toBe(previous.systemIdentifier);
  }
  const q: SourceTransportRequest = { phase: 'prepare', boundary: 'destination-postcommit', outcome, isolation, tombstone, ownerId,
    source: source.pin, destination: destination.pin, binding: produced.binding, pin: produced.pin };
  const prepared = await postcommitChild(q); await absent();
  // No source mutation/abort trigger: the abort case closes before forwarding COMMIT.
  const archive = () => {
    const path = `${q.pin.directory}/artifact.json`, stat = statSync(path);
    return { sha256: sha256(readFileSync(path, 'utf8')), inode: stat.ino, device: stat.dev, size: stat.size };
  };
  return { q, produced, prepared, source, destination, archive,
    state: async () => ({ source: await witness(source.db), destination: await witness(destination.db) }) };
}
suite('Task19 source COMMIT transport after destination COMMIT', () => {
  const cases = [false, true].flatMap(tombstone => (['commit', 'rollback'] as const).flatMap(outcome =>
    (['READ COMMITTED', 'REPEATABLE READ'] as const).map(isolation => ({ tombstone, outcome, isolation }))));
  it.each(cases)('native source $outcome $isolation tombstone=$tombstone', async ({ tombstone, outcome, isolation }) => {
    const { q, produced, prepared, source, destination, state, archive } = await fixture(tombstone, outcome, isolation);
    const before = await state(), archiveBefore = archive(); expect(before).toEqual(prepared.after);
    expect(archiveBefore.sha256).toBe(q.pin.sha256);
    const w = await sourceTransportWorker({ ...q, phase: 'crash' });
    expect(existsSync(`${sourceTransportDirectory}/${w.id}-result.json`)).toBe(false);
    expect(existsSync(`${sourceTransportDirectory}/${w.id}-driver-settled.json`)).toBe(false);
    expect(w.barrier).toMatchObject({ side: 'SOURCE', driverSettled: false, driverCommitAcknowledged: false,
      destinationAcknowledged: true, callerAcknowledged: false, sourceBackend: { isolation: isolation.toLowerCase() },
      wire: { frontend: 'Q', query: 'COMMIT', submitted: outcome === 'commit', deliveredCommitResponseBytes: 0, driverResponseInjected: false } });
    if (outcome === 'commit') {
      expect(w.barrier.wire.withheldBytes).toBeGreaterThan(0);
      expect(w.barrier.wire.frames).toEqual([{ type: 'C', bytes: 12, tag: 'COMMIT' }, { type: 'Z', bytes: 6, status: 'I' }]);
      expect(w.barrier.wire.boundary).toBe('SOURCE_COMMIT_RESPONSE');
    } else {
      expect(w.barrier.wire).toMatchObject({ boundary: 'SOURCE_COMMIT_NOT_FORWARDED', withheldBytes: 0, rawHex: '', frames: [],
        frontendHex: Buffer.from([81, 0, 0, 0, 11, ...Buffer.from('COMMIT\0')]).toString('hex') });
    }
    const activitySql = 'SELECT pid,backend_start::text AS started,state,xact_start::text AS xact_start,query,usename,application_name FROM pg_stat_activity WHERE pid=$1';
    const sourceActivity = (await source.db.owner.query(activitySql, [w.barrier.sourceBackend.pid])).rows;
    const destinationActivity = (await destination.db.owner.query(activitySql, [w.barrier.destinationBackend.pid])).rows;
    expect(sourceActivity).toEqual([expect.objectContaining({ state: outcome === 'commit' ? 'idle' : 'idle in transaction',
      usename: 'app_runtime', application_name: APPLICATION })]);
    if (outcome === 'commit') expect(sourceActivity[0]).toMatchObject({ xact_start: null, query: 'COMMIT' });
    else { expect(sourceActivity[0].xact_start).not.toBeNull(); expect(sourceActivity[0].query).not.toBe('COMMIT'); }
    expect(destinationActivity).toEqual([expect.objectContaining({ state: 'idle', xact_start: null, query: 'COMMIT', usename: 'app_runtime', application_name: APPLICATION })]);
    const sourceXidBefore = (await source.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.sourceBackend.xid])).rows;
    const destinationXid = (await destination.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.destinationBackend.xid])).rows;
    expect(sourceXidBefore).toEqual([{ status: outcome === 'commit' ? 'committed' : 'in progress' }]);
    expect(destinationXid).toEqual([{ status: 'committed' }]);
    const sourceObserver = (await source.db.owner.query('SELECT pg_backend_pid() AS pid')).rows[0];
    const destinationObserver = (await destination.db.owner.query('SELECT pg_backend_pid() AS pid')).rows[0];
    expect(sourceObserver.pid).not.toBe(w.barrier.sourceBackend.pid); expect(destinationObserver.pid).not.toBe(w.barrier.destinationBackend.pid);
    const visible = await state(), receipt = (await destination.db.owner.query('SELECT * FROM migration_local_materializations')).rows;
    expect(visible.source).toBe(before.source); expect(receipt).toHaveLength(1); expect(visible.destination).not.toBe(before.destination);
    expect(receipt[0]).toMatchObject({ source_database_id: q.source.databaseId, destination_database_id: q.destination.databaseId,
      owner_id: q.ownerId, generation_id: q.binding.generationId, authority: 'NONAUTHORITY', activation_allowed: false,
      domain_readback: w.barrier.callbackResult.readback });
    const survived = await closeSourceTransportAndFinish(w); await absent();
    const sourceXidAfter = (await source.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.sourceBackend.xid])).rows;
    expect(sourceXidAfter).toEqual([{ status: outcome === 'commit' ? 'committed' : 'aborted' }]);
    expect((await destination.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.destinationBackend.xid])).rows).toEqual(destinationXid);
    expect(survived.pid).toBe(w.barrier.pid);
    expect(survived.transport).toMatchObject({ side: 'SOURCE', pidAtError: w.barrier.pid, pidAfterReconnect: w.barrier.pid,
      driverError: { message: 'Connection terminated unexpectedly' }, callbacks: 1, attempts: 1, retrySleeps: 0,
      destinationAttempts: 1, destinationAcknowledged: true, failedBackendAbsent: true, samePoolReconnected: true, syntheticErrorInjected: false });
    const afterClose = await state(); expect(afterClose).toEqual(visible);
    for (const replay of survived.replays) {
      expect(replay.pid).toBe(w.barrier.pid); expect(replay.before).toEqual(visible); expect(replay.after).toEqual(visible);
      expect(replay.outcome.value.materialized).toEqual(w.barrier.callbackResult);
    }
    const cold = await sourceTransportChild({ ...q, phase: 'resume' }); await absent();
    expect(cold.pid).not.toBe(survived.pid);
    for (const replay of cold.replays) { expect(replay.before).toEqual(visible); expect(replay.after).toEqual(visible); }
    const negatives = await postcommitChild({ ...q, phase: 'negatives' }); await absent();
    const finalRetry = await sourceTransportChild({ ...q, phase: 'retry' }); await absent();
    for (const replay of finalRetry.replays) { expect(replay.before).toEqual(negatives.after); expect(replay.after).toEqual(replay.before); }
    const groups = [prepared.backends, ...survived.backendGroups, ...cold.backendGroups, negatives.backends, ...finalRetry.backendGroups];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) distinct(groups[i], groups[j]);
    for (const db of [source.db, destination.db]) {
      expect((await db.owner.query('SELECT count(*)::int AS n FROM migration_authority_receipts')).rows).toEqual([{ n: 0 }]);
      expect((await db.owner.query("SELECT count(*)::int AS n FROM tenants WHERE lifecycle='ACTIVE'")).rows).toEqual([{ n: 0 }]);
    }
    expect(archive()).toEqual(archiveBefore);
    sourceTransportSave(w.id, 'source-transport-evidence', { side: 'SOURCE', request: q, produced, prepared, before, visible, afterClose,
      archiveBefore, archiveAfter: archive(), sourceActivity, destinationActivity, sourceObserver, destinationObserver,
      sourceXidBefore, sourceXidAfter, destinationXid, receipt, barrier: w.barrier,
      survived, cold, negatives, finalRetry, topology: [source.db.evidence, destination.db.evidence], backendAbsenceProven: true });
  }, 600_000);
  it.each([false, true])('refuses actual committed partial import tombstone=%s', async tombstone => {
    const { q, produced, prepared } = await fixture(tombstone, 'commit', 'REPEATABLE READ');
    const partial = await postcommitChild({ ...q, phase: 'partial' }); await absent();
    const refused = await sourceTransportChild({ ...q, phase: 'resume', expectedReplay: 'refuse' }); await absent();
    for (const replay of refused.replays) { expect(replay.before).toEqual(partial.partial); expect(replay.after).toEqual(partial.partial); }
    sourceTransportSave(randomUUID(), 'partial-evidence', { request: q, produced, prepared, partial, refused });
  }, 600_000);
});
