import 'server-only';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import type { GoogleSession } from '@/server/googleOAuth';

const MAX_BYTES = 2048;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function classMutationReply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function hasSameOrigin(request: Request, url: URL): boolean {
  let expectedOrigin = url.origin;
  const host = request.headers.get('host');
  if (host && host !== url.host) {
    // NextURL normalizes loopback IPs to localhost in requests passing through
    // the proxy. Match the browser's actual Host, including its port, only for
    // that normalization. Forwarded headers never expand the accepted origin.
    if (url.hostname !== 'localhost') return false;
    try {
      const original = new URL(`${url.protocol}//${host}`);
      if (original.host !== host || original.port !== url.port
        || !['127.0.0.1', '[::1]'].includes(original.hostname)) return false;
      expectedOrigin = original.origin;
    } catch { return false; }
  }
  return request.headers.get('origin') === expectedOrigin;
}

export async function readClassMutationRequest(request: Request): Promise<Response | {
  session: GoogleSession; body: Record<string, unknown>;
}> {
  const session = getGoogleSessionFromRequest(request);
  if (!session) return classMutationReply(401, { error: '로그인이 필요하거나 만료되었습니다. 다시 로그인해 주세요.' });
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.search || !hasSameOrigin(request, url)
    || request.headers.get('sec-fetch-site') !== 'same-origin'
    || request.headers.get('content-type') !== 'application/json' || request.headers.has('content-encoding')) {
    return classMutationReply(403, { error: '같은 사이트의 새 학급 화면에서 요청해 주세요.' });
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    return classMutationReply(413, { error: '입력이 너무 큽니다.' });
  }
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return classMutationReply(400, { error: '학급 이름을 확인해 주세요.' });
    const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return classMutationReply(413, { error: '입력이 너무 큽니다.' }); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } catch { return classMutationReply(400, { error: '입력을 확인해 주세요.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return classMutationReply(400, { error: '입력을 확인해 주세요.' });
  return { session, body: body as Record<string, unknown> };
}
