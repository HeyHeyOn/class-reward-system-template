import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export const scratch = '/scratch/crs-task20';
export const sourceInputs = [
  'src/app/c/[slug]/admin/migrations/history/page.tsx',
  'src/app/api/migrations/status/[slug]/preflight/download/route.ts',
  'src/app/api/migrations/status/readHistoricalReportDownload.ts',
  'src/app/api/migrations/status/readPreflightReport.ts',
  'src/app/api/migrations/status/preflightReportProjection.ts',
  'src/server/googleOAuth.ts', 'src/server/tenantAuth.ts', 'src/server/tenantContext.ts',
  'src/server/db/config.ts',
  'src/app/layout.tsx', 'src/app/c/[slug]/layout.tsx',
  'src/server/LegacyMigrationNotice.tsx', 'src/server/legacyDeploymentMode.ts',
] as const;

type Receipt = {
  runId: string;
  environmentId: string;
  snapshotManifestSha256: string;
  independentVerifier: string;
  origin: string;
  cdpUrl: string;
  pgPort: number;
  processIds: { next: number; browser: number; postgres: number };
  sourceHashes: Record<string, string>;
};

export function checkSources(receipt: Receipt) {
  for (const path of sourceInputs) {
    assert.match(receipt.sourceHashes[path], /^[a-f0-9]{64}$/);
    const actual = createHash('sha256').update(readFileSync(`/fixture/${path}`)).digest('hex');
    assert.equal(actual, receipt.sourceHashes[path], `Snapshot changed: ${path}`);
  }
}

/** Fail BEFORE importing pg, opening HTTP/CDP sockets or accepting a URL.
 * This is a necessary in-process check, NOT a sandbox launcher/certification.
 * A trusted supervisor must create the receipt after proving the whole topology.
 * No host mode, alternate path, environment-URL input or auto-start fallback.
 */
export function requireIsolatedFixture(): Receipt {
  for (const path of ['/home', '/root', '/run', '/var/run', '/etc/resolv.conf']) {
    assert.equal(existsSync(path), false, 'NOT_RUN: operational filesystem visible');
  }
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'NOT_RUN: not loopback-only');
  assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
  for (const line of readFileSync('/proc/net/ipv6_route', 'utf8').trim().split('\n').filter(Boolean)) {
    const row = line.trim().split(/\s+/);
    assert.equal(row.at(-1), 'lo');
    assert.ok([`${'0'.repeat(32)}`, `${'0'.repeat(31)}1`].includes(row[0]));
    if (row[0] === '0'.repeat(32)) assert.ok(parseInt(row[8], 16) & 0x200);
  }
  for (const key of Object.keys(process.env)) {
    assert.ok(!/^(?:GOOGLE_|GENERATOR_|DATABASE_URL$|DIRECT_DATABASE_URL$|PG|REDIS|UPSTASH|AUTH_SECRET$|ADMIN_PASSWORD$|NODE_OPTIONS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key),
      'NOT_RUN: credential or transport override in runner environment');
  }
  for (const dir of ['/fixture', '/fixture/src', '/scratch']) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local']) {
      assert.equal(existsSync(`${dir}/${name}`), false, 'NOT_RUN: dotenv file visible');
    }
  }
  const receiptPath = `${scratch}/fixture.json`;
  assert.equal(realpathSync(receiptPath), receiptPath);
  assert.ok(statSync(receiptPath).size < 32_768);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  assert.match(receipt.runId, /^[a-f0-9]{32}$/);
  assert.match(receipt.snapshotManifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(receipt.environmentId && receipt.independentVerifier);
  const origin = new URL(receipt.origin);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.origin, receipt.origin);
  assert.ok(origin.port);
  const cdp = new URL(receipt.cdpUrl);
  assert.equal(cdp.protocol, 'ws:');
  assert.equal(cdp.hostname, '127.0.0.1');
  assert.ok(cdp.port);
  assert.ok(Number.isInteger(receipt.pgPort) && receipt.pgPort > 0 && receipt.pgPort < 65536);
  assert.equal(new Set([Number(origin.port), Number(cdp.port), receipt.pgPort]).size, 3);
  const net = readlinkSync('/proc/self/ns/net');
  for (const [kind, pid] of Object.entries(receipt.processIds)) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(statSync(`/proc/${pid}`).uid, process.getuid?.());
    assert.equal(readlinkSync(`/proc/${pid}/ns/net`), net, 'NOT_RUN: process namespace mismatch');
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (kind === 'next') assert.equal(readlinkSync(`/proc/${pid}/cwd`), '/fixture');
    if (kind === 'browser') {
      assert.ok(argv.includes(`--user-data-dir=${scratch}/chrome`));
      assert.ok(!argv.some(arg => /no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox/.test(arg)));
    }
    if (kind === 'postgres') assert.ok(argv.includes(`${scratch}/pg`));
  }
  assert.deepEqual(Object.keys(receipt.processIds).sort(), ['browser', 'next', 'postgres']);
  checkSources(receipt);
  return receipt;
}
