import { readHistoricalLocalGenerationCsvDownload } from '@/server/exports/readHistoricalLocalGenerationCsvDownload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ slug: string }> };
const privateHeaders = {
  'cache-control': 'private, no-store',
  'content-type': 'text/plain; charset=utf-8',
  'referrer-policy': 'no-referrer',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
};

function failure(status: 405 | 503, head: boolean): Response {
  const code = status === 405 ? 'METHOD_NOT_ALLOWED' : 'UNAVAILABLE';
  return new Response(head ? null : `HISTORICAL_LOCAL_GENERATION_${code}\n`, {
    status,
    headers: { ...privateHeaders, ...(status === 405 ? { allow: 'GET, HEAD' } : {}) },
  });
}

async function read(request: Request, context: Context, method: 'GET' | 'HEAD'): Promise<Response> {
  let head = method === 'HEAD';
  try {
    head = head || request.method === 'HEAD';
    // Direct handler misuse is separate from Next's automatic OPTIONS/405.
    if (request.method !== method) return failure(405, head);
    const params = await context.params;
    if (!params || typeof params.slug !== 'string') return failure(503, head);
    // The fixed adapter admits canonical slugs and literal selectors. Never
    // normalize the slug, rebuild the URL/Request, or derive authority here.
    // Return its actual Response; every GET/HEAD reauthorizes through its reader.
    return await readHistoricalLocalGenerationCsvDownload(params.slug, request);
  } catch {
    // Params/adapter failures disclose no exception, cookie, ID or attachment.
    return failure(503, head);
  }
}

// HISTORICAL_ONLY / LOCAL_CANDIDATE metadata DISPLAY, never current authority,
// source-payload verification, full export, retained backup or cutover evidence.
export async function GET(request: Request, context: Context): Promise<Response> {
  return read(request, context, 'GET');
}

// Explicit HEAD repeats admission and representation checks; the adapter makes
// it bodyless before HTTP sending. Framework OPTIONS/405 do not inherit our
// private headers. No extra method exports or automatic GET-to-HEAD fallback.
export async function HEAD(request: Request, context: Context): Promise<Response> {
  return read(request, context, 'HEAD');
}
