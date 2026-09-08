import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createRedisWriterDisableEvidence, type FinalBridgeChallenge } from '../legacyMigrationBridge';
import { sealLegacyBridgeManifest } from './legacyBridgeManifest';
import { makeSheets, makeRedis, finalizeSheetsSnapshot, finalizeRedisSnapshot } from './__fixtures__/normalization';
import type { TenantImportTransactionRunner } from './importer';
import { createFinalBridgeIntake, readVerifiedFinalBridgeAcquisition } from './finalBridgeIntake';

vi.mock('server-only', () => ({}));
let h: PgliteDatabaseHarness;
const USER = '20000000-0000-4000-8000-000000000019';
const JOB = '40000000-0000-4000-8000-000000000019';
const HASH = 'a'.repeat(64);
const signing = generateKeyPairSync('ed25519');
const writer = generateKeyPairSync('ed25519');
const encryptionKey = randomBytes(32);
beforeEach(async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(dir)).filter((n) => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) {
    await h.database.exec(await readFile(resolve(dir, name), 'utf8'));
  }
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')", [USER]);
  for (const tenant of [h.tenantOneId, h.tenantTwoId]) {
    await h.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1", [tenant]);
    await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenant, USER]);
    await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,source_fingerprint) VALUES($1,$2,'READY',$3)", [tenant, JOB, HASH]);
    await h.database.query("INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint) VALUES($1,$2,'sheet','GOOGLE_SHEETS',$3,$4)", [tenant, JOB, `sheet-${tenant}`, HASH]);
  }
  await h.database.exec('GRANT SELECT, INSERT ON migration_bridge_challenges, migration_bridge_consumptions TO app_runtime');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
});
afterEach(async () => { vi.unstubAllGlobals(); await h?.close(); });
function registration(tenantId = h.tenantOneId) {
  return { tenantId, sourceId: 'sheet', externalSourceId: `sheet-${tenantId}`, deploymentId: 'legacy-1',
    keyId: 'bridge-1', signingPublicKey: signing.publicKey, encryptionKey,
    writerKeyId: 'writer-1', writerSigningPublicKey: writer.publicKey };
}
function service(options: { tenantId?: string; subject?: string | null; registrations?: ReturnType<typeof registration>[];
  runTransaction?: TenantImportTransactionRunner } = {}) {
  const tenantId = options.tenantId ?? h.tenantOneId;
  return createFinalBridgeIntake({ tenantId, getAuthenticatedSubject: async () => options.subject === undefined ? 'owner' : options.subject,
    registeredDeployments: options.registrations ?? [registration(tenantId)], runTransaction: options.runTransaction ?? h.runTenantTransaction });
}
const intent = () => ({ migrationJobId: JOB, expectedStateVersion: '1', sourceId: 'sheet' });
function payload(b: FinalBridgeChallenge) {
  const capturedAt = new Date(b.issuedAt).toISOString();
  return { manifestType: 'CLASS_STORE_LEGACY_ACQUISITION', deploymentId: b.deploymentId, mode: 'final-delta', capturedAt,
    finalIntakeBinding: b,
    sheetsSnapshot: finalizeSheetsSnapshot({ ...makeSheets(), spreadsheetId: b.externalSourceId, capturedAt }),
    redisSnapshot: finalizeRedisSnapshot({ ...makeRedis({ v1Tombstones: [{ tupleDigest: 'e'.repeat(64), ownerDigest: 'f'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }], orphanedClaimDigests: ['d'.repeat(64)] }), capturedAt }), redisAcquisition: 'CAPTURED',
    redisNeverConfiguredProof: null, writerDisableRequired: true,
    writerDisableEvidence: createRedisWriterDisableEvidence({ deploymentId: b.deploymentId, disabledAt: capturedAt,
      controlGeneration: 41, controlEvidence: `sha256:${HASH}`, keyId: 'writer-1', signingPrivateKey: writer.privateKey }) };
}
function seal(b: FinalBridgeChallenge, data: unknown = payload(b), overrides: Partial<Parameters<typeof sealLegacyBridgeManifest>[1]> = {}) {
  return sealLegacyBridgeManifest(data, { keyId: 'bridge-1', encryptionKey, signingPrivateKey: signing.privateKey,
    now: () => b.issuedAt, ...overrides });
}
async function consumed() { return (await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows; }
async function state() {
  const tables = ['tenants', 'migration_jobs', 'migration_sources', 'migration_authority_receipts', 'migration_authority_replays',
    'padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'padlet_claim_digest_registry', 'operations',
    'transactions', 'adjustments', 'migration_source_records', 'migration_snapshots', 'audit_events'];
  return Promise.all(tables.map(async (table) => (await h.database.query(`SELECT * FROM ${table}`)).rows));
}

describe('authenticated final bridge acquisition intake, never freeze or activation', () => {
  it('issues a durable server-bound challenge, verifies real crypto and complete BANK/claim/tombstone acquisition without forward writes', async () => {
    await h.database.exec("UPDATE migration_sources SET grant_expires_at=now()+interval '1 hour'");
    await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated-claim','MIGRATION_IMPORT',$2)", [h.tenantTwoId, HASH]);
    await h.database.query(`INSERT INTO padlet_evidence_claims
      (provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
      VALUES('PADLET','other-board','other-post',encode(digest(convert_to('other-board','UTF8')||decode('00','hex')||convert_to('other-post','UTF8'),'sha256'),'hex'),$1,'unrelated-claim',now(),'Other Student')`, [h.tenantTwoId]);
    await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')", ['c'.repeat(64), HASH]);
    const before = await state();
    const api = service(); const b = await api.issueChallenge(intent());
    expect(b).toMatchObject({ tenantId: h.tenantOneId, migrationJobId: JOB, expectedStateVersion: '1', sourceId: 'sheet',
      actorUserId: USER, actorSubject: 'owner', deploymentId: 'legacy-1', purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE' });
    const cap = await api.accept({ challengeId: b.challengeId, manifest: seal(b) });
    expect(JSON.stringify(cap)).toBe('{}');
    const acquired = readVerifiedFinalBridgeAcquisition(cap);
    expect(acquired.sheets).toEqual(payload(b).sheetsSnapshot);
    expect(acquired.redis).toEqual(payload(b).redisSnapshot);
    expect(acquired.normalization.status).not.toBe('READY_FOR_IMPORT');
    expect(acquired.normalization.quarantines.length).toBeGreaterThan(0);
    expect(acquired.exclusion).toBe('NOT_PROVEN');
    expect(Object.isFrozen(acquired.redis)).toBe(true);
    expect(() => readVerifiedFinalBridgeAcquisition({} as typeof cap)).toThrow();
    expect(await consumed()).toHaveLength(1);
    expect(await state()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, 'nonmember', ' owner '])('refuses unauthenticated/nonmember subject %s at issuance and acceptance', async (subject) => {
    const b = await service().issueChallenge(intent());
    await expect(service({ subject }).issueChallenge(intent())).rejects.toThrow('Final bridge intake refused.');
    await expect(service({ subject }).accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow('Final bridge intake refused.');
    expect(await consumed()).toEqual([]);
  });
  it('refuses unknown or ambiguous trust registrations and request-injected authority', async () => {
    await expect(service({ registrations: [] }).issueChallenge(intent())).rejects.toThrow();
    await expect(service({ registrations: [registration(), registration()] }).issueChallenge(intent())).rejects.toThrow();
    await expect(service().issueChallenge({ ...intent(), tenantId: h.tenantTwoId } as ReturnType<typeof intent>)).rejects.toThrow();
    const b = await service().issueChallenge(intent());
    for (const extra of [{ keyId: 'bridge-1' }, { signingPublicKey: 'attacker' }, { url: 'https://attacker.invalid' }, { actorSubject: 'owner' }]) {
      await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b), ...extra })).rejects.toThrow();
    }
    await expect(service({ registrations: [] }).accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
  });
  it('refuses preflight, unbound old finals, digest receipts and every altered canonical challenge field before consumption', async () => {
    const b = await service().issueChallenge(intent()); const good = payload(b);
    const oldFinal = Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'finalIntakeBinding'));
    const bad: unknown[] = [{ ...good, mode: 'preflight' }, oldFinal, { preparationDigest: HASH }, { receiptId: b.challengeId }];
    for (const key of Object.keys(b)) bad.push({ ...good, finalIntakeBinding: { ...b, [key]: 'different' } });
    for (const data of bad) await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b, data) })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
    await service().accept({ challengeId: b.challengeId, manifest: seal(b) });
  });
  it('requires complete semantic Sheets+Redis and never coerces missing/null acquisitions into empty snapshots', async () => {
    const b = await service().issueChallenge(intent()); const good = payload(b);
    const bad: unknown[] = [
      { ...good, redisSnapshot: null }, { ...good, sheetsSnapshot: null }, { ...good, redisAcquisition: 'PROVEN_NEVER_CONFIGURED' },
      { ...good, sheetsSnapshot: { ...good.sheetsSnapshot, tabs: {} } },
      { ...good, redisSnapshot: { ...good.redisSnapshot, v1Tombstones: [] } },
      { ...good, sheetsSnapshot: { ...good.sheetsSnapshot, spreadsheetId: 'other' } },
      { ...good, redisSnapshot: { ...good.redisSnapshot, capturedAt: '2026-01-01T00:00:00.000Z' } },
      { ...good, writerDisableRequired: false }, { ...good, writerDisableEvidence: null },
      { ...good, writerDisableEvidence: { ...good.writerDisableEvidence, controlGeneration: 42 } },
    ];
    for (const data of bad) await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b, data) })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
  });
  it('rejects wrong crypto/key IDs and future or expired envelopes without burning the valid challenge', async () => {
    const b = await service().issueChallenge(intent());
    const valid = seal(b);
    for (const manifest of [
      { ...valid, signature: 'A'.repeat(86) }, seal(b, payload(b), { encryptionKey: randomBytes(32) }),
      seal(b, payload(b), { signingPrivateKey: writer.privateKey }), seal(b, payload(b), { keyId: 'unknown-key' }),
      seal(b, payload(b), { now: () => b.issuedAt + 120_000 }), seal(b, payload(b), { now: () => b.issuedAt - 120_000 }),
    ]) await expect(service().accept({ challengeId: b.challengeId, manifest })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
    await service().accept({ challengeId: b.challengeId, manifest: valid });
  });
  it('rechecks removed membership, stale jobs and foreign tenant bindings under locks', async () => {
    const b = await service().issueChallenge(intent()); const manifest = seal(b);
    await expect(service({ tenantId: h.tenantTwoId }).accept({ challengeId: b.challengeId, manifest })).rejects.toThrow();
    await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [h.tenantOneId]);
    await expect(service().accept({ challengeId: b.challengeId, manifest })).rejects.toThrow();
    await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [h.tenantOneId, USER]);
    await h.database.query("UPDATE migration_jobs SET status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now() WHERE tenant_id=$1", [h.tenantOneId]);
    await expect(service().accept({ challengeId: b.challengeId, manifest })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
  });
  it('consumes a challenge once across instances even with new envelope nonces', async () => {
    const b = await service().issueChallenge(intent()); const manifest = seal(b);
    await service().accept({ challengeId: b.challengeId, manifest });
    await expect(service().accept({ challengeId: b.challengeId, manifest })).rejects.toThrow();
    await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow();
    expect(await consumed()).toHaveLength(1);
  });
  it('rejects a nonce globally across two otherwise eligible tenant challenges and different key IDs', async () => {
    const a = service(); const b = service({ tenantId: h.tenantTwoId, registrations: [{ ...registration(h.tenantTwoId), keyId: 'bridge-2' }] });
    const one = await a.issueChallenge(intent()); const two = await b.issueChallenge(intent());
    const nonce = () => Buffer.alloc(24, 17);
    await a.accept({ challengeId: one.challengeId, manifest: seal(one, payload(one), { nonce }) });
    await expect(b.accept({ challengeId: two.challengeId, manifest: seal(two, payload(two), { nonce, keyId: 'bridge-2' }) })).rejects.toThrow();
    expect(await consumed()).toHaveLength(1);
  });
  it('detaches request scalars/envelope before awaits and rejects accessors without evaluation', async () => {
    const b = await service().issueChallenge(intent());
    const mutable = { challengeId: b.challengeId, manifest: { ...seal(b) } };
    const detached = service({ runTransaction: (tenant, callback) => {
      mutable.challengeId = '30000000-0000-4000-8000-000000000099';
      mutable.manifest.ciphertext = 'mutated-after-await';
      return h.runTenantTransaction(tenant, callback);
    } });
    await detached.accept(mutable);
    const getter = vi.fn(() => b.challengeId);
    const bad = { manifest: seal(b) };
    Object.defineProperty(bad, 'challengeId', { enumerable: true, get: getter });
    await expect(service().accept(bad)).rejects.toThrow();
    const badEnvelope = { ...seal(b) };
    Object.defineProperty(badEnvelope, 'keyId', { enumerable: true, get: getter });
    await expect(service().accept({ challengeId: b.challengeId, manifest: badEnvelope })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(await consumed()).toHaveLength(1);
  });
  it('rejects correctly signed future writer evidence and stale source/deployment registration', async () => {
    const b = await service().issueChallenge(intent()); const good = payload(b);
    const future = createRedisWriterDisableEvidence({ deploymentId: b.deploymentId,
      disabledAt: new Date(b.issuedAt + 60_000).toISOString(), controlGeneration: 41,
      controlEvidence: `sha256:${HASH}`, keyId: 'writer-1', signingPrivateKey: writer.privateKey });
    await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b, { ...good, writerDisableEvidence: future }) })).rejects.toThrow();
    await expect(service({ registrations: [{ ...registration(), deploymentId: 'replacement' }] })
      .accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow();
    await h.database.query('UPDATE migration_jobs SET source_fingerprint=$1 WHERE tenant_id=$2', ['b'.repeat(64), h.tenantOneId]);
    await h.database.query('UPDATE migration_sources SET source_fingerprint=$1 WHERE tenant_id=$2', ['b'.repeat(64), h.tenantOneId]);
    await expect(service().accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow();
    expect(await consumed()).toEqual([]);
  });
  it('rolls consumption back if its database wait crosses exact challenge expiry', async () => {
    const b = await service().issueChallenge(intent());
    const { PgDialect } = await import('drizzle-orm/pg-core');
    let reads = 0;
    const late = service({ runTransaction: (tenant, callback) => h.runTenantTransaction(tenant, async (tx) => {
      const execute = tx.execute.bind(tx);
      const wrapped = new Proxy(tx, { get(target, key, receiver) {
        if (key !== 'execute') return Reflect.get(target, key, receiver);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          if ((typeof query === 'string' ? query : new PgDialect().sqlToQuery(query.getSQL()).sql).includes('clock_timestamp()')) {
            reads += 1;
            return { rows: [{ ms: String(reads < 3 ? b.issuedAt : b.expiresAt) }] };
          }
          return execute(query);
        };
      } });
      return callback(wrapped);
    }) });
    await expect(late.accept({ challengeId: b.challengeId, manifest: seal(b) })).rejects.toThrow('Final bridge intake refused.');
    expect(reads).toBe(3);
    expect(await consumed()).toEqual([]);
  });
  it('never returns a new verified acquisition after lost commit response, and fails closed on storage errors', async () => {
    const b = await service().issueChallenge(intent()); const input = { challengeId: b.challengeId, manifest: seal(b) };
    const broken = service({ runTransaction: async () => { throw new Error('storage credential must not leak'); } });
    await expect(broken.accept(input)).rejects.toThrow('Final bridge intake refused.');
    const lost = service({ runTransaction: async (tenant, callback) => {
      await h.runTenantTransaction(tenant, callback); throw new Error('commit response lost');
    } });
    await expect(lost.accept(input)).rejects.toThrow('Final bridge intake refused.');
    expect(await consumed()).toHaveLength(1);
    await expect(service().accept(input)).rejects.toThrow();
  });
});
