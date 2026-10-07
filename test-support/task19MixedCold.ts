import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { ExecSocket } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson } from '@/server/migration/validators';
import { TENANT, JOB, type MutablePin } from './task19MutableFixture';

export type MixedColdRequest = {
  source: MutablePin; destination: MutablePin; ownerId: string; tombstone: boolean;
  phase: 'produce' | 'import' | 'retry'; binding?: LocalCandidateBinding;
};
// Independent inventory, intentionally NOT imported from the runtime catalog.
export const CATEGORIES = ['students','accounts','products','settings','tasks','task_allowed_students',
  'promotions','promotion_products','transactions','transaction_items','adjustments','task_assignments',
  'task_completions','legacy_operation_bindings','padlet_evidence_claims','padlet_claim_digest_tombstones'];
export const REPORTS = [...CATEGORIES,'SOURCE_RECORDS','MAPPINGS','CONTRIBUTORS','DELTA_ENTRIES','CLAIM_RECAPTURES'];
export const APPLICATION = 'class-store-task19-mixed-cold';

/** Test-only borrowed connection: live allocator retains exclusive ownership and
 * cleanup. No orphan adoption, URL, operational source or connection fallback. */
export function coldConnections(request: MixedColdRequest) {
  const scratch = mkdtempSync(join(tmpdir(), 'task19-mixed-cold-'));
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, DOCKER_CONFIG: scratch, LANG: 'C', NODE_ENV: 'test' };
  const pools: Pool[] = [], streams = new Set<ExecSocket>();
  const backends: { databaseId: string; user: string; pid: number; started: string }[] = [];
  const connect = async (pin: MutablePin, role: 'SOURCE' | 'DESTINATION') => {
    if (!/^[0-9a-f]{64}$/.test(pin.containerId) || !/^sha256:[0-9a-f]{64}$/.test(pin.imageId)
      || !/^[0-9a-f-]{36}$/.test(pin.databaseId) || !/^[0-9]+$/.test(pin.systemIdentifier)) throw new Error('Invalid owned pin');
    const [actual] = JSON.parse(execFileSync('docker', ['--host','unix:///var/run/docker.sock','inspect',pin.containerId],
      { env: environment, encoding: 'utf8', timeout: 30_000 }));
    const config = actual.HostConfig, mounts = ['/test-bin','/tmp','/var/lib/postgresql/data','/var/run/postgresql'];
    if (actual.Id !== pin.containerId || actual.Image !== pin.imageId || actual.State.Running !== true
      || actual.Config.Labels?.['io.class-store.synthetic-pg-owner'] !== pin.databaseId || actual.Config.User !== 'postgres'
      || config.NetworkMode !== 'none' || Object.keys(config.PortBindings ?? {}).length || config.PublishAllPorts
      || config.Binds?.length || config.VolumesFrom?.length || config.Privileged || !config.ReadonlyRootfs
      || !config.CapDrop?.includes('ALL') || !config.SecurityOpt?.includes('no-new-privileges')
      || JSON.stringify(Object.keys(config.Tmpfs).sort()) !== JSON.stringify(mounts)
      || actual.Mounts.some((m: {Type: string; Destination: string}) => m.Type !== 'tmpfs' || !mounts.includes(m.Destination))) {
      throw new Error('Owned child topology differs');
    }
    const pool = async (user: string) => {
      const p = new Pool({ user, database: 'postgres', host: '/var/run/postgresql', port: 5432,
        password: () => '', ssl: false, sslnegotiation: 'postgres', options: '-c timezone=UTC', client_encoding: 'UTF8',
        application_name: APPLICATION, connectionTimeoutMillis: 15_000, statement_timeout: 15_000, query_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000, max: 1, idleTimeoutMillis: 0, stream: () => {
          const stream = new ExecSocket(pin.containerId, environment);
          streams.add(stream); stream.once('close', () => streams.delete(stream)); return stream;
        } });
      pools.push(p); p.on('error', () => {});
      const row = (await p.query("SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
      backends.push({databaseId:pin.databaseId,user,...row});
      return p;
    };
    const owner = await pool('postgres'), runtime = await pool('app_runtime');
    expect((await owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows).toEqual([{id:pin.systemIdentifier}]);
    expect((await owner.query('SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database')).rows)
      .toEqual([{database_id:pin.databaseId,owner_id:request.ownerId,role,tenant_id:TENANT,job_id:JOB}]);
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{rolsuper:false,rolbypassrls:false}]);
    return { owner, runtime, lease: { kind:'SYNTHETIC_DISPOSABLE' as const, databaseId:pin.databaseId,ownerId:request.ownerId,
      queryOwner:(text: string,values?: unknown[]) => owner.query(text,values),runTransaction:createTenantTransactionRunner({pool:runtime}) } };
  };
  return { connect, backends, close: async () => {
    try { await Promise.all(pools.map(pool => pool.end())); }
    finally { for (const stream of streams) stream.destroy(); rmSync(scratch,{recursive:true,force:false}); }
  } };
}
export type ColdDatabase = Awaited<ReturnType<ReturnType<typeof coldConnections>['connect']>>;
async function tables(db: Pick<ColdDatabase,'owner'>) {
  return (await db.owner.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
    .map(row => row.tablename as string);
}
export async function witness(db: Pick<ColdDatabase,'owner'>, physical = true) {
  // Every owned public table, plus tuple identity over the measured interval.
  const rows = (await db.owner.query((await tables(db)).map(table => `SELECT '${table}' AS name,
    coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t)${physical ? ", 'xmin',t.xmin::text,'ctid',t.ctid::text" : ''})
    ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`).join(' UNION ALL '))).rows;
  // PostgreSQL Parallel Append need not preserve UNION ALL branch order.
  return canonicalJson(rows.sort((a,b) => a.name.localeCompare(b.name)));
}
export async function denyWrites(db: Pick<ColdDatabase,'owner'>) {
  await db.owner.query("CREATE FUNCTION task19_mixed_no_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Cold mixed retry attempted a write'; END $$");
  for (const table of await tables(db)) await db.owner.query(`CREATE TRIGGER task19_mixed_no_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION task19_mixed_no_write()`);
}
export async function clearWriteGuard(db: Pick<ColdDatabase,'owner'>) {
  for (const table of await tables(db)) await db.owner.query(`DROP TRIGGER task19_mixed_no_write ON ${table}`);
  await db.owner.query('DROP FUNCTION task19_mixed_no_write()');
}
