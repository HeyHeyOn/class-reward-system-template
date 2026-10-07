// @vitest-environment node
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import * as importer from '@/server/migration/importer';
import { readOwnedMixedRetentionV2 } from '@/server/db/testing/task19MixedRetentionV2';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { coldConnections, witness, denyWrites, clearWriteGuard } from './task19MixedCold';
import { TENANT, JOB } from './task19MutableFixture';
import { recoverySave, type RecoveryRequest } from './task19MixedRecoveryV2';
import { recoveryRefusals, recoveryDomain } from './task19MixedRecoveryV2Checks';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('No default database allowed'); } }));
const request: RecoveryRequest | null = process.env.MIXED_RECOVERY_REQUEST
  ? JSON.parse(readFileSync(process.env.MIXED_RECOVERY_REQUEST, 'utf8')) : null;
const id = process.env.MIXED_RECOVERY_ID!;
it.skipIf(!request)('mixed V2 interrupted reconstruction cold child', async () => {
  const q = request!, binding = q.binding!, pin = q.pin;
  const connections = coldConnections({ ...q, phase: 'import' });
  let result: Record<string, unknown> = {};
  try {
    const source = await connections.connect(q.source!, 'SOURCE'), destination = await connections.connect(q.destination!, 'DESTINATION');
    const state = async () => ({ source: await witness(source), destination: await witness(destination) });
    const observations = q.boundary === 'source-records' && q.phase !== 'resume' && q.phase !== 'reject-partial'
      ? await recoveryRefusals(q, source, destination) : [];
    const before = { source: await witness(source), destination: await witness(destination) };
    if (q.phase === 'reject-partial') {
      const evidence = await readOwnedMixedRetentionV2(pin, binding);
      const original = evidence.envelopes.find(row => row.event_id === evidence.header.original_generation_id)!.redacted_details as { manifest: LegacyNormalizationManifest };
      let batches = 0;
      await expect(importer.importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest: original.manifest,
        runTransaction: async (tenant, callback) => {
          const value = await source.lease.runTransaction(tenant, callback);
          if (++batches === 2) throw new Error('LEGACY_PARTIAL_STOP');
          return value;
        } })).rejects.toThrow('LEGACY_PARTIAL_STOP');
      const partial = await state(); expect(partial.source).not.toBe(before.source);
      expect((await source.owner.query('SELECT count(*)::integer AS count FROM migration_source_records')).rows[0].count).toBeGreaterThan(0);
      await expect(reconstructOwnedMixedSourceV2(pin, binding, source.lease)).rejects.toThrow('Synthetic mixed V2 source recovery refused.');
      const after = await state(); expect(after).toEqual(partial);
      result = { ok: true, pid: process.pid, backends: connections.backends, partial, after, disposition: 'LEGACY_PARTIAL_REFUSED' };
    } else {
    const hold = async (tx: Parameters<Parameters<typeof source.lease.runTransaction>[1]>[0]) => {
      const backend = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0];
      const records = (await tx.execute(sql`SELECT count(*)::integer AS count FROM migration_source_records`)).rows[0];
      const staged = (await tx.execute(sql`SELECT count(*)::integer AS count FROM migration_full_generations`)).rows[0];
      const receipts = (await tx.execute(sql`SELECT count(*)::integer AS count FROM migration_local_materializations`)).rows[0];
      recoverySave(id, 'barrier', { pid: process.pid, boundary: q.boundary, backend, records, staged, receipts,
        backends: connections.backends, before, observations });
      await new Promise<void>(() => { /* Parent proves native SQL and kills this exact process. */ });
    };
    // Inject interruption into actual SQL callbacks, never fabricate rows or a
    // successful importer. The RED frozen predecessor committed each callback.
    const realImport = importer.importLegacyNormalizationManifest;
    let batches = 0;
    if (q.phase === 'crash' && q.boundary === 'source-records') vi.spyOn(importer, 'importLegacyNormalizationManifest')
      .mockImplementation(input => realImport({ ...input, runTransaction: async (tenant, callback) => input.runTransaction!(tenant, async tx => {
        const value = await callback(tx);
        if (++batches === 2) await hold(tx);
        return value;
      }) }));
    if (q.phase === 'retry') { await denyWrites(source); await denyWrites(destination); }
    const sourceLease = { ...source.lease, runTransaction: (async (tenant, callback) => source.lease.runTransaction(tenant, async tx => {
      const value = await callback(tx);
      if (q.phase === 'crash' && q.boundary === 'source-staged') await hold(tx);
      return value;
    })) as typeof source.lease.runTransaction };
    const reconstructed = await reconstructOwnedMixedSourceV2(pin, binding, sourceLease);
    vi.restoreAllMocks();
    if (q.phase === 'crash' && q.boundary === 'source-committed') await source.lease.runTransaction(TENANT, hold);
    const destinationLease = { ...destination.lease, runTransaction: (async (tenant, callback) => destination.lease.runTransaction(tenant, async tx => {
      const value = await callback(tx);
      if (q.phase === 'crash' && q.boundary === 'destination-dml') await hold(tx);
      return value;
    })) as typeof destination.lease.runTransaction };
    const materialized = await materializeLocalCandidate(binding,
      createOwnedLocalMaterializationRunner(TENANT, JOB, source.lease, destinationLease));
    const after = await state();
    if (q.phase === 'retry') { expect(after).toEqual(before); await clearWriteGuard(source); await clearWriteGuard(destination); }
    const immutableEvidence = await recoveryDomain(q, source, destination);
    expect(materialized).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' });
    result = { ok: true, pid: process.pid, backends: connections.backends, materialized, reconstructed, before, after, observations, immutableEvidence };
    }
  } catch (error) { result = { ok: false, pid: process.pid, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }; }
  finally { vi.restoreAllMocks(); await connections.close(); }
  recoverySave(id, 'result', result); expect(result.ok, JSON.stringify(result.error)).toBe(true);
}, 600_000);
