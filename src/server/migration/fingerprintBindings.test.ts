import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { importLegacyNormalizationManifest } from './importer';
import { prepareLegacyImportReady } from './reconcile';
import { createFreezingApprovalIntake, readVerifiedFreezingApproval } from './freezingApprovalIntake';
import { createNonAuthorityReceiptStorage } from './authorityReceiptStorage';
vi.mock('server-only', () => ({}));
const JOB = '40000000-0000-4000-8000-000000000029';
const USER = '20000000-0000-4000-8000-000000000029';
const TOKEN = 'b'.repeat(64);
let h: PgliteDatabaseHarness;
beforeEach(async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve('src/server/db/migrations');
  for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0,4) > '0008').sort()) await h.database.exec(await readFile(resolve(dir,n),'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')",[USER]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[h.tenantOneId,USER]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[h.tenantOneId,JOB]);
  await h.database.exec('GRANT SELECT, INSERT ON migration_freezing_challenges, migration_freezing_consumptions, migration_authority_receipts, migration_authority_replays TO app_runtime');
  vi.stubGlobal('fetch',vi.fn(() => { throw Error('network forbidden'); }));
},60_000);
afterEach(async () => { vi.unstubAllGlobals(); await h?.close(); });
function service() {
  return createFreezingApprovalIntake({tenantId:h.tenantOneId,origin:'https://store.example',getAuthenticatedSession:async () => ({subject:'owner',csrfToken:TOKEN}),runTransaction:h.runTenantTransaction});
}
function request(display: unknown) {
  return new Request('https://store.example/internal',{method:'POST',headers:{origin:'https://store.example','content-type':'application/json','x-csrf-token':TOKEN},body:JSON.stringify({display,confirmation:'START_FREEZING_APPROVAL'})});
}
async function ready() {
  const manifest = createLegacyNormalizationManifest({tenantId:h.tenantOneId,migrationJobId:JOB,sheets:makeSupportedSheets(3)});
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  await importLegacyNormalizationManifest({tenantId:h.tenantOneId,migrationJobId:JOB,manifest,runTransaction:h.runTenantTransaction});
  const prepared = await prepareLegacyImportReady({tenantId:h.tenantOneId,migrationJobId:JOB,manifest,currentManifest:manifest,comparisonInstant:'2026-08-31T03:00:00.000Z',runTransaction:h.runTenantTransaction});
  expect(prepared.readiness,JSON.stringify(prepared.report)).toBe('READY');
  const {rows} = await h.database.query<{source_id:string;version:string;semantic:string;acquisition:string}>(`SELECT s.source_id,j.state_version::text AS version,j.source_fingerprint AS semantic,s.source_fingerprint AS acquisition FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'`,[JOB]);
  expect(rows).toHaveLength(1);
  expect(rows[0].semantic).toBe(manifest.sourceFingerprint);
  expect(rows[0].acquisition).toBe(manifest.sourceArtifacts.sheets.digest);
  expect(rows[0].semantic).not.toBe(rows[0].acquisition);
  return {manifest,row:rows[0],intent:{migrationJobId:JOB,expectedStateVersion:rows[0].version,sourceId:rows[0].source_id}};
}
it('authentic normalizer/importer/reconciler READY issues and accepts distinct fingerprint approval',async () => {
  const {row,intent} = await ready();
  const evidence = () => h.database.query('SELECT * FROM migration_snapshots ORDER BY snapshot_id');
  const before = (await evidence()).rows;
  const b = await service().issueChallenge(intent);
  expect(b).toMatchObject({jobSemanticFingerprint:row.semantic,sourceAcquisitionDigest:row.acquisition});
  expect(readVerifiedFreezingApproval(await service().accept(request(b)))).toEqual(b);
  const {rows} = await h.database.query(`SELECT r.*,p.replay_digest,r.expected_state_version::text AS expected_state_version,r.issued_at_ms::text AS issued_at_ms,r.expires_at_ms::text AS expires_at_ms FROM migration_authority_receipts r JOIN migration_authority_replays p USING(tenant_id,receipt_id)`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({source_fingerprint:row.semantic,source_acquisition_digest:row.acquisition});
  const archived = await createNonAuthorityReceiptStorage({tenantId:h.tenantOneId,runTransaction:h.runTenantTransaction}).recover(rows[0] as Record<string,unknown>);
  expect(archived.storage).toBe('NON_AUTHORITY');
  expect(() => readVerifiedFreezingApproval(archived as never)).toThrow();
  expect((await evidence()).rows).toEqual(before);
  await expect(service().accept(request(b))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
},60_000);
it('receipt composition independently checks each binding and archival recovery requires the exact acquisition',async () => {
  const {intent} = await ready();
  const b = await service().issueChallenge(intent);
  const {canonicalJson,sha256} = await import('./validators');
  const input = {tenant_id:h.tenantOneId,receipt_id:b.challengeId,job_id:JOB,source_id:b.sourceId,
    provider:'GOOGLE_SHEETS',external_source_id:b.externalSourceId,actor_user_id:USER,actor_subject:'owner',
    action:b.action,expected_status:'READY',expected_state_version:b.expectedStateVersion,
    source_fingerprint:b.jobSemanticFingerprint,source_acquisition_digest:b.sourceAcquisitionDigest,
    issued_at_ms:String(b.issuedAt),expires_at_ms:String(b.expiresAt),issuer_digest:sha256('test-storage-only'),
    content_digest:sha256(canonicalJson(b)),replay_digest:sha256('test-storage-replay'),
    final_sheet_digest:null,final_redis_digest:null,final_report_digest:null};
  const storage = createNonAuthorityReceiptStorage({tenantId:h.tenantOneId,runTransaction:h.runTenantTransaction});
  for (const field of ['source_fingerprint','source_acquisition_digest']) {
    await expect(storage.append({...input,[field]:'c'.repeat(64)})).rejects.toThrow('Receipt storage refused.');
    expect((await h.database.query('SELECT * FROM migration_authority_receipts')).rows).toEqual([]);
  }
  // A legacy envelope cannot silently equalize distinct real fingerprints.
  const {source_acquisition_digest: acquisition,...legacy} = input;
  expect(acquisition).not.toBe(input.source_fingerprint);
  await expect(storage.append(legacy)).rejects.toThrow('Receipt storage refused.');
  await expect(storage.append({...input,source_acquisition_digest:null})).rejects.toThrow('Receipt storage refused.');
  expect((await storage.append(input)).storage).toBe('NON_AUTHORITY');
  await expect(storage.recover(legacy)).rejects.toThrow('Receipt storage refused.');
  await expect(storage.recover({...input,source_acquisition_digest:'c'.repeat(64)})).rejects.toThrow('Receipt storage refused.');
  expect((await storage.recover(input)).storage).toBe('NON_AUTHORITY');
},60_000);
it.each(['migration_jobs','migration_sources'])('rejects independent %s fingerprint drift after authentic READY issuance',async table => {
  const {intent} = await ready();
  const b = await service().issueChallenge(intent);
  await h.database.query(`UPDATE ${table} SET source_fingerprint=$1 WHERE tenant_id=$2 AND job_id=$3`,['c'.repeat(64),h.tenantOneId,JOB]);
  await expect(service().accept(request(b))).rejects.toThrow('Freezing approval intake refused.');
  for (const t of ['migration_freezing_consumptions','migration_authority_receipts','migration_authority_replays']) expect((await h.database.query(`SELECT * FROM ${t}`)).rows).toEqual([]);
},60_000);
