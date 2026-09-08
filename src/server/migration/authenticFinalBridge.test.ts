import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { acquireDeploymentLocalRedisReader, runLegacyMigrationBridge } from '../legacyMigrationBridge';
import { captureSheetsSnapshot, type WorkbookSnapshotReader } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { prepareLegacyImportReady } from './reconcile';
import { createFinalBridgeIntake, readVerifiedFinalBridgeAcquisition } from './finalBridgeIntake';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
const JOB = '40000000-0000-4000-8000-000000000039';
const USER = '20000000-0000-4000-8000-000000000039';
// Hash-shaped is deliberately still RAW: no representation inference is permitted.
const RAW = 'a'.repeat(64);
const signing = generateKeyPairSync('ed25519');
const writer = generateKeyPairSync('ed25519');
const encryptionKey = randomBytes(32);
const originalTime = '2026-08-31T02:00:00.000Z';
let h: PgliteDatabaseHarness;
let disabledAt: string;
let calls: string[];
let revision: string;
const reader: WorkbookSnapshotReader = {
  listSheetNames: async () => { calls.push('SHEETS'); return Object.keys(makeSupportedSheets().tabs); },
  getRevision: async () => revision,
  // Only workbook I/O is faked. Discard fixture digests/provenance and feed raw
  // rows through the real acquisition producer, including credential redaction.
  getRows: async name => {
    const tab = makeSupportedSheets().tabs[name];
    return [tab.headers, ...tab.rows.map(row => row.cells)];
  },
};
beforeEach(async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve('src/server/db/migrations');
  for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) await h.database.exec(await readFile(resolve(dir, n), 'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')", [USER]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [h.tenantOneId, USER]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  await h.database.exec('GRANT SELECT, INSERT ON migration_bridge_challenges, migration_bridge_consumptions TO app_runtime');
  calls = []; revision = 'original-r1'; disabledAt = originalTime;
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fixture-upstash.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fixture-redis-token');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/legacy-redis-writer');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'fixture-control-token');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-1');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', String(writer.publicKey.export({ type: 'spki', format: 'pem' })));
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', String(writer.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    let body: unknown;
    if (url === 'http://127.0.0.1:8787/legacy-redis-writer') {
      calls.push(`CONTROL:${init.method}`);
      body = { version: 1, deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST', status: 'DISABLED', disabled: true,
        generation: 41, evidence: `sha256:${'b'.repeat(64)}`, disabledAt };
    } else if (url === 'https://fixture-upstash.example') {
      const command = JSON.parse(String(init.body));
      if (!['HSCAN', 'SCAN'].includes(command[0])) throw Error('Unexpected Redis command');
      calls.push(command[0]); body = { result: ['0', []] };
    } else throw Error('Unexpected external I/O');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }));
}, 60_000);
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await h?.close(); });
async function ready() {
  const sheets = await captureSheetsSnapshot({ spreadsheetId: RAW, capturedAt: originalTime, reader });
  const redisReader = await acquireDeploymentLocalRedisReader();
  expect(redisReader).not.toBeNull();
  const redis = await captureRedisClaimSnapshot(redisReader!, { capturedAt: originalTime });
  const manifest = createLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, sheets, redis });
  expect(manifest.status, JSON.stringify(manifest.quarantines)).toBe('READY_FOR_IMPORT');
  await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  const result = await prepareLegacyImportReady({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, currentManifest: manifest,
    comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: h.runTenantTransaction });
  expect(result.readiness, JSON.stringify(result.report)).toBe('READY');
  const { rows } = await h.database.query<{ source_id: string; version: string; semantic: string; acquisition: string; identity: string }>(`SELECT s.source_id,j.state_version::text AS version,j.source_fingerprint AS semantic,s.source_fingerprint AS acquisition,s.external_source_id AS identity FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'`, [JOB]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.semantic).toBe(manifest.sourceFingerprint);
  expect(row.acquisition).toBe(sheets.digest);
  expect(row.semantic).not.toBe(row.acquisition);
  expect(row.identity).toBe(sha256(RAW));
  expect(row.identity).not.toBe(RAW);
  const registration = { tenantId: h.tenantOneId, sourceId: row.source_id, spreadsheetId: RAW, spreadsheetIdDigest: sha256(RAW),
    deploymentId: 'legacy-1', keyId: 'bridge-1', signingPublicKey: signing.publicKey, encryptionKey,
    writerKeyId: 'writer-1', writerSigningPublicKey: writer.publicKey };
  const api = createFinalBridgeIntake({ tenantId: h.tenantOneId, getAuthenticatedSubject: async () => 'owner',
    registeredDeployments: [registration], runTransaction: h.runTenantTransaction });
  return { row, sheets, redis, api, intent: { migrationJobId: JOB, expectedStateVersion: row.version, sourceId: row.source_id } };
}
async function unchangedState() {
  // Cover ALL operational/receipt/staging/global tables, not just the subset
  // whose rows are obvious in this fixture. Only acquisition replay may change.
  const { rows } = await h.database.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('migration_bridge_challenges','migration_bridge_consumptions') ORDER BY tablename`);
  return Promise.all(rows.map(async ({ tablename }) => ({ table: tablename,
    rows: (await h.database.query(`SELECT * FROM "${tablename.replaceAll('"', '""')}"`)).rows })));
}
it('actual acquisition → normalization → import → READY → challenge → final bridge → CAPTURED preserves distinct original bindings', async () => {
  const { row, sheets, redis, api, intent } = await ready();
  const before = await unchangedState();
  const b = await api.issueChallenge(intent);
  expect(b).toMatchObject({ bindingVersion: 2, jobSemanticFingerprint: row.semantic, sourceAcquisitionDigest: row.acquisition, spreadsheetIdDigest: sha256(RAW) });
  expect(b).not.toHaveProperty('spreadsheetId'); expect(b).not.toHaveProperty('externalSourceId'); expect(b).not.toHaveProperty('sourceFingerprint');
  disabledAt = new Date(b.issuedAt).toISOString(); revision = 'final-r2'; calls = [];
  const final = await runLegacyMigrationBridge({ deploymentId: 'legacy-1', mode: 'final-delta', capturedAt: disabledAt,
    sheets: { spreadsheetId: RAW, reader }, finalIntakeBinding: b,
    crypto: { keyId: 'bridge-1', encryptionKey, signingPrivateKey: signing.privateKey } });
  expect(calls).toEqual(['CONTROL:POST', 'CONTROL:GET', 'HSCAN', 'SCAN', 'HSCAN', 'SCAN', 'SHEETS', 'CONTROL:GET']);
  expect(final.redisAcquisition).toBe('CAPTURED'); expect(final.writerDisabled).toBe(true);
  const cap = await api.accept({ challengeId: b.challengeId, manifest: final.manifest });
  const acquired = readVerifiedFinalBridgeAcquisition(cap);
  expect(JSON.stringify(cap)).toBe('{}'); expect(acquired.exclusion).toBe('NOT_PROVEN');
  expect(acquired.sheets.spreadsheetId).toBe(RAW);
  expect(acquired.sheets.digest).not.toBe(sheets.digest); expect(acquired.redis.digest).not.toBe(redis.digest);
  expect(acquired.normalization.status).toBe('READY_FOR_IMPORT');
  expect((await h.database.query('SELECT binding FROM migration_bridge_challenges')).rows).toEqual([{ binding: b }]);
  expect((await h.database.query('SELECT nonce_digest FROM migration_bridge_consumptions')).rows).toEqual([
    { nonce_digest: sha256(canonicalJson(['CLASS_STORE_FINAL_BRIDGE_NONCE_V1', final.manifest.nonce])) },
  ]);
  expect(await unchangedState()).toEqual(before);
  await expect(api.accept({ challengeId: b.challengeId, manifest: final.manifest })).rejects.toThrow('Final bridge intake refused.');
}, 60_000);
it.each(['semantic', 'acquisition', 'identity'])('rejects independent %s drift after authentic producer READY without new evidence', async kind => {
  const { api, intent } = await ready();
  const b = await api.issueChallenge(intent);
  disabledAt = new Date(b.issuedAt).toISOString();
  const final = await runLegacyMigrationBridge({ deploymentId: 'legacy-1', mode: 'final-delta', capturedAt: disabledAt,
    sheets: { spreadsheetId: RAW, reader }, finalIntakeBinding: b,
    crypto: { keyId: 'bridge-1', encryptionKey, signingPrivateKey: signing.privateKey } });
  if (kind === 'semantic') await h.database.query('UPDATE migration_jobs SET source_fingerprint=$1 WHERE job_id=$2', ['c'.repeat(64), JOB]);
  else await h.database.query(`UPDATE migration_sources SET ${kind === 'identity' ? 'external_source_id' : 'source_fingerprint'}=$1 WHERE source_id=$2`, ['c'.repeat(64), intent.sourceId]);
  const before = await unchangedState();
  await expect(api.accept({ challengeId: b.challengeId, manifest: final.manifest })).rejects.toThrow('Final bridge intake refused.');
  expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toEqual([]);
  expect(await unchangedState()).toEqual(before);
}, 60_000);
