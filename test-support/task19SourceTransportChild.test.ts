import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createTenantTransactionRunner, type TransactionConnection } from '@/server/db/transaction';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { coldConnections, denyWrites, clearWriteGuard, APPLICATION, type ColdDatabase } from './task19MixedCold';
import { postcommitReplay, postcommitDomain, postcommitState } from './task19MixedPostcommitV2Checks';
import { TENANT, OTHER, JOB } from './task19MutableFixture';
import { SourceCommitSocket } from './task19SourceCommitSocket';
import { sourceTransportSave, sourceTransportDirectory, type SourceTransportRequest } from './task19SourceTransport';
vi.mock('server-only', () => ({}));
const path = process.env.SOURCE_TRANSPORT_REQUEST;
const errorValue = (error: unknown) => error instanceof Error
  ? { message: error.message, stack: error.stack, ...('code' in error ? { code: error.code } : {}) } : { message: String(error) };
const nativeSql = 'SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()';
async function tenantCoverage(source: ColdDatabase, destination: ColdDatabase) {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const coverage = [];
  for (const [role, db] of [['SOURCE', source], ['DESTINATION', destination]] as const) {
    const columns = (await db.owner.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id') ORDER BY table_name,column_name`)).rows;
    const owner = [];
    for (const column of columns) {
      const counts = (await db.owner.query(`SELECT count(*) FILTER (WHERE ${quote(column.column_name)}=$1)::integer AS target,
        count(*) FILTER (WHERE ${quote(column.column_name)}<>$1)::integer AS foreign
        FROM ${quote(column.table_name)}`, [TENANT])).rows[0];
      expect(counts.foreign, `${role}.${column.table_name}.${column.column_name}`).toBe(0); owner.push({ ...column, ...counts });
    }
    const rlsTables = (await db.owner.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND rowsecurity AND has_table_privilege('app_runtime',quote_ident(tablename),'SELECT') ORDER BY tablename`)).rows;
    // tenants is keyed by id and intentionally contains OTHER's own identity.
    // Only tenant_id/claimed_by_tenant_id tables promise zero rows for OTHER.
    const scopedNames = new Set(columns.map(row => row.table_name));
    const tables = rlsTables.filter(row => scopedNames.has(row.tablename));
    expect(tables.map(row => row.tablename)).toEqual(expect.arrayContaining(['products', 'students', 'migration_jobs']));
    let visibleTenantIds: unknown[] = [];
    const rls = await db.lease.runTransaction(OTHER, async tx => {
      visibleTenantIds = (await tx.execute(sql`SELECT id FROM tenants ORDER BY id`)).rows.map(row => row.id);
      expect(visibleTenantIds).toEqual([OTHER]);
      const counts = [];
      for (const row of tables) {
        const n = (await tx.execute(sql.raw(`SELECT count(*)::integer AS n FROM ${quote(row.tablename)}`))).rows[0].n;
        expect(n, `${role}.${row.tablename}`).toBe(0); counts.push({ table: row.tablename, otherTenantCount: n });
      }
      return counts;
    });
    coverage.push({ role, owner, rls, targetTenant: TENANT, otherTenant: OTHER, visibleTenantIds,
      unscopedRls: rlsTables.filter(row => !scopedNames.has(row.tablename)).map(row => row.tablename) });
  }
  return coverage;
}
it.skipIf(!path)('source COMMIT native close after acknowledged destination commit', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: SourceTransportRequest = JSON.parse(readFileSync(path!, 'utf8')), id = process.env.SOURCE_TRANSPORT_ID!;
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
      const streams: SourceCommitSocket[] = [], cleanupErrors: ReturnType<typeof errorValue>[] = [];
      wirePool = new Pool({ user: 'app_runtime', database: 'postgres', host: '/var/run/postgresql', port: 5432,
        password: () => '', ssl: false, sslnegotiation: 'postgres', options: '-c timezone=UTC', client_encoding: 'UTF8',
        application_name: APPLICATION, connectionTimeoutMillis: 15_000, statement_timeout: 15_000, query_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000, max: 1, idleTimeoutMillis: 0, stream: () => {
          const stream = new SourceCommitSocket(q.source.containerId,
            { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' });
          streams.push(stream); return stream;
        } });
      wirePool.on('error', () => {});
      const native = (await wirePool.query(nativeSql)).rows[0];
      connections.backends.push({ databaseId: q.source.databaseId, user: 'app_runtime', ...native } as (typeof connections.backends)[number]);
      const statements: string[] = [], releases: boolean[] = [], destinationStatements: string[] = [];
      let attempts = 0, retrySleeps = 0, destinationAttempts = 0;
      const instrument = (pool: Pool, list: string[], sourceSide: boolean) => ({ connect: async () => {
        if (sourceSide) attempts++; else destinationAttempts++;
        const client = await pool.connect();
        const query: TransactionConnection['query'] = (text, values) => { list.push(text); return client.query(text, values); };
        return { query, on: (event: 'error', listener: (error: Error) => void) => client.on(event, listener),
          removeListener: (event: 'error', listener: (error: Error) => void) => client.removeListener(event, listener),
          release: (error?: Error | boolean) => { if (sourceSide) releases.push(!!error); client.release(error); } };
      } });
      const run = createTenantTransactionRunner({ pool: instrument(wirePool, statements, true),
        sleep: async () => { retrySleeps++; }, onCleanupError: error => cleanupErrors.push(errorValue(error)) }, { isolationLevel: q.isolation });
      const destinationRun = createTenantTransactionRunner({ pool: instrument(destination.runtime, destinationStatements, false) });
      let sourceBackend: unknown, destinationBackend: unknown, callbackResult: unknown, driverError: unknown;
      let driverSettled = false, callbacks = 0, destinationAcknowledged = false;
      let closeJob: Promise<void> | undefined;
      const destinationLease = { ...destination.lease, runTransaction: (async (tenant, callback) => {
        const value = await destinationRun(tenant, async tx => {
          const result = await callback(tx);
          destinationBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid`)).rows[0];
          return result;
        });
        destinationAcknowledged = true; return value;
      }) as typeof destination.lease.runTransaction };
      const sourceLease = { ...source.lease, runTransaction: (async (tenant, callback) => {
        try {
          const value = await run(tenant, async tx => {
            callbacks++; callbackResult = await callback(tx);
            // The real nested destination transaction has returned only after COMMIT.
            expect(destinationAcknowledged).toBe(true);
            sourceBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
              current_setting('transaction_isolation') AS isolation`)).rows[0];
            expect(sourceBackend).toMatchObject({ pid: native.pid, isolation: q.isolation.toLowerCase() });
            expect(streams).toHaveLength(1);
            streams[0].armSource(q.outcome, wire => {
              expect(driverSettled).toBe(false);
              sourceTransportSave(id, 'barrier', { pid: process.pid, side: 'SOURCE', before, sourceBackend, destinationBackend, callbackResult,
                backends: connections.backends, wire, driverSettled, destinationAcknowledged,
                driverCommitAcknowledged: false, callerAcknowledged: false });
              closeJob = (async () => {
                const releasePath = `${sourceTransportDirectory}/${id}-release.json`, deadline = Date.now() + 10_000;
                while (!existsSync(releasePath)) {
                  if (Date.now() > deadline) throw new Error('Owner transport release missing');
                  await new Promise(done => setTimeout(done, 20));
                }
                expect(JSON.parse(readFileSync(releasePath, 'utf8'))).toEqual({ pid: process.pid, closeExactBorrowedTransport: true });
                streams[0].closeNativeTransport();
              })();
              void closeJob.catch(error => sourceTransportSave(id, 'close-job-error', errorValue(error)));
            });
            return callbackResult;
          });
          driverSettled = true; sourceTransportSave(id, 'driver-settled', { pid: process.pid, resolved: true }); return value;
        } catch (error) {
          driverSettled = true; driverError = errorValue(error);
          sourceTransportSave(id, 'driver-settled', { pid: process.pid, resolved: false, error: driverError }); throw error;
        }
      }) as typeof source.lease.runTransaction };
      const caller = await materializeLocalCandidate(q.binding,
        createOwnedLocalMaterializationRunner(TENANT, JOB, sourceLease, destinationLease))
        .then(value => ({ accepted: true, value }), error => ({ accepted: false, error: errorValue(error) }));
      await closeJob;
      expect(driverError).toMatchObject({ message: 'Connection terminated unexpectedly' });
      expect(caller).toMatchObject({ accepted: false, error: { message: 'Local candidate domain materialization refused.' } });
      expect(callbacks).toBe(1); expect(attempts).toBe(1); expect(retrySleeps).toBe(0); expect(destinationAttempts).toBe(1);
      expect(statements.filter(text => text === 'COMMIT')).toHaveLength(1); expect(statements.at(-1)).toBe('ROLLBACK');
      expect(releases).toEqual([true]); expect(destinationStatements.filter(text => text === 'COMMIT')).toHaveLength(1);
      expect(destinationStatements).not.toContain('ROLLBACK'); expect(streams).toHaveLength(1);
      const events = [...streams[0].events];
      expect(events.map(row => row.event)).toEqual(expect.arrayContaining(['relay-stdin-end-requested', 'relay-stdin-ended', 'native-relay-stdout-eof', 'stream-close']));
      expect(events.some(row => row.event === 'stream-error' || row.message)).toBe(false);
      expect((await source.owner.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [native.pid])).rows).toEqual([]);
      const afterFailure = await postcommitState(source, destination); expect(afterFailure.source).toBe(before.source);
      // Same application process AND source pg Pool survive; failed client is gone.
      const reconnected = (await wirePool.query(nativeSql)).rows[0];
      expect(reconnected).not.toEqual(native); expect(streams).toHaveLength(2);
      expect((await source.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(reconnected.pid);
      Object.assign(transport, { side: 'SOURCE', pidAtError: process.pid, pidAfterReconnect: process.pid, native, reconnected,
        events, driverError, cleanupErrors, caller, callbacks, attempts, retrySleeps, destinationAttempts, destinationAcknowledged,
        statements, destinationStatements, releases, before, afterFailure, failedBackendAbsent: true, samePoolReconnected: true, syntheticErrorInjected: false });
      await wirePool.end(); wirePool = undefined;
      backendGroups.push([...connections.backends]); await closeConnections();
      connections = coldConnections({ ...q, phase: 'retry' }); connectionsOpen = true;
    }
    const replays = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { connections = coldConnections({ ...q, phase: 'retry' }); connectionsOpen = true; }
      const source = await connections.connect(q.source, 'SOURCE'), destination = await connections.connect(q.destination, 'DESTINATION');
      source.lease.runTransaction = createTenantTransactionRunner({ pool: source.runtime }, { isolationLevel: q.isolation });
      const before = await postcommitState(source, destination);
      await denyWrites(source); await denyWrites(destination);
      const receipt = (await destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
      const outcome = await (async () => {
        if (receipt.length !== 1) throw new Error('UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT');
        return postcommitReplay(q, source, destination);
      })().then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error: (error as Error).message }));
      const after = await postcommitState(source, destination); expect(after).toEqual(before);
      const domain = outcome.accepted ? await postcommitDomain(q, source, destination, outcome.value.materialized) : null;
      if (q.expectedReplay !== 'refuse') expect(outcome.accepted).toBe(true);
      else expect(outcome).toEqual({ accepted: false, error: 'UNCERTAIN_COMMIT_WITHOUT_EXACT_RECEIPT' });
      const tenants = await tenantCoverage(source, destination);
      expect(await postcommitState(source, destination)).toEqual(after);
      await clearWriteGuard(source); await clearWriteGuard(destination);
      const backends = [...connections.backends]; backendGroups.push(backends);
      replays.push({ pid: process.pid, before, after, receipt, outcome, domain, backends, tenants, noDmlReplay: true });
      await closeConnections();
    }
    for (let i = 0; i < backendGroups.length; i++) for (let j = i + 1; j < backendGroups.length; j++) {
      const keys = new Set(backendGroups[i].map(row => `${row.databaseId}/${row.pid}/${row.started}`));
      expect(backendGroups[j].every(row => !keys.has(`${row.databaseId}/${row.pid}/${row.started}`))).toBe(true);
    }
    result = { ok: true, pid: process.pid, transport, replays, backendGroups, freshBackendRecovery: true, poolsClosed: true };
  } catch (error) { result = { ok: false, pid: process.pid, error: errorValue(error) }; }
  finally { await wirePool?.end(); await closeConnections(); }
  sourceTransportSave(id, 'result', result); expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
