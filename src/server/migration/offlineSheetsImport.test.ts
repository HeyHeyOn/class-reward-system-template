import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { makeRedis, makeSupportedSheets } from './__fixtures__/normalization';
import { captureOfflineSheetsBaseline } from './sheetsSnapshot';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { stageLegacyFinalGeneration } from './finalGeneration';
vi.mock('server-only', () => ({}));
const job = '20000000-0000-4000-8000-000000000001';
let db: PgliteDatabaseHarness;
beforeEach(async () => {
  db = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  for (const name of (await readdir(resolve('src/server/db/migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) {
    await db.database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
});
afterEach(async () => { await db?.close(); });
async function fixture(legacyReward = false) {
  const original = makeSupportedSheets(3, tabs => {
    if (!legacyReward) return;
    const values: Record<string, string> = { transactionId: 'TASK-LOGICAL-synthetic-bank', timestamp: '2026-09-01T01:00:00.000Z', studentId: 'S1', studentName: 'Alice',
      items: JSON.stringify([{ productId: 'T1', name: 'Historical task title', price: -5, quantity: 1, subtotal: -5 }]),
      totalAmount: '-5', balanceBefore: '90', balanceAfter: '95', status: 'TASK_REWARD', operator: 'bank' };
    tabs.Transactions.rows.push({ rowNumber: 3, hash: '', cells: tabs.Transactions.headers.map(key => values[key] ?? '') });
    tabs.Students.rows[0].cells[tabs.Students.headers.indexOf('balance')] = '95';
  });
  const tabs = Object.fromEntries(Object.entries(original.tabs).map(([name, tab]) => [name, [[...tab.headers], ...tab.rows.map(row => [...row.cells])]]));
  tabs.Settings.find(row => row[0] === 'schemaVersion')![1] = '4';
  const sheets = await captureOfflineSheetsBaseline({ spreadsheetId: 'synthetic-sheet', capturedAt: original.capturedAt, contentSha256: 'a'.repeat(64), tabs });
  const manifest = createLegacyNormalizationManifest({ tenantId: db.tenantOneId, migrationJobId: job, sheets });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  return { sheets, manifest };
}
describe('offline baseline has no production import authority', () => {
  it('rejects the default importer before resolving its production database', async () => {
    const { manifest } = await fixture();
    await expect(importLegacyNormalizationManifest({ tenantId: db.tenantOneId, migrationJobId: job, manifest })).rejects.toThrow(/offline.*isolated/i);
  });
  it('rehearses explicit isolated imports idempotently with a distinct non-cutover binding', async () => {
    const { manifest } = await fixture();
    await db.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [db.tenantOneId, job]);
    const input = { tenantId: db.tenantOneId, migrationJobId: job, manifest, runTransaction: db.runTenantTransaction, offlineRehearsal: true as const };
    const first = await importLegacyNormalizationManifest(input);
    const second = await importLegacyNormalizationManifest(input);
    expect(second).toEqual(first);
    const snapshots = await db.database.query<{ binding: string }>("SELECT redacted_manifest->>'bindingKind' AS binding FROM migration_snapshots");
    expect(snapshots.rows.map(row => row.binding)).toEqual(['OFFLINE_REHEARSAL_IMPORT']);
    expect((await db.database.query("SELECT count(*)::int n FROM migration_snapshots WHERE redacted_manifest->>'bindingKind'='LEGACY_NORMALIZATION_IMPORT'")).rows[0]).toEqual({ n: 0 });
    expect((await db.database.query('SELECT schema_version FROM tenant_settings WHERE tenant_id=$1', [db.tenantOneId])).rows[0]).toEqual({ schema_version: 4 });
    const accounts = await db.database.query<{ student_id: string; balance: number }>('SELECT student_id,balance FROM accounts WHERE tenant_id=$1', [db.tenantOneId]);
    expect(accounts.rows.map(row => [row.student_id, Number(row.balance)])).toEqual(manifest.records.accounts.map(row => [row.studentId, row.balance]));
  });
  it('refuses offline snapshots at final-generation preparation before writes', async () => {
    const { sheets } = await fixture();
    const redis = makeRedis({ operationBindings: [], v2Claims: [] });
    const manifest = createLegacyNormalizationManifest({ tenantId: db.tenantOneId, migrationJobId: job, sheets, redis });
    const called = vi.fn();
    const runTransaction: TenantImportTransactionRunner = (tenant, callback) => {
      called(); return db.runTenantTransaction(tenant, callback);
    };
    await expect(stageLegacyFinalGeneration({ tenantId: db.tenantOneId, migrationJobId: job, expectedStateVersion: '1',
      originalSnapshotId: `import:${manifest.manifestDigest}`, originalSourceId: `sheet:${sheets.digest}`,
      exclusionGenerationReference: 'b'.repeat(64), original: { sheets, redis }, candidate: { sheets, redis } }, { runTransaction })).rejects.toThrow();
    expect(called).not.toHaveBeenCalled();
  });
  it('retains a signed Sheets BANK ledger item without a purchase, stock decrement or new command', async () => {
    const { manifest } = await fixture(true);
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    await db.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [db.tenantOneId, job]);
    const input = { tenantId: db.tenantOneId, migrationJobId: job, manifest, runTransaction: db.runTenantTransaction, offlineRehearsal: true as const };
    await importLegacyNormalizationManifest(input);
    await importLegacyNormalizationManifest(input);
    const ledger = await db.database.query("SELECT legacy_total_amount,balance_delta,kind,operation_id FROM transactions WHERE transaction_id='TASK-LOGICAL-synthetic-bank'");
    expect(ledger.rows).toEqual([{ legacy_total_amount: -5, balance_delta: 5, kind: 'TASK_REWARD', operation_id: null }]);
    const line = await db.database.query("SELECT current_product_id,unit_price_snapshot,subtotal_snapshot FROM transaction_items WHERE transaction_id='TASK-LOGICAL-synthetic-bank'");
    expect(line.rows).toEqual([{ current_product_id: null, unit_price_snapshot: -5, subtotal_snapshot: -5 }]);
    expect((await db.database.query('SELECT balance FROM accounts')).rows).toEqual([{ balance: 95 }]);
    expect((await db.database.query<{ product_id: string; stock: number }>('SELECT product_id,stock FROM products')).rows)
      .toEqual(manifest.records.products.map(row => ({ product_id: row.productId, stock: row.stock })));
    expect((await db.database.query<{ n: number }>("SELECT count(*)::int n FROM operations")).rows[0].n).toBe(0);
  });
});
