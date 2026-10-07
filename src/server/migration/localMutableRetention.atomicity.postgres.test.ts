// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { constants as C, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readOwnedMutableRetention, retainOwnedMutableProvenance } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import type { MutableRetentionBinding } from './localMutableRetention';
import { canonicalJson, sha256 } from './validators';
import { cleanupMutableFixture, forbidMutableWrites, mutableFixture, mutableState, OTHER } from '../../../test-support/task19MutableFixture';

vi.mock('server-only', () => ({}));
// Faults are confined to the new attempt's exact private parent/handles. All SQL,
// capture, validation and file I/O remain real; there is no fake evidence/pin.
const fault = vi.hoisted(() => ({
  parent: '', kind: '', hits: 0, live: new Set<number>(), artifactDirectory: '',
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    const path = String(args[0]);
    const proc = /^\/proc\/self\/fd\/(\d+)\/artifact\.json$/.exec(path);
    const scoped = fault.parent && (path === fault.parent || path.startsWith(`${fault.parent}/`)
      || (proc && fault.live.has(Number(proc[1]))));
    if (!scoped) return file;
    const fd = file.fd;
    fault.live.add(fd);
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      try { await close(); } finally { fault.live.delete(fd); }
      if (proc && fault.kind === 'file-close') { fault.hits++; throw new Error('INJECTED_CLOSE'); }
    });
    if (!proc && path !== fault.parent) fault.artifactDirectory = path;
    if (proc && typeof args[1] === 'number' && (args[1] & C.O_WRONLY)) {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
        if (fault.kind === 'write-zero') { fault.hits++; throw new Error('INJECTED_ENOSPC'); }
        if (fault.kind === 'write-partial' || fault.kind === 'write-interrupted') {
          await write(String(data).slice(0, 113)); // real incomplete file, not a fabricated verifier result
          fault.hits++;
          if (fault.kind === 'write-interrupted') {
            const controller = new AbortController(); controller.abort();
            // Exercise the real Node cancellation path after an actual prefix.
            await write(String(data).slice(113), { signal: controller.signal });
            throw new Error('ABORT_WAS_NOT_OBSERVED');
          }
          throw new Error('INJECTED_EIO');
        }
        if (fault.kind === 'write-paused') {
          await write(String(data).slice(0, 113));
          fault.hits++; fault.entered!(); await fault.release;
          throw new Error('INJECTED_ABORT_AFTER_PAUSE');
        }
        await write(data, options);
      });
    }
    const point = proc ? 'file-sync' : path === fault.parent ? 'parent-sync' : 'directory-sync';
    const sync = file.sync.bind(file);
    vi.spyOn(file, 'sync').mockImplementation(async () => {
      if (fault.kind === point) { fault.hits++; throw new Error(`INJECTED_${point}`); }
      await sync();
    });
    if (proc && args[1] === (C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK) && fault.kind === 'readback') {
      vi.spyOn(file, 'readFile').mockRejectedValue(new Error('INJECTED_READBACK'));
      fault.hits++;
    }
    return file;
  } };
});

