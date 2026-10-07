import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { RecoveryRequest } from './task19MixedRecoveryV2';
export const postcommitDirectory = '.task19-mixed-postcommit-v2';
export type PostcommitRequest = Omit<RecoveryRequest, 'phase' | 'boundary'> & {
  phase: 'prepare' | 'crash' | 'resume' | 'retry' | 'negatives' | 'partial';
  boundary: 'destination-precommit' | 'destination-postcommit';
};
export function postcommitSave(id: string, suffix: string, value: unknown) {
  mkdirSync(postcommitDirectory, { recursive: true, mode: 0o700 });
  const path = `${postcommitDirectory}/${id}-${suffix}.json`;
  if (existsSync(path)) throw new Error('Fresh evidence path required');
  writeFileSync(path + '.part', JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(path + '.part', path);
}
const environment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1' });
const args = (id: string) => ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19MixedPostcommitV2Child.test.ts',
  '--maxWorkers=1', '--no-file-parallelism', '--pool=threads', '--reporter=default', '--reporter=json',
  `--outputFile.json=${postcommitDirectory}/${id}-vitest.json`];
const env = (id: string) => ({ ...environment(), POSTCOMMIT_REQUEST: `${postcommitDirectory}/${id}-request.json`, POSTCOMMIT_ID: id });
const exec = promisify(execFile);
export async function postcommitChild(request: PostcommitRequest) {
  const id = randomUUID(); postcommitSave(id, 'request', request);
  let exit: number | string = 0, stdout = '', stderr = '';
  try { ({ stdout, stderr } = await exec(process.execPath, args(id), { env: env(id), timeout: 600_000, maxBuffer: 12_000_000 })); }
  catch (error) { const e = error as { code: number | string; stdout: string; stderr: string }; exit = e.code; stdout = e.stdout; stderr = e.stderr; }
  postcommitSave(id, 'execution', { exit, stdout, stderr });
  expect(exit, stdout + stderr).toBe(0);
  const result = JSON.parse(readFileSync(`${postcommitDirectory}/${id}-result.json`, 'utf8'));
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  expect(JSON.parse(readFileSync(`${postcommitDirectory}/${id}-vitest.json`, 'utf8')))
    .toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  return { ...result, resultPath: `${postcommitDirectory}/${id}-result.json` };
}
type End = { code: number | null; signal: NodeJS.Signals | null };
type Worker = { child: ChildProcess; id: string; exit: Promise<End>; close: Promise<End>; log: () => string };
const workers: Worker[] = [];
export async function postcommitWorker(request: PostcommitRequest) {
  const id = randomUUID(); postcommitSave(id, 'request', request); let output = '';
  const child = spawn(process.execPath, args(id), { env: env(id), stdio: ['ignore', 'pipe', 'pipe'] });
  const event = (name: 'exit' | 'close') => new Promise<End>((resolve, reject) => {
    child.once('error', reject); child.once(name, (code, signal) => resolve({ code, signal }));
  });
  const w: Worker = { child, id, exit: event('exit'), close: event('close'), log: () => output }; workers.push(w);
  child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
  const path = `${postcommitDirectory}/${id}-barrier.json`, deadline = Date.now() + 180_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Postcommit barrier failed: ${output}`);
    await new Promise(done => setTimeout(done, 50));
  }
  const barrier = JSON.parse(readFileSync(path, 'utf8'));
  expect(barrier.pid).toBe(child.pid);
  return { ...w, barrier };
}
export function noPostcommitAck(id: string) {
  expect(existsSync(`${postcommitDirectory}/${id}-caller-ack.json`)).toBe(false);
  expect(existsSync(`${postcommitDirectory}/${id}-result.json`)).toBe(false);
}
export async function killPostcommitWorker(w: Awaited<ReturnType<typeof postcommitWorker>>) {
  noPostcommitAck(w.id);
  expect(w.child.kill('SIGKILL')).toBe(true);
  const exit = await w.exit, close = await w.close;
  postcommitSave(w.id, 'termination', { pid: w.child.pid, exit, close, output: w.log() });
  expect(exit).toEqual({ code: null, signal: 'SIGKILL' }); expect(close).toEqual(exit);
  noPostcommitAck(w.id);
}
export async function cleanupPostcommitWorkers() {
  for (const w of workers.splice(0)) {
    if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGKILL');
    await w.close;
  }
}
