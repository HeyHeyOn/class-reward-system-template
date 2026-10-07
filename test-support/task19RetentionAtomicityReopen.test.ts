// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readOwnedMutableRetention } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionBinding } from '@/server/migration/localMutableRetention';
import { sha256 } from '@/server/migration/validators';
vi.mock('server-only', () => ({}));
const connections = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { connections.attempts++; throw new Error('COLD_SOURCE_FORBIDDEN'); } }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  class Pool { constructor() { connections.attempts++; throw new Error('COLD_PG_FORBIDDEN'); } }
  return { ...actual, Pool, Client: Pool, default: { ...actual, Pool, Client: Pool } };
});
const root = '.task19-retention-atomicity';
const requestPath = `${root}/requests.json`;
// Only meaningful after the serial PG command exits, in runner-v2 run (not run-pg).
// No artifact-derived pin construction, source URLs, captures or database repair.
it.skipIf(!existsSync(requestPath))('cold independent retention atomicity positives and negatives after PG runner exit', async () => {
  expect(process.env.RUN_REAL_POSTGRES).toBeUndefined();
  expect(existsSync('/var/run/docker.sock')).toBe(false);
  const wire = readFileSync(requestPath, 'utf8');
  const input = JSON.parse(wire) as { requests: { name: string; pin: MutableRetentionPin; binding: MutableRetentionBinding; outcome: string }[];
    failed: { kind: string; directory: string; bytes: number; pinReturned: false }[] };
  expect(input.requests.length).toBeGreaterThan(20); expect(input.failed).toHaveLength(8);
  const results = [];
  for (const request of input.requests) {
    let outcome = 'REFUSED';
    try {
      const evidence = await readOwnedMutableRetention(request.pin, request.binding);
      expect(evidence).toMatchObject({ complete: false, activationAllowed: false, authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN' });
      expect(evidence.coverage.coverage).toHaveLength(16);
      expect(evidence.deltas.map(row => row.change_kind).sort()).toEqual(['ADDED','MUTATED','REMOVED']);
      outcome = 'VERIFIED';
    } catch (error) { expect(error).toEqual(new Error('Local mutable retention archive refused.')); }
    expect(outcome, request.name).toBe(request.outcome);
    expect(connections.attempts).toBe(0); // thrown fallback is not a successful negative
    results.push({ name: request.name, outcome });
  }
  for (const row of input.failed) {
    expect(row.pinReturned).toBe(false);
    expect(readFileSync(`${row.directory}/artifact.json`).byteLength).toBe(row.bytes);
  }
  writeFileSync(`${root}/cold-receipt.json`, JSON.stringify({ pid: process.pid, requestsSha256: sha256(wire),
    dockerSocket: false, pgOptIn: false, connectionAttempts: connections.attempts, results,
    failedArtifactsPreserved: input.failed.length }), { flag: 'wx', mode: 0o600 });
}, 60_000);
