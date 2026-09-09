// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { TransactionPool, TransactionConnection } from '@/server/db/transaction';
import type { BridgeReservation } from './registeredBridgeProducer';

vi.mock('server-only', () => ({}));
let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  for (const file of (await readdir('src/server/db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/server/db/migrations/${file}`, 'utf8'));
  }
  await db.exec(`CREATE ROLE "legacy-1" NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE "legacy-2" NOSUPERUSER NOBYPASSRLS;`);
}, 60_000);
afterAll(async () => { await db?.close(); });

it('ships a forced-RLS deployment-bound permanent producer replay relation', async () => {
  const result = await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname = 'migration_bridge_producer_reservations'`);
  expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
});

it('mirrors exact SQL column domains, defaults, PK, unique and CHECK expressions in Drizzle', async () => {
  const schema = await import('@/server/db/schema') as Record<string, unknown>;
  expect(schema.migrationBridgeProducerReservations).toBeDefined();
  const config = getTableConfig(schema.migrationBridgeProducerReservations as PgTable);
  const dialect = new PgDialect();
  const columns = config.columns.map(c => `"${c.name}" ${c.getSQLType()}${c.notNull ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${dialect.sqlToQuery(c.default as Parameters<PgDialect['sqlToQuery']>[0]).sql}` : ''}`);
  const constraints = [
    ...config.primaryKeys.map(k => `CONSTRAINT "${k.getName()}" PRIMARY KEY (${k.columns.map(c => `"${c.name}"`).join(',')})`),
    ...config.uniqueConstraints.map(k => `CONSTRAINT "${k.getName()}" UNIQUE (${k.columns.map(c => `"${c.name}"`).join(',')})`),
    ...config.checks.map(k => `CONSTRAINT "${k.name}" CHECK (${dialect.sqlToQuery(k.value).sql.replaceAll('"migration_bridge_producer_reservations".', '')})`),
  ];
  await db.exec(`CREATE SCHEMA bridge_parity; CREATE TABLE bridge_parity.migration_bridge_producer_reservations (${[...columns, ...constraints].join(',')})`);
  const domains = (schemaName: string) => db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='migration_bridge_producer_reservations' ORDER BY column_name`, [schemaName]);
  expect((await domains('bridge_parity')).rows).toEqual((await domains('public')).rows);
  const checks = (schemaName: string) => db.query(`SELECT conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u','c','f') ORDER BY conname`, [`${schemaName}.migration_bridge_producer_reservations`]);
  expect((await checks('bridge_parity')).rows).toEqual((await checks('public')).rows);
});

export function reservation(): BridgeReservation {
  const issuedAt = Date.now();
  return { deploymentId: 'legacy-1', registrationDigest: 'c'.repeat(64), ceremonyId: randomUUID(),
    challengeId: randomUUID(), nonceDigest: randomUUID().replaceAll('-', '').repeat(2),
    requestDigest: 'd'.repeat(64), issuedAt, expiresAt: issuedAt + 60_000 };
}

it('acknowledges exact persisted SQL rows; rejects independent global nonce/challenge replays', async () => {
  const { createBridgeProducerReservations } = await import('./bridgeProducerReservations');
  await db.exec('GRANT SELECT, INSERT ON migration_bridge_producer_reservations TO "legacy-1", "legacy-2"');
  const pool = localPool(); const reserve = createBridgeProducerReservations(pool, 'legacy-1');
  const row = reservation();
  expect(await reserve.reserveAndCommit(row)).toEqual(row);
  await expect(reserve.reserveAndCommit({ ...row, nonceDigest: 'e'.repeat(64) })).rejects.toThrow();
  await expect(reserve.reserveAndCommit({ ...row, challengeId: randomUUID() })).rejects.toThrow();
  const other = createBridgeProducerReservations(localPool('legacy-2'), 'legacy-2');
  await expect(other.reserveAndCommit({ ...row, deploymentId: 'legacy-2', challengeId: randomUUID() })).rejects.toThrow();
  await db.exec('SET ROLE "legacy-2"');
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations')).rows).toEqual([]);
  await db.exec('RESET ROLE');
});