const ROOT = '.task19-retention-atomicity';
const REFUSED = 'Local mutable retention archive refused.';
type Request = { name: string; pin: MutableRetentionPin; binding: MutableRetentionBinding; outcome: 'VERIFIED' | 'REFUSED' };
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
suite('Task19 trusted-pin failure atomicity acceptance', () => {
  let f: Awaited<ReturnType<typeof mutableFixture>>;
  let inherited: MutableRetentionPin, foreign: MutableRetentionPin, retry: MutableRetentionPin;
  let inheritedBytes: string, foreignBytes: string, before: Awaited<ReturnType<typeof mutableState>>[];
  const requests: Request[] = [];
  const failed: { kind: string; directory: string; bytes: number; pinReturned: false }[] = [];
  const file = (pin: MutableRetentionPin) => join(pin.directory, 'artifact.json');
  const retain = (parent: string, binding = f.binding) => retainOwnedMutableProvenance(f.source, f.ownerId, binding, parent);
  const parent = () => { const path = resolve(ROOT, randomUUID()); mkdirSync(path, { mode: 0o700 }); return path; };
  const preserve = () => {
    expect(readFileSync(file(inherited), 'utf8')).toBe(inheritedBytes);
    expect(readFileSync(file(foreign), 'utf8')).toBe(foreignBytes);
    expect(fault.live.size).toBe(0);
  };
  beforeAll(async () => {
    mkdirSync(ROOT, { mode: 0o700 });
    f = await mutableFixture();
    inherited = await retain(parent()); inheritedBytes = readFileSync(file(inherited), 'utf8');
    const other = await mutableFixture();
    expect(other.binding).toEqual(f.binding); // different physical source, same logical generation
    foreign = await retainOwnedMutableProvenance(other.source, other.ownerId, other.binding, parent());
    foreignBytes = readFileSync(file(foreign), 'utf8');
    expect(foreign.sourceDatabaseId).not.toBe(inherited.sourceDatabaseId);
    expect(foreign.sourceOwnerId).not.toBe(inherited.sourceOwnerId);
    for (const db of [other.source, other.destination]) console.info('TASK19_ATOMICITY_CLOSED', JSON.stringify(await db.close()));
    before = [await mutableState(f.source), await mutableState(f.destination)];
    await forbidMutableWrites(f.source); await forbidMutableWrites(f.destination);
    requests.push({ name: 'inherited completed archive', pin: inherited, binding: f.binding, outcome: 'VERIFIED' },
      { name: 'other owner completed archive', pin: foreign, binding: f.binding, outcome: 'VERIFIED' });
  }, 120_000);
  afterAll(async () => { fault.parent = ''; vi.restoreAllMocks(); await cleanupMutableFixture(); });

  it.each(['write-zero','write-partial','write-interrupted','file-sync','file-close','directory-sync','parent-sync','readback'])
  ('does not issue a trusted pin after %s and preserves other archives', async kind => {
    fault.parent = parent(); fault.kind = kind; fault.hits = 0; fault.artifactDirectory = '';
    let returned: MutableRetentionPin | undefined;
    try {
      await expect(retain(fault.parent).then(pin => { returned = pin; })).rejects.toThrow(REFUSED);
      expect(returned).toBeUndefined(); expect(fault.hits).toBeGreaterThan(0);
      expect(fault.artifactDirectory).not.toBe('');
      const residual = readFileSync(join(fault.artifactDirectory, 'artifact.json'));
      if (kind === 'write-zero') expect(residual.byteLength).toBe(0);
      else if (kind.startsWith('write-')) expect(residual.byteLength).toBe(113);
      else expect(JSON.parse(residual.toString()).evidence.binding).toEqual(f.binding);
      failed.push({ kind, directory: fault.artifactDirectory, bytes: residual.byteLength, pinReturned: false });
      // Never mint a pin from failed bytes. A previously trusted pin cannot be
      // transplanted to the orphan, even when its directory is supplied instead.
      requests.push({ name: kind, pin: { ...inherited, directory: fault.artifactDirectory }, binding: f.binding, outcome: 'REFUSED' });
      preserve();
    } finally { fault.parent = ''; fault.kind = ''; vi.restoreAllMocks(); }
    retry = await retain(parent()); // failure must release the same-source busy lease
    expect(await readOwnedMutableRetention(retry, f.binding)).toMatchObject({ complete: false, authority: 'NONAUTHORITY' });
    preserve();
  }, 120_000);

  it('refuses simultaneous same-source capture while a partial write is paused, then permits retry', async () => {
    fault.parent = parent(); fault.kind = 'write-paused'; fault.hits = 0;
    let release!: () => void;
    fault.release = new Promise<void>(done => { release = done; });
    const entered = new Promise<void>(done => { fault.entered = done; });
    const attempt = retain(fault.parent).then(() => 'UNEXPECTED_PIN', () => 'REFUSED');
    try {
      await Promise.race([entered, attempt.then(() => { throw new Error('Write fault was not reached'); })]);
      expect(readFileSync(join(fault.artifactDirectory, 'artifact.json')).byteLength).toBe(113);
      const second = parent();
      await expect(retain(second)).rejects.toThrow(REFUSED);
      expect(readdirSync(second)).toEqual([]);
    } finally { release(); await attempt; fault.parent = ''; fault.kind = ''; vi.restoreAllMocks(); }
    expect(await attempt).toBe('REFUSED');
    retry = await retain(parent()); preserve();
  }, 120_000);

  it.each([
    ['tenantId', OTHER], ['migrationJobId', OTHER], ['expectedStateVersion', '999'],
    ['generationId', `full-mutable-stage:${'0'.repeat(64)}`], ['manifestDigest', '0'.repeat(64)], ['sourceFingerprint', '0'.repeat(64)],
  ])('refuses stale or wrong %s before archive creation and again in cold readback', async (key, value) => {
    const root = parent(), binding = { ...f.binding, [key]: value };
    await expect(retain(root, binding)).rejects.toThrow(REFUSED);
    expect(readdirSync(root)).toEqual([]); preserve();
    requests.push({ name: `binding ${key}`, pin: inherited, binding, outcome: 'REFUSED' });
  }, 120_000);

  it('refuses wrong physical source and destination binding without an archive', async () => {
    const root = parent();
    await expect(retainOwnedMutableProvenance(f.source, foreign.sourceOwnerId, f.binding, root)).rejects.toThrow(REFUSED);
    await expect(retainOwnedMutableProvenance(f.destination, f.ownerId, f.binding, root)).rejects.toThrow(REFUSED);
    expect(readdirSync(root)).toEqual([]); preserve();
    requests.push({ name: 'wrong source database pin', pin: { ...inherited, sourceDatabaseId: foreign.sourceDatabaseId }, binding: f.binding, outcome: 'REFUSED' },
      { name: 'wrong source owner pin', pin: { ...inherited, sourceOwnerId: foreign.sourceOwnerId }, binding: f.binding, outcome: 'REFUSED' });
  }, 120_000);

  it('refuses a partial artifact and rehashed wrong-source bytes at independent cold readback', async () => {
    // Only damage new test-owned archives, never either preserved sentinel.
    const partial = await retain(parent());
    writeFileSync(file(partial), inheritedBytes.slice(0, 113));
    requests.push({ name: 'truncated under its original trusted pin', pin: partial, binding: f.binding, outcome: 'REFUSED' },
      { name: 'truncated even with recomputed digest', pin: { ...partial, sha256: sha256(inheritedBytes.slice(0, 113)) }, binding: f.binding, outcome: 'REFUSED' });
    const substituted = await retain(parent());
    const wrapper = JSON.parse(foreignBytes);
    // Rebind artifact identity but keep the other physical source identity. The
    // recomputed digest is a semantic negative, not a claim about signed pins.
    Object.assign(wrapper, { artifactId: substituted.artifactId, ownerId: substituted.ownerId });
    const bytes = canonicalJson(wrapper); writeFileSync(file(substituted), bytes);
    requests.push({ name: 'other physical source rehashed', pin: { ...substituted, sha256: sha256(bytes) }, binding: f.binding, outcome: 'REFUSED' });
    preserve();
  }, 120_000);

  it('real capture SQL failure issues no pin and leaves inherited archives untouched', async () => {
    const root = parent();
    // Owner-installed fault only in disposable source; app remains SELECT-only.
    await f.source.owner.query('REVOKE SELECT ON migration_full_delta_entries FROM app_runtime');
    try {
      await expect(retain(root)).rejects.toThrow(REFUSED);
      expect(readdirSync(root)).toEqual([]); preserve();
    } finally { await f.source.owner.query('GRANT SELECT ON migration_full_delta_entries TO app_runtime'); }
    retry = await retain(parent()); preserve();
  }, 120_000);

  it('closes all owned PG, preserves failed artifacts and queues exact cold acceptance with no source access', async () => {
    expect([await mutableState(f.source), await mutableState(f.destination)]).toEqual(before);
    requests.push({ name: 'successful retry after capture failure', pin: retry, binding: f.binding, outcome: 'VERIFIED' });
    for (const db of [f.source, f.destination]) console.info('TASK19_ATOMICITY_CLOSED', JSON.stringify(await db.close()));
    preserve();
    for (const row of failed) expect(readFileSync(join(row.directory, 'artifact.json')).byteLength).toBe(row.bytes);
    writeFileSync(join(ROOT, 'requests.json'), JSON.stringify({ requests, failed }), { flag: 'wx', mode: 0o600 });
    for (const request of requests) {
      if (request.outcome === 'VERIFIED') expect((await readOwnedMutableRetention(request.pin, request.binding)).coverage.coverage).toHaveLength(16);
      else await expect(readOwnedMutableRetention(request.pin, request.binding)).rejects.toThrow(REFUSED);
    }
  }, 120_000);
});
