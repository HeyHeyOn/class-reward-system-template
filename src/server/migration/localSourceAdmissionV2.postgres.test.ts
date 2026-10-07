// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateMixed } from '../../../test-support/task19MixedArchiveV2';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { recoveryProducer } from '../../../test-support/task19MixedRecoveryV2';
import { postcommitChild } from '../../../test-support/task19MixedPostcommitV2';
import { sourceAdmissionV2Child, sourceAdmissionV2Worker, sourceAdmissionV2Save, admissionCloseTransport, admissionRefuse, admissionRestoreAndFinish, ADMISSION_DAMAGES, cleanupSourceAdmissionV2Workers, sourceAdmissionV2Directory,
  type SourceAdmissionV2Request } from '../../../test-support/task19SourceAdmissionV2';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
let stopped = false;
beforeEach(() => { if (stopped) throw new Error('STOP: previous owned case failed; no further resources allocated'); });
afterEach(async context => {
  if (context.task.result?.state === 'fail') stopped = true;
  await cleanupSourceAdmissionV2Workers();
  const cleanup = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close(); sourceAdmissionV2Save(db.runId, 'cleanup', { evidence: db.evidence, result });
    console.info('TASK19_SOURCE_ADMISSION_V2_CLEANUP', JSON.stringify(result));
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
async function fixture(tombstone: boolean, outcome: SourceAdmissionV2Request['outcome'], isolation: SourceAdmissionV2Request['isolation']) {
  const produced = await recoveryProducer(tombstone);
  const ownerId = randomUUID(), source = await allocateMixed(databases, ownerId, 'SOURCE'), destination = await allocateMixed(databases, ownerId, 'DESTINATION');
  for (const previous of produced.originalPins) for (const fresh of [source.pin, destination.pin]) {
    expect(fresh.containerId).not.toBe(previous.containerId); expect(fresh.databaseId).not.toBe(previous.databaseId);
    expect(fresh.systemIdentifier).not.toBe(previous.systemIdentifier);
  }
  const q: SourceAdmissionV2Request = { phase: 'prepare', boundary: 'destination-postcommit', outcome, isolation, tombstone, ownerId,
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
  const cases = [false, true].flatMap(tombstone => (['commit', 'rollback'] as const)
    .map(outcome => ({ tombstone, outcome, isolation: 'REPEATABLE READ' as const })));
  it.each(cases)('first admission source $outcome tombstone=$tombstone', async ({ tombstone, outcome, isolation }) => {
    const { q, produced, prepared, source, destination, state, archive } = await fixture(tombstone, outcome, isolation);
    const before = await state(), archiveBefore = archive(); expect(before).toEqual(prepared.after);
    expect(archiveBefore.sha256).toBe(q.pin.sha256);
    const w = await sourceAdmissionV2Worker({ ...q, phase: 'crash' });
    expect(existsSync(`${sourceAdmissionV2Directory}/${w.id}-result.json`)).toBe(false);
    expect(existsSync(`${sourceAdmissionV2Directory}/${w.id}-driver-settled.json`)).toBe(false);
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
    const ready = await admissionCloseTransport(w); await absent();
    expect(ready.successfulRecoveries).toBe(0);
    expect(ready.transport).toMatchObject({ side: 'SOURCE', pidAtError: w.barrier.pid, pidAfterReconnect: w.barrier.pid,
      driverError: { message: 'Connection terminated unexpectedly' }, callbacks: 1, attempts: 1, retrySleeps: 0,
      destinationAttempts: 1, destinationAcknowledged: true, failedBackendAbsent: true, samePoolReconnected: true, syntheticErrorInjected: false });
    const sourceXidAfter = (await source.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.sourceBackend.xid])).rows;
    expect(sourceXidAfter).toEqual([{ status: outcome === 'commit' ? 'committed' : 'aborted' }]);
    expect((await destination.db.owner.query('SELECT pg_xact_status($1::xid8) AS status', [w.barrier.destinationBackend.xid])).rows).toEqual(destinationXid);
    const afterClose = await state(); expect(afterClose).toEqual(visible);
    const receiptText = async () => (await destination.db.owner.query('SELECT row_to_json(t)::text AS bytes FROM migration_local_materializations t')).rows.map(row => row.bytes as string);
    const receiptOriginal = await receiptText(); expect(receiptOriginal).toHaveLength(1);
    const receiptGuards = async () => (await destination.db.owner.query(`SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t WHERE tgrelid='migration_local_materializations'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
    const guards = await receiptGuards();
    // Exact owner-only synthetic mutation, outside measured intervals. The
    // intrinsic trigger is restored before replay; no roles/grants change.
    const mutateReceipt = async (statement: string, values?: unknown[]) => {
      const client = await destination.db.owner.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE migration_local_materializations DISABLE TRIGGER migration_local_materializations_immutable');
        await client.query(statement, values);
        await client.query('ALTER TABLE migration_local_materializations ENABLE TRIGGER migration_local_materializations_immutable');
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      expect(await receiptGuards()).toEqual(guards);
    };
    const artifact = `${q.pin.directory}/artifact.json`, originalBytes = readFileSync(artifact);
    const damagedIntervals = [];
    for (const damage of ADMISSION_DAMAGES) {
      const beforeDamage = await state();
      expect(readFileSync(artifact)).toEqual(originalBytes); expect(await receiptText()).toEqual(receiptOriginal);
      if (damage === 'receipt-missing') await mutateReceipt('DELETE FROM migration_local_materializations');
      if (damage === 'receipt-corrupt') await mutateReceipt('UPDATE migration_local_materializations SET manifest_digest=$1', [sha256('controlled wrong receipt binding')]);
      if (damage === 'archive-missing') renameSync(artifact, artifact + '.owned-original');
      if (damage === 'archive-corrupt') writeFileSync(artifact, Buffer.from(originalBytes.toString('utf8') + '\ncontrolled-corruption'));
      const damaged = await state(), receiptDamaged = await receiptText();
      const archiveDamaged = existsSync(artifact) ? { present: true, sha256: sha256(readFileSync(artifact).toString('utf8')) } : { present: false };
      if (damage.startsWith('receipt')) expect(receiptDamaged).not.toEqual(receiptOriginal);
      else expect(archiveDamaged).not.toEqual({ present: true, sha256: q.pin.sha256 });
      let same, cold;
      try {
        same = await admissionRefuse(w, damage); await absent();
        expect(same.successfulRecoveries).toBe(0); expect(same.refusal.before).toEqual(damaged); expect(same.refusal.after).toEqual(damaged);
        cold = await sourceAdmissionV2Child({ ...q, phase: 'resume', expectedReplay: 'refuse', damage }); await absent();
        expect(cold.pid).not.toBe(w.child.pid);
        for (const replay of cold.replays) { expect(replay.before).toEqual(damaged); expect(replay.after).toEqual(damaged); }
        expect(await state()).toEqual(damaged);
      } finally {
        if (damage === 'receipt-missing') await mutateReceipt('INSERT INTO migration_local_materializations SELECT * FROM json_populate_record(NULL::migration_local_materializations,$1::json)', receiptOriginal);
        if (damage === 'receipt-corrupt') await mutateReceipt('UPDATE migration_local_materializations SET manifest_digest=$1', [JSON.parse(receiptOriginal[0]).manifest_digest]);
        if (damage === 'archive-missing') renameSync(artifact + '.owned-original', artifact);
        if (damage === 'archive-corrupt') writeFileSync(artifact, originalBytes);
      }
      const restored = await state();
      expect(readFileSync(artifact)).toEqual(originalBytes); expect(await receiptText()).toEqual(receiptOriginal); expect(await receiptGuards()).toEqual(guards);
      expect(restored.source).toBe(beforeDamage.source);
      const logical = (value: string) => JSON.parse(value).map((table: { name: string; rows: { row: unknown }[] }) => ({ name: table.name, rows: table.rows.map(row => row.row) }));
      expect(logical(restored.destination)).toEqual(logical(beforeDamage.destination));
      if (damage.startsWith('archive')) expect(restored).toEqual(beforeDamage);
      else {
        const nonReceipt = (value: string) => JSON.parse(value).filter((table: {name: string}) => table.name !== 'migration_local_materializations');
        expect(nonReceipt(restored.destination)).toEqual(nonReceipt(beforeDamage.destination));
      }
      damagedIntervals.push({ damage, beforeDamage, damaged, receiptDamaged, archiveDamaged, same, cold, restored,
        restoredArchiveSha256: sha256(readFileSync(artifact).toString('utf8')), restoredReceiptBytes: await receiptText(), guards: await receiptGuards() });
    }
    const restoredBaseline = await state();
    const survived = await admissionRestoreAndFinish(w); await absent();
    expect(survived.pid).toBe(w.child.pid); expect(survived.refusals).toHaveLength(ADMISSION_DAMAGES.length);
    for (const replay of survived.replays) {
      expect(replay.before).toEqual(restoredBaseline); expect(replay.after).toEqual(restoredBaseline);
      expect(replay.outcome.value.materialized).toEqual(w.barrier.callbackResult);
    }
    const cold = await sourceAdmissionV2Child({ ...q, phase: 'resume' }); await absent();
    const finalRetry = await sourceAdmissionV2Child({ ...q, phase: 'retry' }); await absent();
    expect(new Set([survived.pid, cold.pid, finalRetry.pid]).size).toBe(3);
    for (const child of [cold, finalRetry]) for (const replay of child.replays) {
      expect(replay.before).toEqual(restoredBaseline); expect(replay.after).toEqual(restoredBaseline);
    }
    const groups = [prepared.backends, ...survived.backendGroups, ...cold.backendGroups, ...finalRetry.backendGroups,
      ...survived.refusals.map((r: {backends: typeof prepared.backends}) => r.backends),
      ...damagedIntervals.flatMap(d => d.cold.backendGroups)];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) distinct(groups[i], groups[j]);
    expect(canonicalJson(survived.replays[0].receipt)).toBe(canonicalJson(receipt));
    expect(await state()).toEqual(restoredBaseline); expect(archive()).toEqual(archiveBefore);
    for (const db of [source.db, destination.db]) {
      expect((await db.owner.query('SELECT count(*)::int AS n FROM migration_authority_receipts')).rows).toEqual([{ n: 0 }]);
      expect((await db.owner.query("SELECT count(*)::int AS n FROM tenants WHERE lifecycle='ACTIVE'")).rows).toEqual([{ n: 0 }]);
    }
    sourceAdmissionV2Save(w.id, 'admission-evidence', { request: q, produced, prepared, before, visible, afterClose,
      archiveBefore, archiveAfter: archive(), sourceActivity, destinationActivity, sourceObserver, destinationObserver,
      sourceXidBefore, sourceXidAfter, destinationXid, receipt, barrier: w.barrier, receiptOriginal, guards,
      damagedIntervals, restoredBaseline, survived, cold, finalRetry, topology: [source.db.evidence, destination.db.evidence], backendAbsenceProven: true });
  }, 600_000);
});
