// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn(), provider: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  connect = mocks.connect;
  on() {}
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: mocks.config }));
vi.mock('googleapis', () => ({ google: { auth: { OAuth2: mocks.provider }, oauth2: mocks.provider } }));
import { getGoogleSessionFromRequest, type GoogleSession } from '@/server/googleOAuth';
import * as reader from '../../readPreflightReport';
import * as route from './route';

// Characterization of the existing inline route, NOT a key-policy/security fix.
// Real ordinary verifier -> real reader/membership/projector; only pg transport
// and provider are fakes. Reuse route.test.ts's tenant/field/archive conventions
// without importing that suite, changing its fixture or invoking any producer.
// A fallback-key 200 is RISK REPRODUCTION, not deployed-key knowledge, actual
// Google login/membership, live preflight, cutover authority or Task20 acceptance.
// Invoke GET/HEAD in process; no Next HTTP server, browser, SQL engine or network.
// Run with an empty/allowlisted process environment and Vite env-file loading
// disabled; per-test stubs must never select inherited operational credentials.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-private-subject';
const JOB = 'historical/과거 job:%20';
const AUTH_KEY = 'synthetic-identity-route-auth-not-a-real-secret';
const CLIENT_KEY = 'synthetic-identity-route-client-not-a-real-secret';
const ADMIN_KEY = 'synthetic-identity-route-admin-not-a-real-secret';
const WRONG_KEY = 'synthetic-identity-route-unselected-not-a-real-secret';
const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION: GoogleSession = { subject: SUBJECT, email: 'synthetic@example.test', issuedAt: NOW };
type IdentityEnv = NonNullable<Parameters<typeof getGoogleSessionFromRequest>[1]>;
type Method = 'GET' | 'HEAD';
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: [string, number][]): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const tenant = { id: TENANT, slug: 'alpha', display_name: 'synthetic-class', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const member = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
const details = {
  report: { reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED', authority: 'SHEETS_AND_REDIS',
    cutoverAllowed: false, metrics: [], diagnostics: [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }], omittedDiagnostics: 0 },
  comparisonInstant: '2026-01-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64),
  currentManifestDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
};
const event = {
  tenant_id: TENANT, job_id: JOB,
  event_id: `reconciliation:${createHash('sha256').update(canonical([TENANT, JOB, details])).digest('hex')}`,
  event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
  entity_type: null, entity_id: null, redacted_details: details,
};

function installSyntheticEnv(env: IdentityEnv) {
  for (const name of ['AUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD', 'GOOGLE_CLIENT_ID',
    'GOOGLE_REFRESH_TOKEN', 'GENERATOR_GOOGLE_CLIENT_ID', 'GENERATOR_GOOGLE_CLIENT_SECRET']) {
    vi.stubEnv(name, env[name]);
  }
}

