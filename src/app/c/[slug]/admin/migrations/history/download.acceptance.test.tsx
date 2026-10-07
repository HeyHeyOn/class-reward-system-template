// @vitest-environment node

import { expect, test } from 'vitest';

// Not the old download.browser-boundary marker, which stays unchanged/SKIPPED.
// Do not run the shared config or opt in from the host checkout. Sol must first
// supply a reviewed no-egress fixture and serialize the runner (see README.md).
// Enabling the flag without that live fixture fails closed; it cannot yield a
// mock, direct-route, PGlite or assertion-only substitute for real navigation.
test('Task20 existing Next history → native attachment and fresh authorization (isolated acceptance)', async ({ skip }) => {
  if (process.env.RUN_TASK20_NATIVE_ACCEPTANCE !== '1') {
    skip('NOT_RUN: reviewed loopback-only Next/Chrome/PG fixture is not requested; see test-support/crs-http-browser/BLOCKER.md');
    return;
  }
  const { runAcceptance } = await import('../../../../../../../test-support/crs-http-browser/acceptance');
  expect(await runAcceptance()).toEqual([
    'real-pg-connection-and-synthetic-membership',
    'next-history-native-click-and-saved-attachment',
    'cookie-removed-after-render',
    'cookie-expired-after-render',
    'membership-commit-after-render-before-click',
    'cross-tenant-http-denial',
  ]);
  // These are scenario names, NOT Task20's six acceptance criteria. Task20
  // remains 0/6 until Sol's independent integrated verification and acceptance.
}, 240_000);
