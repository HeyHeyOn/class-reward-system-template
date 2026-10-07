// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { taskHistoryFixture } from '../../../test-support/legacyTaskFixture';
import { createDatabaseTransactionCommands } from '@/server/repositories/database/transactionCommands';
import { createDatabaseStudentCommands } from '@/server/repositories/database/studentCommands';
import { createFrozenFullPreparation } from './prepareFrozenFullCutover';
import { verifyOperatorObservedGoogleSheetControl } from './googleSourceControl';
import { createTenantBootstrapper } from '@/server/repositories/database/tenantBootstrap';
import { createDatabaseSettingsCommands } from '@/server/repositories/database/settingsCommands';
import { createDatabaseSettingsQueries } from '@/server/repositories/database/settingsQueries';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { canonicalJson, sha256 } from './validators';
import { inspectLegacyFinancialDiscrepancies, type LegacyFinancialReview } from './legacyFinancialHistory';
import { createFrozenFullCutover, type FrozenCutoverIntent, type FrozenSourceBinding, type FrozenLegacySources,
  type FrozenCutoverDependencies, type VerifiedRedisNonUse } from './frozenFullCutover';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
let db: DisposablePostgres;

function fixture(spreadsheetId: string) {
  const base = taskHistoryFixture();
  base.Settings.push(['classTimeZone', 'Asia/Seoul'], ['currencyUnit', '별']);
  const tabs = { ...base,
    Products: [['productId','name','price','stock','isActive','imageUrl','category','sortOrder'], ['P1','Product','5','41','TRUE','','','1']],
    Adjustments: [['adjustmentId','timestamp','studentId','amount','mode','operator']],
    Promotions: [['promotionId','name','description','type','value','buyQuantity','freeQuantity','startsAt','endsAt','isActive','sortOrder','createdAt','updatedAt','schemaVersion']],
    PromotionProducts: [['promotionProductId','promotionId','productId','createdAt','schemaVersion']],
  };
  return JSON.stringify({ spreadsheetId, sheets: Object.entries(tabs).map(([title, rows]) => ({ properties: { title },
    data: [{ rowData: rows.map(cells => ({ values: cells.map(formattedValue => ({ formattedValue })) })) }] })) });
}
async function seed(recordedGrid?: string, discovered = false, omitPreflight = false) {
  const tenantId = randomUUID(), migrationJobId = randomUUID(), sheetsSourceId = randomUUID(), redisSourceId = randomUUID();
  const userId = randomUUID(), subject = `synthetic-owner-${userId}`;
  const spreadsheetId: string = recordedGrid ? JSON.parse(recordedGrid).spreadsheetId : `synthetic-sheet-${tenantId}`;
  let intent: FrozenCutoverIntent = { migrationJobId, expectedStateVersion: '1', expectedJobFingerprint: null,
    sheetsSourceId, redisSourceId, expectedSheetsFingerprint: sha256('preflight-sheets'), expectedRedisFingerprint: sha256('preflight-redis'), redisNonUseEvidenceDigest: null };
  await db.owner.query('INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,$3)', [userId, subject, `${userId}@example.invalid`]);
  await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Synthetic frozen cutover','DRAFT')", [tenantId, `frozen-${tenantId}`]);
  await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
  await db.owner.query('INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,$3)', [tenantId, migrationJobId, discovered ? 'DISCOVERED' : 'VALIDATED']);
  for (const [source, provider, external, digest] of [
    [sheetsSourceId, 'GOOGLE_SHEETS', spreadsheetId, intent.expectedSheetsFingerprint],
    [redisSourceId, 'LEGACY_REDIS_BRIDGE', `synthetic-redis-${tenantId}`, intent.expectedRedisFingerprint],
  ]) await db.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint,ownership_subject_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, migrationJobId, source, provider, external, digest, sha256(subject)]);
  let subjectNow: string | null = subject;
  let gridJson = recordedGrid ?? fixture(spreadsheetId);
  const tuple = sha256(`synthetic-claim-${tenantId}`);
  const capturedAt = new Date().toISOString();
  const snapshot = await captureRedisClaimSnapshot({ getRevision: async () => 'synthetic-frozen-revision',
    hscan: async () => ({ cursor: '0', entries: [] }),
    scan: async () => ({ cursor: '0', keys: [`padlet:evidence-claim:v1:${tuple}`] }), get: async () => 'synthetic-historical-owner',
  }, { capturedAt });
  if (discovered) {
    intent = { ...intent, expectedSheetsFingerprint: sha256(gridJson), expectedRedisFingerprint: snapshot.digest };
    await db.owner.query('UPDATE migration_sources SET source_fingerprint=CASE WHEN provider=$1 THEN $2 ELSE $3 END WHERE tenant_id=$4',
      ['GOOGLE_SHEETS', intent.expectedSheetsFingerprint, intent.expectedRedisFingerprint, tenantId]);
  } else if (!omitPreflight) {
    await db.owner.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,captured_at,row_count)
      VALUES($1,$2,$3,$4,'PREFLIGHT',$5,$6,$7,0)`, [tenantId, migrationJobId, sheetsSourceId, randomUUID(), intent.expectedSheetsFingerprint,
      { scope: 'FULL_SNAPSHOT_PREFLIGHT', sourceIdentityDigest: sha256(spreadsheetId), redisDigest: intent.expectedRedisFingerprint, redisNonUse: null }, capturedAt]);
  }
  const held = vi.fn(async () => {}), capture = vi.fn<FrozenLegacySources['captureFresh']>(async () => ({ gridJson, capturedAt, redis: snapshot }));
  let beforeFreeze: (binding: FrozenSourceBinding) => Promise<void> = async () => {};
  let proofTransform: (proof: FrozenLegacySources) => FrozenLegacySources = p => p;
  const freeze = vi.fn();
  const withFrozenSources: FrozenCutoverDependencies['withFrozenSources'] = async (binding, work) => {
    freeze(binding);
    await beforeFreeze(binding);
    return work(proofTransform({ bindingDigest: sha256(canonicalJson(binding)), fenceDigest: sha256('synthetic-fence'),
      writerInventoryDigest: sha256('synthetic-inventory'), startedAt: capturedAt, drainedAt: capturedAt,
      assertHeld: held, captureFresh: capture }));
  };
  const dependencies: FrozenCutoverDependencies = { tenantId, getAuthenticatedSubject: async () => subjectNow,
    runMigrationTransaction: db.runTenantTransaction, withFrozenSources };
  return { tenantId, userId, intent, subject, tuple, snapshot, capturedAt, spreadsheetId, dependencies, freeze, held, capture,
    run: (override = intent) => createFrozenFullCutover(dependencies)(override),
    setSubject: (value: string | null) => { subjectNow = value; },
    setGrid: (value: string) => { gridJson = value; },
    setBeforeFreeze: (fn: typeof beforeFreeze) => { beforeFreeze = fn; },
    setProof: (fn: typeof proofTransform) => { proofTransform = fn; },
  };
}
async function expectUntouched(input: Awaited<ReturnType<typeof seed>>) {
  expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [input.tenantId])).rows[0].lifecycle).toBe('DRAFT');
  expect((await db.owner.query('SELECT status,state_version::text,source_fingerprint FROM migration_jobs WHERE tenant_id=$1', [input.tenantId])).rows)
    .toEqual([{ status: 'VALIDATED', state_version: '1', source_fingerprint: null }]);
  for (const table of ['accounts', 'products', 'tasks', 'transactions', 'task_assignments', 'task_completions', 'operations',
    'legacy_full_snapshot_archives', 'legacy_redis_snapshot_archives', 'legacy_claim_publications', 'reconciliation_results', 'audit_events']) {
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [input.tenantId])).rows[0].n, table).toBe(0);
  }
  expect((await db.owner.query("SELECT phase FROM migration_snapshots WHERE tenant_id=$1", [input.tenantId])).rows).toEqual([{ phase: 'PREFLIGHT' }]);
  expect((await db.owner.query('SELECT count(*)::int AS n FROM padlet_claim_digest_registry WHERE tuple_digest=$1', [input.tuple])).rows[0].n).toBe(0);
  expect((await db.owner.query('SELECT source_fingerprint FROM migration_sources WHERE tenant_id=$1 ORDER BY provider', [input.tenantId])).rows)
    .toEqual([{ source_fingerprint: input.intent.expectedSheetsFingerprint }, { source_fingerprint: input.intent.expectedRedisFingerprint }]);
}
suite('finite frozen full cutover on native PostgreSQL (synthetic source adapter)', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined(); db = await createDisposablePostgres();
    // Test executor only. The deployed web runtime must never receive these grants.
    await db.owner.query('GRANT SELECT,INSERT ON legacy_transaction_origins,legacy_task_origins,legacy_full_snapshot_archives,legacy_redis_snapshot_archives,legacy_claim_publications TO app_runtime');
  }, 60_000);
  afterAll(async () => { if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true }); }, 60_000);
  it('binds operator-observed ownership to a private bootstrap and auditable full preflight', async () => {
    const now = Date.now(), subject = randomUUID(), fileId = `operator-sheet-${randomUUID()}`;
    const email = `${subject}@example.invalid`, gridJson = fixture(fileId), evidenceDigest = sha256('synthetic UI evidence');
    const proof = await verifyOperatorObservedGoogleSheetControl({ fileId, session: { subject, email, issuedAt: now }, now: () => now,
      readObservation: async () => ({ method: 'OPERATOR_GOOGLE_SHARE_UI', observedAt: now, fileId, googleSubject: subject,
        ownerEmail: email, ownerIsSignedInUser: true, role: 'OWNER', generalAccess: 'RESTRICTED', listedPrincipals: 1,
        providerSpreadsheetReadSucceeded: true, evidenceDigest }) });
    const bootstrap = createTenantBootstrapper({ runTransaction: async callback => {
      const client = await db.owner.connect();
      try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } });
    const target = await bootstrap({ slug: `operator-${randomUUID()}`, displayName: 'Operator fixture',
      owner: { subject, email }, proof, sourceFingerprint: sha256(gridJson) });
    const details = (await db.owner.query("SELECT redacted_details FROM audit_events WHERE tenant_id=$1 AND event_type='MIGRATION_SOURCE_CONTROL_VERIFIED'", [target.tenantId])).rows[0].redacted_details;
    expect(details).toMatchObject({ method: 'OPERATOR_GOOGLE_SHARE_UI', evidenceDigest, sourceIdentityDigest: sha256(fileId) });
    const intent = await createFrozenFullPreparation({ tenantId: target.tenantId, getAuthenticatedSubject: async () => subject,
      runMigrationTransaction: db.runTenantTransaction })({ migrationJobId: target.jobId, expectedStateVersion: '1', sheetsSourceId: target.sourceId,
      gridJson, capturedAt: new Date().toISOString(), redisSourceId: null,
      redis: { kind: 'NEVER_USED', sourceIdentityDigest: sha256(fileId), evidenceDigest: sha256('owner confirmed non-use') } });
    expect(intent.expectedStateVersion).toBe('2');
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [target.tenantId])).rows[0].lifecycle).toBe('DRAFT');
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [target.tenantId])).rows[0].n).toBe(0);
  });
  it('commits the full archive, exact reconciliation, historical claims and ACTIVE with one replayable receipt', async () => {
    const input = await seed(), receipt = await input.run();
    expect(receipt).toMatchObject({ status: 'ACTIVE', stateVersion: '7', tombstones: 1 });
    expect(input.held).toHaveBeenCalledTimes(4);
    expect((await db.owner.query('SELECT category,status,delta::text FROM reconciliation_results WHERE tenant_id=$1', [input.tenantId])).rows)
      .toHaveLength(13);
    expect((await db.owner.query("SELECT count(*)::int AS n FROM reconciliation_results WHERE tenant_id=$1 AND (status<>'MATCH' OR delta<>0)", [input.tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT phase FROM migration_snapshots WHERE tenant_id=$1 ORDER BY phase', [input.tenantId])).rows)
      .toEqual([{ phase: 'FINAL_FROZEN' }, { phase: 'FINAL_FROZEN' }, { phase: 'PREFLIGHT' }]);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
    // Replay must not reimport or overwrite business changes after activation.
    await db.owner.query('UPDATE products SET stock=40 WHERE tenant_id=$1', [input.tenantId]);
    expect(await input.run()).toEqual(receipt);
    expect(input.freeze).toHaveBeenCalledTimes(1);
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1', [input.tenantId])).rows[0].stock).toBe('40');
    // Source credentials may be deliberately removed after a completed cutover.
    await db.owner.query('UPDATE migration_sources SET grant_deleted_at=clock_timestamp() WHERE tenant_id=$1', [input.tenantId]);
    expect(await input.run()).toEqual(receipt);
    await expect(input.run({ ...input.intent, expectedStateVersion: '2' })).rejects.toThrow(/receipt or retry/);
    input.setSubject(null); await expect(input.run()).rejects.toThrow(/authentication/);
  });
  it('pins owner-reviewed financial exceptions across preparation, freeze binding, activation and retry', async () => {
    const gridJson = fixture(`reviewed-sheet-${randomUUID()}`).replace('TASK_REWARD', 'CANCELLED');
    const input = await seed(gridJson, true);
    const financialReview: LegacyFinancialReview = { policy: 'PRESERVE_RECORDED_BALANCES',
      sourceIdentityDigest: sha256(input.spreadsheetId), approvedBySubjectDigest: sha256(input.subject),
      approvalEvidenceDigest: sha256('owner requests unchanged money and history'),
      discrepancies: inspectLegacyFinancialDiscrepancies(gridJson).discrepancies };
    const intent = await createFrozenFullPreparation(input.dependencies)({ migrationJobId: input.intent.migrationJobId,
      expectedStateVersion: '1', sheetsSourceId: input.intent.sheetsSourceId, gridJson, capturedAt: input.capturedAt,
      redisSourceId: input.intent.redisSourceId, redis: input.snapshot, financialReview });
    await expect(createFrozenFullCutover(input.dependencies)(intent)).rejects.toThrow(/preflight/);
    await expect(createFrozenFullCutover({ ...input.dependencies, financialReview: { ...financialReview,
      approvalEvidenceDigest: sha256('different decision') } })(intent)).rejects.toThrow(/preflight/);
    await expect(createFrozenFullCutover({ ...input.dependencies, financialReview: { ...financialReview,
      approvedBySubjectDigest: sha256('another owner') } })(intent)).rejects.toThrow(/owner mismatch/);
    expect(input.freeze).not.toHaveBeenCalled();
    const run = createFrozenFullCutover({ ...input.dependencies, financialReview }), receipt = await run(intent);
    expect(receipt.status).toBe('ACTIVE'); expect(await run(intent)).toEqual(receipt);
    expect(input.freeze.mock.calls[0][0].financialReviewDigest).toBe(sha256(canonicalJson(financialReview)));
    expect((await db.owner.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND event_type='MIGRATION_FINANCIAL_DISCREPANCIES_PRESERVED'", [input.tenantId])).rows[0].n).toBe(1);
    await expect(createFrozenFullCutover({ ...input.dependencies, financialReview: { ...financialReview,
      approvalEvidenceDigest: sha256('changed after activation') } })(intent)).rejects.toThrow(/receipt or retry/);
  });
  it('recovers a committed but lost response from the immutable receipt without acquiring another freeze', async () => {
    const input = await seed(); let calls = 0;
    const runner = input.dependencies.runMigrationTransaction;
    const service = createFrozenFullCutover({ ...input.dependencies, runMigrationTransaction: async (tenant, fn) => {
      const result = await runner(tenant, fn); if (++calls === 2) throw new Error('synthetic lost response after COMMIT'); return result;
    } });
    await expect(service(input.intent)).rejects.toThrow(/lost response/);
    expect(await input.run()).toMatchObject({ status: 'ACTIVE', stateVersion: '7' });
    expect(input.freeze).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent identical attempts to one import and one receipt', async () => {
    const input = await seed();
    const results = await Promise.allSettled([input.run(), input.run()]);
    const [first, second] = results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
    expect(second).toEqual(first);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(1);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(1);
  });
  it('refuses unauthenticated, foreign-owner and stale intents before external freeze work', async () => {
    const input = await seed(); input.setSubject(null);
    await expect(input.run()).rejects.toThrow(/authentication/);
    input.setSubject('foreign-owner'); await expect(input.run()).rejects.toThrow(/owner/);
    input.setSubject(input.subject); await expect(input.run({ ...input.intent, expectedStateVersion: '2' })).rejects.toThrow(/Stale/);
    expect(input.freeze).not.toHaveBeenCalled(); await expectUntouched(input);
  });
  it.each(['membership', 'source', 'identity'] as const)('rechecks %s after external acquisition', async change => {
    const input = await seed();
    input.setBeforeFreeze(async () => {
      if (change === 'membership') await db.owner.query("UPDATE tenant_memberships SET role='ADMIN' WHERE tenant_id=$1", [input.tenantId]);
      if (change === 'source') await db.owner.query('UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2 AND provider=$3', ['changed-source', input.tenantId, 'GOOGLE_SHEETS']);
      if (change === 'identity') input.setSubject('new-subject');
    });
    await expect(input.run()).rejects.toThrow(/owner|changed|preflight/); await expectUntouched(input);
  });
  it.each([1, 2, 3, 4])('rolls everything back if exclusion is lost at fence check %i', async check => {
    const input = await seed(); let calls = 0;
    input.held.mockImplementation(async () => { if (++calls === check) throw new Error('synthetic fence lost'); });
    await expect(input.run()).rejects.toThrow(/fence lost/); await expectUntouched(input);
    input.held.mockImplementation(async () => {});
    expect(await input.run()).toMatchObject({ status: 'ACTIVE' });
  });
  it('rolls back publication and every imported row when the final activation statement fails', async () => {
    const input = await seed();
    await db.owner.query(`CREATE FUNCTION frozen_activation_failure_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='ACTIVE' THEN RAISE EXCEPTION 'synthetic activation failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER frozen_activation_failure_test BEFORE UPDATE ON migration_jobs FOR EACH ROW EXECUTE FUNCTION frozen_activation_failure_test()`);
    try { await expect(input.run()).rejects.toThrow(); }
    finally { await db.owner.query('DROP TRIGGER frozen_activation_failure_test ON migration_jobs; DROP FUNCTION frozen_activation_failure_test()'); }
    await expectUntouched(input); expect(await input.run()).toMatchObject({ status: 'ACTIVE' });
  });
  it.each(['wrong-sheet', 'predrain', 'wrong-binding', 'orphan'] as const)('rejects invalid acquisition: %s', async kind => {
    const input = await seed();
    if (kind === 'wrong-sheet') input.setGrid(fixture('another-sheet'));
    if (kind === 'predrain') input.capture.mockImplementation(async () => ({ gridJson: fixture(input.spreadsheetId),
      capturedAt: '2026-09-01T00:00:00.000Z', redis: input.snapshot }));
    if (kind === 'wrong-binding') input.setProof(p => ({ ...p, bindingDigest: sha256('other-binding') }));
    if (kind === 'orphan') {
      const redis = await captureRedisClaimSnapshot({ getRevision: async () => 'synthetic-frozen',
        hscan: async () => ({ cursor: '0', entries: [[`claim:${sha256('orphan')}`, 'missing-operation']] }),
        scan: async () => ({ cursor: '0', keys: [] }), get: async () => null }, { capturedAt: input.capturedAt });
      input.capture.mockImplementation(async () => ({ gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redis }));
    }
    await expect(input.run()).rejects.toThrow(/identity mismatch|follow writer drain|proof mismatch|Unresolved/);
    await expectUntouched(input);
  });
  it('preserves existing private business data and refuses activation', async () => {
    const input = await seed();
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'keep','Existing','ACTIVE')", [input.tenantId]);
    await expect(input.run()).rejects.toThrow(/empty business tables/);
    expect((await db.owner.query('SELECT student_id FROM students WHERE tenant_id=$1', [input.tenantId])).rows).toEqual([{ student_id: 'keep' }]);
    await expectUntouched(input);
  });
  it('does not replace a globally claimed historical post belonging to another owner', async () => {
    const input = await seed();
    await db.owner.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'upstash:padlet:evidence-claim:v1')", [input.tuple, sha256('other-owner')]);
    await expect(input.run()).rejects.toThrow(/ownership conflict/);
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [input.tenantId])).rows[0].lifecycle).toBe('DRAFT');
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT owner_digest FROM padlet_claim_digest_tombstones WHERE tuple_digest=$1', [input.tuple])).rows[0].owner_digest).toBe(sha256('other-owner'));
  });
  it('rechecks time-limited source grants immediately before activation', async () => {
    const input = await seed();
    // The synthetic last fence check consumes the grant's remaining lifetime.
    await db.owner.query("UPDATE migration_sources SET grant_expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1", [input.tenantId]);
    let calls = 0;
    input.held.mockImplementation(async () => {
      if (++calls === 4) await db.owner.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (MAX(grant_expires_at)-clock_timestamp())))+0.01) FROM migration_sources WHERE tenant_id=$1", [input.tenantId]);
    });
    await expect(input.run()).rejects.toThrow(/grant expired/); await expectUntouched(input);
  });
  it('refuses a second migration job in the same private destination', async () => {
    const input = await seed();
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'DISCOVERED')", [input.tenantId, randomUUID()]);
    await expect(input.run()).rejects.toThrow(/single destination job/);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
  });
  it('records verified Redis non-use without creating an invented Redis source, archive or claim publication', async () => {
    const input = await seed(undefined, true);
    await db.owner.query("DELETE FROM migration_sources WHERE tenant_id=$1 AND provider='LEGACY_REDIS_BRIDGE'", [input.tenantId]);
    const evidence: VerifiedRedisNonUse = { kind: 'NEVER_USED', sourceIdentityDigest: sha256(input.spreadsheetId), evidenceDigest: sha256('synthetic owner non-use declaration and inventory') };
    const intent = await createFrozenFullPreparation(input.dependencies)({ migrationJobId: input.intent.migrationJobId, expectedStateVersion: '1',
      sheetsSourceId: input.intent.sheetsSourceId, gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redisSourceId: null, redis: evidence });
    input.capture.mockImplementation(async () => ({ gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redis: evidence }));
    const receipt = await input.run(intent);
    expect(receipt).toMatchObject({ redisCoverage: 'NEVER_USED', redisDigest: null, tombstones: 0 });
    for (const table of ['legacy_redis_snapshot_archives', 'legacy_claim_publications']) {
      expect((await db.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [input.tenantId])).rows[0].n).toBe(0);
    }
    expect((await db.owner.query("SELECT redacted_details FROM audit_events WHERE tenant_id=$1 AND event_type='MIGRATION_FROZEN_FULL_ACTIVATED'", [input.tenantId])).rows[0].redacted_details.redisNonUse).toEqual(evidence);
    expect(await input.run(intent)).toEqual(receipt);
  });
  it.each(['source', 'evidence', 'unexpected-snapshot'] as const)('rejects invalid non-use authority: %s', async kind => {
    const input = await seed(undefined, true);
    await db.owner.query("DELETE FROM migration_sources WHERE tenant_id=$1 AND provider='LEGACY_REDIS_BRIDGE'", [input.tenantId]);
    const evidence: VerifiedRedisNonUse = { kind: 'NEVER_USED', sourceIdentityDigest: sha256(input.spreadsheetId), evidenceDigest: sha256('reviewed inventory') };
    const intent = await createFrozenFullPreparation(input.dependencies)({ migrationJobId: input.intent.migrationJobId, expectedStateVersion: '1',
      sheetsSourceId: input.intent.sheetsSourceId, gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redisSourceId: null, redis: evidence });
    input.capture.mockImplementation(async () => ({ gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt,
      redis: kind === 'unexpected-snapshot' ? input.snapshot : { ...evidence, ...(kind === 'source'
        ? { sourceIdentityDigest: sha256('wrong-source') } : { evidenceDigest: sha256('wrong-evidence') }) } }));
    await expect(input.run(intent)).rejects.toThrow(/non-use evidence mismatch|coverage differs/);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
  });
  it('prepares a DISCOVERED source without business writes and connects its exact intent to frozen activation', async () => {
    const input = await seed(undefined, true);
    const prepare = createFrozenFullPreparation(input.dependencies);
    const request = { migrationJobId: input.intent.migrationJobId, expectedStateVersion: '1', sheetsSourceId: input.intent.sheetsSourceId,
      gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redisSourceId: input.intent.redisSourceId, redis: input.snapshot };
    const reviewed = await prepare(request);
    expect(reviewed.expectedStateVersion).toBe('2');
    expect(await prepare(request)).toEqual(reviewed);
    expect((await db.owner.query('SELECT count(*)::int AS n FROM students WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
    const receipt = await input.run(reviewed);
    expect(receipt).toMatchObject({ status: 'ACTIVE', stateVersion: '8' });
    expect((await db.owner.query('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(2);
  });
  it('prepares verified non-use without binding a fictitious Redis source', async () => {
    const input = await seed(undefined, true);
    await db.owner.query("DELETE FROM migration_sources WHERE tenant_id=$1 AND provider='LEGACY_REDIS_BRIDGE'", [input.tenantId]);
    const redis: VerifiedRedisNonUse = { kind: 'NEVER_USED', sourceIdentityDigest: sha256(input.spreadsheetId), evidenceDigest: sha256('reviewed historical non-use') };
    const prepare = createFrozenFullPreparation(input.dependencies);
    const request = { migrationJobId: input.intent.migrationJobId, expectedStateVersion: '1', sheetsSourceId: input.intent.sheetsSourceId,
      gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redisSourceId: null, redis };
    const reviewed = await prepare(request);
    input.capture.mockImplementation(async () => ({ gridJson: request.gridJson, capturedAt: input.capturedAt, redis }));
    expect(await input.run(reviewed)).toMatchObject({ status: 'ACTIVE', redisCoverage: 'NEVER_USED', tombstones: 0 });
  });
  it('rejects preflight input drift and missing reviewed manifests', async () => {
    const input = await seed(undefined, true), prepare = createFrozenFullPreparation(input.dependencies);
    const request = { migrationJobId: input.intent.migrationJobId, expectedStateVersion: '1', sheetsSourceId: input.intent.sheetsSourceId,
      gridJson: fixture(input.spreadsheetId), capturedAt: input.capturedAt, redisSourceId: input.intent.redisSourceId, redis: input.snapshot };
    await expect(prepare({ ...request, gridJson: fixture('different-source') })).rejects.toThrow(/source binding mismatch/);
    await prepare(request);
    await expect(prepare({ ...request, capturedAt: new Date(Date.parse(request.capturedAt) + 1).toISOString() })).rejects.toThrow(/retry differs/);
    const missing = await seed(undefined, false, true);
    await expect(missing.run()).rejects.toThrow(/preflight/); expect(missing.freeze).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.CRS_FROZEN_RECORDED_GRID)('rehearses recorded TEST business data through activation and negative legacy cancellation in an isolated database', async () => {
    const input = await seed(await readFile(process.env.CRS_FROZEN_RECORDED_GRID!, 'utf8'));
    const started = performance.now(), receipt = await input.run(), durationMs = performance.now() - started;
    expect(receipt).toMatchObject({ physicalRows: 59, businessRows: 49, status: 'ACTIVE' });
    const settingsDependencies = { tenantId: input.tenantId, runTenantTransaction: db.runTenantTransaction };
    expect(await createDatabaseSettingsCommands(settingsDependencies).get()).toMatchObject({ qrManualInputEnabled: false, source: 'database' });
    expect(await createDatabaseSettingsQueries(settingsDependencies).getAppSettings()).toMatchObject({ qrManualInputEnabled: false, source: 'database' });
    expect((await db.owner.query('SELECT count(*)::int AS n FROM transactions WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(13);
    const original = (await db.owner.query(`SELECT t.transaction_id,t.student_id,s.name,s.status,s.version::int AS student_version,a.version::int AS account_version,
      t.balance_delta::int AS reward FROM transactions t JOIN students s USING(tenant_id,student_id) JOIN accounts a USING(tenant_id,student_id)
      WHERE t.tenant_id=$1 AND t.legacy_status_snapshot='TASK_REWARD' ORDER BY t.transaction_id`, [input.tenantId])).rows;
    expect(original.length).toBe(1);
    const row = original[0];
    expect(row.reward).toBeGreaterThan(0);
    await createDatabaseStudentCommands({ tenantId: input.tenantId, runTenantTransaction: db.runTenantTransaction }).update({
      operationId: randomUUID(), studentId: row.student_id, name: row.name, status: row.status, balance: 0,
      expectedStudentVersion: row.student_version, expectedAccountVersion: row.account_version });
    const commands = createDatabaseTransactionCommands({ tenantId: input.tenantId, runTenantTransaction: db.runTenantTransaction });
    const cancelInput = { operationId: randomUUID(), transactionId: row.transaction_id };
    const cancellation = await commands.cancel(cancelInput);
    expect(cancellation.balanceAfter).toBe(-row.reward);
    expect((await commands.cancel(cancelInput)).reversalTransactionId === cancellation.reversalTransactionId).toBe(true);
    await expect(commands.cancel({ ...cancelInput, operationId: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    expect(await input.run()).toEqual(receipt);
    if (process.env.CRS_FROZEN_REHEARSAL_REPORT) await writeFile(process.env.CRS_FROZEN_REHEARSAL_REPORT, JSON.stringify({
      nativePostgres: true, recordedSheetsDigest: receipt.sheetsDigest, physicalRows: 59, businessRows: 49, financialRows: 13,
      coordinatorDurationMs: durationMs, exactReconciliationCategories: 13, negativeLegacyCancellationPassed: true,
      replayAndRecancelPassed: true, activationReceiptReplayAfterNewWritesPassed: true,
      liveWriterFreezeProven: false, actualRedisCoverageProven: false, actualSourceModified: false,
      limit: 'Recorded TEST business snapshot, synthetic exclusion and Redis adapter, disposable PostgreSQL only; not a live C acceptance or downtime measurement.',
    }, null, 2) + '\n', { mode: 0o600 });
  });
});
