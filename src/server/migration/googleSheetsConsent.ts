import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import { Readable } from 'node:stream';
import type { GaxiosOptions } from 'gaxios';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { NextResponse } from 'next/server';

export const MIGRATION_CONSENT_COOKIE = 'class_store_migration_google_state';
export const MIGRATION_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  // drive.file is valid only for a file created/opened by this app or explicitly
  // selected and shared through Google Picker. A caller-supplied Sheet ID alone
  // grants no access and proves no role; Task 12/20 must verify the Picker ID and
  // Drive owner (or explicitly supported Shared Drive control) role before binding.
  'https://www.googleapis.com/auth/drive.file',
] as const;

// Identity scopes are isolated to fresh action-bound consent; preflight keeps its
// historical readonly Sheets + selected-file scope contract.
export const FREEZING_GOOGLE_SCOPES = [...MIGRATION_GOOGLE_SCOPES, 'openid', 'email'] as const;
export const MIGRATION_CALLBACK_PATH = '/api/migrations/google-sheets/callback';

export function createFreezingConsentUrl(origin: string, state: string, nonce: string, env: GoogleAuthEnv = process.env): string {
  return createMigrationOAuthClient(origin, env).generateAuthUrl({
    access_type: 'online', prompt: 'consent', include_granted_scopes: false,
    scope: [...FREEZING_GOOGLE_SCOPES], state, nonce,
  });
}

export type FreezingOAuthDependencies = Readonly<{
  env?: GoogleAuthEnv;
  // Internal server/test transport seam, never populated from a Request.
  createClient?: (origin: string, env: GoogleAuthEnv) => InstanceType<typeof google.auth.OAuth2>;
}>;

/** A directly exchanged access token must be paired with the verified ID token.
 * Own cleanup immediately after exchange, including identity/transport failures.
 * No provider errors (which can carry token request config) escape this boundary.
 */
