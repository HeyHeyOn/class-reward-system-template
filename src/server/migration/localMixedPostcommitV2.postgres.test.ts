// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateMixed } from '../../../test-support/task19MixedArchiveV2';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { recoveryProducer } from '../../../test-support/task19MixedRecoveryV2';
import { postcommitChild, postcommitWorker, postcommitSave, noPostcommitAck, killPostcommitWorker,
  cleanupPostcommitWorkers, type PostcommitRequest } from '../../../test-support/task19MixedPostcommitV2';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
afterEach(async () => {
  await cleanupPostcommitWorkers();
  const cleanup = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close(); postcommitSave(db.runId, 'cleanup', { evidence: db.evidence, result });
    console.info('TASK19_POSTCOMMIT_V2_CLEANUP', JSON.stringify(result));
    expect(result.containerRemoved && result.scratchRemoved).toBe(true);
  }));
  const failed = cleanup.filter(row => row.status === 'rejected');
  if (failed.length) throw new AggregateError(failed, 'Owned cleanup failed');
});
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
async function absent() {
  const deadline = Date.now() + 30_000;
  for (const db of databases) {
    while ((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [APPLICATION])).rows.length) {
      if (Date.now() > deadline) throw new Error('Child backend remains; no cold-process conclusion');
      await new Promise(done => setTimeout(done, 50));
    }
  }
}
function distinctBackends(before: { databaseId: string; pid: number; started: string }[], after: typeof before) {
  const keys = new Set(before.map(row => `${row.databaseId}/${row.pid}/${row.started}`));
  expect(before.length).toBe(4); expect(after.length).toBe(4);
  expect(after.every(row => !keys.has(`${row.databaseId}/${row.pid}/${row.started}`))).toBe(true);
}
async function fixture(tombstone: boolean, boundary: PostcommitRequest['boundary']) {
  const produced = await recoveryProducer(tombstone);
  for (const pin of produced.originalPins) expect(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc', '--filter', `id=${pin.containerId}`],
    { env: { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
  const ownerId = randomUUID(), source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
  for (const previous of produced.originalPins) for (const fresh of [source.pin, destination.pin]) {
    expect(fresh.containerId).not.toBe(previous.containerId); expect(fresh.databaseId).not.toBe(previous.databaseId);
    expect(fresh.systemIdentifier).not.toBe(previous.systemIdentifier);
  }
  const q: PostcommitRequest = { phase: 'prepare', boundary, tombstone, ownerId,
    source: source.pin, destination: destination.pin, binding: produced.binding, pin: produced.pin };
  const prepared = await postcommitChild(q); await absent();
  return { produced, source, destination, q, prepared, state: async () => ({ source: await witness(source.db), destination: await witness(destination.db) }) };
}
suite('Task19 mixed V2 destination postcommit application death', () => {
  const cases = [false, true].flatMap(tombstone => (['destination-precommit', 'destination-postcommit'] as const).map(boundary => ({ tombstone, boundary })));
  it.each(cases)('cold replay distinguishes committed destination: $boundary tombstone=$tombstone', async ({ boundary, tombstone }) => {
    const { produced, source, destination, q, prepared, state } = await fixture(tombstone, boundary);
    const before = await state(); expect(before).toEqual(prepared.after);
    const w = await postcommitWorker({ ...q, phase: 'crash' }); noPostcommitAck(w.id);
    const activitySql = 'SELECT pid,state,xact_start::text AS xact_start,query FROM pg_stat_activity WHERE pid=$1';
    const sourceActivity = (await source.db.owner.query(activitySql, [w.barrier.sourceBackend.pid])).rows;
    const destinationActivity = (await destination.db.owner.query(activitySql, [w.barrier.destinationBackend.pid])).rows;
    expect(sourceActivity).toHaveLength(1); expect(sourceActivity[0].state).toBe('idle in transaction'); expect(sourceActivity[0].xact_start).not.toBeNull();
    expect(destinationActivity).toHaveLength(1);
    const committed = boundary === 'destination-postcommit';
    expect(w.barrier.driverCommitAcknowledged).toBe(committed);
    expect(destinationActivity[0].state).toBe(committed ? 'idle' : 'idle in transaction');
    if (committed) {
      expect(destinationActivity[0].xact_start).toBeNull(); expect(destinationActivity[0].query).toBe('COMMIT');
    } else expect(destinationActivity[0].xact_start).not.toBeNull();
    const visible = await state(); expect(visible.source).toBe(before.source);
    const receipt = (await destination.db.owner.query('SELECT * FROM migration_local_materializations')).rows;
    expect(receipt.length).toBe(committed ? 1 : 0);
    if (committed) {
      expect(visible.destination).not.toBe(before.destination);
      expect(receipt[0].domain_readback).toEqual(w.barrier.callbackResult.readback);
      expect(receipt[0]).toMatchObject({ source_database_id: q.source.databaseId, destination_database_id: q.destination.databaseId,
        generation_id: q.binding.generationId, owner_id: q.ownerId, authority: 'NONAUTHORITY', activation_allowed: false });
    } else expect(visible).toEqual(before);
    await killPostcommitWorker(w); await absent();
    const afterDeath = await state(); expect(afterDeath).toEqual(visible);
    postcommitSave(w.id, 'crash-evidence', { request: q, produced, prepared, before, visible, afterDeath,
      sourceActivity, destinationActivity, receipt, barrier: w.barrier, topology: [source.db.evidence, destination.db.evidence], backendAbsenceProven: true });
    const resumed = await postcommitChild({ ...q, phase: 'resume' }); await absent();
    expect(resumed.before).toEqual(afterDeath); expect(resumed.after.source).toBe(before.source);
    if (committed) { expect(resumed.after).toEqual(afterDeath); expect(resumed.materialized).toEqual(w.barrier.callbackResult); }
    const retried = await postcommitChild({ ...q, phase: 'retry' }); await absent();
    expect(retried.before).toEqual(resumed.after); expect(retried.after).toEqual(retried.before);
    expect(retried.materialized).toEqual(resumed.materialized);
    const negatives = committed ? await postcommitChild({ ...q, phase: 'negatives' }) : null; await absent();
    const finalRetry = committed ? await postcommitChild({ ...q, phase: 'retry' }) : null; await absent();
    if (finalRetry) { expect(finalRetry.before).toEqual(negatives.after); expect(finalRetry.before).toEqual(finalRetry.after); expect(finalRetry.materialized).toEqual(resumed.materialized); }
    const processes = [prepared, { pid: w.child.pid, backends: w.barrier.backends }, resumed, retried, ...(negatives ? [negatives, finalRetry] : [])];
    expect(new Set([produced.pid, ...processes.map(row => row.pid)]).size).toBe(processes.length + 1);
    for (let i = 0; i < processes.length; i++) for (let j = i + 1; j < processes.length; j++) distinctBackends(processes[i].backends, processes[j].backends);
    postcommitSave(w.id, 'replay-evidence', { request: q, produced, prepared, crashPid: w.child.pid, resumed, retried, negatives, finalRetry, backendAbsenceProven: true });
  }, 600_000);
  it.each([false, true])('refuses a real committed partial destination without repair: tombstone=%s', async tombstone => {
    const { q, produced, prepared } = await fixture(tombstone, 'destination-postcommit');
    const refused = await postcommitChild({ ...q, phase: 'partial' }); await absent();
    expect(refused.disposition).toBe('PARTIAL_DESTINATION_REFUSED'); expect(refused.partial).toEqual(refused.after);
    postcommitSave(randomUUID(), 'partial-evidence', { request: q, produced, prepared, refused, backendAbsenceProven: true });
  }, 600_000);
});
