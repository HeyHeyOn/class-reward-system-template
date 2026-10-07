import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import assert from 'node:assert/strict';

assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
assert.equal(existsSync('/home'), false);
const probes = [
  ['/usr/bin/google-chrome', ['--headless', '--remote-debugging-port=0', '--user-data-dir=/scratch/task20-chrome', 'about:blank']],
  ['/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/scratch', '--clearenv', '--', '/usr/bin/true']],
];
const results = probes.map(([file, args]) => {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: '/scratch' } });
  return { argv: [file, ...args], status: r.status, signal: r.signal, error: r.error?.message,
    stdout: r.stdout, stderr: r.stderr };
});
console.log(JSON.stringify({ network: readlinkSync('/proc/self/ns/net'), results,
  browser: 'NOT_EXECUTED; runtime prerequisite probe only; no sandbox relaxation' }, null, 2));
// A blocked probe is not PASS and must retain its nonzero terminal receipt.
process.exitCode = results.some(r => r.status !== 0) ? 1 : 0;
