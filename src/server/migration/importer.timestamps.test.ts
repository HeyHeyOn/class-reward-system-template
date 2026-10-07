import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { QueryResult, QueryResultRow } from 'pg';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createTenantTransactionRunner, type TransactionConnection } from '@/server/db/transaction';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000199';
const AT = '2026-08-31T00:00:00.000Z';
const SAME_INSTANT_TEXT = [
  '2026-08-31 00:00:00+00',
  '2026-08-31T05:45:00.000+05:45',
  '2026-08-30T21:30:00.000-02:30',
  '2026-08-31T00:00:00.000000Z',
];
let harness: PgliteDatabaseHarness;

// The shared PGlite harness ignores Drizzle's pg type parsers and returns Date.
// For this regression, request PostgreSQL's actual timestamptz text (OID 1184),
// just as node-postgres + Drizzle do. No stored row or comparison result is rewritten.
function textTimestampRunner(timeZone = 'UTC'): TenantImportTransactionRunner {
  const run = createTenantTransactionRunner({
    pool: harness.runtimePool,
    createDatabase: (connection) => {
      const textConnection: TransactionConnection = {
        async query<TResult extends QueryResultRow = QueryResultRow>(
          input: string | { text: string; values?: unknown[]; rowMode?: 'array' }, values: unknown[] = [],
        ): Promise<QueryResult<TResult>> {
          if (typeof input === 'string') return connection.query<TResult>(input, values);
          return await harness.database.query<TResult>(input.text, input.values ?? values, {
            ...(input.rowMode ? { rowMode: input.rowMode } : {}), parsers: { 1184: (text) => text },
          }) as unknown as QueryResult<TResult>;
        },
        release: (error) => connection.release(error),
      };
      return harness.createDatabase(textConnection);
    },
  });
  return (tenant, work) => run(tenant, async (tx) => {
    await tx.execute(sql`SELECT set_config('TimeZone',${timeZone},true)`);
    return work(tx);
  });
}

function makeManifest() {
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
    sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows[0].cells[tabs.Products.headers.indexOf('name')] = AT;
      tabs.Promotions.rows[0].cells[tabs.Promotions.headers.indexOf('startsAt')] = '2026-08-31T00:00:00.123Z';
    }),
  });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  return manifest;
}
async function retainedEvidence() {
  const result: unknown[] = [];
  for (const table of ['migration_sources', 'migration_snapshots', 'migration_source_records']) {
    result.push((await harness.database.query(`SELECT jsonb_build_array(t.xmin::text,to_jsonb(t))::text AS value FROM ${table} t ORDER BY value`)).rows);
  }
  return canonicalJson(result);
}
async function importedFixture() {
  const manifest = makeManifest();
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  const input = { tenantId: harness.tenantOneId, migrationJobId: JOB, manifest };
  await importLegacyNormalizationManifest({ ...input, runTransaction: harness.runTenantTransaction });
  return { input, inspect: (run = textTimestampRunner()) => run(input.tenantId, (tx) => inspectLegacyImport(tx, input, manifest)) };
}

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  for (const name of (await readdir(resolve('src/server/db/migrations')))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
});
afterEach(async () => { await harness?.close(); });

