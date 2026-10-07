import 'server-only';

import { Buffer } from 'node:buffer';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { parseTenantSlug } from '@/server/tenantContext';
import { buildHistoricalLocalGenerationCsv } from './historicalLocalGenerationCsv';
import { readPersistedLocalGeneration } from './readPersistedLocalGeneration';

const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
const ERROR_CODES = Object.freeze({
  400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 503: 'UNAVAILABLE',
});
const CONDITIONAL_HEADERS = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];
type Selection = Readonly<{ jobId: string; generationId: string }>;
function failure(status: keyof typeof ERROR_CODES, head: boolean): Response {
  return new Response(head ? null : `HISTORICAL_LOCAL_GENERATION_${ERROR_CODES[status]}\n`, { status, headers: {
    ...PRIVATE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
  } });
}
function bounded(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= bytes && Buffer.byteLength(value, 'utf8') <= bytes;
}
function opaqueId(value: string): boolean {
  // Same literal job-ID admission as the reader. Do not trim/normalize/coerce.
  return bounded(value, 1024) && value.length > 0 && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value);
}
function encodeSelector(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function select(slug: unknown, rawUrl: string): Selection | null {
  try {
    const canonical = parseTenantSlug(slug);
    if (canonical.needsRedirect || !bounded(rawUrl, 8192)) return null;
    const url = new URL(rawUrl);
    const path = `/api/exports/${canonical.slug}/historical-local-generation-metadata.csv`;
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.pathname !== path) return null;
    // Exactly two ordered keys. No URLSearchParams repair of malformed UTF-8,
    // percent escapes or '+'; no unknown/duplicate parameters or latest fallback.
    const parts = url.search.slice(1).split('&');
    if (parts.length !== 2 || !parts[0].startsWith('jobId=') || !parts[1].startsWith('generationId=')) return null;
    const jobId = decodeURIComponent(parts[0].slice('jobId='.length));
    const generationId = decodeURIComponent(parts[1].slice('generationId='.length));
    if (!opaqueId(jobId) || !bounded(generationId, 86) || !/^preparation:candidate:[a-f0-9]{64}$/.test(generationId)) return null;
    const query = `?jobId=${encodeSelector(jobId)}&generationId=${encodeSelector(generationId)}`;
    // Comparison only, NEVER replace/rewrite the original Request. Unreserved
    // characters are literal; others are uppercase RFC3986 UTF-8 percent bytes.
    // %2520 selects literal %20, not a space: transport decoding happens once.
    if (rawUrl !== `${url.origin}${path}${query}`) return null;
    return { jobId, generationId };
  } catch { return null; }
}

/** Server-only IN-PROCESS metadata Response adapter, not a registered route.
 * Contract: GET/HEAD /api/exports/{canonical-slug}/historical-local-generation-metadata.csv
 * ?jobId={RFC3986-encoded-literal-ID}&generationId={RFC3986-encoded-candidate-ID}
 * in that exact order/representation. URL <=8192 UTF-8 bytes; job <=1024;
 * generation is preparation:candidate: + 64 lowercase hex. HTTP(S) origin is
 * syntax, NOT tenant authority or a trusted deployment-origin allowlist.
 * This separate leaf follows the existing internal product export namespace;
 * it is NOT the product or preflight JSON URL, nor a tenant-dispatcher rewrite.
 * Any normalization performed BEFORE Request.url is supplied is unobservable.
 * Future route/dispatcher/inventory/proxy/HTTP integration requires separate work.
 *
 * Only original Request + canonical slug are accepted. No caller DTO, role,
 * tenant identity, reader/pool/filename override, cache, retry or retained file.
 * The fixed trusted reader authorizes each call, including HEAD, using current
 * Google identity and tenant membership; the serializer accepts only its fresh
 * success DTO. Headers/query/body never supply authority. All bytes are bounded
 * metadata DISPLAY, not full export, restore, payload validation or cutover proof.
 *
 * Reader authorization is a final READ COMMITTED statement snapshot, NOT a
 * revocation lease. Membership/tenant/DB role-policy changes AFTER that snapshot
 * (including during rollback, release or Promise handoff) may not be observed.
 * Synchronous cookie-verifier/continuity checks below detect request/session
 * changes and expiry at their check instants, NOT later database revocation.
 * No additional async gap is introduced after the fresh reader returns. Time
 * still passes during synchronous work and delivery after return is outside this
 * boundary: no instantaneous revocation/delivery guarantee or production acceptance.
 */