export async function withVerifiedFreezingAuthorization<T>(
  origin: string, code: string,
  expected: Readonly<{subject: string; email: string; nonce: string}>,
  capture: (authorization: EphemeralMigrationAuthorization) => Promise<T>,
  dependencies: FreezingOAuthDependencies = {},
): Promise<T> {
  const binding = {...expected};
  const env = {...(dependencies.env ?? process.env)};
  let client: InstanceType<typeof google.auth.OAuth2> | undefined;
  let revocationToken: string | undefined;
  try {
    // Validate the configured isolated client/origin even when a local transport is used.
    client = createMigrationOAuthClient(origin, env);
    if (dependencies.createClient) client = dependencies.createClient(origin, env);
    // The SDK otherwise enables retries for code exchange. An uncertain exchange
    // must require a new ceremony, never an automatic second exchange.
    const transport = client.transporter.request.bind(client.transporter);
    client.transporter.request = (async (options:GaxiosOptions={}) => {
      const bounded = {...options,retry:false,retryConfig:{retry:0,noResponseRetries:0},maxRedirects:0,timeout:10_000,validateStatus:()=>true};
      // Workbook responses are bounded by the reader. All SDK JSON endpoints
      // must be streamed here: Gaxios otherwise buffers JSON and error bodies.
      if(options.responseType==='stream')return transport(bounded);
      const controller=new AbortController();let stream:Readable|undefined;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();stream?.destroy();reject(Error());},10_000);});
        const read=async()=>{
          const response=await transport({...bounded,responseType:'stream',signal:controller.signal});
          if(!(response.data instanceof Readable))throw Error();
          stream=response.data;
          if(controller.signal.aborted){stream.destroy();throw Error();}
          if(response.status!==200)throw Error();
          // node-fetch decodes these codings but retains the wire Content-Length.
          // Keep a conservative declared wire cap and independently cap decoded bytes.
          const encoding=response.headers.get('content-encoding') ?? 'identity';
          if(!['identity','gzip','deflate','br'].includes(encoding))throw Error();
          const length=response.headers.get('content-length');
          if(length!==null && (!/^(0|[1-9][0-9]*)$/.test(length)||BigInt(length)>BigInt(128_000)))throw Error();
          let bytes=0;const chunks:Buffer[]=[];
          for await(const chunk of stream){
            if(!(typeof chunk==='string'||chunk instanceof Uint8Array))throw Error();
            const buffer=Buffer.from(chunk);bytes+=buffer.byteLength;if(bytes>128_000)throw Error();chunks.push(buffer);
          }
          if(encoding==='identity'&&length!==null&&BigInt(length)!==BigInt(bytes))throw Error();
          // Revocation may legitimately return an empty successful body.
          response.data=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
          return response;
        };
        return await Promise.race([read(),timeout]);
      } finally {if(timer)clearTimeout(timer);controller.abort();stream?.destroy();}
    }) as typeof client.transporter.request;
    client.eagerRefreshThresholdMillis = 0;
    const {tokens} = await client.getToken(code);
    revocationToken = tokens.refresh_token?.trim() || tokens.access_token?.trim() || undefined;
    // Never make an unexpected refresh grant available to the acquisition client.
    client.setCredentials({access_token:tokens.access_token,expiry_date:tokens.expiry_date});
    if (!tokens.access_token || !tokens.id_token || !tokens.expiry_date || tokens.expiry_date <= Date.now()) throw Error();
    const ticket = await client.verifyIdToken({idToken:tokens.id_token,audience:env.MIGRATION_GOOGLE_CLIENT_ID!.trim()});
    const claims = ticket.getPayload() as (ReturnType<typeof ticket.getPayload> & {nonce?:string;at_hash?:string;azp?:string});
    const clientId = env.MIGRATION_GOOGLE_CLIENT_ID!.trim();
    if (!claims || !['accounts.google.com','https://accounts.google.com'].includes(claims.iss)
      || claims.aud !== clientId || (claims.azp !== undefined && claims.azp !== clientId)
      || claims.sub !== binding.subject || canonicalEmail(claims.email) !== canonicalEmail(binding.email) || claims.email_verified !== true
      || claims.nonce !== binding.nonce || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()
      || !Number.isSafeInteger(claims.iat) || claims.iat * 1000 > Date.now()
      || claims.at_hash !== createHash('sha256').update(tokens.access_token).digest().subarray(0,16).toString('base64url')) throw Error();
    const info = await client.getTokenInfo(tokens.access_token);
    const scopes = new Set(info.scopes);
    if (info.aud !== clientId || info.sub !== binding.subject || (info.azp !== undefined && info.azp !== clientId)
      || !Number.isSafeInteger(info.expiry_date) || info.expiry_date <= Date.now()
      || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email'))
      || MIGRATION_GOOGLE_SCOPES.some(scope => !scopes.has(scope))) throw Error();
    const expiresAt = Math.min(tokens.expiry_date,info.expiry_date,claims.exp*1000);
    const result = await capture({auth:client,expiresAt});
    if (Date.now() >= expiresAt) throw Error();
    return result;
  } catch {
    throw new Error('Freezing OAuth refused.');
  } finally {
    try {
      if (client && revocationToken) await client.revokeToken(revocationToken);
    } catch {
      throw new Error('Freezing OAuth refused.');
    } finally {
      if (client) client.setCredentials({});
    }
  }
}

function canonicalEmail(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length>320 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Freezing OAuth refused.');
  return value.trim().toLowerCase();
}

const COOKIE_VERSION = 'migration-v1';
const COOKIE_PATH = '/api/migrations/google-sheets';
const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const MAX_BINDING_AGE_MS = COOKIE_MAX_AGE_SECONDS * 1000;
const DEFAULT_RETURN_TO = '/admin/migrations';
const CALLBACK_PATH = '/api/migrations/google-sheets/callback';

export type MigrationConsentStage = 'preflight' | 'freezing';

