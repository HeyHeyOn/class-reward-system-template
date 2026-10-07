// @vitest-environment node
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { readOwnedMixedRetentionV2 } from '@/server/db/testing/task19MixedRetentionV2';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';
import { coldConnections, denyWrites, clearWriteGuard } from './task19MixedCold';
import { TENANT, JOB } from './task19MutableFixture';
import { postcommitSave, type PostcommitRequest } from './task19MixedPostcommitV2';
import { postcommitReplay, postcommitDomain, postcommitRefusals, postcommitState } from './task19MixedPostcommitV2Checks';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.POSTCOMMIT_REQUEST;
if (path && !/^\.task19-mixed-postcommit-v2\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid owned request');
it.skipIf(!path)('mixed V2 destination postcommit cold child', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: PostcommitRequest = JSON.parse(readFileSync(path!, 'utf8')), id = process.env.POSTCOMMIT_ID!;
  const connections = coldConnections({ ...q, phase: 'import' });
  let result: Record<string, unknown> = { ok: false, pid: process.pid };
  try {
    const source = await connections.connect(q.source, 'SOURCE'), destination = await connections.connect(q.destination, 'DESTINATION');
    const state = () => postcommitState(source, destination), before = await state();
    if (q.phase === 'prepare') {
      const reconstructed = await reconstructOwnedMixedSourceV2(q.pin, q.binding, source.lease);
      expect(reconstructed.disposition).toBe('RECONSTRUCTED');
      const after = await state(); expect(after.destination).toBe(before.destination); expect(after.source).not.toBe(before.source);
      expect((await source.owner.query('SELECT status FROM migration_jobs')).rows).toEqual([{ status: 'READY' }]);
      result = { ...result, ok: true, reconstructed, before, after };
    } else {
      // The death/replay slice starts at separately COMMITTED READY, not at a
      // process-local reconstruction value. Pristine or partial source is not it.
      expect((await source.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows)
        .toEqual([{ status: 'READY', version: q.binding.expectedStateVersion }]);
      if (q.phase === 'crash') {
        const reconstructed = await reconstructOwnedMixedSourceV2(q.pin, q.binding, source.lease);
        expect(reconstructed.disposition).toBe('VERIFIED_EXISTING');
        let sourceBackend: unknown, destinationBackend: unknown, callbackResult: unknown;
        const hold = async () => {
          postcommitSave(id, 'barrier', { pid: process.pid, boundary: q.boundary, before, sourceBackend, destinationBackend,
            callbackResult, backends: connections.backends, driverCommitAcknowledged: q.boundary === 'destination-postcommit',
            callerAcknowledged: false });
          await new Promise<void>(() => { /* Exact launcher kills this child, never returns a fake commit. */ });
        };
        const sourceLease = { ...source.lease, runTransaction: (async (tenant, callback) => source.lease.runTransaction(tenant, async tx => {
          sourceBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0];
          return callback(tx);
        })) as typeof source.lease.runTransaction };
        const destinationLease = { ...destination.lease, runTransaction: (async (tenant, callback) => {
          const value = await destination.lease.runTransaction(tenant, async tx => {
            destinationBackend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0];
            const actual = await callback(tx); callbackResult = actual;
            if (q.boundary === 'destination-precommit') await hold();
            return actual;
          });
          // This is AFTER the actual transaction Promise's COMMIT response and
          // release, BEFORE any value reaches the pair runner/materializer caller.
          if (q.boundary === 'destination-postcommit') await hold();
          return value;
        }) as typeof destination.lease.runTransaction };
        const materialized = await materializeLocalCandidate(q.binding,
          createOwnedLocalMaterializationRunner(TENANT, JOB, sourceLease, destinationLease));
        postcommitSave(id, 'caller-ack', { pid: process.pid, materialized });
        throw new Error('Crash child escaped death barrier');
      } else if (q.phase === 'partial') {
        const evidence = await readOwnedMixedRetentionV2(q.pin, q.binding);
        const manifest = (evidence.envelopes.find(row => row.event_id === evidence.header.candidate_generation_id)!
          .redacted_details as { manifest: LegacyNormalizationManifest }).manifest;
        let batches = 0;
        await expect(importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest,
          runTransaction: async (tenant, callback) => {
            const value = await destination.lease.runTransaction(tenant, callback);
            if (++batches === 2) throw new Error('COMMITTED_PARTIAL_DESTINATION');
            return value;
          } })).rejects.toThrow('COMMITTED_PARTIAL_DESTINATION');
        const partial = await state(); expect(partial.destination).not.toBe(before.destination);
        expect((await destination.owner.query('SELECT count(*)::integer AS n FROM migration_source_records')).rows[0].n).toBeGreaterThan(0);
        expect((await destination.owner.query('SELECT count(*)::integer AS n FROM migration_local_materializations')).rows).toEqual([{ n: 0 }]);
        const outcome = await postcommitReplay(q, source, destination).then(value => ({ accepted: true, value }), error => ({ accepted: false, error: (error as Error).message }));
        const after = await state(); expect(after).toEqual(partial);
        expect(outcome).toEqual({ accepted: false, error: 'Local candidate domain materialization refused.' });
        result = { ...result, ok: true, before, partial, after, outcome, disposition: 'PARTIAL_DESTINATION_REFUSED' };
      } else if (q.phase === 'negatives') {
        const observations = await postcommitRefusals(q, source, destination);
        const verified = await postcommitReplay(q, source, destination);
        result = { ...result, ok: true, observations, before, after: await state(), ...verified,
          domain: await postcommitDomain(q, source, destination, verified.materialized) };
      } else {
        const exactRetry = q.phase === 'retry' || q.boundary === 'destination-postcommit';
        await denyWrites(source);
        if (exactRetry) await denyWrites(destination);
        const replayed = await postcommitReplay(q, source, destination), after = await state();
        expect(replayed.reconstructed.disposition).toBe('VERIFIED_EXISTING');
        expect(after.source).toBe(before.source);
        if (exactRetry) expect(after).toEqual(before);
        await clearWriteGuard(source);
        if (exactRetry) await clearWriteGuard(destination);
        result = { ...result, ok: true, ...replayed, before, after, exactRetry,
          domain: await postcommitDomain(q, source, destination, replayed.materialized) };
      }
    }
  } catch (error) {
    result = { ok: false, pid: process.pid, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
  } finally { await connections.close(); }
  postcommitSave(process.env.POSTCOMMIT_ID!, 'result', { ...result, backends: connections.backends, poolsClosed: true });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
