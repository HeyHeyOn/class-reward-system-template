import { createTenantApiDispatcher, type TenantApiAccessResolver, type TenantApiRoute } from '@/server/tenantApiDispatcher';
import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { readBridgeBytes } from '@/server/migration/registeredBridgeProducer';

export const dynamic = 'force-dynamic';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Context = { params: Promise<Record<string, string>> };
type Handler = (request: Request, context: Context) => Promise<Response> | Response;

function route(method: Method, pattern: string, access: TenantApiAccessResolver, handler: Handler): TenantApiRoute {
  return { method, pattern, access, handler };
}

const ROUTES: readonly TenantApiRoute[] = [
  { ...route('GET', 'migrations/[jobId]/freezing/reacquisition/bootstrap', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/reacquisition/bootstrap/route')).GET(r, c)), preserveCanonicalRequest: true },
  { ...route('POST', 'migrations/[jobId]/freezing/reacquisition/challenge', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/reacquisition/challenge/route')).POST(r, c)), preserveCanonicalRequest: true },
  { ...route('POST', 'migrations/[jobId]/freezing/reacquisition', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/reacquisition/route')).POST(r, c)), preserveCanonicalRequest: true },
  { ...route('GET', 'migrations/[jobId]/freezing/reacquisition/[attemptId]', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/reacquisition/[attemptId]/route')).GET(r, c)), preserveCanonicalRequest: true },
  route('GET', 'migrations/[jobId]/freezing/start/challenge', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/start/challenge/route')).GET(r, c)),
  route('POST', 'migrations/[jobId]/freezing/start', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/start/route')).POST(r, c)),
  route('GET', 'migrations/[jobId]/freezing/start/[attemptId]', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/start/[attemptId]/route')).GET(r, c)),
  // These handlers independently require real Google identity + current DB membership;
  // the generic admin compatibility fallback is deliberately not their authority.
  route('POST', 'migrations/[jobId]/freezing/consent/challenge', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/consent/challenge/route')).POST(r, c as never)),
  route('POST', 'migrations/[jobId]/freezing/consent', 'public', async (r, c) => (await import('@/app/api/migrations/[jobId]/freezing/consent/route')).POST(r, c as never)),
  route('POST', 'admin/login', 'public', async (r) => (await import('@/app/api/admin/login/route')).POST(r)),
  route('GET', 'bank/balance', 'public', async (r) => (await import('@/app/api/bank/balance/route')).GET(r)),
  route('GET', 'bank/student', 'public', async (r) => (await import('@/app/api/bank/student/route')).GET(r)),
  route('GET', 'bank/tasks', 'public', async (r) => (await import('@/app/api/bank/tasks/route')).GET(r)),
  route('POST', 'checkout', 'public', async (r) => (await import('@/app/api/checkout/route')).POST(r)),
  route('POST', 'checkout/preview', 'public', async (r) => (await import('@/app/api/checkout/preview/route')).POST(r)),
  route('POST', 'qrcode', 'admin', async (r) => (await import('@/app/api/qrcode/route')).POST(r)),
  route('GET', 'products', (r) => new URL(r.url).searchParams.get('includeInactive') === '1' ? 'admin' : 'public', async (r) => (await import('@/app/api/products/route')).GET(r)),
  route('POST', 'products', 'admin', async (r) => (await import('@/app/api/products/route')).POST(r)),
  route('PATCH', 'products/[productId]', 'admin', async (r, c) => (await import('@/app/api/products/[productId]/route')).PATCH(r, c as never)),
  route('DELETE', 'products/[productId]', 'admin', async (r, c) => (await import('@/app/api/products/[productId]/route')).DELETE(r, c as never)),
  route('PATCH', 'products/batch', 'admin', async (r) => (await import('@/app/api/products/batch/route')).PATCH(r)),
  route('DELETE', 'products/batch', 'admin', async (r) => (await import('@/app/api/products/batch/route')).DELETE(r)),
  route('GET', 'promotions/active', 'public', async (r) => (await import('@/app/api/promotions/active/route')).GET(r)),
  route('GET', 'promotions', 'admin', async (r) => (await import('@/app/api/promotions/route')).GET(r)),
  route('POST', 'promotions', 'admin', async (r) => (await import('@/app/api/promotions/route')).POST(r)),
  route('PATCH', 'promotions/[promotionId]', 'admin', async (r, c) => (await import('@/app/api/promotions/[promotionId]/route')).PATCH(r, c as never)),
  route('DELETE', 'promotions/[promotionId]', 'admin', async (r, c) => (await import('@/app/api/promotions/[promotionId]/route')).DELETE(r, c as never)),
  route('GET', 'settings', 'public', async (r) => (await import('@/app/api/settings/route')).GET(r)),
  route('POST', 'settings', 'admin', async (r) => (await import('@/app/api/settings/route')).POST(r)),
  route('GET', 'students', 'admin', async () => (await import('@/app/api/students/route')).GET()),
  route('POST', 'students', 'admin', async (r) => (await import('@/app/api/students/route')).POST(r)),
  route('GET', 'students/[studentId]', 'public', async (r, c) => (await import('@/app/api/students/[studentId]/route')).GET(r, c as never)),
  route('PATCH', 'students/[studentId]', 'admin', async (r, c) => (await import('@/app/api/students/[studentId]/route')).PATCH(r, c as never)),
  route('DELETE', 'students/[studentId]', 'admin', async (r, c) => (await import('@/app/api/students/[studentId]/route')).DELETE(r, c as never)),
  route('PATCH', 'students/batch', 'admin', async (r) => (await import('@/app/api/students/batch/route')).PATCH(r)),
  route('DELETE', 'students/batch', 'admin', async (r) => (await import('@/app/api/students/batch/route')).DELETE(r)),
  route('PATCH', 'students/bulk', 'admin', async (r) => (await import('@/app/api/students/bulk/route')).PATCH(r)),
  route('GET', 'tasks', (r) => new URL(r.url).searchParams.get('includeInactive') === '1' ? 'admin' : 'public', async (r) => (await import('@/app/api/tasks/route')).GET(r)),
  route('POST', 'tasks', 'admin', async (r) => (await import('@/app/api/tasks/route')).POST(r)),
  route('GET', 'tasks/[taskId]', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/route')).GET(r, c as never)),
  route('PATCH', 'tasks/[taskId]', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/route')).PATCH(r, c as never)),
  route('DELETE', 'tasks/[taskId]', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/route')).DELETE(r, c as never)),
  route('GET', 'tasks/[taskId]/assignments', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/assignments/route')).GET(r, c as never)),
  route('PATCH', 'tasks/[taskId]/assignments', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/assignments/route')).PATCH(r, c as never)),
  route('POST', 'tasks/[taskId]/complete', 'public', async (r, c) => (await import('@/app/api/tasks/[taskId]/complete/route')).POST(r, c as never)),
  route('GET', 'tasks/[taskId]/history', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/history/route')).GET(r, c as never)),
  route('POST', 'tasks/assignments/batch', 'admin', async (r) => (await import('@/app/api/tasks/assignments/batch/route')).POST(r)),
  route('PATCH', 'tasks/batch', 'admin', async (r) => (await import('@/app/api/tasks/batch/route')).PATCH(r)),
  route('DELETE', 'tasks/batch', 'admin', async (r) => (await import('@/app/api/tasks/batch/route')).DELETE(r)),
  route('POST', 'tasks/completions/reset', 'admin', async (r) => (await import('@/app/api/tasks/completions/reset/route')).POST(r)),
  route('POST', 'tasks/schedules/batch', 'admin', async (r) => (await import('@/app/api/tasks/schedules/batch/route')).POST(r)),
  route('GET', 'transactions', 'admin', async (r) => (await import('@/app/api/transactions/route')).GET(r)),
  route('POST', 'transactions/[transactionId]/cancel', 'admin', async (r, c) => (await import('@/app/api/transactions/[transactionId]/cancel/route')).POST(r, c as never)),
];

const dispatch = createTenantApiDispatcher(getProductionTenantAccessDependencies(), ROUTES);
type RouteContext = { params: Promise<{ slug: string; path: string[] }> };

async function handle(request: Request, context: RouteContext) {
  const { slug, path } = await context.params;
  const consent = path[0] === 'migrations' && path[2] === 'freezing' && path[3] === 'consent'
    && (path.length === 4 || (path.length === 5 && path[4] === 'challenge'));
  const start = path[0] === 'migrations' && path[2] === 'freezing' && path[3] === 'start'
    && (path.length === 4 || path.length === 5);
  const reacquisition = path[0] === 'migrations' && path[2] === 'freezing' && path[3] === 'reacquisition';
  if (!consent && !start && !reacquisition) return dispatch(request, { slug, path });
  // Directory/method failures occur before the target handler; they must not
  // expose tenant existence or cache the challenge/CSRF endpoint's refusals.
  try {
    // Bound these exact consent POSTs before the legacy dispatcher materializes
    // their bodies (and before directory/service SQL). Content-Length is untrusted.
    const bounded = request.method !== 'POST' ? request : reacquisition
      ? await boundedReacquisitionRequest(request) : await boundedConsentRequest(request);
    const response = await dispatch(bounded, { slug, path });
    if (response.ok) return response;
  } catch { /* Generic, credential-free refusal without logging request URLs. */ }
  return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

async function boundedReacquisitionRequest(request: Request): Promise<Request> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 5000);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    // Fixed byte cap before directory SQL, authentication, or JSON. Preserve the
    // canonical URL and metadata; Content-Length never expands this budget.
    const body = await readBridgeBytes(request.body, 8192, controller.signal);
    return new Request(request, { body });
  } finally {
    clearTimeout(timer); controller.abort(); request.signal.removeEventListener('abort', abort);
  }
}

async function boundedConsentRequest(request: Request): Promise<Request> {
  const reader = request.body?.getReader();
  if (!reader) throw Error('Freezing consent refused.');
  const bytes = new Uint8Array(4096);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.byteLength - size) throw Error('Freezing consent refused.');
      bytes.set(value, size);
      size += value.byteLength;
    }
    return new Request(request, { body: bytes.slice(0, size) });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
