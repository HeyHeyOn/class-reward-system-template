import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { products } from '@/server/db/schema';

const TENANT = '20000000-0000-4000-8000-000000000001';
const migrations = [
  '0001_identity_tenants.sql',
  '0002_operational.sql',
  '0005_mutable_entity_versions.sql',
  '0008_product_tombstone_invariant.sql',
] as const;

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
});

afterEach(async () => {
  await database?.close();
});

async function migration(name: string): Promise<string> {
  return readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8');
}

describe('product tombstone invariant', () => {
  it('requires tombstoned products to be inactive in SQL and Drizzle metadata', async () => {
    const sql = await migration('0008_product_tombstone_invariant.sql');
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
    const check = getTableConfig(products).checks.find(
      (candidate) => candidate.name === 'products_deleted_status_check',
    );
    expect(check).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(check!.value).sql
      .replaceAll('"', '')
      .replace(/\bproducts\./g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    expect(rendered).toBe('deleted_at is null or not is_active');

    for (const name of migrations.slice(0, -1)) await database.exec(await migration(name));
    await database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'product-tombstone', 'Product Tombstone')`,
      [TENANT],
    );
    const deletedAt = new Date('2026-08-28T00:00:00.000Z');
    await database.query(
      `INSERT INTO products
        (tenant_id, product_id, name, price, stock, is_active, created_at, updated_at, deleted_at)
       VALUES ($1, 'LEGACY', 'Legacy Tombstone', 100, 5, true, $2, $2, $2)`,
      [TENANT, deletedAt],
    );
    await database.exec(await migration('0008_product_tombstone_invariant.sql'));
    const legacy = await database.query<{
      product_id: string; is_active: boolean; deleted_at: Date;
    }>(
      `SELECT product_id, is_active, deleted_at
       FROM products WHERE tenant_id=$1 AND product_id='LEGACY'`,
      [TENANT],
    );
    expect(legacy.rows).toEqual([{
      product_id: 'LEGACY', is_active: false, deleted_at: deletedAt,
    }]);

    await database.query(
      `INSERT INTO products (tenant_id, product_id, name, price, stock)
       VALUES ($1, 'P001', 'Product', 100, 5)`,
      [TENANT],
    );
    await expect(database.query(
      `UPDATE products SET deleted_at=updated_at WHERE tenant_id=$1 AND product_id='P001'`,
      [TENANT],
    )).rejects.toThrow();
    await database.query(
      `UPDATE products SET is_active=false, deleted_at=updated_at
       WHERE tenant_id=$1 AND product_id='P001'`,
      [TENANT],
    );
  });

  it('leaves transaction ownership to the migration runner', async () => {
    for (const name of migrations.slice(0, -1)) await database.exec(await migration(name));
    await database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'rollback-probe', 'Rollback Probe')`,
      [TENANT],
    );
    await database.query(
      `INSERT INTO products
        (tenant_id, product_id, name, price, stock, is_active, created_at, updated_at, deleted_at)
       VALUES ($1, 'LEGACY', 'Legacy Tombstone', 100, 5, true,
               '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`,
      [TENANT],
    );
    await database.exec('BEGIN');
    await database.exec(await migration('0008_product_tombstone_invariant.sql'));
    await database.exec('ROLLBACK');
    const check = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
       WHERE conname='products_deleted_status_check'`,
    );
    expect(check.rows).toEqual([{ count: '0' }]);
    const legacy = await database.query<{ is_active: boolean }>(
      `SELECT is_active FROM products WHERE tenant_id=$1 AND product_id='LEGACY'`,
      [TENANT],
    );
    expect(legacy.rows).toEqual([{ is_active: true }]);
  });
});
