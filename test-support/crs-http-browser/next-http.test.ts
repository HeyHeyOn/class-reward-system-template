// @vitest-environment node
// Executed only by the unchanged v2 run-pg sandbox. Never import a route/page.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '../../src/server/db/testing/disposablePostgres';
import { archiveReportId, comparisonVariants, details, downloadPath, filename, fixture, historyPath, reportId, selectors, sessionCookie } from './fixture';

vi.mock('server-only', () => ({})); // Marker in the test process only; Next has no mocks/aliases.
const enabled = process.env.RUN_REAL_POSTGRES === '1';
const OTHER = '10000000-0000-4000-8000-000000000002';
const FOREIGN_CANARY = 'TASK20_FOREIGN_DATA_CANARY';
const statusPath = `/api/migrations/status/${fixture.slug}?jobId=${encodeURIComponent(fixture.job)}`;
const pagePath = `/c/${fixture.slug}/admin/migrations/status?${selectors}`;
const reportPath = `/api/migrations/status/${fixture.slug}/preflight?${selectors}`;
const snapshotSummary = '과거 스냅샷 식별 정보 확인 (읽기 전용)';
const output = resolve('.runner-v2-reports/task20-http');
const requests: unknown[] = [];
const relays = new Set<ChildProcess>();
const sockets = new Set<Socket>();
let db: Awaited<ReturnType<typeof createDisposablePostgres>> | undefined;
let pgServer: Server | undefined;
let next: ChildProcess | undefined;
let origin: string;
let cookie: string;
let initialRows: unknown;
let app: string;
const copiedHashes: Record<string, string> = {};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function copiedSource(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const source = `${path}/${entry.name}`;
    if (entry.isDirectory()) await copiedSource(source);
    else if (entry.isFile()) {
      copiedHashes[source] = hash(await readFile(source));
      expect(hash(await readFile(`${app}/${source}`))).toBe(copiedHashes[source]);
    } else throw new Error('Unexpected symlink in frozen source');
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  return address.port;
}
async function rows() {
  const result: Record<string, unknown> = {};
  const tables = (await db!.owner.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename: table } of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected fixture relation');
    result[table] = (await db!.owner.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
  }
  return result;
}
async function request(path: string, auth = cookie, method: 'GET' | 'HEAD' = 'GET', conditions: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...conditions, ...(auth ? { Cookie: `${fixture.cookieName}=${auth}` } : {}) },
    redirect: 'manual', signal: AbortSignal.timeout(120_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  const headers = Object.fromEntries(response.headers);
  const index = requests.length;
  await writeFile(`${output}/response-${index}.body`, bytes);
  requests.push({ method, path, auth: auth ? 'synthetic-session' : 'none', conditions,
    syntheticCookieSha256: auth ? createHash('sha256').update(auth).digest('hex') : null,
    status: response.status, headers, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(`${output}/requests.json`, JSON.stringify(requests, null, 2));
  expect(text).not.toContain(FOREIGN_CANARY);
  expect(text).not.toContain(fixture.privateCanary);
  expect(text).not.toContain(fixture.secret);
  expect(text).not.toContain(fixture.privateCanary.toLowerCase());
  if (auth) expect(text).not.toContain(auth);
  return { response, bytes, text, headers };
}
function protectedJson(r: Awaited<ReturnType<typeof request>>, status: number) {
  expect(r.response.status).toBe(status);
  expect(r.headers['cache-control']).toContain('no-store');
  expect(r.headers['referrer-policy']).toBe('no-referrer');
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child required forced shutdown')); }, 15_000);
    child.once('exit', () => { clearTimeout(timer); accept(); });
    child.kill('SIGTERM');
  });
}