function localPool(role = 'legacy-1', fault?: 'ack' | 'readback' | 'clock' | 'insert' | 'isolation' | 'begin') {
  const releases: (boolean | Error | undefined)[] = []; let commits = 0; let connects = 0;
  const pool: TransactionPool = { async connect() {
    connects++;
    return { async query(text: string, values?: unknown[]) {
      if (text.startsWith('BEGIN')) { await db.exec(text); await db.exec(`SET LOCAL ROLE "${role}"`); if (fault === 'begin') throw Error('BEGIN acknowledgement lost'); return { rows: [], rowCount: null }; }
      if (fault === 'insert' && text.startsWith('INSERT')) throw Error('DB unavailable');
      const result = await db.query(text, values);
      if (text === 'COMMIT') { commits++; if (fault === 'ack') throw Error('lost COMMIT acknowledgement'); }
      if (fault === 'readback' && text.startsWith('SELECT nonce_digest')) return { rows: [] };
      if (fault === 'clock' && text.includes('clock_timestamp')) return { rows: [{ now_ms: '9007199254740991' }] };
      if (fault === 'isolation' && text.startsWith('SHOW')) return { rows: [{ transaction_isolation: 'repeatable read' }] };
      return result;
    }, release(error) { releases.push(error); } } as TransactionConnection;
  } };
  return { ...pool, releases, get commits() { return commits; }, get connects() { return connects; } };
}

it.each(['ack', 'readback', 'clock', 'insert', 'isolation'] as const)('refuses %s without retry and preserves only acknowledged/uncertain commits', async fault => {
  const { createBridgeProducerReservations } = await import('./bridgeProducerReservations');
  const pool = localPool('legacy-1', fault); const row = reservation();
  await expect(createBridgeProducerReservations(pool, 'legacy-1').reserveAndCommit(row)).rejects.toThrow();
  expect(pool.connects).toBe(1);
  expect(pool.commits).toBe(fault === 'ack' ? 1 : 0);
  expect(pool.releases).toEqual([fault === 'ack' ? true : undefined]);
  const stored = await db.query('SELECT nonce_digest FROM migration_bridge_producer_reservations WHERE nonce_digest=$1', [row.nonceDigest]);
  expect(stored.rows).toHaveLength(fault === 'ack' ? 1 : 0);
});

it('discards an uncertain BEGIN connection rather than returning an open transaction to the pool', async () => {
  const { createBridgeProducerReservations } = await import('./bridgeProducerReservations');
  const pool = localPool('legacy-1', 'begin');
  await expect(createBridgeProducerReservations(pool, 'legacy-1').reserveAndCommit(reservation())).rejects.toThrow();
  await db.exec('ROLLBACK'); // PGlite transport simulates physical close explicitly.
  expect(pool.releases).toEqual([true]);
});

it('SQL denies foreign deployment insert, immutable owner mutation and runtime TRUNCATE', async () => {
  const { createBridgeProducerReservations } = await import('./bridgeProducerReservations');
  const row = reservation(); await createBridgeProducerReservations(localPool(), 'legacy-1').reserveAndCommit(row);
  await expect(createBridgeProducerReservations(localPool(), 'legacy-2').reserveAndCommit({ ...reservation(), deploymentId: 'legacy-2' })).rejects.toThrow();
  for (const sql of ['UPDATE migration_bridge_producer_reservations SET request_digest=request_digest',
    'DELETE FROM migration_bridge_producer_reservations', 'TRUNCATE migration_bridge_producer_reservations']) {
    await expect(db.exec(sql)).rejects.toThrow();
  }
  await db.exec('SET ROLE "legacy-1"');
  await expect(db.exec('TRUNCATE migration_bridge_producer_reservations')).rejects.toThrow();
  await db.exec('RESET ROLE');
});
