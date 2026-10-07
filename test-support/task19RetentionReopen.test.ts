// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readOwnedMutableRetention } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionBinding } from '@/server/migration/localMutableRetention';
import { sha256 } from '@/server/migration/validators';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('COLD_SOURCE_FORBIDDEN'); } }));
const pinPath = '.task19-retention-results/positive-pin.json';
// Execute via runner-v2 run (NOT run-pg) only after the PG suite's final receipt.
// In an ordinary full test run without that owned artifact, this is not a gate.
it.skipIf(!existsSync(pinPath))('independent sandbox rereads retained provenance after the original PG runner exits', async () => {
  expect(process.env.RUN_REAL_POSTGRES).toBeUndefined();
  expect(existsSync('/var/run/docker.sock')).toBe(false);
  const { pin, binding } = JSON.parse(readFileSync(pinPath, 'utf8')) as { pin: MutableRetentionPin; binding: MutableRetentionBinding };
  const evidence = await readOwnedMutableRetention(pin, binding);
  expect(evidence.deltas.map(row => row.change_kind).sort()).toEqual(['ADDED','MUTATED','REMOVED']);
  expect(evidence.coverage.coverage).toHaveLength(16);
  expect(evidence).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false, exclusion: 'NOT_PROVEN', complete: false });
  const digest = sha256(readFileSync(`${pin.directory}/artifact.json`, 'utf8'));
  expect(digest).toBe(pin.sha256);
  writeFileSync('.task19-retention-results/independent-cold-receipt.json', JSON.stringify({
    pid: process.pid, pin, binding, digest, outcome: 'VERIFIED', dockerSocket: false, pgOptIn: false,
    kinds: evidence.deltas.map(row => row.change_kind).sort(), categories: evidence.coverage.coverage,
    authority: evidence.authority, activationAllowed: evidence.activationAllowed,
  }), { flag: 'wx', mode: 0o600 });
}, 60_000);
