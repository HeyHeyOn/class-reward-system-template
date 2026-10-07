// @vitest-environment node
// Test-owned native ORIGINAL admission/dump and adjacent retention failures only.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupOriginalDatabase, backupPreparedDatabase, readMaterializedRecoveryState, retainMaterializedBackup } from '@/server/db/testing/materializedRestore';
import { acquireColdArchive, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, TENANT } from '../../../test-support/task19DeleteFixture';
import { expectRetainedFilesUnchanged } from '../../../test-support/retainedFileWitness';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
// Real files and Node cancellation after an actual prefix; no fake archive,
// backup seal, SQL result, pg_dump output, or durable journal is supplied.
const fault = vi.hoisted(() => ({ kind: '', id: '', hits: 0, prefixBytes: 0, collisionId: '' }));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => fault.collisionId || actual.randomUUID() };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const result = await actual.mkdir(...args);
    const match = /\/\.cold-restore-control\/([a-f0-9-]{36})$/.exec(String(args[0]));
    if (fault.kind && match) fault.id = match[1];
    return result;
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args), path = String(args[0]);
    if (!fault.kind || fault.hits || !fault.id) return file;
    if (path.includes('/.part-') && (path.includes('/.cold-restore-transport/') || path.includes(`/.cold-restore-control/${fault.id}/`))) {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
        const bytes = Buffer.from(data as Uint8Array);
        const phase = path.includes('/.cold-restore-transport/') ? 'transport-write'
          : JSON.parse(bytes.toString()).status ? 'state-write' : 'expectation-write';
        if (phase !== fault.kind || fault.hits) return write(data, options);
        await write(bytes.subarray(0, 113)); fault.prefixBytes = 113; fault.hits++;
        const controller = new AbortController(); controller.abort();
        await write(bytes.subarray(113), { signal: controller.signal });
        throw new Error('REAL_WRITE_ABORT_NOT_OBSERVED');
      });
    }
    if (fault.kind === 'ready-readback' && path.endsWith(`/${fault.id}/expectation.json`)) {
      const read = file.readFile.bind(file);
      vi.spyOn(file, 'readFile').mockImplementation(async () => {
        fault.hits++;
        const controller = new AbortController(); controller.abort();
        return read({ signal: controller.signal });
      });
    }
    return file;
  } };
});
afterEach(async () => { fault.kind = ''; fault.collisionId = ''; vi.restoreAllMocks(); await phase('cleanup', cleanupDeleteFixture); });
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const exec = promisify(execFile);
const policy = () => ({ retainUntil: Date.now() + 60_000, expiresAt: Date.now() + 3_600_000 });
const inventory = () => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc',
  '--filter', 'label=io.class-store.synthetic-pg-owner'], { env: { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' },
  encoding: 'utf8', timeout: 30_000 }).trim().split('\n').filter(Boolean).sort();
