import { createCipheriv, createHash, randomBytes } from 'node:crypto';

// Only public, synthetic fixture values. Never copy an operational cookie/env.
export const fixture = {
  tenant: '10000000-0000-4000-8000-000000000001',
  member: '30000000-0000-4000-8000-000000000003',
  user: '40000000-0000-4000-8000-000000000004',
  slug: 'task20-alpha',
  foreignSlug: 'task20-beta',
  subject: 'task20-synthetic-admin',
  secret: 'task20-synthetic-session-secret-not-an-operational-credential',
  privateCanary: 'TASK20_PRIVATE_IDENTITY_CANARY',
  job: 'archive/job +%26?#',
  cookieName: 'class_store_google_auth',
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid synthetic archive');
  return encoded;
}

// Same archival contract as the existing SQL tests; no synthetic reader/route.
export const details = {
  report: {
    reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED',
    authority: 'SHEETS_AND_REDIS', cutoverAllowed: false,
    metrics: [{ category: 'BALANCES', expected: '-9007199254740993', actual: '0',
      delta: '9007199254740993', status: 'MISMATCH' }],
    diagnostics: [{ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: 'e'.repeat(64) }],
    omittedDiagnostics: 0,
  },
  comparisonInstant: '2026-09-25T00:00:00.000Z',
  manifestDigest: 'a'.repeat(64), currentManifestDigest: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
};
export const reportId = `reconciliation:${createHash('sha256')
  .update(canonical([fixture.tenant, fixture.job, details])).digest('hex')}`;
export const selectors = new URLSearchParams({ jobId: fixture.job, reportId }).toString();
export const historyPath = `/c/${fixture.slug}/admin/migrations/history?${selectors}`;
export const downloadPath = `/api/migrations/status/${fixture.slug}/preflight/download?${selectors}`;
export const filename = `historical-preflight-${reportId.slice('reconciliation:'.length)}.json`;

// Archived v1 variants, not current preflight inputs. MATCHED requires all v1
// metrics; absent comparison evidence is explicitly null with its diagnostic.
// Keep the oracle independent of the application reader/projector.
const metricCategories = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
export function archiveReportId(tenant: string, archive: unknown): string {
  return `reconciliation:${createHash('sha256').update(canonical([tenant, fixture.job, archive])).digest('hex')}`;
}
export const comparisonVariants = [
  { name: 'matched-past-comparison', status: 'MATCHED_PREFLIGHT',
    manifestDigest: '1'.repeat(64), currentManifestDigest: '1'.repeat(64),
    sourceFingerprint: '5'.repeat(64), diagnostics: [] },
  { name: 'absent-past-comparison', status: 'BLOCKED',
    manifestDigest: '2'.repeat(64), currentManifestDigest: null,
    sourceFingerprint: '6'.repeat(64), diagnostics: [{ category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' }] },
  { name: 'different-past-comparison', status: 'BLOCKED',
    manifestDigest: '3'.repeat(64), currentManifestDigest: '4'.repeat(64),
    sourceFingerprint: '7'.repeat(64), diagnostics: [{ category: 'SOURCES', code: 'SOURCE_MUTATION' }] },
].map(({ name, status, manifestDigest, currentManifestDigest, sourceFingerprint, diagnostics }) => {
  const archive = {
    ...details, manifestDigest, currentManifestDigest, sourceFingerprint,
    report: { ...details.report, status, diagnostics,
      metrics: metricCategories.map(category => ({ category, expected: '9007199254740993',
        actual: '9007199254740993', delta: '0', status: 'MATCH' })) },
  };
  const id = archiveReportId(fixture.tenant, archive);
  const query = new URLSearchParams({ jobId: fixture.job, reportId: id }).toString();
  return { name, archive, reportId: id, query,
    historyPath: `/c/${fixture.slug}/admin/migrations/history?${query}`,
    reportPath: `/api/migrations/status/${fixture.slug}/preflight?${query}`,
    downloadPath: `/api/migrations/status/${fixture.slug}/preflight/download?${query}`,
    filename: `historical-preflight-${id.slice('reconciliation:'.length)}.json`,
  };
});

// Test issuer only. The unchanged application decrypts/verifies the v2 cookie.
// This intentionally does NOT invoke or claim to test Google's OAuth callback.
export function sessionCookie(expired = false, issuedAt = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(fixture.secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({
    subject: fixture.subject, email: `${fixture.privateCanary}@example.invalid`,
    name: fixture.privateCanary, issuedAt: expired ? 1 : issuedAt,
  })), cipher.final()]);
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
