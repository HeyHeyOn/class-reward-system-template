import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { resolveTenantContext, type TenantDirectory } from '@/server/tenantContext';
import { createFreezingConsentIntake, readVerifiedFreezingConsent, readVerifiedStartFreezingConsent, type VerifiedFreezingConsent } from './freezingConsentIntake';
import { readFreezingConsentSession } from './freezingConsentSession';
import { MIGRATION_CALLBACK_PATH } from './googleSheetsConsent';
import { canonicalJson, sha256 } from './validators';
import { detachStartFreezingRegistration, type StartFreezingDispatchOutcome } from './startFreezingCeremony';
import type { StartedFreezing } from './startFreezing';

export const FREEZING_ROUTING_COOKIE = '__Secure-class_store_freezing_route';
const PURPOSE = 'CLASS_STORE_FREEZING_ROUTING_V1';
const START_PURPOSE = 'CLASS_STORE_START_FREEZING_ROUTING_V1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
type Context = { params: Promise<Record<string, string>> };
type Dependencies = Omit<Parameters<typeof createFreezingConsentIntake>[0], 'tenantId'> & { directory: TenantDirectory;
  continueStart?: (request: Request, handle: VerifiedFreezingConsent, intake: ReturnType<typeof createFreezingConsentIntake>) => Promise<StartFreezingDispatchOutcome | StartedFreezing>;
};
type Hint = {
  purpose: typeof PURPOSE | typeof START_PURPOSE; intentDigest?: string; slug: string; tenantId: string; migrationJobId: string;
  challengeId: string; sessionBinding: string; expiresAt: number; stateDigest: string | null;
};

/** Server-only composition seam. Only the canonical dispatcher can supply start
 * context. Callback hints never grant authority: directory + exact immutable
 * tenant-scoped challenge + the intake's current identity/membership rebind it.
 * The service retains the reservation/cleanup/acknowledged-commit boundary.
 */