// Independent fixture encoder: the test specifies one raw synthetic key, never
// the production resolver/fallback algorithm. Fixed IV is test-only, not reuse
// guidance for real encryption. Tampered tags still pass the reader's grammar.
function cookie(key: string, session = SESSION, tamperTag = false): string {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tamperTag) tag[0] ^= 1;
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${tag.toString('base64url')}.${bytes.toString('base64url')}`;
}

let membershipReply: Reply;
let client: EventEmitter & {
  query: ReturnType<typeof vi.fn<(config: QueryConfig) => Promise<Reply>>>;
  release: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
const reportCalls = () => client.query.mock.calls.filter(([config]) => config.text.includes('public.audit_events'));
beforeEach(() => {
  installSyntheticEnv({});
  vi.stubEnv('NODE_ENV', 'production');
  vi.spyOn(Date, 'now').mockReturnValue(NOW); // Keep reader deadline timers real.
  membershipReply = reply([member], MEMBER_FIELDS);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
      if (config.text.includes('public.audit_events')) {
        return reply([{ found: true, oversized: false, envelope_text: JSON.stringify(event) }], REPORT_FIELDS);
      }
      if (config.text.includes('public.platform_find_membership')) {
        expect(config.values).toEqual([TENANT, SUBJECT]);
        return membershipReply;
      }
      if (config.text.includes('public.platform_find_tenant')) {
        expect(config.values).toEqual(['alpha']);
        return reply([tenant], TENANT_FIELDS);
      }
      if (/^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT set_config\(|ROLLBACK$)/.test(config.text)) {
        return reply([], []);
      }
      throw new Error('Unexpected fixture SQL');
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
  mocks.config.mockReset().mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
  mocks.provider.mockReset().mockImplementation(() => { throw new Error('Provider access forbidden'); });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(client.query.mock.calls.every(([config]) =>
      /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text.trimStart()))).toBe(true);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function exercise(method: Method, env: IdentityEnv, value: string, status: 200 | 401 | 403) {
  installSyntheticEnv(env);
  const input = new Request(`https://example.test/api/migrations/status/alpha/preflight?jobId=${encodeURIComponent(JOB)}&reportId=${event.event_id}`, {
    method, headers: { cookie: value, 'x-role': 'OWNER' },
  });
  // Default-env overload is exactly what the production reader calls. Do not
  // mock the verifier or pass a separate env only to this assertion.
  expect(getGoogleSessionFromRequest(input)).toEqual(status === 401 ? null : SESSION);
  const read = vi.spyOn(reader, 'readPreflightReport'); // Call-through, never stubbed.
  const response = await route[method](input, { params: Promise.resolve({ slug: 'alpha' }) });
  expect(read).toHaveBeenCalledExactlyOnceWith('alpha', input);
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('set-cookie')).toBeNull();
  if (method === 'HEAD') {
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  } else if (status === 200) {
    const projection = await response.json();
    expect(projection).toMatchObject({
      scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY', originalBinding: 'NOT_VERIFIED',
      currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN',
      cutoverAllowed: false, reportId: event.event_id, report: { status: 'BLOCKED' },
    });
    // Archived authority labels are deliberately not part of HistoricalReport.
    // Only the projection's current, fail-closed authority fields survive.
    expect(projection.report).not.toHaveProperty('cutoverAllowed');
    expect(projection.report).not.toHaveProperty('authority');
  } else {
    expect(await response.json()).toEqual({ error: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED' });
  }
  if (status === 401) {
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  } else {
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(client.query.mock.calls.at(-1)?.[0].text).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(reportCalls()).toHaveLength(status === 200 ? 1 : 0);
    if (status === 200) {
      expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
    }
  }
}

const accepted: { label: string; env: IdentityEnv; key: string }[] = [
  { label: 'control: AUTH_SECRET wins over client/admin keys',
    env: { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: AUTH_KEY },
  { label: 'RISK REPRODUCTION: missing AUTH_SECRET accepts client fallback before admin',
    env: { GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: CLIENT_KEY },
  { label: 'RISK REPRODUCTION: empty AUTH_SECRET accepts client fallback',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: CLIENT_KEY },
  { label: 'RISK REPRODUCTION: admin-only fallback without OAuth provider configuration',
    env: { ADMIN_PASSWORD: ADMIN_KEY }, key: ADMIN_KEY },
  { label: 'RISK REPRODUCTION: empty AUTH_SECRET/client accepts admin fallback',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: '', ADMIN_PASSWORD: ADMIN_KEY }, key: ADMIN_KEY },
  { label: 'RISK REPRODUCTION: one-character AUTH_SECRET wins over strong fallback strings',
    env: { AUTH_SECRET: 'x', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: 'x' },
];
const rejected: { label: string; env: IdentityEnv; key: string }[] = [
  { label: 'all keys absent', env: {}, key: AUTH_KEY },
  { label: 'whitespace AUTH_SECRET must not fall through to client',
    env: { AUTH_SECRET: ' \t\n', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: CLIENT_KEY },
  { label: 'whitespace client secret must not fall through to admin',
    env: { GOOGLE_CLIENT_SECRET: ' \t\n', ADMIN_PASSWORD: ADMIN_KEY }, key: ADMIN_KEY },
  { label: 'unselected client cookie when AUTH_SECRET is set',
    env: { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: CLIENT_KEY },
  { label: 'unselected admin cookie when client fallback is selected',
    env: { GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY }, key: ADMIN_KEY },
];

describe.each(['GET', 'HEAD'] as const)('inline preflight %s identity boundary (synthetic PG, not security remediation)', method => {
  it.each(accepted)('$label -> historical 200 only', async ({ env, key }) => {
    await exercise(method, env, cookie(key), 200);
  });
  it.each(rejected)('$label -> 401 before PG acquisition', async ({ env, key }) => {
    await exercise(method, env, cookie(key), 401);
  });
  it.each([
    { label: 'wrong selected key', value: () => cookie(WRONG_KEY) },
    { label: 'tampered authentication tag', value: () => cookie(AUTH_KEY, SESSION, true) },
    { label: 'expired correctly keyed identity', value: () => cookie(AUTH_KEY, { ...SESSION, issuedAt: NOW - MAX_AGE_MS - 1 }) },
    { label: 'correctly keyed empty subject', value: () => cookie(AUTH_KEY, { ...SESSION, subject: '' }) },
  ])('$label -> 401 before PG acquisition', async ({ value }) => {
    await exercise(method, { AUTH_SECRET: AUTH_KEY }, value(), 401);
  });
  it('accepted admin-key identity still needs current membership; ACTIVE and role headers do not grant it', async () => {
    membershipReply = reply([], MEMBER_FIELDS);
    await exercise(method, { ADMIN_PASSWORD: ADMIN_KEY }, cookie(ADMIN_KEY), 403);
  });
});