// The legacy PG file on the CLI satisfies v2's fixed allowlist; -t selects ONLY
// this separately-owned suite. No edit to that legacy file or to v2 is required.
describe.skipIf(!enabled)('Task20 synthetic Next HTTP', () => {
  beforeAll(async () => {
    expect(Object.keys(networkInterfaces())).toEqual(['lo']);
    expect((await readFile('/proc/net/route', 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(process.cwd()).toBe('/fixture');
    await mkdir(output, { recursive: true });
    db = await createDisposablePostgres();
    await writeFile(`${output}/database.json`, JSON.stringify(db.evidence, null, 2));
    // Narrow read grants only, on this freshly allocated synthetic cluster.
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime`);
    await db.owner.query(`INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,'Synthetic alpha'),($3,$4,$5)`,
      [fixture.tenant, fixture.slug, OTHER, fixture.foreignSlug, FOREIGN_CANARY]);
    await db.owner.query('INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES($1,$2,$3,$4)',
      [fixture.user, fixture.subject, `${fixture.privateCanary.toLowerCase()}@example.invalid`, fixture.privateCanary]);
    await db.owner.query("INSERT INTO tenant_memberships(id,tenant_id,user_id,role) VALUES($1,$2,$3,'ADMIN')",
      [fixture.member, fixture.tenant, fixture.user]);
    for (const tenant of [fixture.tenant, OTHER]) {
      await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'DISCOVERED')", [tenant, fixture.job]);
      await db.owner.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
        VALUES($1,$2,$3,'MIGRATION_RECONCILIATION_PREFLIGHT',$4::jsonb)`,
      [tenant, reportId, fixture.job, JSON.stringify(details)]);
      for (const variant of comparisonVariants) {
        // Seed a valid tenant-bound archive in BOTH tenants. A wrong-tenant
        // refusal must not merely be a missing/invalid foreign report.
        await db.owner.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
          VALUES($1,$2,$3,'MIGRATION_RECONCILIATION_PREFLIGHT',$4::jsonb)`,
        [tenant, archiveReportId(tenant, variant.archive), fixture.job, JSON.stringify(variant.archive)]);
      }
    }
    await db.owner.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
      VALUES($1,$2,$3,'MIGRATION_RECONCILIATION_PREFLIGHT',$4::jsonb)`,
    [fixture.tenant, `reconciliation:${'d'.repeat(64)}`, fixture.job, JSON.stringify(details)]);
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'different-job','DISCOVERED')", [fixture.tenant]);
    initialRows = await rows();
    await writeFile(`${output}/comparison-variants.json`, JSON.stringify(comparisonVariants, null, 2));
    // Native pg wire, not a SQL mock: private loopback -> docker exec -> the
    // launcher-recorded exact owned container's Unix socket relay. No host ports.
    const ownedId = db.evidence.containerId;
    if (typeof ownedId !== 'string' || !/^[a-f0-9]{64}$/.test(ownedId)) throw new Error('Missing exact owned PG ID');
    pgServer = createServer(socket => {
      sockets.add(socket);
      const child = spawn('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', '--user', 'postgres', ownedId, '/test-bin/pg-stdio-relay'], {
        env: { PATH: '/usr/bin:/bin', HOME: '/scratch', DOCKER_CONFIG: '/scratch/docker-config', NODE_ENV: 'test' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      relays.add(child);
      child.stderr!.pipe(createWriteStream(`${output}/pg-relay.log`, { flags: 'a' }));
      child.once('error', () => socket.destroy());
      child.once('close', () => { relays.delete(child); socket.destroy(); });
      socket.on('error', () => { child.kill('SIGTERM'); });
      child.stdin!.on('error', () => socket.destroy());
      socket.once('close', () => { sockets.delete(socket); child.kill('SIGTERM'); });
      socket.pipe(child.stdin!); child.stdout!.pipe(socket);
    });
    const pgPort = await listen(pgServer);
    const databaseUrl = `postgresql://app_runtime@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
    const probe = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    try {
      const role = await probe.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      const tenant = await probe.query('SELECT * FROM public.platform_find_tenant_by_slug($1)', [fixture.slug]);
      const member = await probe.query('SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1,$2)',
        [fixture.tenant, fixture.subject]);
      await writeFile(`${output}/transport-probe.json`, JSON.stringify({ role: role.rows, tenant: tenant.rows, member: member.rows }, null, 2));
      expect(role.rows[0]).toMatchObject({ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false });
      expect(tenant.rows).toHaveLength(1);
      expect(member.rows).toHaveLength(1);
    } catch (error) {
      await writeFile(`${output}/transport-error.txt`, String(error));
      throw error;
    } finally { await probe.end(); }
    app = await mkdtemp('/scratch/task20-next-');
    // next-env.d.ts is generated by Next; v2 intentionally does not freeze it.
    for (const name of ['src', 'public', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) {
      await cp(resolve(name), `${app}/${name}`, { recursive: true });
    }
    await copiedSource('src'); await copiedSource('public');
    for (const name of ['package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs']) {
      copiedHashes[name] = hash(await readFile(name));
      expect(hash(await readFile(`${app}/${name}`))).toBe(copiedHashes[name]);
    }
    await writeFile(`${output}/app-copy-hashes.json`, JSON.stringify(copiedHashes, null, 2));
    await symlink(resolve('node_modules'), `${app}/node_modules`);
    expect((await readdir(app)).filter(name => name.startsWith('.env'))).toEqual([]);
    const portReservation = createServer();
    const port = await listen(portReservation);
    await new Promise<void>((accept, reject) => portReservation.close(error => error ? reject(error) : accept()));
    origin = `http://127.0.0.1:${port}`;
    const argv = [resolve('node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)];
    next = spawn(process.execPath, argv, { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: '/scratch', TMPDIR: '/tmp', NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1', AUTH_SECRET: fixture.secret,
      DATABASE_URL: databaseUrl,
    } });
    next.stdout!.pipe(createWriteStream(`${output}/next.stdout.log`));
    next.stderr!.pipe(createWriteStream(`${output}/next.stderr.log`));
    await writeFile(`${output}/server.json`, JSON.stringify({ argv, origin, app, pgPort, ownedId,
      auth: 'synthetic locally-issued AES-GCM v2; real getGoogleSessionFromRequest; no OAuth exchange',
      database: 'real app_runtime NOSUPERUSER NOBYPASSRLS; forced RLS migrations; private TCP relay',
      implementation: 'full frozen src/public/config copied; no aliases, mocked routes, or auth/datastore substitution',
      namespace: await readFile('/proc/net/route', 'utf8') }, null, 2));
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Next readiness timeout')), 120_000);
      next!.once('error', error => { clearTimeout(timer); reject(error); });
      next!.once('exit', code => { clearTimeout(timer); reject(new Error(`Next exited before ready: ${code}`)); });
      next!.stdout!.on('data', data => {
        if (String(data).includes('Ready in')) { clearTimeout(timer); accept(); }
      });
    });
    cookie = sessionCookie();
  }, 180_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    try { await stop(next); } catch (error) { failures.push(error); }
    const copyDrift: string[] = [];
    try {
      for (const [name, digest] of Object.entries(copiedHashes)) {
        if (hash(await readFile(`${app}/${name}`)) !== digest) copyDrift.push(name);
      }
      expect(copyDrift).toEqual([]);
    } catch (error) { failures.push(error); }
    for (const socket of sockets) socket.destroy();
    try { if (pgServer) await new Promise<void>((accept, reject) => pgServer!.close(e => e ? reject(e) : accept())); }
    catch (error) { failures.push(error); }
    for (const relay of relays) { try { await stop(relay); } catch (error) { failures.push(error); } }
    if (db) {
      let unchanged: boolean | null = null;
      try {
        if (initialRows !== undefined) {
          const after = await rows();
          unchanged = JSON.stringify(after) === JSON.stringify(initialRows);
          await writeFile(`${output}/rows-before.json`, JSON.stringify(initialRows, null, 2));
          await writeFile(`${output}/rows-after.json`, JSON.stringify(after, null, 2));
          expect(unchanged).toBe(true);
        }
      } catch (error) { failures.push(error); }
      // Cleanup is independent of setup/SQL/read-only assertion success.
      try {
        const cleanup = await db.close();
        await writeFile(`${output}/cleanup.json`, JSON.stringify({ unchanged, cleanup,
          copyDrift, nextExit: next?.exitCode, nextSignal: next?.signalCode, relays: relays.size }, null, 2));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Task20 cleanup/read-only verification failed');
  }, 90_000);

  it('serves tenant-scoped persisted status with unknown operational authority', async () => {
    const r = await request(statusPath);
    protectedJson(r, 200);
    expect(JSON.parse(r.text)).toMatchObject({ readOnly: true, migrationStatus: 'DISCOVERED', authority: 'UNKNOWN' });
  }, 150_000);
  it('renders the actual Next status page and exact historical navigation link', async () => {
    const r = await request(pagePath);
    expect(r.response.status).toBe(200);
    expect(r.text).toContain('저장된 작업 상태');
    expect(r.text).toContain('DISCOVERED');
    expect(r.text).toContain(historyPath.replaceAll('&', '&amp;'));
    expect(r.text).not.toContain('<form');
  }, 150_000);
  it('renders actual Next history with a reauthorized download link', async () => {
    const r = await request(historyPath);
    expect(r.response.status).toBe(200);
    expect(r.text).toContain('9007199254740993');
    expect(r.text).toContain(downloadPath.replaceAll('&', '&amp;'));
    expect(r.text).toContain('과거 보고서 JSON 다운로드');
  }, 150_000);
  it('downloads historical JSON attachment as real HTTP bytes', async () => {
    const r = await request(downloadPath);
    protectedJson(r, 200);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(r.text)).toMatchObject({ readOnly: true, scope: 'HISTORICAL_ONLY',
      operationalAuthority: 'UNKNOWN', currentPreflight: 'NOT_EVALUATED', cutoverAllowed: false,
      report: { metrics: details.report.metrics } });
    expect(r.text).not.toContain(fixture.tenant);
    expect(r.text).not.toContain(fixture.job);
  }, 150_000);
  it('confirms exact historical snapshot identity in server-rendered UI and both HTTP representations', async () => {
    const inline = await request(reportPath);
    protectedJson(inline, 200);
    expect(inline.headers['content-disposition']).toBeUndefined();
    const attachment = await request(downloadPath);
    protectedJson(attachment, 200);
    const projection = JSON.parse(inline.text);
    expect(JSON.parse(attachment.text)).toEqual(projection);
    expect(projection).toMatchObject({ scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
      eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
      operationalAuthority: 'UNKNOWN', currentPreflight: 'NOT_EVALUATED', cutoverAllowed: false,
      reportId, manifestDigest: details.manifestDigest, currentManifestDigest: details.currentManifestDigest,
      sourceFingerprint: details.sourceFingerprint, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE' });
    expect(projection.report).not.toHaveProperty('authority');
    expect(projection.report).not.toHaveProperty('cutoverAllowed');
    const page = await request(historyPath);
    expect(page.response.status).toBe(200);
    // Installed Next base-server explicitly overrides page caching in dev.
    // Do not claim production no-store from this dev-server exercise.
    expect(page.headers['cache-control']).toBe('no-cache, must-revalidate');
    // Inspect the server-delivered element, not an RSC script containing text.
    // A native read-only affordance, NOT a browser toggle/click assertion.
    const disclosure = page.text.match(/<details\b[^>]*>([\s\S]*?)<\/details>/)?.[1];
    expect(disclosure).toBeDefined();
    expect(disclosure!.match(/<summary[^>]*>([^<]+)<\/summary>/)?.[1]).toBe(snapshotSummary);
    const fields = Object.fromEntries([...disclosure!.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)]
      .map(match => [match[1], match[2]]));
    expect(fields).toEqual({
      '과거 보고서 ID': projection.reportId,
      '보관된 원본 매니페스트 해시': projection.manifestDigest,
      '보관된 비교 매니페스트 해시 (현재 조회 아님)': projection.currentManifestDigest,
      '보관된 원본 지문': projection.sourceFingerprint,
      '보관된 스냅샷 범위': projection.freshness,
      '검증 범위': projection.verification,
      '보관 내용 무결성': projection.eventIntegrity,
    });
    expect(disclosure).toContain('해시 일치는 보관 내용의 무결성만 확인합니다. 원본 출처·현재성·전환 권한은 증명하지 않습니다.');
    for (const value of ['HISTORICAL_ONLY', 'NOT_EVALUATED', 'UNKNOWN', 'cutoverAllowed: false']) expect(page.text).toContain(value);
    expect(page.text).not.toContain('SHEETS_AND_REDIS');
    expect(disclosure).not.toMatch(/<(?:form|input|button|script)\b/);
  }, 150_000);
  it.each([reportPath, downloadPath])('reauthorizes bodyless HEAD without converting history to current authority %s', async path => {
    const head = await request(path, cookie, 'HEAD');
    protectedJson(head, 200);
    expect(head.bytes.length).toBe(0);
    const expired = await request(path, sessionCookie(true), 'HEAD');
    protectedJson(expired, 401);
    expect(expired.bytes.length).toBe(0);
    expect(expired.headers['content-disposition']).toBeUndefined();
    const foreign = await request(path.replace(fixture.slug, fixture.foreignSlug), cookie, 'HEAD');
    protectedJson(foreign, 403);
    expect(foreign.bytes.length).toBe(0);
    expect(foreign.headers['content-disposition']).toBeUndefined();
  });
  it.each([statusPath, reportPath, downloadPath])('rejects unauthenticated HTTP %s', async path => {
    protectedJson(await request(path, ''), 401);
  });
  it.each([pagePath, historyPath])('denies unauthenticated Next page %s', async path => {
    const r = await request(path, '');
    if (path === pagePath) {
      expect([307, 303]).toContain(r.response.status);
      expect(r.headers.location).toBe(`/c/${fixture.slug}/admin/login`);
    } else {
      expect(r.response.status).toBe(200);
      expect(r.text).toContain('로그인 필요');
    }
    expect(r.text).not.toContain('9007199254740993');
    expect(r.text).not.toContain('DISCOVERED');
  });
  it.each([statusPath, reportPath, downloadPath])('rejects expired session %s', async path => {
    protectedJson(await request(path, sessionCookie(true)), 401);
  });
  it.each([statusPath, reportPath, downloadPath])('rejects other-tenant membership even with same stored job/report %s', async path => {
    const r = await request(path.replace(fixture.slug, fixture.foreignSlug));
    protectedJson(r, 403);
    expect(r.text).not.toContain('9007199254740993');
    expect(r.text).not.toContain('DISCOVERED');
  });
  it.each(['missing', 'expired', 'foreign'])('does not expose snapshot confirmation on denied history: %s', async denial => {
    const path = denial === 'foreign' ? historyPath.replace(fixture.slug, fixture.foreignSlug) : historyPath;
    const auth = denial === 'missing' ? '' : denial === 'expired' ? sessionCookie(true) : cookie;
    const page = await request(path, auth);
    expect(page.response.status).toBe(200);
    expect(page.text).toContain(denial === 'foreign' ? '접근할 수 없음' : '로그인 필요');
    expect(page.text).not.toContain('<details');
    expect(page.text).not.toContain(snapshotSummary);
    for (const value of [details.manifestDigest, details.sourceFingerprint, '과거 보고서 JSON 다운로드']) expect(page.text).not.toContain(value);
  });
  it.each([pagePath, historyPath])('renders no wrong-tenant report in Next page %s', async path => {
    const r = await request(path.replace(fixture.slug, fixture.foreignSlug));
    expect(r.response.status).toBe(path === pagePath ? 404 : 200);
    if (path === historyPath) expect(r.text).toContain('접근할 수 없음');
    expect(r.text).not.toContain('9007199254740993');
    expect(r.text).not.toContain('DISCOVERED');
    expect(r.text).not.toContain('과거 보고서 JSON 다운로드');
  });
  it.each([statusPath, downloadPath])('rejects nonexistent canonical slug %s', async path => {
    protectedJson(await request(path.replace(fixture.slug, 'task20-missing')), 403);
  });
  it('refuses missing job without current authority inference', async () => {
    protectedJson(await request(statusPath.replace(encodeURIComponent(fixture.job), 'missing-job')), 404);
  });
  it('refuses missing report and never offers it as a download', async () => {
    const missing = `reconciliation:${'0'.repeat(64)}`;
    protectedJson(await request(downloadPath.replace(encodeURIComponent(reportId), encodeURIComponent(missing))), 404);
    const r = await request(historyPath.replace(encodeURIComponent(reportId), encodeURIComponent(missing)));
    expect(r.text).toContain('보고서를 찾을 수 없음');
    expect(r.text).not.toContain('과거 보고서 JSON 다운로드');
  });
  it('refuses a stale mismatched job/report pair', async () => {
    const path = `/api/migrations/status/${fixture.slug}/preflight/download?${new URLSearchParams({ jobId: 'different-job', reportId })}`;
    expect(path).not.toBe(downloadPath);
    protectedJson(await request(path), 404);
  });
  it('refuses a stored report whose bytes no longer match its immutable selector', async () => {
    const stale = encodeURIComponent(`reconciliation:${'d'.repeat(64)}`);
    const r = await request(downloadPath.replace(encodeURIComponent(reportId), stale));
    protectedJson(r, 503);
    expect(r.headers['content-disposition']).toBeUndefined();
    const page = await request(historyPath.replace(encodeURIComponent(reportId), stale));
    expect(page.text).toContain('보고서 확인 불가');
    expect(page.text).not.toContain('과거 보고서 JSON 다운로드');
  });
  it('refuses duplicate selectors over real HTTP', async () => {
    protectedJson(await request(`${downloadPath}&jobId=wrong`), 400);
    protectedJson(await request(`${statusPath}&jobId=duplicate`), 400);
  });
  it('follows served status/history links to attachment bytes using HTTP, not a browser', async () => {
    const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)]
      .map(match => match[1].replaceAll('&amp;', '&'));
    const status = await request(pagePath);
    const historyLink = hrefs(status.text).find(href => href.startsWith(`/c/${fixture.slug}/admin/migrations/history?`));
    expect(historyLink).toBe(historyPath);
    const history = await request(historyLink!);
    const downloadLink = hrefs(history.text).find(href => href.startsWith(`/api/migrations/status/${fixture.slug}/preflight/download?`));
    expect(downloadLink).toBe(downloadPath);
    const downloaded = await request(downloadLink!);
    protectedJson(downloaded, 200);
    expect(JSON.parse(downloaded.text).report.metrics).toEqual(details.report.metrics);
    // A served link is only a selector, never an authorization capability.
    protectedJson(await request(downloadLink!, ''), 401);
  });

  it('refuses warmed historical links after committed revocation, stale session and foreign substitution even with cache validators', async () => {
    const before = await rows();
    const history = await request(historyPath);
    expect(history.response.status).toBe(200);
    const links = [...history.text.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)]
      .map(match => match[1].replaceAll('&amp;', '&'));
    const link = links.find(href => href === downloadPath);
    expect(link).toBe(downloadPath);
    const warm = await request(link!);
    protectedJson(warm, 200);
    expect(JSON.parse(warm.text).report.metrics).toEqual(details.report.metrics);
    const conditions = {
      'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2031 00:00:00 GMT',
      'cache-control': 'max-stale=31536000', range: 'bytes=0-31',
    };
    const noReuse = (r: Awaited<ReturnType<typeof request>>, status: number, method: 'GET' | 'HEAD') => {
      protectedJson(r, status);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.headers.vary?.split(',').map(value => value.trim())).toContain('Cookie');
      for (const name of ['etag', 'last-modified', 'content-range', 'content-disposition']) {
        expect(r.headers[name]).toBeUndefined();
      }
      expect(r.bytes.equals(warm.bytes)).toBe(false);
      expect(r.text).toBe(method === 'HEAD' ? '' : JSON.stringify({
        error: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED',
      }));
      for (const value of [reportId, details.manifestDigest, details.sourceFingerprint, '9007199254740993']) {
        expect(r.text).not.toContain(value);
      }
    };
    // Committed owner-only fixture mutation, not production revocation authority.
    // Restore the exact row (including timestamps) in finally; no trigger bypass.
    const removed = await db!.owner.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2 RETURNING row_to_json(tenant_memberships) AS row',
      [fixture.tenant, fixture.member]);
    try {
      expect(removed.rowCount).toBe(1);
      expect((await db!.owner.query('SELECT count(*)::text AS n FROM tenant_memberships WHERE tenant_id=$1',
        [fixture.tenant])).rows).toEqual([{ n: '0' }]);
      const revokedRows = await rows();
      for (const method of ['GET', 'HEAD'] as const) {
        noReuse(await request(link!, cookie, method), 403, method);
        noReuse(await request(link!, cookie, method, conditions), 403, method);
      }
      expect(await rows()).toEqual(revokedRows);
      await writeFile(`${output}/revocation.json`, JSON.stringify({
        before, revoked: revokedRows, afterDenied: await rows(),
        boundary: 'DELETE autocommit acknowledged before HTTP; same URL and exact same synthetic cookie',
      }, null, 2));
    } finally {
      for (const { row } of removed.rows) {
        await db!.owner.query('INSERT INTO tenant_memberships SELECT * FROM json_populate_record(NULL::tenant_memberships,$1::json)',
          [JSON.stringify(row)]);
      }
    }
    expect(await rows()).toEqual(before);
    // The restored positive must still emit the complete attachment, not 304/206.
    const restored = await request(link!, cookie, 'GET', conditions);
    protectedJson(restored, 200);
    expect(restored.bytes).toEqual(warm.bytes);
    expect(restored.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
    // Warm a still-valid cookie, then let wall-clock time expire that EXACT
    // token. No fake timers in this Next/PG HTTP scenario.
    const expiresAt = Date.now() + 5_000;
    const issuedAt = expiresAt - 30 * 24 * 60 * 60 * 1000;
    const expired = sessionCookie(false, issuedAt);
    const agingWarm = await request(link!, expired);
    protectedJson(agingWarm, 200);
    expect(agingWarm.bytes).toEqual(warm.bytes);
    const warmObservedAt = Date.now();
    await delay(Math.max(0, expiresAt - Date.now() + 20));
    expect(Date.now()).toBeGreaterThan(expiresAt);
    await writeFile(`${output}/aging-session.json`, JSON.stringify({ issuedAt, expiresAt, warmObservedAt,
      deniedRequestsStartAt: Date.now(), syntheticCookieSha256: createHash('sha256').update(expired).digest('hex'),
    }, null, 2));
    const variant = comparisonVariants[0];
    const foreign = `/api/migrations/status/${fixture.foreignSlug}/preflight/download?${new URLSearchParams({
      jobId: fixture.job, reportId: archiveReportId(OTHER, variant.archive),
    })}`;
    // The foreign selector names a valid tenant-bound archive, not corrupt data.
    expect((await db!.owner.query('SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1 AND event_id=$2',
      [OTHER, archiveReportId(OTHER, variant.archive)])).rows).toEqual([{ n: '1' }]);
    for (const method of ['GET', 'HEAD'] as const) {
      noReuse(await request(link!, expired, method, conditions), 401, method);
      noReuse(await request(foreign, cookie, method, conditions), 403, method);
    }
    expect(await rows()).toEqual(before);
  }, 150_000);

  describe.each(comparisonVariants)('comparison variant $name', variant => {
    const paths = [variant.historyPath, variant.reportPath, variant.downloadPath];
    // Parse only the served <main>, never escaped RSC scripts/serialized props.
    const main = (html: string) => {
      const markup = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
      expect(markup).toBeDefined();
      return markup!;
    };
    const fields = (markup: string) => Object.fromEntries(
      [...markup.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)].map(match => [match[1], match[2]]));
    const authorityFields = {
      '조회 범위': 'HISTORICAL_ONLY', '현재 사전검사': 'NOT_EVALUATED',
      '현재 운영 권한': 'UNKNOWN', '전환 허용': 'cutoverAllowed: false',
    };
    function noReport(text: string) {
      expect(text).not.toContain('<details');
      expect(text).not.toContain(snapshotSummary);
      expect(text).not.toContain('과거 보고서 JSON 다운로드');
      expect(text).not.toContain('9007199254740993');
      // A page may serialize the requested reportId in RSC; that is not a
      // disclosure. Neither response may contain stored archive evidence.
      for (const value of [variant.archive.manifestDigest, variant.archive.sourceFingerprint,
        variant.archive.currentManifestDigest].filter((value): value is string => value !== null)) {
        expect(text).not.toContain(value);
      }
    }

    it('preserves the selected archive in authenticated SSR disclosure and identical report/download JSON', async () => {
      const inline = await request(variant.reportPath);
      protectedJson(inline, 200);
      expect(inline.headers['content-disposition']).toBeUndefined();
      const attachment = await request(variant.downloadPath);
      protectedJson(attachment, 200);
      expect(attachment.headers['content-disposition']).toBe(`attachment; filename="${variant.filename}"`);
      expect(attachment.headers['x-content-type-options']).toBe('nosniff');
      const projection = JSON.parse(inline.text);
      // The attachment contract includes a trailing LF; compare JSON values,
      // not transport whitespace or property insertion order.
      expect(JSON.parse(attachment.text)).toEqual(projection);
      const { archive } = variant;
      expect(projection).toEqual({
        projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
        eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
        currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
        reportId: variant.reportId, comparisonInstant: archive.comparisonInstant,
        manifestDigest: archive.manifestDigest, currentManifestDigest: archive.currentManifestDigest,
        sourceFingerprint: archive.sourceFingerprint, freshness: archive.freshness,
        report: { reportVersion: archive.report.reportVersion, phase: archive.report.phase,
          status: archive.report.status, metrics: archive.report.metrics,
          diagnostics: archive.report.diagnostics, omittedDiagnostics: archive.report.omittedDiagnostics },
      });
      for (const value of [fixture.tenant, fixture.job, 'SHEETS_AND_REDIS']) expect(inline.text).not.toContain(value);
      const page = await request(variant.historyPath);
      expect(page.response.status).toBe(200);
      const markup = main(page.text);
      expect(fields(markup)).toMatchObject({ ...authorityFields,
        '과거 보고서 결과': archive.report.status, '보관된 비교 시각': archive.comparisonInstant,
        '원본 결합 증명': 'NOT_VERIFIED', '현재성 검증': 'NOT_VERIFIED' });
      const disclosure = markup.match(/<details\b[^>]*>([\s\S]*?)<\/details>/)?.[1];
      expect(disclosure).toBeDefined();
      expect(disclosure!.match(/<summary[^>]*>([^<]+)<\/summary>/)?.[1]).toBe(snapshotSummary);
      expect(fields(disclosure!)).toEqual({
        '과거 보고서 ID': variant.reportId,
        '보관된 원본 매니페스트 해시': archive.manifestDigest,
        '보관된 비교 매니페스트 해시 (현재 조회 아님)': archive.currentManifestDigest ?? '보관된 비교 매니페스트 해시 없음',
        '보관된 원본 지문': archive.sourceFingerprint, '보관된 스냅샷 범위': archive.freshness,
        '검증 범위': 'INTEGRITY_ONLY', '보관 내용 무결성': 'VERIFIED',
      });
      expect(disclosure).toContain('해시 일치는 보관 내용의 무결성만 확인합니다. 원본 출처·현재성·전환 권한은 증명하지 않습니다.');
      expect(markup).not.toMatch(/<(?:form|input|button|script)\b/);
      expect(page.text).not.toContain('SHEETS_AND_REDIS');
      const links = [...markup.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
      expect(links).toEqual([variant.downloadPath]);
      const followed = await request(links[0]);
      protectedJson(followed, 200);
      expect(JSON.parse(followed.text)).toEqual(projection);
    }, 150_000);

    it.each(['expired', 'foreign'] as const)('reauthorizes every representation with %s identity and reveals no archive', async denial => {
      const auth = denial === 'expired' ? sessionCookie(true) : cookie;
      for (const path of paths) {
        const url = new URL(path, origin);
        if (denial === 'foreign') {
          url.pathname = url.pathname.replace(fixture.slug, fixture.foreignSlug);
          url.searchParams.set('reportId', archiveReportId(OTHER, variant.archive));
        }
        const deniedPath = url.pathname + url.search;
        if (denial === 'foreign') expect(deniedPath).not.toBe(path);
        const r = await request(deniedPath, auth);
        if (path === variant.historyPath) {
          expect(r.response.status).toBe(200);
          expect(main(r.text)).toContain(denial === 'expired' ? '로그인 필요' : '접근할 수 없음');
          expect(fields(main(r.text))).toMatchObject(authorityFields);
        } else {
          protectedJson(r, denial === 'expired' ? 401 : 403);
          expect(JSON.parse(r.text)).toEqual({ error: denial === 'expired' ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED' });
          expect(r.headers['content-disposition']).toBeUndefined();
          const head = await request(deniedPath, auth, 'HEAD');
          protectedJson(head, denial === 'expired' ? 401 : 403);
          expect(head.bytes.length).toBe(0);
          expect(head.headers['content-disposition']).toBeUndefined();
        }
        noReport(r.text);
      }
    }, 150_000);

    it.each(['duplicate-job', 'duplicate-report', 'digest-override', 'wrong-job', 'missing-report'] as const)(
      'rejects selector tampering %s on page, report and attachment', async tampering => {
        const invalid = !['wrong-job', 'missing-report'].includes(tampering);
        for (const path of paths) {
          const url = new URL(path, origin);
          if (tampering === 'duplicate-job') url.searchParams.append('jobId', fixture.job);
          if (tampering === 'duplicate-report') url.searchParams.append('reportId', variant.reportId);
          if (tampering === 'digest-override') url.searchParams.set('currentManifestDigest', details.manifestDigest);
          if (tampering === 'wrong-job') url.searchParams.set('jobId', 'different-job');
          if (tampering === 'missing-report') url.searchParams.set('reportId', `reconciliation:${'0'.repeat(64)}`);
          const tamperedPath = url.pathname + url.search;
          expect(tamperedPath).not.toBe(path);
          const r = await request(tamperedPath);
          if (path === variant.historyPath) {
            expect(r.response.status).toBe(200);
            expect(main(r.text)).toContain(invalid ? '잘못된 보고서 선택' : '보고서를 찾을 수 없음');
            expect(fields(main(r.text))).toMatchObject(authorityFields);
          } else {
            protectedJson(r, invalid ? 400 : 404);
            expect(JSON.parse(r.text)).toEqual({ error: invalid ? 'INVALID_PREFLIGHT_REQUEST' : 'PREFLIGHT_REPORT_NOT_FOUND' });
            expect(r.headers['content-disposition']).toBeUndefined();
          }
          noReport(r.text);
        }
      }, 150_000);
  });
});