export async function readHistoricalLocalGenerationCsvDownload(slug: unknown, originalRequest: Request): Promise<Response> {
  let head = false;
  try {
    if (!(originalRequest instanceof Request)) return failure(400, head);
    const method = originalRequest.method;
    head = method === 'HEAD';
    if (method !== 'GET' && !head) return failure(405, head);
    const url = originalRequest.url;
    const selected = select(slug, url);
    const cookie = originalRequest.headers.get('cookie');
    const signal = originalRequest.signal;
    if (!selected || !bounded(cookie ?? '', 32768)
      || CONDITIONAL_HEADERS.some(name => originalRequest.headers.has(name))) return failure(400, head);
    if (signal.aborted) return failure(503, head);
    const identity = getGoogleSessionFromRequest(originalRequest);
    if (!identity || !bounded(identity.subject, 1024)) return failure(401, head);
    // Not a replacement for the reader's unambiguous-cookie and DB membership
    // checks. Reverify the actual signed/encrypted session, not just its string.
    const requestFailure = (): 400 | 401 | 503 | null => {
      if (signal.aborted || originalRequest.signal !== signal) return 503;
      if (originalRequest.headers.get('cookie') !== cookie) return 401;
      if (originalRequest.method !== method || originalRequest.url !== url) return 400;
      const current = getGoogleSessionFromRequest(originalRequest);
      if (!current || current.subject !== identity.subject || current.issuedAt !== identity.issuedAt) return 401;
      return null;
    };
    const beforeRead = requestFailure();
    if (beforeRead) return failure(beforeRead, head);
    const result = await readPersistedLocalGeneration(slug, originalRequest, selected);
    const afterRead = requestFailure();
    if (afterRead) return failure(afterRead, head);
    switch (result.kind) {
      case 'UNAUTHENTICATED': return failure(401, head);
      case 'FORBIDDEN': return failure(403, head);
      case 'INVALID_REQUEST': return failure(400, head);
      case 'NOT_FOUND': return failure(404, head);
      case 'HISTORICAL_LOCAL_GENERATION': break;
      default: return failure(503, head);
    }
    if (result.jobId !== selected.jobId || result.generationId !== selected.generationId) return failure(503, head);
    // The real synchronous formatter checks the complete closed DTO and ALL
    // NONAUTHORITY/HISTORICAL_ONLY/LOCAL_CANDIDATE/unverified/false literals.
    const csv = buildHistoricalLocalGenerationCsv(result);
    if (csv.format !== 'CSV' || csv.schemaVersion !== 'historical-local-generation-metadata-display/v1'
      || csv.purpose !== 'DISPLAY_ONLY' || csv.contentType !== 'text/csv; charset=utf-8; header=present'
      || csv.metadataRowCount !== 1 || !(csv.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(csv.byteLength) || csv.byteLength <= 0 || csv.byteLength > 16384
      || csv.byteLength !== csv.bytes.byteLength) return failure(503, head);
    const body = head ? null : new Uint8Array(csv.bytes);
    const beforePublication = requestFailure();
    if (beforePublication) return failure(beforePublication, head);
    // No yield, stream prefix, I/O, cache or deferred serialization here. HEAD
    // exposes only representation headers and follows identical refusal checks.
    return new Response(body, { status: 200, headers: {
      ...PRIVATE_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8; header=present',
      'Content-Disposition': 'attachment; filename="historical-local-generation-metadata.csv"',
      'Content-Length': String(csv.byteLength),
    } });
  } catch {
    // No raw exceptions, SQL, request URL, IDs, cookies or private logging.
    return failure(503, head);
  }
}
