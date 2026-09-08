import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { FinalBridgeChallenge } from '../legacyMigrationBridge';

vi.mock('server-only', () => ({}));
let h: PgliteDatabaseHarness;
const USER = '20000000-0000-4000-8000-000000000019';
const JOB = '40000000-0000-4000-8000-000000000019';
const CHALLENGE = '30000000-0000-4000-8000-000000000019';
const HASH = 'a'.repeat(64);
beforeEach(async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(dir)).filter((n) => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) {
    await h.database.exec(await readFile(resolve(dir, name), 'utf8'));
  }
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')", [USER]);
  for (const tenant of [h.tenantOneId, h.tenantTwoId]) {
    await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,source_fingerprint) VALUES($1,$2,'READY',$3)", [tenant, JOB, HASH]);
    await h.database.query("INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint) VALUES($1,$2,'sheet','GOOGLE_SHEETS',$3,$4)", [tenant, JOB, `sheet-${tenant}`, HASH]);
  }
});
afterEach(async () => { await h?.close(); });
const binding = (tenantId = h.tenantOneId): FinalBridgeChallenge => ({
  purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE', challengeId: CHALLENGE, tenantId, migrationJobId: JOB,
  expectedStatus: 'READY', expectedStateVersion: '1', sourceId: 'sheet', externalSourceId: `sheet-${tenantId}`,
  sourceFingerprint: HASH, deploymentId: 'legacy-1', actorUserId: USER, actorSubject: 'owner', issuedAt: 1000, expiresAt: 61000,
});
async function grant() {
  await h.database.exec('GRANT SELECT, INSERT ON migration_bridge_challenges, migration_bridge_consumptions TO app_runtime');
}
async function append(b = binding()) {
  const { appendBridgeChallenge } = await import('./bridgeReplay');
  return h.runTenantTransaction(b.tenantId, (tx) => appendBridgeChallenge(tx, b));
}
async function consume(b = binding(), nonceDigest = HASH) {
  const { consumeBridgeChallenge } = await import('./bridgeReplay');
  return h.runTenantTransaction(b.tenantId, (tx) => consumeBridgeChallenge(tx, b, nonceDigest));
}

describe('separate final bridge challenge and global nonce storage', () => {
  it('has distinct relations rather than repurposing receipt-FK replay storage', async () => {
    const { rows } = await h.database.query("SELECT to_regclass('migration_bridge_challenges') AS challenges, to_regclass('migration_bridge_consumptions') AS consumptions");
    expect(rows[0]).toEqual({ challenges: 'migration_bridge_challenges', consumptions: 'migration_bridge_consumptions' });
  });
  it.each(['tenantId', 'challengeId', 'migrationJobId', 'sourceId', 'actorUserId', 'purpose'])('rejects JSON null duplicated binding %s in SQL', async (key) => {
    const b = binding();
    await expect(h.database.query(`INSERT INTO migration_bridge_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [b.tenantId,b.challengeId,b.migrationJobId,b.sourceId,b.actorUserId,
      JSON.stringify({ ...b, [key]: null })])).rejects.toThrow('check constraint');
  });
  it('matches ORM types/nullability, keys, FK actions and parsed CHECK expressions to production DDL', async () => {
    const schema = await import('@/server/db/schema');
    const { getTableConfig, PgDialect } = await import('drizzle-orm/pg-core');
    const { getTableName } = await import('drizzle-orm');
    for (const [name, table] of Object.entries({ migration_bridge_challenges: schema.migrationBridgeChallenges,
      migration_bridge_consumptions: schema.migrationBridgeConsumptions })) {
      expect(table).toBeDefined();
      const config = getTableConfig(table);
      const { rows: columns } = await h.database.query(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required
        FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [name]);
      expect(config.columns.map((c) => ({ name: c.name, type: c.getSQLType(), required: c.notNull }))).toEqual(columns);
      const { rows: names } = await h.database.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('c','f','p','u') ORDER BY conname", [name]);
      expect([...config.checks.map((c) => c.name), ...config.primaryKeys.map((c) => c.getName()),
        ...config.uniqueConstraints.map((c) => c.name), ...config.foreignKeys.map((c) => c.getName())].sort()).toEqual(names.map((r) => r.conname));
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const { rows } = await h.database.query<{ definition: string }>('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2', [name, fk.getName()]);
        expect(rows[0].definition).toBe(`FOREIGN KEY (${ref.columns.map((c) => c.name).join(', ')}) REFERENCES ${getTableName(ref.foreignTable)}(${ref.foreignColumns.map((c) => c.name).join(', ')})`);
        expect(fk.onDelete ?? 'no action').toBe('no action'); expect(fk.onUpdate ?? 'no action').toBe('no action');
      }
      for (const check of config.checks) {
        const expression = new PgDialect().sqlToQuery(check.value).sql;
        await h.database.exec(`ALTER TABLE ${name} ADD CONSTRAINT orm_probe CHECK (${expression}) NOT VALID`);
        const { rows } = await h.database.query<{ expression: string }>(`SELECT pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
          WHERE conrelid=$1::regclass AND conname IN ($2,'orm_probe') ORDER BY conname`, [name, check.name]);
        expect(rows).toHaveLength(2); expect(rows[0].expression).toBe(rows[1].expression);
        await h.database.exec(`ALTER TABLE ${name} DROP CONSTRAINT orm_probe`);
      }
    }
  });
  it('atomically consumes each challenge and global nonce once across independent instances and tenant RLS', async () => {
    await grant();
    const one = binding(); const two = { ...binding(h.tenantTwoId), challengeId: '30000000-0000-4000-8000-000000000020' };
    await append(one); await append(two);
    await consume(one);
    await expect(consume(one, 'b'.repeat(64))).rejects.toThrow();
    await expect(consume(two)).rejects.toThrow();
    expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toHaveLength(1);
    expect((await h.database.query('SELECT * FROM migration_authority_replays')).rows).toEqual([]);
  });
  it('forces RLS, hides foreign nonces, forbids runtime update/delete, and protects immutable rows even from owner DML', async () => {
    await grant(); await append(); await consume();
    await h.runTenantTransaction(h.tenantTwoId, async (tx) => {
      expect((await tx.execute(sql`SELECT * FROM migration_bridge_challenges`)).rows).toEqual([]);
      expect((await tx.execute(sql`SELECT * FROM migration_bridge_consumptions`)).rows).toEqual([]);
    });
    for (const table of ['migration_bridge_challenges', 'migration_bridge_consumptions']) {
      for (const statement of [`DELETE FROM ${table}`, `UPDATE ${table} SET tenant_id=tenant_id`]) {
        await expect(h.database.exec(statement)).rejects.toThrow('immutable');
        await expect(h.runTenantTransaction(h.tenantOneId, (tx) => tx.execute(sql.raw(statement)))).rejects.toThrow();
      }
    }
  });
  it.each(['migration_bridge_challenges', 'migration_bridge_consumptions'])('fails closed on suppressed %s insert with exact readback', async (table) => {
    await grant();
    if (table.endsWith('consumptions')) await append();
    await h.database.exec(`CREATE FUNCTION suppress_bridge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_bridge BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_bridge()`);
    await expect(table.endsWith('consumptions') ? consume() : append()).rejects.toThrow();
    expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toEqual([]);
  });
  it('rejects consumption of altered stored bindings or an unknown challenge', async () => {
    await grant(); await append();
    await expect(consume({ ...binding(), actorSubject: 'other' })).rejects.toThrow();
    await expect(consume({ ...binding(), challengeId: '30000000-0000-4000-8000-000000000099' })).rejects.toThrow();
    expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toEqual([]);
  });
});
