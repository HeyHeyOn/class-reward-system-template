import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

assert.equal(process.env.TASK20_BROWSER, '1');
assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
for (const path of ['/home', '/run/user', '/var/run/docker.sock', '/etc/resolv.conf']) assert.equal(existsSync(path), false);
const out = '.runner-v2-reports/task20-browser-alternatives';
mkdirSync(out, { recursive: true });
const targets = [
  ['playwright', '/task20-runtimes/playwright/chrome'],
  ['playwright-shell', '/task20-runtimes/playwright-shell/chrome-headless-shell'],
  ['puppeteer', '/task20-runtimes/puppeteer/chrome'],
];
const results = targets.map(([name, executable]) => {
  const args = ['--headless', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-sync',
    `--user-data-dir=/scratch/task20-${name}`, '--dump-dom', 'about:blank'];
  const r = spawnSync(executable, args, { encoding: 'utf8', timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', HOME: '/scratch', LANG: 'C.UTF-8' } });
  const result = { name, argv: [executable, ...args], exitCode: r.status, signal: r.signal, error: r.error?.message,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    stdout: r.stdout, stderr: r.stderr };
  writeFileSync(`${out}/${name}.json`, JSON.stringify(result, null, 2));
  return result;
});
const helper = statSync('/opt/google/chrome/chrome-sandbox');
const result = { browserAcceptance: 'NOT_RUN; prerequisite diagnostics only',
  namespace: readlinkSync('/proc/self/ns/net'), uidMap: readFileSync('/proc/self/uid_map', 'utf8'),
  helper: { uid: helper.uid, gid: helper.gid, mode: (helper.mode & 0o7777).toString(8) }, results };
writeFileSync(`${out}/summary.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
// All candidates blocked is a failing prerequisite, not successful acceptance.
process.exitCode = results.some(r => r.exitCode === 0 && r.stdout.includes('<html')) ? 0 : 1;
