import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

// Executable prerequisite probe only, never a browser acceptance receipt.
assert.equal(process.env.TASK20_BROWSER, '1');
assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
assert.equal(existsSync('/home'), false);
assert.equal(existsSync('/run/user'), false);
assert.equal(existsSync('/var/run/docker.sock'), false);
const executable = '/opt/google/chrome/chrome';
const args = ['--headless', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-sync',
  '--user-data-dir=/scratch/task20-sandbox-profile', '--allow-chrome-scheme-url', '--dump-dom', 'chrome://sandbox'];
const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000,
  env: { PATH: '/usr/bin:/bin', HOME: '/scratch', LANG: 'C.UTF-8' } });
const out = '.runner-v2-reports/task20-browser-runtime';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/sandbox.stdout`, result.stdout ?? '');
writeFileSync(`${out}/sandbox.stderr`, result.stderr ?? '');
writeFileSync(`${out}/probe.json`, JSON.stringify({ argv: [executable, ...args],
  exitCode: result.status, signal: result.signal, error: result.error?.message,
  network: readlinkSync('/proc/self/ns/net'),
  browserAcceptance: 'NOT_RUN; chrome://sandbox prerequisite only' }, null, 2));
console.log(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message,
  stdout: result.stdout, stderr: result.stderr }));
assert.equal(result.error, undefined);
assert.equal(result.status, 0);
assert.match(result.stdout, /You are adequately sandboxed/);
for (const label of ['Namespace Sandbox', 'PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']) {
  assert.match(result.stdout, new RegExp(`${label}</td><td>Yes</td>`));
}
