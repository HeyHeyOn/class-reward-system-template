// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { ExecSocket } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import type { OwnedSyntheticDatabaseLease } from '@/server/migration/localMaterializationRunner';
import type { MutableChildRequest, MutablePin } from './task19MutableFixture';
vi.mock('server-only', () => ({}));

const path = process.env.TASK19_MUTABLE_REQUEST;
if (path && !/^\.task19-mutable-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid Task19 child path');
// A launcher-owned synthetic fixture pin, not a network/request or restore API.
// The allocator stays alive and exclusively owns teardown; this child only opens
// new pools against its two exact, independently pinned disposable container IDs.
it.skipIf(!path)('Task19 fresh-process mutable import or retry', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG opt-in required');
  const request = JSON.parse(readFileSync(path!, 'utf8')) as MutableChildRequest;
  const scratch = mkdtempSync(join(tmpdir(), 'task19-cold-pools-'));
  const pools: Pool[] = [], streams = new Set<ExecSocket>();
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: scratch, DOCKER_CONFIG: scratch, LANG: 'C', NODE_ENV: 'test' };
  const result: Record<string, unknown> = { pid: process.pid, outcome: 'SETUP_ERROR' };
  const connect = async (pin: MutablePin, role: 'SOURCE' | 'DESTINATION'): Promise<OwnedSyntheticDatabaseLease> => {
    if (!/^[0-9a-f]{64}$/.test(pin.containerId) || !/^sha256:[0-9a-f]{64}$/.test(pin.imageId)
      || !/^[0-9a-f-]{36}$/.test(pin.databaseId) || !/^[0-9]+$/.test(pin.systemIdentifier)) throw new Error('Invalid owned pin');
    const [actual] = JSON.parse(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', pin.containerId],
      { env: environment, encoding: 'utf8', timeout: 30_000 }));
    const config = actual.HostConfig;
    const mounts = ['/test-bin','/tmp','/var/lib/postgresql/data','/var/run/postgresql'];
    if (actual.Id !== pin.containerId || actual.Image !== pin.imageId || actual.State.Running !== true
      || actual.Config.Labels?.['io.class-store.synthetic-pg-owner'] !== pin.databaseId || actual.Config.User !== 'postgres'
      || config.NetworkMode !== 'none' || Object.keys(config.PortBindings ?? {}).length || config.PublishAllPorts
      || config.Binds?.length || config.VolumesFrom?.length || config.Privileged || !config.ReadonlyRootfs
      || !config.CapDrop?.includes('ALL') || !config.SecurityOpt?.includes('no-new-privileges')
      || JSON.stringify(Object.keys(config.Tmpfs).sort()) !== JSON.stringify(mounts)
      || actual.Mounts.some((m: {Type: string; Destination: string}) => m.Type !== 'tmpfs' || !mounts.includes(m.Destination))) {
      throw new Error('Owned child topology differs');
    }
    const pool = (user: string) => {
      const p = new Pool({ user, database: 'postgres', host: '/var/run/postgresql', port: 5432,
        password: () => '', ssl: false, sslnegotiation: 'postgres', options: '-c timezone=UTC', client_encoding: 'UTF8',
        application_name: 'class-store-task19-cold-mutable-test', connectionTimeoutMillis: 15_000,
        statement_timeout: 15_000, query_timeout: 20_000, idle_in_transaction_session_timeout: 30_000,
        max: 2, idleTimeoutMillis: 5_000, stream: () => {
          const stream = new ExecSocket(pin.containerId, environment);
          streams.add(stream); stream.once('close', () => streams.delete(stream)); return stream;
        } });
      pools.push(p); p.on('error', () => {}); return p;
    };
    const owner = pool('postgres'), runtime = pool('app_runtime');
    expect((await owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows)
      .toEqual([{ id: pin.systemIdentifier }]);
    expect((await owner.query('SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database')).rows)
      .toEqual([{ database_id: pin.databaseId, owner_id: request.ownerId, role,
        tenant_id: request.binding.tenantId, job_id: request.binding.migrationJobId }]);
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    return { kind: 'SYNTHETIC_DISPOSABLE', databaseId: pin.databaseId, ownerId: request.ownerId,
      queryOwner: (text, values) => owner.query(text, values), runTransaction: createTenantTransactionRunner({ pool: runtime }) };
  };
  try {
    const source = await connect(request.source, 'SOURCE'), destination = await connect(request.destination, 'DESTINATION');
    const run = createOwnedLocalMaterializationRunner(request.binding.tenantId, request.binding.migrationJobId, source, destination);
    // Only the actual application refusal is classified as a negative acceptance.
    // Container, SQL pool or fixture setup failures cannot masquerade as REFUSED.
    try {
      result.receipt = await materializeLocalCandidate(request.binding, run);
      result.outcome = 'MATERIALIZED';
    } catch (error) {
      expect(error).toEqual(new Error('Local candidate domain materialization refused.'));
      result.outcome = 'REFUSED';
    }
  } finally {
    try { await Promise.all(pools.map(pool => pool.end())); }
    finally {
      for (const stream of streams) stream.destroy();
      rmSync(scratch, { recursive: true, force: false });
      result.poolsClosed = true;
      writeFileSync(path!.replace('-request.json', '-result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    }
  }
  expect(result.outcome).not.toBe('SETUP_ERROR');
}, 120_000);
