// @vitest-environment node

import { test } from 'vitest';

/**
 * BLOCKED acceptance marker, NOT an implemented/passed browser or HTTP test.
 *
 * RUN_TASK20_BROWSER_BOUNDARY=1 requests verification only. Do not start Next
 * or a test runner in an inherited environment: this checkout has .env.local.
 * The execution-only continuation uses an allowlisted environment, read-only
 * repository mount, masked dotenv files and a scratch config with envDir:false.
 *
 * The opt-in deliberately remains SKIPPED until a reviewed, isolated harness
 * replaces this marker. Installing a browser or setting the flag alone must not
 * turn missing navigation/authorization evidence into a green assertion.
 *
 * Inspected evidence:
 * - Installed Next app testing/vitest.md recommends E2E for async Server
 *   Components; jsdom rendering/direct route calls are not browser navigation.
 * - Installed testing/playwright.md requires a running Next server/browser.
 *   package.json declares no browser runner; vitest.config.mts selects jsdom.
 * - Next ships experimental/testmode/playwright, but its implementation imports
 *   @playwright/test. Its server interceptor covers fetch/ClientRequest, not
 *   PostgreSQL sockets. It is not an isolated database/auth fixture by itself.
 * - readPreflightReport.ts creates a pg Pool from getDatabaseConfig(), whose
 *   default is process.env. Existing page.test.tsx mocks Pool and next/headers
 *   inside Vitest; those mocks do not isolate a separately started Next server.
 * - The earlier discovery denial was superseded by explicit supervisor approval.
 *   Approved discovery found Next 16.3.3 and /usr/bin/google-chrome; project
 *   resolution found no playwright, playwright-core, @playwright/test,
 *   puppeteer or puppeteer-core. Package absence alone is NOT the blocker.
 * - An unprivileged bubblewrap probe established a separate network namespace:
 *   only lo, no IPv4 routes, successful 127.0.0.1 bind, no operational home.
 *   Chrome then aborted before rendering about:blank (exit 134): its SUID
 *   sandbox helper was not admitted. Host metadata is root-owned mode 4755,
 *   but that helper appears owned by unmapped uid/gid 65534 inside the probe.
 *   This is a failure of the tested sandbox topology, NOT proof Chrome is absent
 *   or that the host helper needs chmod. No sandbox-disable flag, privilege or
 *   host permission/policy change was attempted. No Next server was started.
 * - Run-only commands, stderr and bounded report are under
 *   /home/haeon/workhub-tasks/live/class-store-supervision/
 *   task20-history-membership-browser/run-20260926T010151Z/.
 *
 * Missing prerequisite: an approved, locally launchable browser plus a disposable
 * loopback-only Next fixture serving the actual history page/download route,
 * with synthetic encrypted cookies and revocable synthetic memberships/archive
 * data through the real reader/auth path. It must isolate the pg transport and
 * deny non-fixture egress BEFORE server/module startup. No inherited credentials,
 * .env files, provider calls, production DB, Sheets, Redis, Docker, existing
 * server/profile reuse, or permission changes. Build/output/download scratch must
 * stay outside the repository and be cleaned up without touching others' files.
 *
 * Required evidence before replacing this skip:
 * 1. Load the actual Next history page over loopback HTTP using a synthetic
 *    authorized cookie; observe the exact same-origin native anchor and opaque
 *    jobId/reportId binding. Click it in a real browser, not page.setContent,
 *    route fulfillment, client Blob/fetch, jsdom click, or direct GET invocation.
 * 2. Observe its real navigation request/download event, GET attachment headers,
 *    suggested filename and saved JSON bytes; verify private/no-store, Vary:
 *    Cookie, nosniff, no-referrer and HISTORICAL_ONLY/non-authority semantics.
 * 3. After separately rendering an authorized page, remove/expire its cookie,
 *    then click the still-present anchor: fresh server denial, no attachment.
 *    Repeat with a valid cookie but membership revoked server-side before the
 *    click. Observe real denial responses; no stale UI/cache authorization reuse.
 * 4. Check success/denial bodies, headers, filename, browser DOM/console,
 *    server logs and referrer for synthetic secret/identity/raw-source canaries;
 *    test cross-tenant denial and prove no provider/source acquisition occurred.
 *
 * No application/browser imports, sockets, child processes, fixture writes or
 * credential reads belong in this marker. Neither opt-in branch can pass.
 */
const blocker = 'BLOCKED: Chrome aborted at its SUID sandbox check inside the no-egress namespace; an actual Next/auth/pg/browser fixture is not established. Real navigation, reauthorization, attachment and leak checks were NOT RUN.';

test('Task20 historical download browser boundary (opt-in; BLOCKED, not verified)', ({ skip }) => {
  const requested = process.env.RUN_TASK20_BROWSER_BOUNDARY === '1';
  skip(`${requested ? 'Opt-in requested but prerequisites remain unmet.' : 'Opt-in disabled (RUN_TASK20_BROWSER_BOUNDARY=1 requests verification only).'} ${blocker}`);
});
