import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { MixedArchiveRequest } from './task19MixedArchiveV2';
export const recoveryDirectory = '.task19-mixed-recovery-v2';
export type RecoveryRequest = Omit<Extract<MixedArchiveRequest, { phase: 'rebuild' | 'retry' }>, 'phase'> & {
  phase: 'crash' | 'resume' | 'retry' | 'reject-partial';
  boundary: 'source-records' | 'source-staged' | 'source-committed' | 'destination-dml';
};
export function recoverySave(id: string, suffix: string, value: unknown) {
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const path = `${recoveryDirectory}/${id}-${suffix}.json`;
  writeFileSync(path + '.part', JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(path + '.part', path);
}
const environment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1' });
const args = (id: string) => ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19MixedRecoveryV2Child.test.ts',
  '--maxWorkers=1', '--no-file-parallelism', '--pool=threads', '--reporter=default', '--reporter=json',
  `--outputFile.json=${recoveryDirectory}/${id}-vitest.json`];
const exec = promisify(execFile);
export async function recoveryProducer(tombstone: boolean) {
  const id = randomUUID(), prefix = `.task19-mixed-v2-results/${id}`;
  mkdirSync('.task19-mixed-v2-results', { recursive: true, mode: 0o700 });
  writeFileSync(`${prefix}-request.json`, JSON.stringify({ phase: 'produce', tombstone }), { flag: 'wx', mode: 0o600 });
  const argv = ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19MixedArchiveV2Child.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--pool=threads', '--reporter=default', '--reporter=json', `--outputFile.json=${prefix}-vitest.json`];
  const { stdout, stderr } = await exec(process.execPath, argv, { env: { ...environment(), TASK19_MIXED_V2_REQUEST: `${prefix}-request.json` },
    timeout: 600_000, maxBuffer: 12_000_000 });
  recoverySave(id, 'execution', { exit: 0, stdout, stderr });
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8'));
  expect(result).toMatchObject({ success: true, poolsClosed: true, phase: 'produce' });
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8'))).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  return result;
}
export async function recoveryChild(request: RecoveryRequest) {
  const id = randomUUID(); recoverySave(id, 'request', request);
  let exit: number | string = 0, stdout = '', stderr = '';
  try { ({ stdout, stderr } = await exec(process.execPath, args(id), { env: { ...environment(),
    MIXED_RECOVERY_REQUEST: `${recoveryDirectory}/${id}-request.json`, MIXED_RECOVERY_ID: id }, timeout: 600_000, maxBuffer: 12_000_000 })); }
  catch (error) { const e = error as { code: number | string; stdout: string; stderr: string }; exit = e.code; stdout = e.stdout; stderr = e.stderr; }
  recoverySave(id, 'execution', { exit, stdout, stderr });
  expect(exit, stdout + stderr).toBe(0);
  const result = JSON.parse(readFileSync(`${recoveryDirectory}/${id}-result.json`, 'utf8'));
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const report = JSON.parse(readFileSync(`${recoveryDirectory}/${id}-vitest.json`, 'utf8'));
  expect(report.numPassedTests).toBe(1); expect(report.numFailedTests).toBe(0);
  return { ...result, resultPath: `${recoveryDirectory}/${id}-result.json` };
}
type End = { code: number | null; signal: NodeJS.Signals | null };
type Worker = { child: ChildProcess; id: string; exit: Promise<End>; close: Promise<End>; log: () => string };
const workers: Worker[] = [];
export async function recoveryWorker(request: RecoveryRequest) {
  const id = randomUUID(); recoverySave(id, 'request', request); let output = '';
  const child = spawn(process.execPath, args(id), { env: { ...environment(),
    MIXED_RECOVERY_REQUEST: `${recoveryDirectory}/${id}-request.json`, MIXED_RECOVERY_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] });
  const event = (name: 'exit' | 'close') => new Promise<End>((resolve, reject) => {
    child.once('error', reject); child.once(name, (code, signal) => resolve({ code, signal }));
  });
  const w: Worker = { child, id, exit: event('exit'), close: event('close'), log: () => output }; workers.push(w);
  child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
  const path = `${recoveryDirectory}/${id}-barrier.json`, deadline = Date.now() + 180_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Recovery barrier failed: ${output}`);
    await new Promise(done => setTimeout(done, 50));
  }
  const barrier = JSON.parse(readFileSync(path, 'utf8'));
  expect(barrier.pid).toBe(child.pid);
  return { ...w, barrier };
}
export async function killRecoveryWorker(w: Awaited<ReturnType<typeof recoveryWorker>>) {
  expect(w.child.kill('SIGKILL')).toBe(true);
  const exit = await w.exit, close = await w.close;
  recoverySave(w.id, 'termination', { pid: w.child.pid, exit, close, output: w.log() });
  expect(exit).toEqual({ code: null, signal: 'SIGKILL' }); expect(close).toEqual(exit);
}
export async function cleanupRecoveryWorkers() {
  for (const w of workers.splice(0)) {
    if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGKILL');
    await w.close;
  }
}
