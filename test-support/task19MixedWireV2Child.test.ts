// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { coldConnections, denyWrites, clearWriteGuard, APPLICATION } from './task19MixedCold';
import { TENANT, JOB } from './task19MutableFixture';
import { wireSave, type WireRequest } from './task19MixedWireV2';
import { CommitWireSocket } from './task19CommitWire';
import { postcommitReplay, postcommitDomain, postcommitState } from './task19MixedPostcommitV2Checks';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.COMMIT_WIRE_REQUEST;
if (path && !/^\.task19-mixed-wire-v2\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid owned request');
it.skipIf(!path)('mixed V2 real COMMIT wire cold child', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: WireRequest = JSON.parse(readFileSync(path!, 'utf8')), id = process.env.COMMIT_WIRE_ID!;
  const connections = coldConnections({ ...q, phase: 'import' });
  let result: Record<string, unknown> = { ok: false, pid: process.pid }, wirePool: Pool | undefined;
  try {
    // Validate actual physical topology and SQL ownership before constructing the
    // alternate transport. The parent allocator remains live/exclusive.
    const source = await connections.connect(q.source, 'SOURCE'), destination = await connections.connect(q.destination, 'DESTINATION');
    const state = () => postcommitState(source, destination), before = await state();
    if (q.phase === 'crash') {
      const reconstructed = await reconstructOwnedMixedSourceV2(q.pin, q.binding, source.lease);
      expect(reconstructed.disposition).toBe('VERIFIED_EXISTING');
      const streams: CommitWireSocket[] = [];
      wirePool = new Pool({ user: 'app_runtime', database: 'postgres', host: '/var/run/postgresql', port: 5432,
        password: () => '', ssl: false, sslnegotiation: 'postgres', options: '-c timezone=UTC', client_encoding: 'UTF8',
        application_name: APPLICATION, connectionTimeoutMillis: 15_000, statement_timeout: 15_000, query_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000, max: 1, idleTimeoutMillis: 0, stream: () => {
          const stream = new CommitWireSocket(q.destination.containerId,
            { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' });
          streams.push(stream); return stream;
        } });
      wirePool.on('error', () => {});
      const native = (await wirePool.query("SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
      connections.backends.push({ databaseId: q.destination.databaseId, user: 'app_runtime', ...native } as (typeof connections.backends)[number]);
      const run = createTenantTransactionRunner({ pool: wirePool });
      let sourceBackend: unknown, destinationBackend: unknown, callbackResult: unknown;
      let driverSettled = false;
      const sourceLease = { ...source.lease, runTransaction: (async (tenant, callback) => source.lease.runTransaction(tenant, async tx => {
        sourceBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0];
        return callback(tx);
      })) as typeof source.lease.runTransaction };
      const destinationLease = { ...destination.lease, runTransaction: (async (tenant, callback) => {
        const pending = run(tenant, async tx => {
          callbackResult = await callback(tx);
          destinationBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid`)).rows[0];
          expect(streams).toHaveLength(1);
          streams[0].arm(wire => {
            expect(driverSettled).toBe(false);
            wireSave(id, 'barrier', { pid: process.pid, before, sourceBackend, destinationBackend, callbackResult,
              backends: connections.backends, wire, driverSettled, driverCommitAcknowledged: false, callerAcknowledged: false });
          });
          return callbackResult;
        });
        void pending.then(() => { driverSettled = true; wireSave(id, 'driver-settled', { resolved: true }); },
          error => { driverSettled = true; wireSave(id, 'driver-settled', { resolved: false, error: (error as Error).message }); });
        return pending;
      }) as typeof destination.lease.runTransaction };
      const materialized = await materializeLocalCandidate(q.binding,
        createOwnedLocalMaterializationRunner(TENANT, JOB, sourceLease, destinationLease));
      wireSave(id, 'caller-ack', { materialized });
      throw new Error('Wire child escaped controlled process death');
    } else {
      await denyWrites(source); await denyWrites(destination);
      // The existing materializer also supports first imports. This test-only
      // uncertain-COMMIT resolver deliberately never invokes that branch.
      const receipt = (await destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
      const outcome = await (async () => {
        if (receipt.length !== 1) throw new Error('UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT');
        return postcommitReplay(q, source, destination);
      })().then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error: (error as Error).message }));
      const after = await state(); expect(after).toEqual(before);
      const domain = outcome.accepted ? await postcommitDomain(q, source, destination, outcome.value.materialized) : null;
      if (q.outcome === 'commit' && q.expectedReplay !== 'refuse') expect(outcome.accepted).toBe(true);
      else expect(outcome).toEqual({ accepted: false, error: 'UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT' });
      await clearWriteGuard(source); await clearWriteGuard(destination);
      result = { ...result, ok: true, before, after, receipt, outcome, domain, noDmlReplay: true };
    }
  } catch (error) {
    result = { ok: false, pid: process.pid, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
  } finally { await wirePool?.end(); await connections.close(); }
  wireSave(id, 'result', { ...result, backends: connections.backends, poolsClosed: true });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