export type MigrationConsentBinding = {
  purpose: 'sheets-migration';
  stage: MigrationConsentStage;
  state: string;
  sheetId: string;
  targetTenantId?: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Durable background grants are intentionally not implemented. If introduced,
 * persistence must satisfy this shape: encrypted at rest, explicitly expiring,
 * and revocable. Browser-attached ephemeral authorization remains the default.
 */
export type DurableBackgroundMigrationGrant = {
  encryptedRefreshToken: string;
  expiresAt: number;
  revocationRequired: true;
};

type GoogleAuthEnv = {
  [key: string]: string | undefined;
  // These credentials must belong to an OAuth project/client isolated from the
  // legacy deployment grant. Token revocation can invalidate related grants
  // within the same Google authorization project.
  MIGRATION_GOOGLE_CLIENT_ID?: string;
  MIGRATION_GOOGLE_CLIENT_SECRET?: string;
  MIGRATION_GOOGLE_OAUTH_ORIGIN?: string;
  AUTH_SECRET?: string;
  ADMIN_PASSWORD?: string;
};

type EphemeralOAuthClient = {
  getToken(code: string): Promise<{ tokens: Credentials }>;
  setCredentials(credentials: Credentials): void;
  revokeToken(token: string): Promise<unknown>;
  request?: (options: {
    url: string;
    method?: string;
    params?: Readonly<Record<string, unknown>>;
    responseType?: 'stream';
    timeout?: number;
    retry?: boolean;
    maxRedirects?: number;
    validateStatus?: (status:number)=>boolean;
    signal?: AbortSignal;
  }) => PromiseLike<{ data: unknown; status?: number; headers?: {get(name:string):string|null} }>;
};

export type EphemeralMigrationAuthorization = {
  auth: EphemeralOAuthClient;
  expiresAt?: number;
};

type EphemeralAuthorizationDependencies = {
  createClient?: (origin: string, env?: GoogleAuthEnv) => EphemeralOAuthClient;
  env?: GoogleAuthEnv;
};

const consumedStateCookies = new Map<string, number>();

export function createMigrationConsentBinding(
  input: {
    stage: MigrationConsentStage;
    sheetId: string;
    targetTenantId?: string;
    returnTo?: string;
  },
  now = Date.now(),
): MigrationConsentBinding {
  if (!isValidBindingInput(input)) throw new Error('Invalid migration consent context.');
  const created: MigrationConsentBinding = {
    purpose: 'sheets-migration',
    stage: input.stage,
    state: randomBytes(24).toString('base64url'),
    sheetId: input.sheetId,
    ...(input.targetTenantId ? { targetTenantId: input.targetTenantId } : {}),
    returnTo: sanitizeMigrationReturnTo(input.returnTo),
    issuedAt: now,
    expiresAt: now + MAX_BINDING_AGE_MS,
  };
  if (!isValidBindingShape(created)) throw new Error('Invalid migration consent context.');
  return created;
}

export function createMigrationConsentUrl(origin: string, state: string, env: GoogleAuthEnv = process.env): string {
  const client = createMigrationOAuthClient(origin, env);
  return client.generateAuthUrl({
    access_type: 'online',
    prompt: 'consent',
    include_granted_scopes: false,
    scope: [...MIGRATION_GOOGLE_SCOPES],
    state,
  });
}

export function setMigrationConsentStateCookie(
  response: NextResponse,
  binding: MigrationConsentBinding,
  env: GoogleAuthEnv = process.env,
): void {
  if (!isValidBindingShape(binding)) {
    throw new Error('Invalid migration consent binding.');
  }
  response.cookies.set(MIGRATION_CONSENT_COOKIE, encryptBinding(binding, env), migrationCookieOptions());
}

export function consumeMigrationConsentState(
  request: Request,
  response: NextResponse,
  submittedState: string,
  env: GoogleAuthEnv = process.env,
  now = Date.now(),
): MigrationConsentBinding | null {
  const saved = getCookieValue(request, MIGRATION_CONSENT_COOKIE);
  clearMigrationConsentStateCookie(response);
  pruneConsumedStates(now);
  if (!saved || !submittedState) return null;

  const replayKey = createHash('sha256').update(saved).digest('base64url');
  if (consumedStateCookies.has(replayKey)) return null;
  // Consume before validation so malformed, mismatched, and expired cookies cannot
  // be retried in this runtime. The clearing Set-Cookie is the browser boundary.
  consumedStateCookies.set(replayKey, now + MAX_BINDING_AGE_MS);

  const binding = decryptBinding(saved, env);
  if (!binding || !isValidBindingShape(binding)) return null;
  if (!safeEqual(binding.state, submittedState)) return null;
  if (binding.issuedAt > now || binding.expiresAt <= now) return null;
  if (binding.expiresAt - binding.issuedAt > MAX_BINDING_AGE_MS) return null;
  if (now - binding.issuedAt > MAX_BINDING_AGE_MS) return null;
  if (binding.returnTo !== sanitizeMigrationReturnTo(binding.returnTo)) return null;
  return binding;
}

export function sanitizeMigrationReturnTo(value: string | null | undefined): string {
  if (!value || (value !== DEFAULT_RETURN_TO && !value.startsWith(`${DEFAULT_RETURN_TO}/`) && !value.startsWith(`${DEFAULT_RETURN_TO}?`) && !value.startsWith(`${DEFAULT_RETURN_TO}#`))) {
    return DEFAULT_RETURN_TO;
  }
  if (value.startsWith('//') || value.includes('\\')) return DEFAULT_RETURN_TO;
  try {
    const parsed = new URL(value, 'https://class-store.invalid');
    if (parsed.origin !== 'https://class-store.invalid') return DEFAULT_RETURN_TO;
    if (!parsed.pathname.startsWith('/admin/migrations')) return DEFAULT_RETURN_TO;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

/**
 * Task 14 supplies `captureSnapshot` to capture one immutable snapshot. The
 * OAuth client is usable only during that callback; credentials are revoked
 * and removed in `finally`, including when capture or validation fails.
 */
export async function withEphemeralMigrationAuthorization<T>(
  origin: string,
  code: string,
  captureSnapshot: (authorization: EphemeralMigrationAuthorization) => Promise<T>,
  dependencies: EphemeralAuthorizationDependencies = {},
): Promise<T> {
  const client = dependencies.createClient?.(origin, dependencies.env)
    ?? createMigrationOAuthClient(origin, dependencies.env ?? process.env);
  let revocationToken: string | undefined;
  let primaryError: unknown;

  try {
    const { tokens } = await client.getToken(code);
    revocationToken = tokens.refresh_token?.trim() || tokens.access_token?.trim() || undefined;
    client.setCredentials(tokens);
    if (!tokens.access_token) {
      throw new Error('Google migration consent did not return a browser-attached access token.');
    }
    return await captureSnapshot({ auth: client, expiresAt: tokens.expiry_date ?? undefined });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (revocationToken) await client.revokeToken(revocationToken);
    } catch (revocationError) {
      if (primaryError === undefined) throw revocationError;
      if (primaryError instanceof Error && primaryError.cause === undefined) {
        primaryError.cause = revocationError;
      }
    } finally {
      client.setCredentials({});
    }
  }
}

function createMigrationOAuthClient(origin: string, env: GoogleAuthEnv): InstanceType<typeof google.auth.OAuth2> {
  const clientId = env.MIGRATION_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.MIGRATION_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Migration OAuth requires isolated MIGRATION_GOOGLE_CLIENT_ID and MIGRATION_GOOGLE_CLIENT_SECRET credentials.');
  }
  const applicationOrigin = getCanonicalApplicationOrigin(origin, env);
  return new google.auth.OAuth2(clientId, clientSecret, `${applicationOrigin}${CALLBACK_PATH}`);
}

function getCanonicalApplicationOrigin(origin: string, env: GoogleAuthEnv): string {
  let supplied: URL;
  try {
    supplied = new URL(origin);
  } catch {
    throw new Error('Invalid migration OAuth origin.');
  }
  const isLocalHttp = supplied.protocol === 'http:' && (supplied.hostname === 'localhost' || supplied.hostname === '127.0.0.1');
  if ((!isLocalHttp && supplied.protocol !== 'https:') || supplied.username || supplied.password
    || supplied.pathname !== '/' || supplied.search || supplied.hash) {
    throw new Error('Invalid migration OAuth origin.');
  }

  const configured = env.MIGRATION_GOOGLE_OAUTH_ORIGIN?.trim();
  if (!configured) return supplied.origin;
  let canonical: URL;
  try {
    canonical = new URL(configured);
  } catch {
    throw new Error('Invalid configured migration OAuth origin.');
  }
  if (canonical.origin !== supplied.origin || canonical.pathname !== '/' || canonical.search || canonical.hash) {
    throw new Error('Migration OAuth origin does not match the configured application origin.');
  }
  return canonical.origin;
}

function migrationCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}

