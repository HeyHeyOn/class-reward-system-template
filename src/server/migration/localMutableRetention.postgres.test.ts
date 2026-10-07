// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { materializeLocalCandidate } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { LOCAL_DELTA_COVERAGE_CATALOG } from './localFullCategoryDeltaCoverage';
import type { MutableRetentionBinding, MutableRetentionEvidence } from './localMutableRetention';
import { retainOwnedMutableProvenance } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import { cleanupMutableFixture, mutableFixture, mutableState, forbidMutableWrites, OTHER } from '../../../test-support/task19MutableFixture';
vi.mock('server-only', () => ({}));
const ROOT = '.task19-retention-results';
const ARCHIVES = '.task19-retention-artifacts';
type ColdResult = { pid: number; sourceConnectionAvailable: false; outcome: string; evidence?: MutableRetentionEvidence };
async function cold(pin: MutableRetentionPin, binding: MutableRetentionBinding): Promise<ColdResult> {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const base = join(ROOT, randomUUID()), request = `${base}-request.json`;
  // No source handle, endpoint, capture, manifest, or expected rows are sent.
  writeFileSync(request, JSON.stringify({ pin, binding }), { flag: 'wx', mode: 0o600 });
  const args = ['node_modules/vitest/vitest.mjs','run','test-support/task19RetentionChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--environment=node','--reporter=default','--reporter=json',`--outputFile.json=${base}-vitest.json`];
  const output: Buffer[] = [];
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C',
    NODE_ENV: 'test', TASK19_RETENTION_REQUEST: request }, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', data => output.push(data)); child.stderr.on('data', data => output.push(data));
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const exited = await new Promise<{code: number | null; signal: string | null}>((done, fail) => {
    child.once('error', fail); child.once('close', (code, signal) => done({code,signal}));
  }).finally(() => clearTimeout(timer));
  writeFileSync(`${base}-log.txt`, Buffer.concat(output), { flag: 'wx', mode: 0o600 });
  const report = JSON.parse(readFileSync(`${base}-vitest.json`, 'utf8'));
  expect(exited, Buffer.concat(output).toString()).toEqual({ code: 0, signal: null });
  expect(report.numPassedTests).toBe(1); expect(report.numFailedTests).toBe(0);
  const result = JSON.parse(readFileSync(`${base}-result.json`, 'utf8')) as ColdResult;
  expect(result.pid).not.toBe(process.pid); expect(result.sourceConnectionAvailable).toBe(false);
  console.info('TASK19_RETENTION_COLD', JSON.stringify({ base, ...exited, pid: result.pid, outcome: result.outcome }));
  return result;
}
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
suite('Task19 source independent mutable retention', () => {
  let f: Awaited<ReturnType<typeof mutableFixture>>, pin: MutableRetentionPin, bytes: string;
  let expectedDeltas: Record<string, unknown>[];
  beforeAll(async () => {
    f = await mutableFixture();
    expectedDeltas = (await f.source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_id')).rows;
    expect(expectedDeltas).toHaveLength(3);
    await materializeLocalCandidate(f.binding, f.run());
    const before = [await mutableState(f.source), await mutableState(f.destination)];
    await forbidMutableWrites(f.source); await forbidMutableWrites(f.destination);
    mkdirSync(ARCHIVES, { recursive: true, mode: 0o700 });
    mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    pin = await retainOwnedMutableProvenance(f.source, f.ownerId, f.binding, ARCHIVES);
    expect(pin.ownerId).not.toBe(f.ownerId);
    expect([await mutableState(f.source), await mutableState(f.destination)]).toEqual(before);
    bytes = readFileSync(join(pin.directory, 'artifact.json'), 'utf8');
    writeFileSync(join(ROOT, 'positive-pin.json'), JSON.stringify({ pin, binding: f.binding }), { flag: 'wx', mode: 0o600 });
    // Both databases and their tmpfs are destroyed, not just JS references closed.
    for (const db of [f.source, f.destination]) {
      const cleanup = await db.close(); expect(cleanup.containerRemoved).toBe(true);
      console.info('TASK19_RETENTION_SOURCE_CLOSED', JSON.stringify(cleanup));
    }
  }, 120_000);
  afterAll(cleanupMutableFixture);
  it('retains exact before after and removal tombstone after original evidence source closure', async () => {
    const result = await cold(pin, f.binding);
    expect(result.outcome).toBe('VERIFIED');
    const evidence = result.evidence!;
    expect(evidence.deltas.slice().sort((a,b) => String(a.target_id).localeCompare(String(b.target_id)))).toEqual(expectedDeltas);
    expect(evidence).toEqual(JSON.parse(bytes).evidence);
    expect(evidence.coverage.coverage.map(category => category.table)).toEqual(LOCAL_DELTA_COVERAGE_CATALOG.map(category => category.table));
    expect(evidence.coverage.coverage).toHaveLength(16);
    expect(evidence).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' });
    // Independent product-image oracle, not merely whole-artifact self equality.
    const entry = (id: string) => evidence.deltas.find(row => row.target_id === id)!.entry_value as {
      kind: string; before: {target: Record<string, unknown>} | null; after: {target: Record<string, unknown>} | null;
      beforeDigest: string | null; afterDigest: string | null;
    };
    expect(entry('P1').kind).toBe('MUTATED');
    expect(entry('P1').before!.target).toEqual(f.old.records.products.find(row => row.productId === 'P1'));
    expect(entry('P1').after!.target).toEqual(f.next.records.products.find(row => row.productId === 'P1'));
    expect(entry('P1').beforeDigest).toBe(sha256(canonicalJson(entry('P1').before!.target)));
    expect(entry('P1').afterDigest).toBe(sha256(canonicalJson(entry('P1').after!.target)));
    expect(entry('PX').kind).toBe('REMOVED'); expect(entry('PX').after).toBeNull(); expect(entry('PX').afterDigest).toBeNull();
    expect(entry('PX').before!.target).toEqual(f.old.records.products.find(row => row.productId === 'PX'));
    expect(entry('PNEW').kind).toBe('ADDED'); expect(entry('PNEW').before).toBeNull(); expect(entry('PNEW').beforeDigest).toBeNull();
    expect(entry('PNEW').after!.target).toEqual(f.next.records.products.find(row => row.productId === 'PNEW'));
  }, 120_000);
  it.each([
    ['tenantId', OTHER], ['migrationJobId', OTHER], ['expectedStateVersion', '999'],
    ['generationId', `full-mutable-stage:${'0'.repeat(64)}`], ['manifestDigest', '0'.repeat(64)], ['sourceFingerprint', '0'.repeat(64)],
  ])('refuses wrong cold binding %s', async (key, value) => {
    expect((await cold(pin, { ...f.binding, [key]: value })).outcome).toBe('REFUSED');
  }, 120_000);
  it('refuses a missing artifact without trying to reopen original source', async () => {
    expect((await cold({ ...pin, directory: join(resolve(ARCHIVES), 'missing', `task19-retention-${pin.artifactId}`) }, f.binding)).outcome).toBe('REFUSED');
  }, 120_000);
  it('refuses substituted artifact identity', async () => {
    expect((await cold({ ...pin, ownerId: randomUUID() }, f.binding)).outcome).toBe('REFUSED');
  }, 120_000);
  it('refuses changed directory inode', async () => {
    expect((await cold({ ...pin, inode: pin.inode + 1 }, f.binding)).outcome).toBe('REFUSED');
  }, 120_000);
  it('refuses symlinked artifact directory', async () => {
    const root = join(resolve(ARCHIVES), randomUUID()); mkdirSync(root, {mode: 0o700});
    const alias = join(root, `task19-retention-${pin.artifactId}`); symlinkSync(pin.directory, alias);
    try { expect((await cold({ ...pin, directory: alias }, f.binding)).outcome).toBe('REFUSED'); }
    finally { unlinkSync(alias); }
  }, 120_000);
  const mutations: [string, (payload: MutableRetentionEvidence) => void][] = [
    ['before image', e => { const row = e.deltas.find(row => row.change_kind === 'MUTATED')!;
      (row.entry_value as {before: {target: Record<string,unknown>}}).before.target.name = 'substitution'; }],
    ['after image', e => { const row = e.deltas.find(row => row.change_kind === 'MUTATED')!;
      (row.entry_value as {after: {target: Record<string,unknown>}}).after.target.price = '999'; }],
    ['removal tombstone', e => { e.deltas.splice(e.deltas.findIndex(row => row.change_kind === 'REMOVED'), 1); }],
    ['category coverage', e => { Object.assign(e.coverage, { coverage: e.coverage.coverage.slice(1) }); }],
    ['mandatory report', e => { e.reconciliation.splice(0, 1); }],
    ['misnamed source report', e => { e.reconciliation.find(row => row.category === 'SOURCE_RECORDS')!.category = 'SOURCES'; }],
    ['source pointer', e => { e.sources.splice(0, 1); }],
    ['before capture', e => { e.envelopes.splice(e.envelopes.findIndex(row => row.event_type === 'MIGRATION_PREPARATION_ORIGINAL'), 1); }],
    ['authority promotion', e => { Object.assign(e, { authority: 'AUTHORITY', activationAllowed: true }); }],
  ];
  it.each(mutations)('refuses modified or omitted %s with the original external digest', async (_name, mutate) => {
    const payload = JSON.parse(bytes); mutate(payload.evidence);
    writeFileSync(join(pin.directory, 'artifact.json'), canonicalJson(payload));
    try { expect((await cold(pin, f.binding)).outcome).toBe('REFUSED'); }
    finally { writeFileSync(join(pin.directory, 'artifact.json'), bytes); }
  }, 120_000);
  it.each(mutations)('semantic validation also refuses %s even with a newly computed whole-file digest', async (_name, mutate) => {
    const payload = JSON.parse(bytes); mutate(payload.evidence);
    const corrupt = canonicalJson(payload); writeFileSync(join(pin.directory, 'artifact.json'), corrupt);
    try { expect((await cold({ ...pin, sha256: sha256(corrupt) }, f.binding)).outcome).toBe('REFUSED'); }
    finally { writeFileSync(join(pin.directory, 'artifact.json'), bytes); }
  }, 120_000);
  it('repeated cold read returns exact same artifact with no repair or authority', async () => {
    expect((await cold(pin, f.binding)).evidence).toEqual(JSON.parse(bytes).evidence);
    expect(readFileSync(join(pin.directory, 'artifact.json'), 'utf8')).toBe(bytes);
  }, 120_000);
});

suite('Task19 retention source sealing refuses invalid evidence', () => {
  let f: Awaited<ReturnType<typeof mutableFixture>>, parent: string;
  beforeAll(async () => {
    f = await mutableFixture();
    parent = join(ARCHIVES, randomUUID()); mkdirSync(parent, { recursive: true, mode: 0o700 });
  }, 120_000);
  afterAll(cleanupMutableFixture);
  it('refuses a different source owner without creating an archive', async () => {
    await expect(retainOwnedMutableProvenance(f.source, randomUUID(), f.binding, parent))
      .rejects.toThrow('Local mutable retention archive refused.');
    expect(readdirSync(parent)).toEqual([]);
  }, 120_000);
  it('keeps the immutable source ownership marker SELECT-only for app_runtime', async () => {
    expect((await f.source.runtime.query("SELECT has_table_privilege(current_user,'migration_local_disposable_database','SELECT') AS read, has_table_privilege(current_user,'migration_local_disposable_database','UPDATE') AS write")).rows)
      .toEqual([{ read: true, write: false }]);
    await expect(f.source.runtime.query('SELECT database_id FROM migration_local_disposable_database FOR SHARE'))
      .rejects.toMatchObject({ code: '42501' });
  });
  it('refuses a wrong tenant at capture without creating an archive', async () => {
    await expect(retainOwnedMutableProvenance(f.source, f.ownerId, { ...f.binding, tenantId: OTHER }, parent))
      .rejects.toThrow('Local mutable retention archive refused.');
    expect(readdirSync(parent)).toEqual([]);
  }, 120_000);
  it('refuses omitted source before acquisition rather than manufacturing provenance', async () => {
    // Corruption only in this owned synthetic source; intentionally last test.
    const client = await f.source.owner.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL session_replication_role='replica'");
      await client.query("DELETE FROM audit_events WHERE event_type='MIGRATION_PREPARATION_ORIGINAL'");
      await client.query('COMMIT');
    } finally { client.release(true); }
    await expect(retainOwnedMutableProvenance(f.source, f.ownerId, f.binding, parent))
      .rejects.toThrow('Local mutable retention archive refused.');
    expect(readdirSync(parent)).toEqual([]);
  }, 120_000);
});