export function createFreezingConsentHandlers(dependencies: Dependencies) {
  const env = Object.freeze({ ...(dependencies.env ?? process.env) });
  const origin = dependencies.origin;
  const startRegistration = dependencies.startRegistration ? detachStartFreezingRegistration(dependencies.startRegistration) : undefined;
  const continueStart = dependencies.continueStart;
  if (Boolean(startRegistration) !== Boolean(continueStart)) refused();
  const purpose = startRegistration ? START_PURPOSE : PURPOSE;
  const registrations = dependencies.registeredSheets.map(row => Object.freeze({ ...row }));
  const service = (tenantId: string) => createFreezingConsentIntake({ ...dependencies, env, registeredSheets: registrations, tenantId, startRegistration });
  function key() {
    const secret = env.AUTH_SECRET;
    if (!secret || secret.length < 32 || secret.length > 1024 || secret.trim() !== secret) refused();
    return createHmac('sha256', secret).update(JSON.stringify([purpose, origin])).digest();
  }
  function seal(hint: Hint) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(hint), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  function open(request: Request): Hint {
    const parts = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${FREEZING_ROUTING_COOKIE}=`));
    if (parts.length !== 1) refused();
    const encoded = parts[0].slice(FREEZING_ROUTING_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{40,4096}$/.test(encoded)) refused();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) refused();
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const hint = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as Hint;
    if (!hint || Object.keys(hint).sort().join(',') !== (startRegistration
      ? 'challengeId,expiresAt,intentDigest,migrationJobId,purpose,sessionBinding,slug,stateDigest,tenantId'
      : 'challengeId,expiresAt,migrationJobId,purpose,sessionBinding,slug,stateDigest,tenantId')
      || hint.purpose !== purpose || (startRegistration && (typeof hint.intentDigest !== 'string' || !HASH.test(hint.intentDigest))) || !UUID.test(hint.tenantId) || !UUID.test(hint.challengeId)
      || typeof hint.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hint.slug) || hint.slug.length > 63
      || typeof hint.migrationJobId !== 'string' || !hint.migrationJobId || hint.migrationJobId.length > 1024
      || !HASH.test(hint.sessionBinding) || (hint.stateDigest !== null && !HASH.test(hint.stateDigest))
      || !Number.isSafeInteger(hint.expiresAt) || hint.expiresAt <= Date.now() || hint.expiresAt > Date.now() + 300_000) refused();
    const session = readFreezingConsentSession(request, origin, env);
    if (session.sessionBinding !== hint.sessionBinding) refused();
    return hint;
  }
  function cookie(value: string, maxAge: number) {
    // Both canonical initiation and the fixed callback are below /api/.
    // Host-only, never Domain; Lax is necessary for the provider's top-level GET.
    return `${FREEZING_ROUTING_COOKIE}=${value}; Path=/api/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }
  function response(body: unknown, status = 200, hint?: Hint, clear = false) {
    return Response.json(body, { status, headers: {
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      ...(hint ? { 'set-cookie': cookie(seal(hint), Math.max(0, Math.floor((hint.expiresAt - Date.now()) / 1000))) }
        : clear ? { 'set-cookie': cookie('', 0) } : {}),
    } });
  }
  function deny(clear = false) { return response({ error: 'Freezing consent refused.' }, 403, undefined, clear); }
  function sameOriginPost(request: Request) {
    if (request.method !== 'POST' || new URL(request.url).origin !== origin || /[?#]/.test(request.url)
      || request.headers.get('origin') !== origin || request.headers.get('content-type') !== 'application/json'
      || ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) refused();
  }
  async function rebind(request: Request, hint: Hint) {
    const resolved = await resolveTenantContext(hint.slug, dependencies.directory);
    if (resolved.needsRedirect || resolved.tenant.id !== hint.tenantId) refused();
    // Exact tenant + challenge lookup under RLS. No global challenge/tenant scan.
    await dependencies.runTransaction(hint.tenantId, async tx => {
      const rows = (await tx.execute(sql`SELECT binding FROM migration_consent_challenges
        WHERE tenant_id=${hint.tenantId} AND challenge_id=${hint.challengeId}`)).rows;
      const b = rows[0]?.binding as Record<string, unknown> | undefined;
      if (rows.length !== 1 || !b || b.tenantId !== hint.tenantId || b.challengeId !== hint.challengeId
        || b.migrationJobId !== hint.migrationJobId || b.sessionBinding !== hint.sessionBinding
        || b.expiresAt !== hint.expiresAt) refused();
      if (startRegistration) {
        const intents = (await tx.execute(sql`SELECT binding FROM migration_start_intents
          WHERE tenant_id=${hint.tenantId} AND ceremony_id=${hint.challengeId}`)).rows;
        if (intents.length !== 1 || sha256(canonicalJson(intents[0].binding)) !== hint.intentDigest) refused();
      }
    });
    // Do not let a directory or DB wait outlive the current login/cookie.
    if (hint.expiresAt <= Date.now() || readFreezingConsentSession(request, origin, env).sessionBinding !== hint.sessionBinding) refused();
  }
  return {
    async challenge(request: Request, context: Context): Promise<Response> {
      try {
        const tenant = getTrustedTenantRequestContext().tenant;
        sameOriginPost(request);
        const session = readFreezingConsentSession(request, origin, env);
        const { jobId } = await context.params;
        const input = await body(request, ['expectedStateVersion', 'sourceId']);
        const issued = await service(tenant.id).issueChallenge(request, { ...input, migrationJobId: jobId });
        const { startIntentDigest, ...display } = issued;
        return response(display, 200, { purpose, ...(startRegistration ? { intentDigest: startIntentDigest } : {}), slug: tenant.slug, tenantId: tenant.id, migrationJobId: jobId,
          challengeId: issued.challengeId, sessionBinding: session.sessionBinding, expiresAt: issued.expiresAt, stateDigest: null });
      } catch { return deny(); }
    },
    async begin(request: Request, context: Context): Promise<Response> {
      try {
        const tenant = getTrustedTenantRequestContext().tenant;
        sameOriginPost(request);
        const hint = open(request);
        const { jobId } = await context.params;
        const input = await body(request, startRegistration ? ['challengeId', 'display'] : ['challengeId']);
        if (hint.tenantId !== tenant.id || hint.slug !== tenant.slug || hint.migrationJobId !== jobId
          || hint.challengeId !== input.challengeId || hint.stateDigest !== null) refused();
        await rebind(request, hint);
        const authorizationUrl = await service(tenant.id).begin(request, input);
        const state = new URL(authorizationUrl).searchParams.get('state');
        if (!state) refused();
        return response({ authorizationUrl }, 200, { ...hint, stateDigest: sha256(state) });
      } catch { return deny(); }
    },
    async callback(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method !== 'GET' || `${url.origin}${url.pathname}` !== `${origin}${MIGRATION_CALLBACK_PATH}` || url.hash || request.url.length > 12_000) refused();
        // Google adds these informational singleton fields; none are authority.
        const allowed = new Set(['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'error_uri']);
        for (const name of url.searchParams.keys()) if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) refused();
        const hint = open(request);
        const state = url.searchParams.get('state');
        if (!state || !hint.stateDigest || sha256(state) !== hint.stateDigest || state.slice(0, 36) !== hint.challengeId) refused();
        await rebind(request, hint);
        // Denial is terminal only after session/state/challenge validation. Never
        // reflect, persist or log provider error descriptions or error URLs.
        const denied = url.searchParams.has('error');
        if (denied ? (url.searchParams.has('code') || !url.searchParams.get('error'))
          : (url.searchParams.has('error_description') || url.searchParams.has('error_uri'))) refused();
        const code = denied ? 'provider_denied' : url.searchParams.get('code');
        if (!code) refused();
        const normalized = new URL(`${origin}${MIGRATION_CALLBACK_PATH}`);
        normalized.searchParams.set('state', state);
        normalized.searchParams.set(denied ? 'error' : 'code', code);
        const callbackRequest = new Request(normalized, { headers: new Headers(request.headers) });
        const intake = service(hint.tenantId);
        const handle = await intake.complete(callbackRequest);
        if (startRegistration && continueStart) {
          const live = readVerifiedStartFreezingConsent(handle);
          if (sha256(canonicalJson(live.intent)) !== hint.intentDigest) refused();
          // Await in this invocation. Never a detached task, serialized handle,
          // receipt recovery, or consent-only promotion after CAPTURED.
          let result: StartFreezingDispatchOutcome | StartedFreezing;
          try { result = await continueStart(callbackRequest, handle, intake); }
          catch {
            // The producer may already have disabled its writer, and a lost
            // local COMMIT ACK may even mean STARTED is durable. Never label
            // this consent denial/not-performed or expose a retry capability.
            return response({ ceremonyId: hint.challengeId, status: 'UNKNOWN', externalEffect: 'UNKNOWN',
              automaticRetry: false, automaticEnable: false }, 202, undefined, true);
          }
          if (result.status === 'STARTED') {
            if (result.ceremonyId !== hint.challengeId || result.migrationJobId !== hint.migrationJobId || result.exclusion !== 'NOT_PROVEN') refused();
            return response({ ceremonyId: hint.challengeId, status: 'STARTED', exclusion: 'NOT_PROVEN',
              automaticRetry: false, automaticEnable: false }, 200, undefined, true);
          }
          return response({ ceremonyId: hint.challengeId,
            status: result.status === 'UNKNOWN' ? 'UNKNOWN' : 'BRIDGE_RESPONDED_START_NOT_COMMITTED',
            externalEffect: result.externalEffect, automaticRetry: false, automaticEnable: false }, 202, undefined, true);
        }
        const receipt = readVerifiedFreezingConsent(handle);
        // Never serialize the private handle, acquisition, provider data or receipt.
        return response({ challengeId: receipt.challengeId, status: 'CAPTURED', scope: receipt.scope }, 200, undefined, true);
      } catch { return deny(true); }
    },
  };
}
async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) refused();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) refused();
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) refused();
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}
function refused(): never { throw Error('Freezing consent refused.'); }
