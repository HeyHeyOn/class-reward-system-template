// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readOwnedMutableRetention } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionBinding } from '@/server/migration/localMutableRetention';
vi.mock('server-only', () => ({}));
// Any attempted original-source fallback or default connection is a test failure.
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('COLD_SOURCE_FORBIDDEN'); } }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  class Pool { constructor() { throw new Error('COLD_PG_FORBIDDEN'); } }
  return { ...actual, Pool, default: { ...actual, Pool } };
});
const requestPath = process.env.TASK19_RETENTION_REQUEST;
if (requestPath && !/^\.task19-retention-results\/[0-9a-f-]{36}-request\.json$/.test(requestPath)) throw new Error('Invalid cold retention request');
it.skipIf(!requestPath)('cold source-independent Task19 provenance readback', async () => {
  const request = JSON.parse(readFileSync(requestPath!, 'utf8')) as { pin: MutableRetentionPin; binding: MutableRetentionBinding };
  const result: Record<string, unknown> = { pid: process.pid, sourceConnectionAvailable: false };
  try {
    result.evidence = await readOwnedMutableRetention(request.pin, request.binding);
    result.outcome = 'VERIFIED';
  } catch (error) {
    expect(error).toEqual(new Error('Local mutable retention archive refused.'));
    result.outcome = 'REFUSED';
  }
  writeFileSync(requestPath!.replace('-request.json', '-result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
}, 60_000);
