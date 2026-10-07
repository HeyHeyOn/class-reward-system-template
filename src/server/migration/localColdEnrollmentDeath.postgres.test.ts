// @vitest-environment node
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from './validators';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const serial = ['--maxWorkers=1', '--no-file-parallelism', '--pool=threads', '--reporter=default', '--reporter=json'];
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1' };
function save(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
function files() {
  const result: Record<string, string> = {};
  function visit(path: string) {
    if (!existsSync(path)) return;
    const s = lstatSync(path);
    result[path] = s.isDirectory() ? 'directory' : s.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'special';
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  }
  visit('.cold-restore-control'); visit('.cold-restore-transport'); return result;
}
function preserved(before: Record<string, string>) { const after = files(); for (const [p, value] of Object.entries(before)) expect(after[p], p).toBe(value); }
function dockerIds() { return execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc'],
  { env, encoding: 'utf8', timeout: 30_000 }).trim().split('\n').filter(Boolean).sort(); }
type Worker = { child: ChildProcess; prefix: string; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; log: () => string };
function launch(request: Record<string, unknown>): Worker {
  mkdirSync('.enrollment-results', { recursive: true, mode: 0o700 });
  const prefix = `.enrollment-results/${randomUUID()}`;
  save(`${prefix}-request.json`, { ...request, prefix });
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/coldEnrollmentChild.test.ts', ...serial,
    `--outputFile.json=${prefix}-vitest.json`], { env: { ...env, ENROLLMENT_REQUEST: `${prefix}-request.json` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout!.on('data', b => { log += b; }); child.stderr!.on('data', b => { log += b; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, prefix, exit, log: () => log };
}
async function waitFile(w: Worker, suffix: string, milliseconds = 120_000) {
  const end = Date.now() + milliseconds, path = `${w.prefix}-${suffix}.json`;
  while (!existsSync(path)) {
    if (w.child.exitCode !== null || w.child.signalCode !== null || Date.now() > end) throw new Error(`Child ${suffix} absent: ${w.log()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}
async function reap(w: Worker, kill = false) {
  if (kill && w.child.exitCode === null && w.child.signalCode === null) expect(w.child.kill('SIGKILL')).toBe(true);
  const exit = await w.exit;
  if (!existsSync(`${w.prefix}-process.json`)) save(`${w.prefix}-process.json`, { ...exit, pid: w.child.pid, log: w.log() });
  return exit;
}
async function read(anchor: unknown, binding: unknown) {
  const w = launch({ action: 'read', anchor, binding });
  try {
    const result = await waitFile(w, 'result', 30_000);
    expect(await reap(w)).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(`${w.prefix}-vitest.json`, 'utf8'))).toMatchObject({ numPassedTests: 1, numFailedTests: 0, success: true });
    expect(result.pid).toBe(w.child.pid); return result;
  } catch (error) { await reap(w, true); throw error; }
}
async function crash(checkpoint: 'expectation' | 'state') {
  const baseline = files(), containers = dockerIds(), w = launch({ action: 'enroll', checkpoint });
  try {
    const ready = await waitFile(w, 'ready'), setup = JSON.parse(readFileSync(`${w.prefix}-setup.json`, 'utf8'));
    expect(ready.pid).toBe(w.child.pid); expect(setup.pid).toBe(ready.pid);
    expect(existsSync(`${w.prefix}-ack.json`)).toBe(false);
    const retained = files();
    expect(await reap(w, true)).toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(`${w.prefix}-ack.json`)).toBe(false);
    expect(files()).toEqual(retained); preserved(baseline); expect(dockerIds()).toEqual(containers);
    const path = `.cold-restore-control/${ready.id}`, bytes = readFileSync(`${path}/expectation.json`), e = JSON.parse(bytes.toString());
    expect(sha256(bytes.toString())).toBe(ready.expectationSha256);
    expect(e.seal.original.contract).toBe('LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1'); expect(e.seal.prepared).toBeUndefined();
    expect(e.seal.sourceId).toBe(setup.intent.sourceDatabaseId); expect(e.seal.original.candidateDatabaseId).toBe(setup.intent.destinationDatabaseId);
    expect(sha256(readFileSync(`.cold-restore-transport/${ready.id}.sql`, 'utf8'))).toBe(e.seal.digest);
    expect(readdirSync(path).sort()).toEqual(checkpoint === 'state' ? ['expectation.json', 'state.json'] : ['expectation.json']);
    for (const closed of setup.closed) expect(containers).not.toContain(closed.evidence.containerId);
    // This is an attacker/diagnostic claim, deliberately NOT an issued anchor.
    const unissued = { id: ready.id, ownerId: e.seal.sourceOwner, expectationSha256: sha256(bytes.toString()) };
    save(`${w.prefix}-death-readback.json`, { ready, setup, unissued, callerAcknowledged: false, files: retained, containers,
      cleanupSupported: false, enrollmentObservation: checkpoint === 'state' ? 'UNACKNOWLEDGED_READY' : 'INCOMPLETE_NONAUTHORITY',
      successorAuthority: 'NOT_PROVEN', storageBoundary: 'same UID synthetic TCB; not protected enrollment root' });
    console.info('ENROLLMENT_DEATH', JSON.stringify({ prefix: w.prefix, checkpoint, pid: ready.pid, id: ready.id, sourceClosed: true }));
    return { ...setup, ready, unissued, path, retained, prefix: w.prefix, containers };
  } catch (error) { if (w.child.exitCode === null && w.child.signalCode === null) await reap(w, true); throw error; }
}
suite('Task21 ORIGINAL enrollment process death', () => {
  it.each(['expectation', 'state'] as const)('preserves %s checkpoint residue without inventing cleanup authority after cold readback', async checkpoint => {
    const f = await crash(checkpoint);
    expect(f.ready.publishedState).toEqual(checkpoint === 'state' ? { id: f.ready.id, status: 'READY', lastAttempt: null } : null);
    const failed = await read({ ...f.unissued, expectationSha256: '0'.repeat(64) }, f.binding);
    expect(failed.outcome.accepted).toBe(false); expect(files()).toEqual(f.retained);
    const otherOwner = await read({ ...f.unissued, ownerId: randomUUID() }, f.binding);
    const otherBinding = await read(f.unissued, { ...f.binding, sourceFingerprint: '0'.repeat(64) });
    const crossedProfile = await read({ ...f.inherited, expectationSha256: f.candidate.expectationSha256 }, f.binding);
    for (const refused of [otherOwner, otherBinding, crossedProfile]) expect(refused.outcome.accepted).toBe(false);
    expect(files()).toEqual(f.retained);
    const observation = await read(f.unissued, f.binding);
    expect(observation.pid).not.toBe(f.ready.pid);
    // Characterization only: full same-UID journal bytes can be read using a
    // reconstructed claim. No supported restart/cleanup or lease is inferred.
    expect(observation.outcome.accepted).toBe(checkpoint === 'state');
    expect(files()).toEqual(f.retained);
    const inherited = await read(f.inherited, f.binding), candidate = await read(f.candidate, f.binding);
    expect(inherited.outcome).toMatchObject({ accepted: true, original: 'LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1', prepared: null,
      copiedLeaseAccepted: false, copiedBackupAccepted: false });
    expect(candidate.outcome).toMatchObject({ accepted: true, original: null, prepared: 'LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1',
      copiedLeaseAccepted: false, copiedBackupAccepted: false });
    expect(files()).toEqual(f.retained);
    if (checkpoint === 'expectation') {
      // Specific protected-root blocker: this UID can create a coherent READY
      // journal. Existing private modes/hashes cannot certify its producer.
      const forged = `${f.path}/state.json`;
      save(forged, { id: f.ready.id, status: 'READY', lastAttempt: null });
      const beforeForged = files(), copied = await read(f.unissued, f.binding);
      expect(copied.outcome).toMatchObject({ accepted: true, copiedLeaseAccepted: false, copiedBackupAccepted: false });
      expect(files()).toEqual(beforeForged);
      renameSync(forged, `${f.prefix}-same-uid-forged-state.json`); // Preserve fault, not runtime cleanup.
      expect(files()).toEqual(f.retained);
      save(`${f.prefix}-protected-root-boundary.json`, { before: observation, forged: copied, mode: lstatSync(f.path).mode & 0o777,
        uid: lstatSync(f.path).uid, processUid: process.getuid!(), authorityMinted: false,
        conclusion: 'Journal/path/hash cannot distinguish trusted enrollment from coherent same-UID forgery. Automatic adoption/removal remains unsupported.' });
    }
    expect(dockerIds()).toEqual(f.containers);
  }, 240_000);

  it('refuses a FIFO substituted in killed enrollment residue without a writer releasing the cold reader', async () => {
    const f = await crash('expectation'), target = `${f.path}/expectation.json`, retained = `${f.prefix}-retained-expectation.json`;
    renameSync(target, retained); execFileSync('mkfifo', ['-m', '600', target], { env });
    const w = launch({ action: 'read', anchor: f.unissued, binding: f.binding });
    let writerRequired = false;
    try {
      const opened = await waitFile(w, 'open', 30_000); expect(opened.pid).toBe(w.child.pid);
      const end = Date.now() + 3000;
      while (!existsSync(`${w.prefix}-result.json`) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
      writerRequired = !existsSync(`${w.prefix}-result.json`);
      if (writerRequired) {
        // Real FIFO peer releases blocked O_RDONLY open, allowing fstat to reject.
        // This is fixture-assisted teardown, never a passing prompt refusal.
        const writer = openSync(target, constants.O_WRONLY | constants.O_NONBLOCK); closeSync(writer);
      }
      const result = await waitFile(w, 'result', 30_000);
      expect(await reap(w)).toEqual({ code: 0, signal: null });
      expect(result.outcome).toMatchObject({ accepted: false, error: 'Cold restore refused.' });
      save(`${f.prefix}-fifo-observation.json`, { opened, result, writerRequired, mode: lstatSync(target).mode, callerAcknowledged: false });
    } finally {
      if (w.child.exitCode === null && w.child.signalCode === null) await reap(w, true);
      renameSync(target, `${f.prefix}-rejected-fifo`); renameSync(retained, target);
    }
    expect(files()).toEqual(f.retained); // Original/CANDIDATE and residue unchanged; no stranded reader lock.
    const good = await read(f.inherited, f.binding); expect(good.outcome.accepted).toBe(true);
    expect(files()).toEqual(f.retained); expect(dockerIds()).toEqual(f.containers);
    expect(writerRequired, 'cold fail-closed reader must reject a FIFO without peer/writer intervention').toBe(false);
  }, 240_000);
});
