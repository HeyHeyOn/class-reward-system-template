import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest } from '@/server/googleOAuth';

const PURPOSE = 'CLASS_STORE_FREEZING_CONSENT_SESSION_V1';
const DIGEST = /^[0-9a-f]{64}$/;
// The existing Google v2 session reader owns this 30-day login lifetime. Recheck
// both clocks here (including the exact expiry boundary) without changing its wire format.
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
declare const sessionBrand: unique symbol;
export type FreezingConsentSession = Readonly<{
  [sessionBrand]: true;
  subject: string;
  email: string;
  issuedAt: number;
  sessionBinding: string;
}>;
const verifiedSessions = new WeakSet<FreezingConsentSession>();
type Environment = Readonly<Record<string, string | undefined>>;

/** Identity only, never tenant membership or consent authority. This synchronous
 * reader detaches the existing authenticated Google login before an intake await.
 * It deliberately ignores compatibility-admin cookies and dispatcher fallbacks.
 * The keyed binding distinguishes independently encrypted logins even when their
 * subject and issuedAt happen to match; neither raw cookie nor key is returned.
 */
export function readFreezingConsentSession(
  request: Request, origin: string, env: Environment = process.env,
): FreezingConsentSession {
  try {
    assertOrigin(request, origin);
    const secret = env.AUTH_SECRET;
    if (!secret || secret.trim() !== secret || secret.length < 32 || secret.length > 1024) refused();
    const cookies = (request.headers.get('cookie') ?? '').split(';')
      .map(part => part.trim()).filter(part => part.slice(0, part.indexOf('=')) === GOOGLE_AUTH_COOKIE);
    if (cookies.length !== 1) refused();
    const cookie = cookies[0].slice(GOOGLE_AUTH_COOKIE.length + 1);
    if (!cookie || cookie.length > 8192) refused();
    const session = getGoogleSessionFromRequest(request, env);
    if (!session) refused();
    freshSession(session.issuedAt, Date.now());
    const sessionBinding = createHmac('sha256', secret)
      .update(JSON.stringify([PURPOSE, origin, cookie])).digest('hex');
    const detached = Object.freeze({subject: session.subject, email: session.email.trim().toLowerCase(),
      issuedAt: session.issuedAt, sessionBinding}) as FreezingConsentSession;
    verifiedSessions.add(detached);
    return detached;
  } catch { return refused(); }
}

/** Call after provider cleanup and again after DB lock/readback waits. A persisted
 * binding is archival data, not a substitute for this request's verified session.
 */
export function revalidateFreezingConsentSession(
  prior: FreezingConsentSession, request: Request, origin: string, databaseNow: number,
  env: Environment = process.env,
): FreezingConsentSession {
  try {
    if (!verifiedSessions.has(prior)) refused();
    const current = readFreezingConsentSession(request, origin, env);
    if (current.sessionBinding !== prior.sessionBinding || current.subject !== prior.subject
      || current.email !== prior.email || current.issuedAt !== prior.issuedAt) refused();
    freshSession(current.issuedAt, databaseNow);
    return prior;
  } catch { return refused(); }
}

/** The intake must persist digest with its immutable session/tenant/job-bound
 * challenge and deliver token only in a same-origin no-store response. This
 * primitive does not itself issue a challenge, store a token, or grant consent.
 */
export function issueFreezingConsentSynchronizer(): Readonly<{token: string; digest: string}> {
  const token = randomBytes(32).toString('hex');
  return Object.freeze({token, digest: synchronizerDigest(token)});
}

/** trustedDigest must come from that authenticated server challenge, never a
 * request field, cookie-supplied digest, or publicly derivable subject hash.
 */
export function verifyFreezingConsentPost(
  request: Request, origin: string, trustedDigest: string, session: FreezingConsentSession,
  env: Environment = process.env,
): void {
  try {
    revalidateFreezingConsentSession(session, request, origin, Date.now(), env);
    if (request.method !== 'POST' || /[?#]/.test(request.url) || request.headers.get('origin') !== origin
      || request.headers.get('content-type') !== 'application/json'
      || ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) refused();
    const token = request.headers.get('x-csrf-token');
    if (!token || !DIGEST.test(token) || !DIGEST.test(trustedDigest)
      || !timingSafeEqual(Buffer.from(synchronizerDigest(token), 'hex'), Buffer.from(trustedDigest, 'hex'))) refused();
  } catch { return refused(); }
}
function synchronizerDigest(token: string): string {
  return createHash('sha256').update(JSON.stringify([PURPOSE, 'SYNCHRONIZER', token])).digest('hex');
}
function assertOrigin(request: Request, origin: string): void {
  if (!(request instanceof Request) || new URL(origin).origin !== origin || !origin.startsWith('https://')
    || new URL(request.url).origin !== origin) refused();
}
function freshSession(issuedAt: number, now: number): void {
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(now) || issuedAt < 0
    || issuedAt > now || now >= issuedAt + SESSION_LIFETIME_MS) refused();
}
function refused(): never { throw Error('Freezing consent session refused.'); }
