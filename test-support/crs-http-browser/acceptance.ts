import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Cdp } from './cdp';
import { checkSources, requireIsolatedFixture, scratch } from './boundary';
import { downloadPath, filename, fixture, historyPath, reportId, sessionCookie } from './fixture';

type WireResponse = { url: string; status: number; headers: Record<string, string> };
const forbidden: string[] = [fixture.secret, fixture.privateCanary, fixture.privateCanary.toLowerCase(),
  fixture.subject, fixture.tenant, fixture.user, fixture.member];
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function issueCookie(expired = false) {
  const cookie = sessionCookie(expired);
  forbidden.push(cookie);
  return cookie;
}

function noDisclosure(text: string) {
  for (const canary of forbidden) assert.ok(!text.includes(canary), 'Synthetic identity/secret disclosed');
}
function privateHeaders(input: Record<string, string>) {
  const headers = new Headers(input);
  assert.equal(headers.get('cache-control'), 'private, no-store');
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.ok(headers.get('vary')?.split(',').map(value => value.trim().toLowerCase()).includes('cookie'));
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  for (const name of ['etag', 'last-modified', 'location', 'set-cookie', 'content-range']) assert.equal(headers.has(name), false);
  noDisclosure(JSON.stringify(input));
  return headers;
}
function attachment(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 65_536);
  assert.equal(bytes.at(-1), 10);
  noDisclosure(bytes.toString('utf8'));
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(value.reportId, reportId);
  for (const [key, expected] of Object.entries({ readOnly: true, scope: 'HISTORICAL_ONLY',
    verification: 'INTEGRITY_ONLY', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
    currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false })) {
    assert.equal(value[key], expected);
  }
  assert.equal(value.report.status, 'BLOCKED');
  assert.equal(value.report.metrics[0].expected, '-9007199254740993');
}

/** Real network/browser scenario, NOT a fixture server or a synthetic PASS.
 * It has no launch fallback. A supervisor-owned, fully isolated Next/Chrome/PG
 * fixture must already be alive and seeded. See BLOCKER.md and README.md.
 */
