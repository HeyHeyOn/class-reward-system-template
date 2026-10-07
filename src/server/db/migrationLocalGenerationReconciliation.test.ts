import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from './testing/pglite';

let harness: PgliteDatabaseHarness;
const job = 'job-local';
const digest = 'a'.repeat(64);
const source = 'source-local';
const snapshot = 'snapshot-local';
const args = (generation: string, category = 'PRODUCTS', jobId = job) =>
  [harness.tenantOneId, jobId, generation, source, snapshot, digest, category];
const insert = (generation: string, category = 'PRODUCTS', jobId = job) => harness.database.query(
  `INSERT INTO migration_local_generation_reconciliation
   (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
    category,expected_count,actual_count,delta,status)
   VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,0,'MATCH')`, args(generation, category, jobId),
);

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((item) => /^\d{4}_.*\.sql$/.test(item) && item.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  const db = harness.database;
  const tenant = harness.tenantOneId;
  await db.query('INSERT INTO migration_jobs (tenant_id,job_id) VALUES ($1,$2)', [tenant, job]);
  await db.query(`INSERT INTO migration_sources (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES ($1,$2,$3,'GOOGLE_SHEETS','local-fixture', $4)`, [tenant, job, source, digest]);
  await db.query(`INSERT INTO migration_snapshots
    (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
    VALUES ($1,$2,$3,$4,'PREFLIGHT',$5,'{}'::jsonb,0)`, [tenant, job, source, snapshot, digest]);
  for (const id of ['candidate-1', 'plan-1', 'candidate-2', 'plan-2']) {
    await db.query(`INSERT INTO audit_events (tenant_id,event_id,event_type) VALUES ($1,$2,'LOCAL_FIXTURE')`, [tenant, id]);
  }
  for (const index of [1, 2]) {
    await db.query(`INSERT INTO migration_final_generations
      (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_event_id,
       plan_event_id,candidate_manifest_digest,candidate_sheet_digest,expected_state_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
    [tenant, job, `gen-${index}`, source, snapshot, `candidate-${index}`, `plan-${index}`,
      index === 1 ? digest : 'b'.repeat(64), digest]);
  }
});
afterEach(async () => { await harness?.close(); });

describe('non-authoritative generation reconciliation evidence', () => {
  it('rejects duplicate category, wrong generation, wrong job and mismatched candidate digest', async () => {
    await insert('gen-1');
    await expect(insert('gen-1')).rejects.toThrow();
    await expect(insert('missing')).rejects.toThrow();
    await expect(insert('gen-1', 'STUDENTS', 'other-job')).rejects.toThrow();
    await expect(insert('gen-2')).rejects.toThrow(); // digest belongs to gen-1
  });
  it('refuses fabricated MATCH counts and inconsistent deltas', async () => {
    const statement = `INSERT INTO migration_local_generation_reconciliation
      (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
       category,expected_count,actual_count,delta,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    await expect(harness.database.query(statement, [...args('gen-1'), 1, 2, 1, 'MATCH'])).rejects.toThrow();
    await expect(harness.database.query(statement, [...args('gen-1'), 1, 2, 0, 'MISMATCH'])).rejects.toThrow();
    await expect(harness.database.query(statement, [...args('gen-1'), -1, 0, 1, 'MISMATCH'])).rejects.toThrow();
    expect((await harness.database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM migration_local_generation_reconciliation')).rows[0].count).toBe(0);
  });
  it('retains separate generations and refuses mutation', async () => {
    await insert('gen-1');
    await harness.database.query(`INSERT INTO migration_local_generation_reconciliation
      (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
       category,expected_count,actual_count,delta,status)
      VALUES ($1,$2,'gen-2',$3,$4,$5,'PRODUCTS',1,1,0,'MATCH')`,
    [harness.tenantOneId, job, source, snapshot, 'b'.repeat(64)]);
    expect((await harness.database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM migration_local_generation_reconciliation')).rows[0].count).toBe(2);
    await expect(harness.database.exec(`DELETE FROM migration_local_generation_reconciliation WHERE category='PRODUCTS'`)).rejects.toThrow();
  });
});