async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.info('TASK21_PHASE', JSON.stringify({ name, status: 'STARTED', at: new Date().toISOString() }));
  let status = 'FAILED';
  try { const result = await work(); status = 'COMPLETED'; return result; }
  finally { console.info('TASK21_PHASE', JSON.stringify({ name, status, durationMs: performance.now() - started, at: new Date().toISOString() })); }
}
function preservedFiles(before: Record<string, string>, name: string) {
  const started = performance.now();
  try { expectRetainedFilesUnchanged(before, files); }
  finally { console.info('TASK21_FILE_WITNESS', JSON.stringify({ name, inheritedEntries: Object.keys(before).length, durationMs: performance.now() - started })); }
}
function files() {
  const entries: Record<string, string> = {};
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      entries[next] = entry.isDirectory() ? 'directory' : sha256(readFileSync(next).toString());
      if (entry.isDirectory()) visit(next);
    }
  };
  visit('.cold-restore-control'); visit('.cold-restore-transport');
  return entries;
}
const fixture = () => phase('fixture', buildFixture);
async function buildFixture() {
  const f = await deleteFixture();
  const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
  for (const [key, value] of Object.entries({ title: 'Read together', reward: '12' })) task[f.original.sheets.tabs.Tasks.headers.indexOf(key)] = value;
  await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1", [JSON.stringify(task), TENANT]);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const { binding } = await f.stage(await f.capture());
  await materializeLocalCandidate(binding, f.run());
  const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)), expectedMaterializationDigest: sha256(canonicalJson(materialization)) };
  await prepareLocalCandidateTransition(intent, f.run());
  await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',9007199254741003,false)");
  const state = await f.state(), source = await readMaterializedRecoveryState(f.source.owner), candidate = await readMaterializedRecoveryState(f.destination.owner);
  const containers = inventory(), physical = [];
  for (const db of [f.local, f.source, f.destination]) physical.push(await archive.inspectArchiveDatabase(db));
  const preserved = () => phase('fixture-preserved', async () => {
    expect(await f.state()).toEqual(state);
    expect(await readMaterializedRecoveryState(f.source.owner)).toEqual(source);
    expect(await readMaterializedRecoveryState(f.destination.owner)).toEqual(candidate);
    expect(inventory()).toEqual(containers); // Includes transient admission reference cleanup.
    for (const db of [f.source, f.destination]) {
      expect((await db.owner.query("SELECT state,application_name FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (state LIKE 'idle in transaction%' OR application_name='pg_dump')")).rows).toEqual([]);
      expect((await db.owner.query("SELECT nspname FROM pg_namespace WHERE nspname='local_restore_control'")).rows).toEqual([]);
    }
  });
  return { ...f, binding, intent, originalState: source, candidateState: candidate, physical, preserved };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function restoreFresh(f: Fixture, anchor: ColdAnchor) {
  await phase('source-disposal', async () => {
    for (const db of [f.local, f.source, f.destination]) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  });
  for (const pin of f.physical) expect(inventory()).not.toContain(pin.id);
  mkdirSync('.task19-physical-results', { recursive: true, mode: 0o700 });
  const prefix = `.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`, JSON.stringify({ anchor, binding: f.binding, original: true }), { flag: 'wx', mode: 0o600 });
  const output = await phase('restore-child', () => exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19PreparedRestoreChild.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${prefix}-vitest.json`],
  { env: { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
    TASK19_PHYSICAL_REQUEST: `${prefix}-request.json` }, timeout: 180_000, maxBuffer: 8_000_000 }));
  writeFileSync(`${prefix}-process.json`, JSON.stringify({ exitCode: 0, ...output }), { flag: 'wx', mode: 0o600 });
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8'))).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8')), { value } = result.outcome;
  expect(result.pid).not.toBe(process.pid); expect(result.outcome.accepted, result.outcome.error).toBe(true);
  expect(result.journal.status).toBe('SUCCEEDED'); expect(result.observed.sourceReuseRefused).toBe(true);
  expect(result.observed.poolsClosed).toBe(true); expect(result.observed.readOnly).toBe('on');
  expect(f.physical.map(pin => pin.id)).not.toContain(value.containerId);
  expect(f.physical.map(pin => pin.systemIdentifier)).not.toContain(result.observed.physical.systemIdentifier);
  expect([f.source.runId, f.destination.runId]).not.toContain(value.databaseId); expect(value.ownerId).not.toBe(f.ownerId);
  for (const [table, wire] of Object.entries(f.originalState.tables)) {
    if (table !== 'migration_local_restore_databases') expect(value.readback.tables[table], table).toEqual(JSON.parse(wire));
  }
  expect(value.readback.guards).toEqual(f.originalState.guards);
  for (const [name, wire] of Object.entries(f.originalState.sequences)) expect(value.readback.sequences[name]).toEqual(JSON.parse(wire)[0]);
  expect(value.readback.tables.tasks).not.toEqual(JSON.parse(f.candidateState.tables.tasks));
  expect(value.readback.originalRestorations).toHaveLength(1);
  expect(value.readback.tables.migration_local_restorations).toEqual([]);
  expect(value.readback.tables.migration_local_materializations).toEqual([]);
  expect(value.readback.originalRestorations[0].provenance.prepared).toBeUndefined();
  expect(value.result).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false });
  expect(inventory()).not.toContain(value.containerId);
  return { prefix, result };
}
suite('Task21 ORIGINAL backup failure atomicity', () => {
  it('refuses admission and real candidate/original pg_dump snapshot failure, then retries the same admitted fixture', async () => {
    const f = await fixture(), beforeFiles = files();
    const dump = vi.spyOn(archive, 'dumpOwnedDatabase'), originalDump = vi.spyOn(archive, 'dumpOriginalOwnedDatabase');
    try {
      await expect(backupOriginalDatabase(f.source, f.destination, { ...f.intent, expectedReportDigest: sha256('wrong report') })).rejects.toThrow();
      expect(dump).not.toHaveBeenCalled(); expect(originalDump).not.toHaveBeenCalled();
    } finally { dump.mockRestore(); originalDump.mockRestore(); }
    await f.preserved(); expect(files()).toEqual(beforeFiles);
    const failures = [];
    for (const name of ['dumpOwnedDatabase', 'dumpOriginalOwnedDatabase'] as const) {
      const native = archive[name]; let hits = 0;
      const fail = vi.spyOn(archive, name).mockImplementation(async (db, snapshot) => {
        expect(snapshot).toMatch(/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/); hits++;
        // Ask actual pg_dump to import a syntactically valid nonexistent snapshot.
        return native(db, '00000000-00000000-1');
      });
      let returned: unknown, message = '';
      try {
        await expect(backupOriginalDatabase(f.source, f.destination, f.intent).then(value => { returned = value; }).catch(error => {
          message = error.message; throw error;
        })).rejects.toThrow(/pg_dump: error:[\s\S]*snapshot "00000000-00000000-1" does not exist/);
        expect(returned).toBeUndefined(); expect(hits).toBe(1);
      } finally { fail.mockRestore(); }
      await f.preserved(); expect(files()).toEqual(beforeFiles);
      failures.push({ name, hits, message });
    }
    const backup = await backupOriginalDatabase(f.source, f.destination, f.intent);
    await expect(retainMaterializedBackup({ bytes: backup.bytes, seal: {} }, policy())).rejects.toThrow();
    expect(files()).toEqual(beforeFiles); await f.preserved();
    const anchor = await retainMaterializedBackup(backup, policy());
    const restored = await restoreFresh(f, anchor);
    deletionEvidence('task21-original-admission-dump-atomicity', { failures, anchor, source: f.source.runId, candidate: f.destination.runId, ...restored });
  }, 300_000);

  it.each(['transport-write', 'expectation-write', 'state-write', 'ready-readback'])('removes only failed ORIGINAL enrollment after %s and retries without a shadow READY receipt', async kind => {
    const f = await fixture(), backup = await phase('original-backup', () => backupOriginalDatabase(f.source, f.destination, f.intent));
    // Real existing ORIGINAL + CANDIDATE archives must remain byte-for-byte intact.
    const inherited = await retainMaterializedBackup(backup, policy());
    const candidate = await phase('candidate-backup-retention', async () => retainMaterializedBackup(await backupPreparedDatabase(f.source, f.destination, f.intent), policy()));
    const beforeFiles = files();
    fault.kind = kind; fault.id = ''; fault.hits = 0; fault.prefixBytes = 0;
    let returned: ColdAnchor | undefined;
    try {
      await expect(retainMaterializedBackup(backup, policy()).then(value => { returned = value; })).rejects.toMatchObject({ name: 'AbortError' });
      expect(returned).toBeUndefined(); expect(fault.hits).toBe(1); expect(fault.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(fault.prefixBytes).toBe(kind === 'ready-readback' ? 0 : 113);
    } finally { fault.kind = ''; vi.restoreAllMocks(); }
    const failedId = fault.id;
    // RED: previous enrollment left .part SQL or even a usable READY shadow.
    const residual = files();
    deletionEvidence('task21-original-retention-failure-observed', { kind, failedId, residual: Object.keys(residual).filter(path => !(path in beforeFiles)) });
    expect(residual, 'no failed control directory, SQL, .part file or shadow receipt').toEqual(beforeFiles);
    await expect(acquireColdArchive({ ...inherited, id: failedId }, f.binding)).rejects.toThrow();
    await f.preserved();
    const retryBackup = await phase('retry-backup', () => backupOriginalDatabase(f.source, f.destination, f.intent));
    const retry = await retainMaterializedBackup(retryBackup, policy());
    expect([inherited.id, candidate.id, failedId]).not.toContain(retry.id);
    preservedFiles(beforeFiles, 'before-restore');
    const originalSeal = JSON.parse(readFileSync(resolve('.cold-restore-control', retry.id, 'expectation.json'), 'utf8')).seal;
    const candidateSeal = JSON.parse(readFileSync(resolve('.cold-restore-control', candidate.id, 'expectation.json'), 'utf8')).seal;
    expect(originalSeal.original.contract).toBe('LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1'); expect(originalSeal.prepared).toBeUndefined();
    expect(candidateSeal.prepared.contract).toBe('LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1'); expect(candidateSeal.original).toBeUndefined();
    await f.preserved();
    const restored = await restoreFresh(f, retry);
    preservedFiles(beforeFiles, 'after-restore');
    deletionEvidence('task21-original-retention-retry', { kind, failedId, inherited, candidate, retry, ...restored });
  }, 300_000);

  it('refuses existing ORIGINAL, CANDIDATE and transport-only names without overwriting or deleting them', async () => {
    const f = await fixture(), backup = await backupOriginalDatabase(f.source, f.destination, f.intent);
    const original = await retainMaterializedBackup(backup, policy());
    const candidate = await retainMaterializedBackup(await backupPreparedDatabase(f.source, f.destination, f.intent), policy());
    const transportId = randomUUID();
    writeFileSync(`.cold-restore-transport/${transportId}.sql`, backup.bytes, { flag: 'wx', mode: 0o600 });
    const before = files();
    for (const id of [original.id, candidate.id, transportId]) {
      fault.collisionId = id;
      try { await expect(retainMaterializedBackup(backup, policy())).rejects.toMatchObject({ code: 'EEXIST' }); }
      finally { fault.collisionId = ''; }
      expect(files()).toEqual(before); await f.preserved();
    }
    const retry = await retainMaterializedBackup(backup, policy());
    const restored = await restoreFresh(f, retry);
    preservedFiles(before, 'after-collision-restore');
    deletionEvidence('task21-original-retention-collision', { original, candidate, transportId, retry, ...restored });
  }, 300_000);
});
