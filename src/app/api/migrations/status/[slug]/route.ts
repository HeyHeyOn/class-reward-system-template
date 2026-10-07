import { readMigrationStatus } from '../readStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const privateHeaders = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'vary': 'Cookie',
};

// A canonical path carries only the tenant selector; the shared reader checks
// real Google identity and current DB membership. No dispatcher changes needed.
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  // Next.js automatically implements HEAD from GET and OPTIONS. No write verbs
  // are exported; this guard also refuses accidental direct non-read invocation.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, {
      status: 405, headers: { ...privateHeaders, allow: 'GET, HEAD, OPTIONS' },
    });
  }
  try {
    const { slug } = await context.params;
    const url = new URL(request.url);
    if (url.pathname !== `/api/migrations/status/${slug}` || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'jobId')
      || url.searchParams.getAll('jobId').length > 1) {
      return Response.json({ error: 'INVALID_STATUS_REQUEST' }, { status: 400, headers: privateHeaders });
    }
    const result = await readMigrationStatus(slug, request, url.searchParams.get('jobId') ?? undefined);
    switch (result.kind) {
      case 'JOB_AVAILABLE':
        return Response.json(result.status, { status: 200, headers: privateHeaders });
      case 'JOB_NOT_FOUND':
        return Response.json({ error: 'JOB_NOT_FOUND' }, { status: 404, headers: privateHeaders });
      case 'JOB_UNAVAILABLE':
        return Response.json({ error: 'JOB_STATUS_UNAVAILABLE' }, { status: 503, headers: privateHeaders });
      case 'INVALID_REQUEST':
        return Response.json({ error: 'INVALID_STATUS_REQUEST' }, { status: 400, headers: privateHeaders });
      case 'BLOCKED':
        return Response.json(result.status, { status: 503, headers: privateHeaders });
      case 'UNAUTHENTICATED':
        return Response.json({ error: 'AUTHENTICATION_REQUIRED' }, { status: 401, headers: privateHeaders });
      case 'FORBIDDEN':
        return Response.json({ error: 'ACCESS_DENIED' }, { status: 403, headers: privateHeaders });
      case 'UNAVAILABLE':
        return Response.json({ error: 'ACCESS_CHECK_UNAVAILABLE' }, { status: 503, headers: privateHeaders });
    }
  } catch {
    return Response.json({ error: 'ACCESS_CHECK_UNAVAILABLE' }, { status: 503, headers: privateHeaders });
  }
}
