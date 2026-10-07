import 'server-only';

import { Buffer } from 'node:buffer';
import { parseTenantSlug } from '@/server/tenantContext';
import { buildProductInventoryCsv, PRODUCT_INVENTORY_CSV_LIMITS } from './productInventoryCsv';
import { readAuthorizedProductInventoryDisplay } from './readAuthorizedProductInventoryDisplay';

const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

const ERROR_CODES = Object.freeze({
  400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  405: 'METHOD_NOT_ALLOWED', 413: 'LIMIT_EXCEEDED', 503: 'UNAVAILABLE',
});
function failure(status: keyof typeof ERROR_CODES, head: boolean): Response {
  return new Response(head ? null : `PRODUCT_INVENTORY_${ERROR_CODES[status]}\n`, { status, headers: {
    ...PRIVATE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
  } });
}
function bounded(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= bytes && Buffer.byteLength(value, 'utf8') <= bytes;
}
function validTarget(slug: unknown, rawUrl: string): boolean {
  try {
    const canonical = parseTenantSlug(slug);
    if (canonical.needsRedirect || !bounded(rawUrl, 2048)) return false;
    const url = new URL(rawUrl);
    const path = `/api/exports/${canonical.slug}/products`;
    // Match the URL as presented on the ORIGINAL Request, never its repaired
    // version. This also refuses bare ?/#, userinfo, percent/dot/slash aliases.
    // Request/framework normalization before this boundary is not observable.
    // The origin is syntax only, not authority or a trusted deployment origin.
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === path && rawUrl === `${url.origin}${path}`;
  } catch { return false; }
}

/** Internal Response adapter only; no public route, retained artifact or backup.
 * Accepts no caller DTO, role, tenant ID, dependency, filename or URL override.
 * All identity/membership/tenant/data authority stays in the fixed real reader.
 */
export async function readProductInventoryCsvDownload(slug: unknown, originalRequest: Request): Promise<Response> {
  let head = false;
  try {
    if (!(originalRequest instanceof Request)) return failure(400, head);
    const method = originalRequest.method;
    head = method === 'HEAD';
    if (method !== 'GET' && !head) return failure(405, head);
    const url = originalRequest.url;
    const cookie = originalRequest.headers.get('cookie');
    const signal = originalRequest.signal;
    if (!validTarget(slug, url) || !bounded(cookie ?? '', 32768)) return failure(400, head);
    // These checks do not authenticate a cookie or grant tenant authority. They
    // only prevent publishing under a different request than the reader saw.
    const requestFailure = (): 400 | 401 | 503 | null => {
      if (signal.aborted || originalRequest.signal !== signal) return 503;
      if (originalRequest.headers.get('cookie') !== cookie) return 401;
      if (originalRequest.method !== method || originalRequest.url !== url) return 400;
      return null;
    };
    const beforeRead = requestFailure();
    if (beforeRead) return failure(beforeRead, head);
    const result = await readAuthorizedProductInventoryDisplay(slug, originalRequest);
    const afterRead = requestFailure();
    if (afterRead) return failure(afterRead, head);
    switch (result.kind) {
      case 'UNAUTHENTICATED': return failure(401, head);
      case 'FORBIDDEN': return failure(403, head);
      case 'INVALID_REQUEST': return failure(400, head);
      case 'LIMIT_EXCEEDED': return failure(413, head);
      case 'CURRENT_PRODUCT_INVENTORY_DISPLAY': break;
      default: return failure(503, head);
    }
    if (result.authority !== 'NONAUTHORITY' || result.readOnly !== true || result.complete !== true
      || result.source !== 'POSTGRESQL' || result.scope !== 'ALL_NONDELETED_PRODUCTS' || result.snapshot !== 'STATEMENT'
      || result.cutoverAllowed !== false || result.activationAllowed !== false
      || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0 || result.rowCount !== result.dto.rows.length) {
      return failure(503, head);
    }
    const csv = buildProductInventoryCsv(result.dto);
    if (csv.format !== 'CSV' || csv.schemaVersion !== 'product-inventory-display/v1'
      || csv.purpose !== 'DISPLAY_ONLY' || csv.contentType !== 'text/csv; charset=utf-8; header=present'
      || csv.rowCount !== result.rowCount || !(csv.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(csv.byteLength) || csv.byteLength <= 0
      || csv.byteLength > PRODUCT_INVENTORY_CSV_LIMITS.maxOutputBytes || csv.byteLength !== csv.bytes.byteLength) {
      return failure(503, head);
    }
    // HEAD takes the same reader/formatter admission path, but no body. Buffer
    // the whole bounded CSV before publication: no prefix on failure, streaming,
    // follow-up I/O, retry, persistence or activation. No revocation lease after
    // the Response has been returned; later calls authorize afresh.
    const body = head ? null : new Uint8Array(csv.bytes);
    const beforePublication = requestFailure();
    if (beforePublication) return failure(beforePublication, head);
    return new Response(body, { status: 200, headers: {
      ...PRIVATE_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8; header=present',
      'Content-Disposition': 'attachment; filename="product-inventory-display.csv"',
    } });
  } catch {
    // No raw exceptions, SQL, session fields or request strings in output/logs.
    return failure(503, head);
  }
}