function clearMigrationConsentStateCookie(response: NextResponse): void {
  response.cookies.set(MIGRATION_CONSENT_COOKIE, '', {
    ...migrationCookieOptions(),
    maxAge: 0,
  });
}

function isValidBindingShape(value: unknown): value is MigrationConsentBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'purpose', 'stage', 'state', 'sheetId', 'targetTenantId', 'returnTo', 'issuedAt', 'expiresAt',
  ]);
  if (Object.keys(binding).some((key) => !allowedKeys.has(key))) return false;
  return binding.purpose === 'sheets-migration'
    && (binding.stage === 'preflight' || binding.stage === 'freezing')
    && isBoundedString(binding.state, 16, 256)
    && isBoundedString(binding.sheetId, 1, 256)
    && (binding.targetTenantId === undefined || isBoundedString(binding.targetTenantId, 1, 256))
    && (binding.stage !== 'freezing' || binding.targetTenantId !== undefined)
    && typeof binding.returnTo === 'string'
    && Number.isSafeInteger(binding.issuedAt)
    && Number.isSafeInteger(binding.expiresAt)
    && (binding.expiresAt as number) > (binding.issuedAt as number);
}

function isValidBindingInput(value: unknown): value is {
  stage: MigrationConsentStage;
  sheetId: string;
  targetTenantId?: string;
  returnTo?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(['stage', 'sheetId', 'targetTenantId', 'returnTo']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  return (input.stage === 'preflight' || input.stage === 'freezing')
    && isSafeIdentifier(input.sheetId)
    && (input.targetTenantId === undefined || isSafeIdentifier(input.targetTenantId))
    && (input.stage !== 'freezing' || input.targetTenantId !== undefined)
    && (input.returnTo === undefined || (typeof input.returnTo === 'string' && input.returnTo.length <= 1024));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function encryptBinding(binding: MigrationConsentBinding, env: GoogleAuthEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getCookieKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(binding), 'utf8'), cipher.final()]);
  return [COOKIE_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptBinding(value: string, env: GoogleAuthEnv): unknown {
  try {
    const [version, ivPart, tagPart, ciphertextPart, extra] = value.split('.');
    if (version !== COOKIE_VERSION || !ivPart || !tagPart || !ciphertextPart || extra) return null;
    const decipher = createDecipheriv('aes-256-gcm', getCookieKey(env), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
}

function getCookieKey(env: GoogleAuthEnv): Buffer {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32 || secret.length > 1024) {
    throw new Error('Migration OAuth state cookie requires a strong AUTH_SECRET of at least 32 characters.');
  }
  return createHash('sha256').update(`migration-consent\0${secret}`).digest();
}

function getCookieValue(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pruneConsumedStates(now: number): void {
  for (const [key, expiresAt] of consumedStateCookies) {
    if (expiresAt <= now) consumedStateCookies.delete(key);
  }
}
