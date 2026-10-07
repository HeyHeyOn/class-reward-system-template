import { readHistoricalReportDownload } from '../../../readHistoricalReportDownload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ slug: string }> };
const privateHeaders = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
};

async function read(request: Request, context: Context, method: 'GET' | 'HEAD') {
  const head = method === 'HEAD' || request.method === 'HEAD';
  const fail = (status: number, error: string, headers: HeadersInit = privateHeaders) =>
    new Response(head ? null : JSON.stringify({ error }), { status, headers });
  if (request.method !== method) {
    return fail(405, 'METHOD_NOT_ALLOWED', { ...privateHeaders, allow: 'GET, HEAD, OPTIONS' });
  }
  try {
    const params = await context.params;
    if (!params || typeof params.slug !== 'string') return fail(503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    // Preserve the original URL, raw selectors, Cookie and AbortSignal. The
    // fixed adapter/reader reauthorizes each invocation; no cached UI authority,
    // second read, source/export fallback or operational action belongs here.
    return await readHistoricalReportDownload(params.slug, request);
  } catch {
    return fail(503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  }
}

export async function GET(request: Request, context: Context) {
  return read(request, context, 'GET');
}

// Explicit HEAD repeats admission/auth/archival checks and is already bodyless
// before Next sending. Automatic OPTIONS/405 are framework-owned and do NOT
// inherit these application headers; no extra method exports are hidden here.
export async function HEAD(request: Request, context: Context) {
  return read(request, context, 'HEAD');
}
