import { readPreflightReport } from '../../readPreflightReport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const privateHeaders = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json',
  'referrer-policy': 'no-referrer',
  'vary': 'Cookie',
};
type Context = { params: Promise<{ slug: string }> };

async function read(request: Request, context: Context, method: 'GET' | 'HEAD') {
  const headOnly = method === 'HEAD' || request.method === 'HEAD';
  const respond = (body: unknown, status: number, headers: HeadersInit = privateHeaders) => headOnly
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
  if (request.method !== method) {
    return respond({ error: 'METHOD_NOT_ALLOWED' }, 405, {
      ...privateHeaders, allow: 'GET, HEAD, OPTIONS',
    });
  }
  try {
    const { slug } = await context.params;
    // Forward the original request unchanged. The reader owns canonical selector
    // admission, Google identity, current tenant membership and bounded DB reads.
    const result = await readPreflightReport(slug, request);
    switch (result.kind) {
      case 'HISTORICAL_REPORT':
        // 200 means archive retrieval only, NOT live preflight or cutover approval.
        // Preserve HISTORICAL_ONLY/UNKNOWN/false, including for MATCHED_PREFLIGHT.
        return respond(result.projection, 200);
      case 'UNAUTHENTICATED':
        return respond({ error: 'AUTHENTICATION_REQUIRED' }, 401);
      case 'FORBIDDEN':
        return respond({ error: 'ACCESS_DENIED' }, 403);
      case 'INVALID_REQUEST':
        return respond({ error: 'INVALID_PREFLIGHT_REQUEST' }, 400);
      case 'NOT_FOUND':
        return respond({ error: 'PREFLIGHT_REPORT_NOT_FOUND' }, 404);
      case 'UNAVAILABLE':
        return respond({ error: 'PREFLIGHT_REPORT_UNAVAILABLE' }, 503);
    }
  } catch {
    // No upstream details, identifiers, logs, retries or fallback authority.
  }
  return respond({ error: 'PREFLIGHT_REPORT_UNAVAILABLE' }, 503);
}

// No write handlers. Next.js supplies empty 405 refusals and read-only OPTIONS.
export async function GET(request: Request, context: Context) {
  return read(request, context, 'GET');
}

// Explicitly bodyless before framework sending; still performs the same reader
// authorization and status checks, without serializing a historical report.
export async function HEAD(request: Request, context: Context) {
  return read(request, context, 'HEAD');
}
