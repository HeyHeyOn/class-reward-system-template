import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { sourceAdmissionV2Save, sourceAdmissionV2Directory, ADMISSION_DAMAGES, type SourceAdmissionV2Request, type AdmissionDamage } from './task19SourceAdmissionV2';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.SOURCE_ADMISSION_V2_REQUEST;
if (path && !/^\.task19-source-admission-v2\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid owned admission request');
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
async function waitInstruction(id: string, suffix: string, expected: unknown) {
  const path = `${sourceAdmissionV2Directory}/${id}-${suffix}.json`, deadline = Date.now() + 180_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Missing owner instruction ${suffix}`);
    await new Promise(done => setTimeout(done, 25));
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
}
async function measuredReplay(q: SourceAdmissionV2Request, damage?: AdmissionDamage) {
  const c = coldConnections({ ...q, phase: 'retry' });
  try {
    const source = await c.connect(q.source, 'SOURCE'), destination = await c.connect(q.destination, 'DESTINATION');
    const trace: Record<string, { statements: string[]; attempts: number; callbacks: number; sleeps: number }> = {};
    const ownerStatements: string[] = [];
    for (const [side, db] of [['source', source], ['destination', destination]] as const) {
      const originalOwnerQuery = db.lease.queryOwner;
      db.lease.queryOwner = (text, values) => { ownerStatements.push(text); return originalOwnerQuery(text, values); };
      const t: typeof trace[string] = trace[side] = { statements: [], attempts: 0, callbacks: 0, sleeps: 0 };
      const run = createTenantTransactionRunner({ pool: { connect: async () => {
        t.attempts++; const client = await db.runtime.connect();
        const query: TransactionConnection['query'] = (text, values) => {
          t.statements.push(typeof text === 'string' ? text : (text as { text: string }).text);
          return client.query(text, values);
        };
        return { query, on: (event: 'error', listener: (error: Error) => void) => client.on(event, listener),
          removeListener: (event: 'error', listener: (error: Error) => void) => client.removeListener(event, listener),
          release: (error?: Error | boolean) => client.release(error) };
      } }, sleep: async milliseconds => { t.sleeps++; await new Promise(done => setTimeout(done, milliseconds)); } }, { isolationLevel: q.isolation });
      db.lease.runTransaction = (tenant, callback) => run(tenant, tx => { t.callbacks++; return callback(tx); });
    }
    const before = await postcommitState(source, destination);
    // NO negative write-denial guards or test receipt-count shortcut: both can
    // hide an attempted repair. Delegate the real composition unchanged.
    if (!damage) { await denyWrites(source); await denyWrites(destination); }
    const receipt = (await destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
    const outcome = await postcommitReplay(q, source, destination)
      .then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error: (error as Error).message }));
    const measuredTrace = structuredClone(trace), after = await postcommitState(source, destination);
    // Retain actual values BEFORE assertions, including unexpected acceptance or
    // attempted DML. Failed proofs must not collapse to a hard-coded refusal.
    sourceAdmissionV2Save(randomUUID(), 'measured-replay', { pid: process.pid, request: q, damage: damage ?? null,
      before, after, receipt, outcome, trace: measuredTrace, ownerStatements: [...ownerStatements] });
    expect(after).toEqual(before);
    expect(ownerStatements.every(text => /^SELECT\b/i.test(text.trim()))).toBe(true);
    for (const t of Object.values(measuredTrace)) {
      expect(t.sleeps).toBe(0); expect(t.callbacks).toBe(t.attempts);
      expect(t.statements.every(text => /^(SELECT|SET|BEGIN|COMMIT|ROLLBACK)\b/i.test(text.trim()))).toBe(true);
    }
    const expectedAttempts = damage?.startsWith('archive') ? [0, 0] : damage === 'receipt-missing' ? [1, 0] : [2, 1];
    expect([measuredTrace.source.attempts, measuredTrace.destination.attempts]).toEqual(expectedAttempts);
    if (damage) expect(outcome).toEqual({ accepted: false, error: damage.startsWith('archive')
      ? 'Synthetic mixed V2 source recovery refused.' : 'Local candidate domain materialization refused.' });
    else expect(outcome.accepted).toBe(true);
    const domain = outcome.accepted ? await postcommitDomain(q, source, destination, outcome.value.materialized) : null;
    const tenants = await tenantCoverage(source, destination);
    expect(await postcommitState(source, destination)).toEqual(after);
    if (!damage) { await clearWriteGuard(source); await clearWriteGuard(destination); }
    return { pid: process.pid, before, after, receipt, outcome, domain, tenants, backends: c.backends, trace: measuredTrace, ownerStatements,
      damage: damage ?? null, noDmlReplay: true, negativeExtraWriteGuards: false, syntheticReceiptPrecheck: false };
  } finally { await c.close(); }
}
it.skipIf(!path)('source COMMIT native close after acknowledged destination commit', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: SourceAdmissionV2Request = JSON.parse(readFileSync(path!, 'utf8')), id = process.env.SOURCE_ADMISSION_V2_ID!;
  if (q.expectedReplay === 'refuse' && !ADMISSION_DAMAGES.includes(q.damage!)) throw new Error('Explicit damage required');
  const connections = coldConnections({ ...q, phase: 'import' });
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
        sleep: async milliseconds => { retrySleeps++; await new Promise(done => setTimeout(done, milliseconds)); }, onCleanupError: error => cleanupErrors.push(errorValue(error)) }, { isolationLevel: q.isolation });
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
              sourceAdmissionV2Save(id, 'barrier', { pid: process.pid, side: 'SOURCE', before, sourceBackend, destinationBackend, callbackResult,
                backends: connections.backends, wire, driverSettled, destinationAcknowledged,
                driverCommitAcknowledged: false, callerAcknowledged: false });
              closeJob = (async () => {
                const releasePath = `${sourceAdmissionV2Directory}/${id}-release.json`, deadline = Date.now() + 10_000;
                while (!existsSync(releasePath)) {
                  if (Date.now() > deadline) throw new Error('Owner transport release missing');
                  await new Promise(done => setTimeout(done, 20));
                }
                expect(JSON.parse(readFileSync(releasePath, 'utf8'))).toEqual({ pid: process.pid, closeExactBorrowedTransport: true });
                streams[0].closeNativeTransport();
              })();
              void closeJob.catch(error => sourceAdmissionV2Save(id, 'close-job-error', errorValue(error)));
            });
            return callbackResult;
          });
          driverSettled = true; sourceAdmissionV2Save(id, 'driver-settled', { pid: process.pid, resolved: true }); return value;
        } catch (error) {
          driverSettled = true; driverError = errorValue(error);
          sourceAdmissionV2Save(id, 'driver-settled', { pid: process.pid, resolved: false, error: driverError }); throw error;
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

    }
    const refusals = [];
    if (q.phase === 'crash') {
      // The process stays alive, but every initial transport connection is now
      // closed. No recovery call may precede the owner's physical mutation.
      await closeConnections();
      sourceAdmissionV2Save(id, 'admission-ready', { pid: process.pid, transport, successfulRecoveries: 0 });
      for (const damage of ADMISSION_DAMAGES) {
        await waitInstruction(id, `try-${damage}`, { pid: process.pid, damage });
        const refusal = await measuredReplay(q, damage); refusals.push(refusal);
        sourceAdmissionV2Save(id, `refused-${damage}`, { pid: process.pid, successfulRecoveries: 0, refusal });
      }
      await waitInstruction(id, 'restored', { pid: process.pid, originalFixtureRestored: true });
    }
    const replays = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await measuredReplay(q, q.expectedReplay === 'refuse' ? q.damage : undefined);
      replays.push(replay); backendGroups.push(replay.backends);
    }
    result = { ok: true, pid: process.pid, transport, refusals, replays, backendGroups, freshBackendRecovery: true, poolsClosed: true };
  } catch (error) { result = { ok: false, pid: process.pid, error: errorValue(error) }; }
  finally { await wirePool?.end(); await closeConnections(); }
  sourceAdmissionV2Save(id, 'result', result); expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
