// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { coldConnections, denyWrites, clearWriteGuard, APPLICATION } from './task19MixedCold';
import { TENANT, JOB } from './task19MutableFixture';
import { transportSave, transportDirectory, type TransportRequest } from './task19MixedTransportV2';
import { SurvivingTransportSocket } from './task19SurvivingTransport';
import { postcommitReplay, postcommitDomain, postcommitState } from './task19MixedPostcommitV2Checks';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.TRANSPORT_REQUEST;
if (path && !/^\.task19-mixed-transport-v2\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid owned request');
const errorValue = (error: unknown) => error instanceof Error
  ? { message: error.message, stack: error.stack, ...('code' in error ? { code: error.code } : {}) } : { message: String(error) };
const nativeSql = 'SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()';
it.skipIf(!path)('mixed V2 surviving driver native transport close', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: TransportRequest = JSON.parse(readFileSync(path!, 'utf8')), id = process.env.TRANSPORT_ID!;
  let connections = coldConnections({ ...q, phase: 'import' });
  let connectionsOpen = true;
  const closeConnections = async () => {
    if (connectionsOpen) { connectionsOpen = false; await connections.close(); }
  };
  let result: Record<string, unknown> = { ok: false, pid: process.pid }, wirePool: Pool | undefined;
  const backendGroups: (typeof connections.backends)[] = [];
  try {
    const transport: Record<string, unknown> = {};
    if (q.phase === 'crash') {
      const source = await connections.connect(q.source, 'SOURCE'), destination = await connections.connect(q.destination, 'DESTINATION');
      const before = await postcommitState(source, destination);
      expect((await reconstructOwnedMixedSourceV2(q.pin, q.binding, source.lease)).disposition).toBe('VERIFIED_EXISTING');
      const streams: SurvivingTransportSocket[] = [], cleanupErrors: ReturnType<typeof errorValue>[] = [];
      wirePool = new Pool({ user: 'app_runtime', database: 'postgres', host: '/var/run/postgresql', port: 5432,
        password: () => '', ssl: false, sslnegotiation: 'postgres', options: '-c timezone=UTC', client_encoding: 'UTF8',
        application_name: APPLICATION, connectionTimeoutMillis: 15_000, statement_timeout: 15_000, query_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000, max: 1, idleTimeoutMillis: 0, stream: () => {
          const stream = new SurvivingTransportSocket(q.destination.containerId,
            { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' });
          streams.push(stream); return stream;
        } });
      wirePool.on('error', () => {});
      const native = (await wirePool.query(nativeSql)).rows[0];
      connections.backends.push({ databaseId: q.destination.databaseId, user: 'app_runtime', ...native } as (typeof connections.backends)[number]);
      const run = createTenantTransactionRunner({ pool: wirePool, onCleanupError: error => cleanupErrors.push(errorValue(error)) });
      let sourceBackend: unknown, destinationBackend: unknown, callbackResult: unknown, driverError: unknown;
      let driverSettled = false, callbacks = 0;
      let closeJob: Promise<void> | undefined;
      const sourceLease = { ...source.lease, runTransaction: (async (tenant, callback) => source.lease.runTransaction(tenant, async tx => {
        sourceBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]; return callback(tx);
      })) as typeof source.lease.runTransaction };
      const destinationLease = { ...destination.lease, runTransaction: (async (tenant, callback) => {
        try {
          const value = await run(tenant, async tx => {
            callbacks++; callbackResult = await callback(tx);
            destinationBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid`)).rows[0];
            expect(streams).toHaveLength(1);
            streams[0].arm(wire => {
              expect(driverSettled).toBe(false);
              transportSave(id, 'barrier', { pid: process.pid, before, sourceBackend, destinationBackend, callbackResult,
                backends: connections.backends, wire, driverSettled, driverCommitAcknowledged: false, callerAcknowledged: false });
              closeJob = (async () => {
                const releasePath = `${transportDirectory}/${id}-release.json`, deadline = Date.now() + 10_000;
                while (!existsSync(releasePath)) {
                  if (Date.now() > deadline) throw new Error('Owner transport release missing');
                  await new Promise(done => setTimeout(done, 20));
                }
                expect(JSON.parse(readFileSync(releasePath, 'utf8'))).toEqual({ pid: process.pid, closeExactBorrowedTransport: true });
                streams[0].closeNativeTransport();
              })();
              // Preserve any orchestration error without an unhandled rejection.
              void closeJob.catch(error => transportSave(id, 'close-job-error', errorValue(error)));
            });
            return callbackResult;
          });
          driverSettled = true; transportSave(id, 'driver-settled', { pid: process.pid, resolved: true }); return value;
        } catch (error) {
          driverSettled = true; driverError = errorValue(error);
          transportSave(id, 'driver-settled', { pid: process.pid, resolved: false, error: driverError }); throw error;
        }
      }) as typeof destination.lease.runTransaction };
      const caller = await materializeLocalCandidate(q.binding,
        createOwnedLocalMaterializationRunner(TENANT, JOB, sourceLease, destinationLease))
        .then(value => ({ accepted: true, value }), error => ({ accepted: false, error: errorValue(error) }));
      await closeJob;
      expect(driverError).toMatchObject({ message: 'Connection terminated unexpectedly' });
      expect(caller).toMatchObject({ accepted: false, error: { message: 'Local candidate domain materialization refused.' } });
      expect(callbacks).toBe(1); expect(streams).toHaveLength(1);
      const events = [...streams[0].events];
      expect(events.map(row => row.event)).toEqual(expect.arrayContaining(['relay-stdin-end-requested', 'relay-stdin-ended', 'native-relay-stdout-eof', 'stream-close']));
      expect(events.some(row => row.event === 'stream-error' || row.message)).toBe(false);
      expect((await destination.owner.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [native.pid])).rows).toEqual([]);
      // Same process and same pg Pool survive, but the failed client is discarded.
      const reconnected = (await wirePool.query(nativeSql)).rows[0];
      expect(reconnected).not.toEqual(native); expect(streams).toHaveLength(2);
      expect((await destination.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(reconnected.pid);
      Object.assign(transport, { pidAtError: process.pid, pidAfterReconnect: process.pid, native, reconnected,
        events, driverError, cleanupErrors, caller, callbacks, failedBackendAbsent: true, samePoolReconnected: true, syntheticErrorInjected: false });
      await wirePool.end(); wirePool = undefined;
      backendGroups.push([...connections.backends]); await closeConnections();
      connections = coldConnections({ ...q, phase: 'retry' });
      connectionsOpen = true;
    }
    const replays = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { connections = coldConnections({ ...q, phase: 'retry' }); connectionsOpen = true; }
      const source = await connections.connect(q.source, 'SOURCE'), destination = await connections.connect(q.destination, 'DESTINATION');
      const before = await postcommitState(source, destination);
      await denyWrites(source); await denyWrites(destination);
      const receipt = (await destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
      const outcome = await (async () => {
        // Test-only uncertain result resolver. Never retry first-import on an
        // absent or partial receipt; trusted live allocator ownership is required.
        if (receipt.length !== 1) throw new Error('UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT');
        return postcommitReplay(q, source, destination);
      })().then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error: (error as Error).message }));
      const after = await postcommitState(source, destination); expect(after).toEqual(before);
      const domain = outcome.accepted ? await postcommitDomain(q, source, destination, outcome.value.materialized) : null;
      if (q.outcome === 'commit' && q.expectedReplay !== 'refuse') expect(outcome.accepted).toBe(true);
      else expect(outcome).toEqual({ accepted: false, error: 'UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT' });
      await clearWriteGuard(source); await clearWriteGuard(destination);
      const backends = [...connections.backends]; backendGroups.push(backends);
      replays.push({ pid: process.pid, before, after, receipt, outcome, domain, backends, noDmlReplay: true });
      await closeConnections();
    }
    for (let i = 0; i < backendGroups.length; i++) for (let j = i + 1; j < backendGroups.length; j++) {
      const keys = new Set(backendGroups[i].map(row => `${row.databaseId}/${row.pid}/${row.started}`));
      expect(backendGroups[j].every(row => !keys.has(`${row.databaseId}/${row.pid}/${row.started}`))).toBe(true);
    }
    result = { ok: true, pid: process.pid, transport, replays, backendGroups, freshBackendRecovery: true, poolsClosed: true };
  } catch (error) { result = { ok: false, pid: process.pid, error: errorValue(error) }; }
  finally { await wirePool?.end(); await closeConnections(); }
  transportSave(id, 'result', result); expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
