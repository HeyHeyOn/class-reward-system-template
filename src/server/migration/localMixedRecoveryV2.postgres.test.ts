// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateMixed } from '../../../test-support/task19MixedArchiveV2';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { recoveryProducer, recoveryWorker, recoveryChild, killRecoveryWorker, cleanupRecoveryWorkers, recoverySave,
  type RecoveryRequest } from '../../../test-support/task19MixedRecoveryV2';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
afterEach(async () => {
  await cleanupRecoveryWorkers();
  const cleanup = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    console.info('TASK19_RECOVERY_V2_CLEANUP', JSON.stringify(await db.close()));
  }));
  const failed = cleanup.filter(row => row.status === 'rejected');
  if (failed.length) throw new AggregateError(failed, 'Owned cleanup failed');
});
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
async function absent() {
  const deadline = Date.now() + 30_000;
  for (const db of databases) {
    while ((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [APPLICATION])).rows.length) {
      if (Date.now() > deadline) throw new Error('Child SQL backend remains; no cold/rollback conclusion');
      await new Promise(done => setTimeout(done, 50));
    }
  }
}
function distinctBackends(before: { databaseId: string; pid: number; started: string }[], after: typeof before) {
  const keys = new Set(before.map(row => `${row.databaseId}/${row.pid}/${row.started}`));
  expect(after.every(row => !keys.has(`${row.databaseId}/${row.pid}/${row.started}`))).toBe(true);
}
suite('Task19 mixed V2 interrupted source recovery', () => {
  const cases = [false, true].flatMap(tombstone => (['source-records', 'source-staged', 'source-committed', 'destination-dml'] as const)
    .map(boundary => ({ tombstone, boundary })));
  it.each(cases)('never exposes a partial source: $boundary tombstone=$tombstone', async ({ boundary, tombstone }) => {
    const produced = await recoveryProducer(tombstone);
    for (const pin of produced.originalPins) {
      expect(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc', '--filter', `id=${pin.containerId}`],
        { env: { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
    }
    const ownerId = randomUUID(), source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
    for (const previous of produced.originalPins) for (const fresh of [source.pin, destination.pin]) {
      expect(fresh.containerId).not.toBe(previous.containerId); expect(fresh.databaseId).not.toBe(previous.databaseId);
      expect(fresh.systemIdentifier).not.toBe(previous.systemIdentifier);
    }
    const before = { source: await witness(source.db), destination: await witness(destination.db) };
    const q: RecoveryRequest = { phase: 'crash', boundary, tombstone, ownerId,
      source: source.pin, destination: destination.pin, binding: produced.binding, pin: produced.pin };
    const w = await recoveryWorker(q);
    expect(w.barrier.records.count).toBeGreaterThan(0);
    if (boundary === 'source-staged' || boundary === 'source-committed') expect(w.barrier.staged.count).toBeGreaterThan(0);
    if (boundary === 'destination-dml') expect(w.barrier.receipts.count).toBe(1);
    const activityDb = boundary === 'destination-dml' ? destination.db : source.db;
    const activity = (await activityDb.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1', [w.barrier.backend.pid])).rows;
    expect(activity).toEqual([{ pid: w.barrier.backend.pid, state: 'idle in transaction' }]);
    const visible = { source: await witness(source.db), destination: await witness(destination.db) };
    await killRecoveryWorker(w);
    await absent();
    const afterDeath = { source: await witness(source.db), destination: await witness(destination.db) };
    recoverySave(w.id, 'crash-evidence', { before, visible, afterDeath, activity, barrier: w.barrier, produced,
      topology: [source.db.evidence, destination.db.evidence] });
    expect(afterDeath).toEqual(visible);
    expect(afterDeath.destination).toBe(before.destination);
    const uncommitted = boundary === 'source-records' || boundary === 'source-staged';
    if (uncommitted) expect(afterDeath.source).toBe(before.source);
    else expect(afterDeath.source).not.toBe(before.source);
    const resumed = await recoveryChild({ ...q, phase: 'resume' }); await absent();
    expect(resumed.before).toEqual(afterDeath);
    expect(resumed.reconstructed.disposition).toBe(uncommitted ? 'RECONSTRUCTED' : 'VERIFIED_EXISTING');
    if (!uncommitted) expect(resumed.after.source).toBe(afterDeath.source);
    const retried = await recoveryChild({ ...q, phase: 'retry' }); await absent();
    expect(retried.before).toEqual(retried.after);
    expect(retried.materialized).toEqual(resumed.materialized);
    expect(retried.reconstructed.disposition).toBe('VERIFIED_EXISTING');
    expect(new Set([produced.pid, w.child.pid, resumed.pid, retried.pid]).size).toBe(4);
    distinctBackends(w.barrier.backends, resumed.backends); distinctBackends(resumed.backends, retried.backends);
    recoverySave(w.id, 'recovery-evidence', { request: q, produced, crashPid: w.child.pid, resumed, retried, backendAbsenceProven: true });
  }, 600_000);
  it.each([false, true])('refuses legacy committed partial source without repair: tombstone=%s', async tombstone => {
    const produced = await recoveryProducer(tombstone), ownerId = randomUUID();
    const source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
    const refused = await recoveryChild({ phase: 'reject-partial', boundary: 'source-records', tombstone, ownerId,
      source: source.pin, destination: destination.pin, binding: produced.binding, pin: produced.pin });
    expect(refused.disposition).toBe('LEGACY_PARTIAL_REFUSED'); expect(refused.partial).toEqual(refused.after); await absent();
  }, 600_000);
});
