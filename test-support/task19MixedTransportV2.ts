import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { WireRequest } from './task19MixedWireV2';
export type TransportRequest = WireRequest;
export const transportDirectory = '.task19-mixed-transport-v2';
export function transportSave(id: string, suffix: string, value: unknown) {
  mkdirSync(transportDirectory, { recursive: true, mode: 0o700 });
  const path = `${transportDirectory}/${id}-${suffix}.json`;
  if (existsSync(path)) throw new Error('Fresh transport evidence path required');
  writeFileSync(path + '.part', JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(path + '.part', path);
}
type End = { code: number | null; signal: NodeJS.Signals | null };
type Worker = { child: ChildProcess; id: string; exit: Promise<End>; close: Promise<End>; log: () => string };
const workers: Worker[] = [];
function launch(request: TransportRequest) {
  const id = randomUUID(); transportSave(id, 'request', request); let output = '';
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19MixedTransportV2Child.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--pool=threads', '--reporter=default', '--reporter=json',
    `--outputFile.json=${transportDirectory}/${id}-vitest.json`], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
      TRANSPORT_REQUEST: `${transportDirectory}/${id}-request.json`, TRANSPORT_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] });
  const event = (name: 'exit' | 'close') => new Promise<End>((resolve, reject) => {
    child.once('error', reject); child.once(name, (code, signal) => resolve({ code, signal }));
  });
  const w = { child, id, exit: event('exit'), close: event('close'), log: () => output }; workers.push(w);
  child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
  return w;
}
export async function transportWorker(request: TransportRequest) {
  const w = launch(request), path = `${transportDirectory}/${w.id}-barrier.json`, deadline = Date.now() + 180_000;
  while (!existsSync(path)) {
    if (w.child.exitCode !== null || w.child.signalCode !== null || Date.now() > deadline) throw new Error(`Transport barrier failed: ${w.log()}`);
    await new Promise(done => setTimeout(done, 50));
  }
  const barrier = JSON.parse(readFileSync(path, 'utf8')); expect(barrier.pid).toBe(w.child.pid);
  return { ...w, barrier };
}
async function finished(w: Worker) {
  const exit = await w.exit, close = await w.close;
  transportSave(w.id, 'execution', { pid: w.child.pid, exit, close, output: w.log() });
  expect(exit, w.log()).toEqual({ code: 0, signal: null }); expect(close).toEqual(exit);
  const result = JSON.parse(readFileSync(`${transportDirectory}/${w.id}-result.json`, 'utf8'));
  expect(result.ok, JSON.stringify(result.error)).toBe(true); expect(result.pid).toBe(w.child.pid);
  expect(JSON.parse(readFileSync(`${transportDirectory}/${w.id}-vitest.json`, 'utf8')))
    .toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  return { ...result, resultPath: `${transportDirectory}/${w.id}-result.json`, exit };
}
export async function closeTransportAndFinish(w: Awaited<ReturnType<typeof transportWorker>>) {
  expect(existsSync(`${transportDirectory}/${w.id}-driver-settled.json`)).toBe(false);
  transportSave(w.id, 'release', { pid: w.child.pid, closeExactBorrowedTransport: true });
  return finished(w);
}
export async function transportChild(request: TransportRequest) { return finished(launch(request)); }
export async function cleanupTransportWorkers() {
  // Failing test teardown only. A successful transport proof never kills its app.
  for (const w of workers.splice(0)) {
    if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGKILL');
    await w.close;
  }
}