describe('importer typed timestamp equality', () => {
  it.each([
    ['UTC', '2026-08-31 00:00:00.123+00'],
    ['Asia/Seoul', '2026-08-31 09:00:00.123+09'],
    ['Asia/Kolkata', '2026-08-31 05:30:00.123+05:30'],
    ['Asia/Kathmandu', '2026-08-31 05:45:00.123+05:45'],
    ['America/St_Johns', '2026-08-30 21:30:00.123-02:30'],
    ['Etc/GMT+12', '2026-08-30 12:00:00.123-12'],
    ['Etc/GMT-14', '2026-08-31 14:00:00.123+14'],
  ])(
    'accepts exact instants through PostgreSQL text in %s, in both inspection and retry', async (timeZone, expectedText) => {
      const { input, inspect } = await importedFixture();
      const original = canonicalJson(input.manifest);
      const before = await retainedEvidence();
      const run = textTimestampRunner(timeZone);
      const readback = await run(input.tenantId, (tx) => tx.execute(sql`SELECT starts_at,pg_typeof(starts_at)::text AS sql_type FROM promotions`));
      expect(readback.rows).toEqual([{ starts_at: expectedText, sql_type: 'timestamp with time zone' }]);
      expect(readback.rows[0].starts_at).not.toBe(input.manifest.records.promotions[0].startsAt);
      expect(await inspect(run)).toEqual([]);
      await expect(importLegacyNormalizationManifest({ ...input, runTransaction: run })).resolves.toMatchObject({ status: 'IMPORTING' });
      expect(await inspect(harness.runTenantTransaction)).toEqual([]); // Date-returning callers remain supported.
      expect(await retainedEvidence()).toBe(before);
      expect(canonicalJson(input.manifest)).toBe(original);
    },
  );

  it.each([
    ['UTC', '0.000001 second', '2026-08-31 00:00:00.123001+00'],
    ['Asia/Kathmandu', '0.000999 second', '2026-08-31 05:45:00.123999+05:45'],
    ['America/St_Johns', '-0.000001 second', '2026-08-30 21:30:00.122999-02:30'],
    ['UTC', '0.001 second', '2026-08-31 00:00:00.124+00'],
    ['UTC', '1 second', '2026-08-31 00:00:01.123+00'],
  ])(
    'rejects a changed timestamp in %s, including six-digit precision: %s', async (timeZone, delta, expectedText) => {
      const { input, inspect } = await importedFixture();
      const before = await retainedEvidence();
      const original = canonicalJson(input.manifest);
      await harness.database.query('UPDATE promotions SET starts_at=starts_at+$1::interval', [delta]);
      const run = textTimestampRunner(timeZone);
      const readback = () => run(input.tenantId, (tx) => tx.execute(sql`SELECT starts_at FROM promotions`));
      expect((await readback()).rows).toEqual([{ starts_at: expectedText }]);
      expect(await inspect(run)).toEqual([{ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'promotions\0PROMO1' }]);
      await expect(importLegacyNormalizationManifest({ ...input, runTransaction: run })).rejects.toThrow('Target conflict for promotions.');
      expect((await readback()).rows).toEqual([{ starts_at: expectedText }]);
      expect(await retainedEvidence()).toBe(before);
      expect(canonicalJson(input.manifest)).toBe(original);
    },
  );

  it('rejects infinity rather than treating it as an instant', async () => {
    const { input, inspect } = await importedFixture();
    await harness.database.exec("UPDATE promotions SET ends_at='infinity'::timestamptz");
    expect(await inspect()).toEqual([{ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'promotions\0PROMO1' }]);
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: textTimestampRunner() })).rejects.toThrow('Target conflict for promotions.');
  });

  it.each(SAME_INSTANT_TEXT)('keeps non-timestamp product text byte-exact: %s', async (changed) => {
    const { input, inspect } = await importedFixture();
    const before = await retainedEvidence();
    const original = canonicalJson(input.manifest);
    expect(input.manifest.records.products[0].name).toBe(AT);
    expect(await inspect()).toEqual([]);
    await harness.database.query('UPDATE products SET name=$1', [changed]);
    expect(await inspect()).toEqual([{ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'products\0P1' }]);
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: textTimestampRunner() })).rejects.toThrow('Target conflict for products.');
    expect((await harness.database.query('SELECT name FROM products')).rows).toEqual([{ name: changed }]);
    expect(await retainedEvidence()).toBe(before);
    expect(canonicalJson(input.manifest)).toBe(original);
  });

  it.each(SAME_INSTANT_TEXT)('keeps timestamp strings inside JSON byte-exact: %s', async (changed) => {
    const { input, inspect } = await importedFixture();
    const before = await retainedEvidence();
    const original = canonicalJson(input.manifest);
    const schedule = input.manifest.records.tasks[0].currentSchedule as Record<string, unknown>;
    expect(schedule.effectiveFrom).toBe(AT);
    expect(await inspect()).toEqual([]);
    await harness.database.query("UPDATE tasks SET current_schedule=jsonb_set(current_schedule,'{effectiveFrom}',to_jsonb($1::text))", [changed]);
    expect(await inspect()).toEqual([{ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'tasks\0TI1' }]);
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: textTimestampRunner() })).rejects.toThrow('Target conflict for tasks.');
    expect((await harness.database.query('SELECT current_schedule FROM tasks')).rows)
      .toEqual([{ current_schedule: { ...schedule, effectiveFrom: changed } }]);
    expect(await retainedEvidence()).toBe(before);
    expect(canonicalJson(input.manifest)).toBe(original);
  });

  it.each([
    '2026-02-29T00:00:00.123Z', // Non-leap year, not silently March 1.
    '2026-04-31T00:00:00.123Z',
    '2026-13-01T00:00:00.123Z',
    '2026-08-31T24:00:00.123Z',
    '2026-08-31T00:00:00.123',
    '2026-08-31 00:00:00.123',
    '2026-08-31T00:00:00.123+25:00',
  ])('refuses noncanonical manifest instants without changing persisted evidence: %s', async (invalid) => {
    const { input, inspect } = await importedFixture();
    const before = await retainedEvidence();
    const original = canonicalJson(input.manifest);
    // Adversarial caller input only: never change stored source/snapshot bytes.
    // Rehash so a stale digest is not the sole reason for rejecting this input.
    const draft = structuredClone(input.manifest);
    const rows = draft.records.promotions as Record<string, unknown>[];
    rows[0].startsAt = invalid;
    const unsigned: Record<string, unknown> = { ...draft };
    delete unsigned.manifestDigest;
    const manifest = { ...draft, manifestDigest: sha256(canonicalJson(unsigned)) };
    const run = textTimestampRunner();
    expect(await run(input.tenantId, (tx) => inspectLegacyImport(tx, { ...input, manifest }, manifest)))
      .toEqual([{ category: 'INTEGRITY', code: 'INVALID_MANIFEST' }]);
    await expect(importLegacyNormalizationManifest({ ...input, manifest, runTransaction: run })).rejects.toThrow();
    expect(await inspect(run)).toEqual([]);
    expect(await retainedEvidence()).toBe(before);
    expect(canonicalJson(input.manifest)).toBe(original);
  });

  it('lets the real typed database reject invalid calendar/offset text, not a fabricated returned row', async () => {
    const { input, inspect } = await importedFixture();
    const before = await retainedEvidence();
    const target = await harness.database.query('SELECT xmin::text,starts_at::text FROM promotions');
    // Impossible persisted timestamptz values are tested at the SQL type gate;
    // they cannot honestly be returned by this driver to the comparator.
    for (const invalid of ['2026-02-29 00:00:00+00', '2026-04-31 00:00:00+00',
      '2026-13-01 00:00:00+00', '2026-08-31 00:00:00+25:00']) {
      await expect(harness.database.query('UPDATE promotions SET starts_at=$1::timestamptz', [invalid]))
        .rejects.toMatchObject({ code: expect.stringMatching(/^2200[789]$/) });
      expect((await harness.database.query('SELECT xmin::text,starts_at::text FROM promotions')).rows).toEqual(target.rows);
    }
    // PostgreSQL DOES accept zoneless SQL input using the session timezone, but
    // returns an explicit offset. This is NOT canonical manifest admission.
    const run = textTimestampRunner('Asia/Kathmandu');
    const implicit = await run(input.tenantId, (tx) => tx.execute(sql`SELECT ${'2026-08-31 00:00:00.123'}::timestamptz AS instant`));
    expect(implicit.rows).toEqual([{ instant: '2026-08-31 00:00:00.123+05:45' }]);
    expect(await inspect(run)).toEqual([]);
    expect(await retainedEvidence()).toBe(before);
  });

  it('fails closed on native non-ISO DateStyle instead of widening parsing', async () => {
    const { input, inspect } = await importedFixture();
    const before = await retainedEvidence();
    const run: TenantImportTransactionRunner = (tenant, work) => textTimestampRunner()(tenant, async (tx) => {
      await tx.execute(sql`SELECT set_config('DateStyle','German, DMY',true)`);
      return work(tx);
    });
    const readback = await run(input.tenantId, (tx) => tx.execute(sql`SELECT starts_at FROM promotions`));
    expect(readback.rows).toEqual([{ starts_at: '31.08.2026 00:00:00.123 UTC' }]);
    expect(await inspect(run)).toContainEqual({ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'promotions\0PROMO1' });
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: run })).rejects.toThrow('Target conflict for promotions.');
    expect(await inspect()).toEqual([]); // SET LOCAL must not leak to later calls.
    expect(await retainedEvidence()).toBe(before);
  });

  it('does not equate a nullable timestamp with a new instant', async () => {
    const { input, inspect } = await importedFixture();
    await harness.database.query('UPDATE tasks SET available_until=$1::timestamptz', ['2026-09-02T00:00:00.000Z']);
    expect(await inspect()).toEqual([{ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: 'tasks\0TI1' }]);
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: textTimestampRunner() })).rejects.toThrow('Target conflict for tasks.');
  });
});