export async function runAcceptance() {
  const receipt = requireIsolatedFixture(); // No sockets/application imports before this gate.
  const { Client } = await import('pg');
  const database = `task20_${receipt.runId}`;
  const connection = { host: '127.0.0.1', port: receipt.pgPort, database,
    password: `synthetic_${receipt.runId}`, ssl: false as const,
    connectionTimeoutMillis: 2_000, query_timeout: 3_000,
    application_name: 'task20-acceptance-only' };
  const owner = new Client({ ...connection, user: 'task20_fixture_owner' });
  const runtime = new Client({ ...connection, user: 'task20_fixture_reader' });
  const completed: string[] = [];
  const startedAt = new Date().toISOString();
  let cdp: Cdp | undefined;
  let contextId: string | undefined;
  let membershipRemoved = false;
  let result = 'FAIL';
  let downloadedSha256: string | null = null;
  let cleanupError = false;
  try {
    await owner.connect();
    await runtime.connect();
    for (const [client, role] of [[owner, 'task20_fixture_owner'], [runtime, 'task20_fixture_reader']] as const) {
      const info = (await client.query(`SELECT current_database() AS db, current_user AS role,
        inet_server_addr()::text AS host, version() AS version,
        r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      assert.equal(info.db, database); assert.equal(info.role, role);
      assert.equal(info.host, '127.0.0.1'); assert.match(info.version, /^PostgreSQL /);
      assert.equal(info.rolsuper, false); assert.equal(info.rolbypassrls, false);
    }
    const rls = (await runtime.query(`SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid IN ('public.migration_jobs'::regclass,'public.audit_events'::regclass)`)).rows;
    assert.equal(rls.length, 2);
    assert.ok(rls.every(row => row.relrowsecurity && row.relforcerowsecurity));
    const binding = (await runtime.query(`SELECT id, user_id, role
      FROM public.platform_find_membership_by_tenant_and_google_subject($1,$2)`, [fixture.tenant, fixture.subject])).rows;
    assert.deepEqual(binding, [{ id: fixture.member, user_id: fixture.user, role: 'OWNER' }]);
    completed.push('real-pg-connection-and-synthetic-membership');

    // Unique scratch path: never use or clean an existing browser/download directory.
    const downloadDir = `${scratch}/downloads-${receipt.runId}`;
    await mkdir(downloadDir, { mode: 0o700 });
    cdp = await Cdp.connect(receipt.cdpUrl);
    contextId = (await cdp.call<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
    await cdp.call('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', browserContextId: contextId, downloadPath: downloadDir, eventsEnabled: true,
    });
    const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank', browserContextId: contextId,
    });
    const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => cdp!.call<T>(method, params, sessionId);
    await call('Page.enable'); await call('Network.enable'); await call('Runtime.enable'); await call('Log.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const reply = await call<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      assert.equal(reply.exceptionDetails, undefined, 'Browser evaluation failed');
      return reply.result.value;
    };
    const setCookie = async (expired = false) => {
      const reply = await call<{ success: boolean }>('Network.setCookie', {
        name: fixture.cookieName, value: issueCookie(expired), url: receipt.origin,
        path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
      });
      assert.equal(reply.success, true);
    };
    const loadHistory = async () => {
      const from = cdp!.events.length;
      const reply = await call<{ errorText?: string }>('Page.navigate', { url: receipt.origin + historyPath });
      assert.equal(reply.errorText, undefined);
      await cdp!.event('Page.loadEventFired', from, event => event.sessionId === sessionId);
      const response = await cdp!.event('Network.responseReceived', from, event =>
        event.sessionId === sessionId && (event.params.response as WireResponse).url === receipt.origin + historyPath);
      assert.equal((response.params.response as WireResponse).status, 200);
      const dom = await evaluate<string>('document.documentElement.outerHTML');
      noDisclosure(dom);
      for (const text of ['HISTORICAL_ONLY', 'NOT_EVALUATED', 'UNKNOWN', 'cutoverAllowed: false']) assert.ok(dom.includes(text));
      const links = await evaluate<{ href: string; text: string; policy: string; download: boolean }[]>(`Array.from(document.querySelectorAll('a'))
        .filter(a => a.textContent.trim() === '과거 보고서 JSON 다운로드')
        .map(a => ({href:a.getAttribute('href'),text:a.textContent.trim(),policy:a.referrerPolicy,download:a.hasAttribute('download')}))`);
      assert.deepEqual(links, [{ href: downloadPath, text: '과거 보고서 JSON 다운로드', policy: 'no-referrer', download: false }]);
    };
    const click = async () => {
      const from = cdp!.events.length;
      const bounds = await evaluate<{ x: number; y: number }>(`(() => {
        const link = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '과거 보고서 JSON 다운로드');
        if (!link) throw new Error('Missing native anchor');
        link.scrollIntoView({block:'center'}); const r=link.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      // Trusted browser input against the rendered anchor, not JS .click(), Blob,
      // fetch, route fulfillment, page.setContent or direct route invocation.
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bounds, button: 'left', clickCount: 1 });
      const request = await cdp!.event('Network.requestWillBeSent', from, event =>
        event.sessionId === sessionId && (event.params.request as { url: string }).url === receipt.origin + downloadPath);
      const data = request.params.request as { method: string; headers: Record<string, string> };
      assert.equal(data.method, 'GET');
      assert.equal(request.params.type, 'Document');
      assert.equal(new Headers(data.headers).has('referer'), false);
      const response = await cdp!.event('Network.responseReceived', from, event => event.sessionId === sessionId
        && event.params.requestId === request.params.requestId);
      return { from, requestId: request.params.requestId, wire: response.params.response as WireResponse };
    };
    await setCookie(); await loadHistory();
    const success = await click();
    assert.equal(success.wire.status, 200);
    assert.equal(privateHeaders(success.wire.headers).get('content-disposition'), `attachment; filename="${filename}"`);
    const download = await cdp.event('Browser.downloadWillBegin', success.from,
      event => event.params.url === receipt.origin + downloadPath);
    assert.equal(download.params.suggestedFilename, filename);
    assert.match(String(download.params.guid), /^[a-zA-Z0-9-]+$/);
    const finished = await cdp.event('Browser.downloadProgress', success.from,
      event => event.params.guid === download.params.guid && ['completed', 'canceled'].includes(String(event.params.state)));
    assert.equal(finished.params.state, 'completed');
    const bytes = await readFile(`${downloadDir}/${download.params.guid}`);
    attachment(bytes); downloadedSha256 = digest(bytes);
    const http = await fetch(receipt.origin + downloadPath, {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { cookie: `${fixture.cookieName}=${issueCookie()}` },
    });
    assert.equal(http.status, 200);
    privateHeaders(Object.fromEntries(http.headers));
    assert.deepEqual(Buffer.from(await http.arrayBuffer()), bytes);
    const head = await fetch(receipt.origin + downloadPath, {
      method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { cookie: `${fixture.cookieName}=${issueCookie()}` },
    });
    assert.equal(head.status, 200);
    assert.equal(privateHeaders(Object.fromEntries(head.headers)).get('content-disposition'), `attachment; filename="${filename}"`);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    completed.push('next-history-native-click-and-saved-attachment');

    const denial = async (status: number, error: string) => {
      const reply = await click();
      assert.equal(reply.wire.status, status);
      assert.equal(privateHeaders(reply.wire.headers).has('content-disposition'), false);
      await cdp!.event('Network.loadingFinished', reply.from,
        event => event.sessionId === sessionId && event.params.requestId === reply.requestId);
      const body = await call<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: reply.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      noDisclosure(text); assert.deepEqual(JSON.parse(text), { error });
      // Absence of attachment plus a completed denial response; short bounded
      // observation is not a claim that arbitrary future downloads are impossible.
      await delay(250);
      assert.ok(!cdp!.events.slice(reply.from).some(event => event.method === 'Browser.downloadWillBegin'));
    };
    await setCookie(); await loadHistory();
    await call('Network.deleteCookies', { name: fixture.cookieName, url: receipt.origin });
    await denial(401, 'AUTHENTICATION_REQUIRED');
    completed.push('cookie-removed-after-render');
    await setCookie(); await loadHistory(); await setCookie(true);
    await denial(401, 'AUTHENTICATION_REQUIRED');
    completed.push('cookie-expired-after-render');
    await setCookie(); await loadHistory();
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenant]);
      const removed = await owner.query(`DELETE FROM public.tenant_memberships
        WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND role='OWNER' RETURNING id`,
      [fixture.tenant, fixture.member, fixture.user]);
      assert.deepEqual(removed.rows, [{ id: fixture.member }]);
      await owner.query('COMMIT'); membershipRemoved = true;
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    assert.equal((await runtime.query(`SELECT id FROM public.platform_find_membership_by_tenant_and_google_subject($1,$2)`,
      [fixture.tenant, fixture.subject])).rows.length, 0);
    await denial(403, 'ACCESS_DENIED');
    completed.push('membership-commit-after-render-before-click');

    // Additional real HTTP negative, not misreported as a native cross-tenant click.
    const foreign = await fetch(receipt.origin + downloadPath.replace(fixture.slug, fixture.foreignSlug), {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { cookie: `${fixture.cookieName}=${issueCookie()}` },
    });
    assert.equal(foreign.status, 403);
    assert.equal(privateHeaders(Object.fromEntries(foreign.headers)).has('content-disposition'), false);
    assert.deepEqual(await foreign.json(), { error: 'ACCESS_DENIED' });
    completed.push('cross-tenant-http-denial');

    for (const event of cdp.events) {
      if (event.method === 'Network.requestWillBeSent') {
        const url = (event.params.request as { url: string }).url;
        if (/^https?:|^wss?:/.test(url)) {
          const target = new URL(url);
          assert.equal(target.hostname, '127.0.0.1');
          assert.equal(target.port, new URL(receipt.origin).port);
        }
      }
      if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method)) noDisclosure(JSON.stringify(event.params));
    }
    // These exact fixture logs are mandatory. Missing files are failures, not
    // empty fabricated logs. Raw logs/cookies/CDP events are not copied out.
    for (const name of ['next.stdout.log', 'next.stderr.log']) noDisclosure(await readFile(`${scratch}/${name}`, 'utf8'));
    checkSources(receipt);
    result = 'SCENARIOS_EXECUTED';
  } finally {
    if (membershipRemoved) {
      try {
        await owner.query('BEGIN');
        await owner.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenant]);
        const restored = await owner.query(`INSERT INTO public.tenant_memberships (tenant_id,id,user_id,role)
          VALUES ($1,$2,$3,'OWNER') RETURNING id`, [fixture.tenant, fixture.member, fixture.user]);
        assert.deepEqual(restored.rows, [{ id: fixture.member }]);
        await owner.query('COMMIT');
      } catch { cleanupError = true; await owner.query('ROLLBACK').catch(() => {}); }
    }
    if (cdp && contextId) await cdp.call('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => { cleanupError = true; });
    cdp?.close();
    await runtime.end().catch(() => { cleanupError = true; });
    await owner.end().catch(() => { cleanupError = true; });
    await writeFile(`${scratch}/acceptance-result.json`, JSON.stringify({
      startedAt, endedAt: new Date().toISOString(), result: cleanupError ? 'FAIL_CLEANUP' : result,
      completed, downloadedSha256, snapshotManifestSha256: receipt.snapshotManifestSha256,
      environmentId: receipt.environmentId, task20Acceptance: '0/6', independentVerification: 'PENDING',
      cleanup: cleanupError ? 'FAILED' : 'connections/context closed; fixture process/download cleanup remains supervisor-owned',
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    assert.equal(cleanupError, false, 'Fixture cleanup failed');
  }
  return completed;
}
