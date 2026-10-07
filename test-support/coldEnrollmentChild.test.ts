// @vitest-environment node
// Owned synthetic admission only. Diagnostic pins reconstructed by this harness
// are NOT a supported recovery/enrollment API or successor authority.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { backupOriginalDatabase, backupPreparedDatabase, retainMaterializedBackup } from '@/server/db/testing/materializedRestore';
import { readColdArchiveForExport, readColdLease } from '@/server/db/testing/coldRestoreStore';
import { materializeLocalCandidate, prepareLocalCandidateTransition } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { cleanupDeleteFixture, deleteFixture, TENANT } from './task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const request = process.env.ENROLLMENT_REQUEST ? JSON.parse(readFileSync(process.env.ENROLLMENT_REQUEST, 'utf8')) : null;
function save(suffix: string, value: unknown) {
  const path = `${request.prefix}-${suffix}.json`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.part`, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(`${path}.part`, path);
}
const policy = () => ({ retainUntil: Date.now() + 3_600_000, expiresAt: Date.now() + 7_200_000 });
it.skipIf(!request)('owned enrollment checkpoint or readback child', async () => {
  if (request.action === 'read') {
    const native = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(`/${request.anchor.id}/${request.observe ?? 'expectation.json'}`)) save('open', { pid: process.pid, path: String(args[0]), flags: args[1] });
      return native(...args);
    });
    let outcome: unknown;
    try {
      const archive = await readColdArchiveForExport(request.anchor, request.binding);
      // A copied seal/lease must not become an in-memory materialization grant.
      let copiedLeaseAccepted = false, copiedBackupAccepted = false;
      try { readColdLease({ id: request.anchor.id }); copiedLeaseAccepted = true; } catch { /* Expected WeakMap boundary. */ }
      try { await retainMaterializedBackup({ bytes: archive.bytes, seal: archive.seal }, policy()); copiedBackupAccepted = true; } catch { /* Expected WeakMap boundary. */ }
      outcome = { accepted: true, digest: sha256(archive.bytes.toString()), original: archive.seal.original?.contract ?? null,
        prepared: archive.seal.prepared?.contract ?? null, copiedLeaseAccepted, copiedBackupAccepted };
    } catch (error) { outcome = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { vi.restoreAllMocks(); }
    save('result', { pid: process.pid, outcome });
    return;
  }
  const f = await deleteFixture();
  try {
    const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
    task[f.original.sheets.tabs.Tasks.headers.indexOf('title')] = 'Enrollment candidate only';
    await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1", [JSON.stringify(task), TENANT]);
    await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
    const { binding } = await f.stage(await f.capture());
    await materializeLocalCandidate(binding, f.run());
    const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
    const receipt = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
    const intent = { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
      expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)), expectedMaterializationDigest: sha256(canonicalJson(receipt)) };
    await prepareLocalCandidateTransition(intent, f.run());
    const before = await f.state(), original = await backupOriginalDatabase(f.source, f.destination, intent);
    const inherited = await retainMaterializedBackup(original, policy());
    const candidate = await retainMaterializedBackup(await backupPreparedDatabase(f.source, f.destination, intent), policy());
    expect(await f.state()).toEqual(before);
    const closed = [];
    for (const db of [f.local, f.source, f.destination]) {
      const cleanup = await db.close(); expect(cleanup).toMatchObject({ containerRemoved: true, scratchRemoved: true });
      closed.push({ runId: db.runId, evidence: db.evidence, cleanup });
    }
    save('setup', { pid: process.pid, inherited, candidate, binding, intent, closed, sourceStateDigest: sha256(canonicalJson(before)) });
    const nativeRename = fs.rename, nativeOpen = fs.open;
    let directory = '', id = '';
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await nativeRename(...args);
      const target = String(args[1]);
      if (target.endsWith(`/${request.checkpoint}.json`) && target.includes('/.cold-restore-control/')) {
        directory = dirname(target); id = directory.split('/').at(-1)!;
      }
    });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args);
      if (directory && String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          await sync();
          save('ready', { pid: process.pid, checkpoint: request.checkpoint, id, directory,
            publishedState: existsSync(`${directory}/state.json`) ? JSON.parse(readFileSync(`${directory}/state.json`, 'utf8')) : null,
            expectationSha256: sha256(readFileSync(`${directory}/expectation.json`, 'utf8')),
            boundary: 'after real rename and directory fsync, before enrollment readback/return' });
          await new Promise<void>(() => { /* Only the exact spawned child is killed by the launcher. */ });
        });
      }
      return handle;
    });
    const returned = await retainMaterializedBackup(original, policy());
    save('ack', { returned }); // Must remain absent at and after the kill.
  } finally { vi.restoreAllMocks(); await cleanupDeleteFixture(); }
}, 180_000);
