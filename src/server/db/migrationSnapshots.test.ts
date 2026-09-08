import { afterEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from './testing/pglite';
vi.mock('server-only', () => ({}));
let h: PgliteDatabaseHarness;
afterEach(async () => { await h?.close(); });
it('upgrades existing evidence unchanged and rejects every snapshot mutation while retaining append/idempotency', async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve('src/server/db/migrations');
  for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008' && n.slice(0, 4) < '0016').sort()) await h.database.exec(await readFile(resolve(dir, n), 'utf8'));
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,source_fingerprint) VALUES($1,'job','READY',repeat('a',64))", [h.tenantOneId]);
  await h.database.query("INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint) VALUES($1,'job','sheet','GOOGLE_SHEETS','synthetic',repeat('a',64))", [h.tenantOneId]);
  await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,'job','sheet','original','PREFLIGHT',repeat('a',64),'{\"evidence\":true}',42)", [h.tenantOneId]);
  const state = async () => (await h.database.query('SELECT row_to_json(s)::text AS bytes FROM migration_snapshots s ORDER BY snapshot_id')).rows;
  const before = await state();
  const upgrade = (await readdir(dir)).find(n => n.startsWith('0016_'));
  if (upgrade) await h.database.exec(await readFile(resolve(dir, upgrade), 'utf8'));
  expect(await state()).toEqual(before);
  for (const column of ['tenant_id', 'job_id', 'source_id', 'snapshot_id', 'phase', 'artifact_digest', 'redacted_manifest', 'captured_at', 'source_max_modified_at', 'row_count']) {
    await expect(h.database.exec(`UPDATE migration_snapshots SET ${column}=${column}`)).rejects.toThrow(/immutable/);
  }
  for (const sql of ['DELETE FROM migration_snapshots', 'DELETE FROM migration_sources', 'DELETE FROM migration_jobs', 'DELETE FROM tenants', 'TRUNCATE migration_snapshots', 'TRUNCATE tenants CASCADE']) await expect(h.database.exec(sql)).rejects.toThrow(/immutable/);
  expect(await state()).toEqual(before);
  await h.database.exec("INSERT INTO migration_snapshots SELECT tenant_id,job_id,source_id,'final','FINAL_FROZEN',artifact_digest,redacted_manifest,captured_at,source_max_modified_at,row_count FROM migration_snapshots");
  await expect(h.database.exec("INSERT INTO migration_snapshots SELECT tenant_id,job_id,source_id,'duplicate',phase,artifact_digest,redacted_manifest,captured_at,source_max_modified_at,row_count FROM migration_snapshots WHERE snapshot_id='original'")).rejects.toThrow(/unique/);
  expect((await state()).length).toBe(2);
  await h.database.exec(`SET ROLE app_runtime; SELECT set_config('app.tenant_id','${h.tenantOneId}',false)`);
  await expect(h.database.exec('SELECT * FROM migration_snapshots FOR SHARE')).resolves.toBeDefined();
  await expect(h.database.exec('UPDATE migration_snapshots SET row_count=row_count')).rejects.toThrow(/immutable/);
  await expect(h.database.exec('DELETE FROM migration_snapshots')).rejects.toThrow(/immutable/);
  await expect(h.database.exec('TRUNCATE migration_snapshots')).rejects.toThrow(/permission denied/);
  await expect(h.database.exec('ALTER TABLE migration_snapshots DISABLE TRIGGER ALL')).rejects.toThrow(/owner/);
  await expect(h.withMigrationSnapshotTampering(async () => {})).rejects.toThrow(/owner/);
  await h.database.exec('RESET ROLE');
  await expect(h.withMigrationSnapshotTampering(async () => {
    await h.database.exec('UPDATE migration_snapshots SET row_count=row_count+1');
    throw new Error('fixture failure');
  })).rejects.toThrow('fixture failure');
  await expect(h.database.exec('UPDATE migration_snapshots SET row_count=row_count')).rejects.toThrow(/immutable/);
}, 60_000);
