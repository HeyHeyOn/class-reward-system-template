import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrationsDirectory = resolve(process.cwd(), 'src/server/db/migrations');
let database: PGlite;

async function migration(name: string): Promise<string> {
  return readFile(resolve(migrationsDirectory, name), 'utf8');
}

async function applyBaseSchema() {
  await database.exec(await migration('0001_identity_tenants.sql'));
  await database.exec(await migration('0002_operational.sql'));
}

async function seedAdjustment() {
  await database.exec(`
    INSERT INTO tenants (id, slug, display_name, lifecycle)
    VALUES ('10000000-0000-4000-8000-000000000001', 'one', 'One', 'ACTIVE');
    INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'S001', 'Student', 'ACTIVE',
       '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
    INSERT INTO accounts (tenant_id, student_id, balance, version, updated_at)
    VALUES ('10000000-0000-4000-8000-000000000001', 'S001', 10, 1, '2026-08-29T00:00:00Z');
    INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot,
       kind, legacy_total_amount, balance_delta, balance_before, balance_after,
       operator_snapshot, legacy_status_snapshot, schema_version)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'tx-1', '2026-08-29T00:00:00Z',
       'S001', 'Student', 'ADMIN_ADJUSTMENT', -10, 10, 0, 10,
       'admin', 'ADMIN_ADJUSTMENT', 1);
    INSERT INTO adjustments
      (tenant_id, adjustment_id, transaction_id, mode, requested_amount, operator_snapshot)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'adjustment-1', 'tx-1', 'set', 10, 'admin');
  `);
}

beforeEach(async () => {
  database = new PGlite();
  await database.waitReady;
});

afterEach(async () => database?.close());

describe('immutable ledger guard migration', () => {
  it('leaves transaction ownership to the migration runner', async () => {
    const sql = await migration('0006_immutable_ledger_guards.sql');
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);

    await applyBaseSchema();
    await seedAdjustment();
    await database.exec('BEGIN');
    await database.exec(sql);
    await database.exec('ROLLBACK');

    await database.exec("UPDATE transactions SET operator_snapshot='changed' WHERE transaction_id='tx-1'");
    const transaction = await database.query<{ operator_snapshot: string }>(
      "SELECT operator_snapshot FROM transactions WHERE transaction_id='tx-1'",
    );
    expect(transaction.rows).toEqual([{ operator_snapshot: 'changed' }]);
    const functions = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_proc WHERE proname='reject_immutable_ledger_change'",
    );
    expect(functions.rows).toEqual([{ count: '0' }]);
  });

  it('preserves existing ledgers and rejects transaction updates and adjustment deletes', async () => {
    await applyBaseSchema();
    await seedAdjustment();
    await database.exec(await migration('0006_immutable_ledger_guards.sql'));

    await expect(database.exec("UPDATE transactions SET operator_snapshot='changed' WHERE transaction_id='tx-1'"))
      .rejects.toThrow(/immutable ledger row in transactions/i);
    await expect(database.exec("DELETE FROM adjustments WHERE adjustment_id='adjustment-1'"))
      .rejects.toThrow(/immutable ledger row in adjustments/i);

    const rows = await database.query<{ transaction_count: string; adjustment_count: string }>(`
      SELECT
        (SELECT count(*)::text FROM transactions) AS transaction_count,
        (SELECT count(*)::text FROM adjustments) AS adjustment_count
    `);
    expect(rows.rows).toEqual([{ transaction_count: '1', adjustment_count: '1' }]);
  });
});
