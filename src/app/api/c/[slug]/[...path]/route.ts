import { createTenantApiDispatcher, type TenantApiAccessResolver, type TenantApiRoute } from '@/server/tenantApiDispatcher';
import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { readBridgeBytes } from '@/server/migration/registeredBridgeProducer';

export const dynamic = 'force-dynamic';
// Includes bounded response-time Padlet work registered through Next.js after().
export const maxDuration = 60;

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
  // The earlier shared ATM trusted a bare student number; students now use their own bank session
  // (bank/session, bank/me/...). What is left of the ATM serves the teacher only.
  route('GET', 'bank/balance', 'admin', async (r) => (await import('@/app/api/bank/balance/route')).GET(r)),
  route('POST', 'bank/balance', 'admin', async (r) => (await import('@/app/api/bank/balance/route')).POST(r)),
  route('GET', 'bank/student', 'admin', async (r) => (await import('@/app/api/bank/student/route')).GET(r)),
  route('GET', 'bank/tasks', 'admin', async (r) => (await import('@/app/api/bank/tasks/route')).GET(r)),
  // Personal bank: public at the router, but each handler requires the student's own session cookie.
  route('GET', 'bank/session', 'public', async (r) => (await import('@/app/api/bank/session/route')).GET(r)),
  route('POST', 'bank/session', 'public', async (r) => (await import('@/app/api/bank/session/route')).POST(r)),
  route('DELETE', 'bank/session', 'public', async (r) => (await import('@/app/api/bank/session/route')).DELETE(r)),
  route('GET', 'bank/me/transactions', 'public', async (r) => (await import('@/app/api/bank/me/transactions/route')).GET(r)),
  route('GET', 'bank/me/tasks', 'public', async (r) => (await import('@/app/api/bank/me/tasks/route')).GET(r)),
  route('POST', 'bank/me/board-ticket', 'public', async (r) => (await import('@/app/api/bank/me/board-ticket/route')).POST(r)),
  route('POST', 'bank/me/tasks/[taskId]/complete', 'public', async (r, c) => (await import('@/app/api/bank/me/tasks/[taskId]/complete/route')).POST(r, c as never)),
  route('GET', 'bank/me/tree', 'public', async (r) => (await import('@/app/api/bank/me/tree/route')).GET(r)),
  route('POST', 'bank/me/tree/water', 'public', async (r) => (await import('@/app/api/bank/me/tree/water/route')).POST(r)),
  route('GET', 'bank/me/bag', 'public', async (r) => (await import('@/app/api/bank/me/bag/route')).GET(r)),
  route('GET', 'bank/me/pet', 'public', async (r) => (await import('@/app/api/bank/me/pet/route')).GET(r)),
  route('GET', 'bank/me/pet/dex', 'public', async (r) => (await import('@/app/api/bank/me/pet/dex/route')).GET(r)),
  route('POST', 'bank/me/pet/adopt', 'public', async (r) => (await import('@/app/api/bank/me/pet/adopt/route')).POST(r)),
  route('POST', 'bank/me/pet/care', 'public', async (r) => (await import('@/app/api/bank/me/pet/care/route')).POST(r)),
  route('POST', 'bank/me/pet/graduate', 'public', async (r) => (await import('@/app/api/bank/me/pet/graduate/route')).POST(r)),
  route('POST', 'bank/me/pet/decor/buy', 'public', async (r) => (await import('@/app/api/bank/me/pet/decor/buy/route')).POST(r)),
  route('POST', 'bank/me/pet/decor/place', 'public', async (r) => (await import('@/app/api/bank/me/pet/decor/place/route')).POST(r)),
  route('POST', 'bank/me/pet/companions', 'public', async (r) => (await import('@/app/api/bank/me/pet/companions/route')).POST(r)),
  route('POST', 'bank/me/pet/rename', 'public', async (r) => (await import('@/app/api/bank/me/pet/rename/route')).POST(r)),
  route('POST', 'checkout', 'public', async (r) => (await import('@/app/api/checkout/route')).POST(r)),
  route('POST', 'checkout/preview', 'public', async (r) => (await import('@/app/api/checkout/preview/route')).POST(r)),
  route('POST', 'checkout/vouchers', 'public', async (r) => (await import('@/app/api/checkout/vouchers/route')).POST(r)),
  route('POST', 'qrcode', 'admin', async (r) => (await import('@/app/api/qrcode/route')).POST(r)),
  route('GET', 'products', (r) => new URL(r.url).searchParams.get('includeInactive') === '1' ? 'admin' : 'public', async (r) => (await import('@/app/api/products/route')).GET(r)),
  route('POST', 'products', 'admin', async (r) => (await import('@/app/api/products/route')).POST(r)),
  route('PATCH', 'products/batch', 'admin', async (r) => (await import('@/app/api/products/batch/route')).PATCH(r)),
  route('DELETE', 'products/batch', 'admin', async (r) => (await import('@/app/api/products/batch/route')).DELETE(r)),
  route('PATCH', 'products/[productId]', 'admin', async (r, c) => (await import('@/app/api/products/[productId]/route')).PATCH(r, c as never)),
  route('DELETE', 'products/[productId]', 'admin', async (r, c) => (await import('@/app/api/products/[productId]/route')).DELETE(r, c as never)),
  route('GET', 'products/import/template', 'admin', async (r) => (await import('@/app/api/products/import/template/route')).GET(r)),
  route('POST', 'products/import/preview', 'admin', async (r) => (await import('@/app/api/products/import/preview/route')).POST(r)),
  route('POST', 'products/import/commit', 'admin', async (r) => (await import('@/app/api/products/import/commit/route')).POST(r)),
  route('GET', 'promotions/active', 'public', async (r) => (await import('@/app/api/promotions/active/route')).GET(r)),
  route('GET', 'promotions', 'admin', async (r) => (await import('@/app/api/promotions/route')).GET(r)),
  route('POST', 'promotions', 'admin', async (r) => (await import('@/app/api/promotions/route')).POST(r)),
  route('PATCH', 'promotions/[promotionId]', 'admin', async (r, c) => (await import('@/app/api/promotions/[promotionId]/route')).PATCH(r, c as never)),
  route('DELETE', 'promotions/[promotionId]', 'admin', async (r, c) => (await import('@/app/api/promotions/[promotionId]/route')).DELETE(r, c as never)),
  route('GET', 'settings', 'public', async (r) => (await import('@/app/api/settings/route')).GET(r)),
  { ...route('POST', 'settings', 'admin', async (r) => (await import('@/app/api/settings/route')).POST(r)), preserveCanonicalRequest: true },
  route('GET', 'students', 'admin', async (r) => (await import('@/app/api/students/route')).GET(r)),
  route('POST', 'students', 'admin', async (r) => (await import('@/app/api/students/route')).POST(r)),
  route('GET', 'students/[studentId]', 'public', async (r, c) => (await import('@/app/api/students/[studentId]/route')).GET(r, c as never)),
  route('PATCH', 'students/batch', 'admin', async (r) => (await import('@/app/api/students/batch/route')).PATCH(r)),
  route('PATCH', 'students/bulk', 'admin', async (r) => (await import('@/app/api/students/bulk/route')).PATCH(r)),
  route('POST', 'students/qr-reissue', 'admin', async (r) => (await import('@/app/api/students/qr-reissue/route')).POST(r)),
  route('GET', 'student-groups', 'admin', async (r) => (await import('@/app/api/student-groups/route')).GET(r)),
  route('POST', 'student-groups', 'admin', async (r) => (await import('@/app/api/student-groups/route')).POST(r)),
  route('PATCH', 'students/[studentId]', 'admin', async (r, c) => (await import('@/app/api/students/[studentId]/route')).PATCH(r, c as never)),
  route('DELETE', 'students/[studentId]', 'admin', async (r, c) => (await import('@/app/api/students/[studentId]/route')).DELETE(r, c as never)),
  route('DELETE', 'students/batch', 'admin', async (r) => (await import('@/app/api/students/batch/route')).DELETE(r)),
  route('GET', 'students/import/template', 'admin', async (r) => (await import('@/app/api/students/import/template/route')).GET(r)),
  route('POST', 'students/import/preview', 'admin', async (r) => (await import('@/app/api/students/import/preview/route')).POST(r)),
  route('POST', 'students/import/commit', 'admin', async (r) => (await import('@/app/api/students/import/commit/route')).POST(r)),
  route('GET', 'tasks', (r) => new URL(r.url).searchParams.get('includeInactive') === '1' ? 'admin' : 'public', async (r) => (await import('@/app/api/tasks/route')).GET(r)),
  route('GET', 'tasks/[taskId]', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/route')).GET(r, c as never)),
  route('POST', 'tasks/[taskId]/complete', 'admin', async (r, c) => (await import('@/app/api/tasks/[taskId]/complete/route')).POST(r, c as never)),
  // Tasks of PostgreSQL classes: a plain stage ledger without cycles. The earlier per-cycle task
  // writers are not routed for classes any more; only reads and the bank completion remain above.
  route('GET', 'task-ledger', 'admin', async (r) => (await import('@/app/api/task-ledger/route')).GET(r)),
  route('POST', 'task-ledger/tasks', 'admin', async (r) => (await import('@/app/api/task-ledger/tasks/route')).POST(r)),
  route('POST', 'task-ledger/tasks/delete', 'admin', async (r) => (await import('@/app/api/task-ledger/tasks/delete/route')).POST(r)),
  route('PATCH', 'task-ledger/tasks/[taskId]', 'admin', async (r, c) => (await import('@/app/api/task-ledger/tasks/[taskId]/route')).PATCH(r, c as never)),
  route('GET', 'task-ledger/tasks/[taskId]/history', 'admin', async (r, c) => (await import('@/app/api/task-ledger/tasks/[taskId]/history/route')).GET(r, c as never)),
  route('POST', 'task-ledger/stages', 'admin', async (r) => (await import('@/app/api/task-ledger/stages/route')).POST(r)),
  route('POST', 'task-ledger/reset', 'admin', async (r) => (await import('@/app/api/task-ledger/reset/route')).POST(r)),
  route('POST', 'task-ledger/repeat', 'admin', async (r) => (await import('@/app/api/task-ledger/repeat/route')).POST(r)),
  route('POST', 'task-ledger/qr', 'admin', async (r) => (await import('@/app/api/task-ledger/qr/route')).POST(r)),
  route('GET', 'task-ledger/padlet', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/route')).GET(r)),
  route('GET', 'task-ledger/padlet/preview', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/preview/route')).GET(r)),
  route('POST', 'task-ledger/padlet/key', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/key/route')).POST(r)),
  route('POST', 'task-ledger/padlet/links', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/links/route')).POST(r)),
  route('POST', 'task-ledger/padlet/unlink', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/unlink/route')).POST(r)),
  route('POST', 'task-ledger/padlet/sync', 'admin', async (r) => (await import('@/app/api/task-ledger/padlet/sync/route')).POST(r)),
  route('GET', 'task-ledger/board', 'admin', async (r) => (await import('@/app/api/task-ledger/board/route')).GET(r)),
  route('POST', 'task-ledger/board/links', 'admin', async (r) => (await import('@/app/api/task-ledger/board/links/route')).POST(r)),
  route('POST', 'task-ledger/board/unlink', 'admin', async (r) => (await import('@/app/api/task-ledger/board/unlink/route')).POST(r)),
  // Class apple tree (PostgreSQL classes): the teacher's board, settings, classFeed, harvest and coupons.
  route('GET', 'class-tree', 'admin', async (r) => (await import('@/app/api/class-tree/route')).GET(r)),
  route('POST', 'class-tree/settings', 'admin', async (r) => (await import('@/app/api/class-tree/settings/route')).POST(r)),
  route('POST', 'class-tree/feed', 'admin', async (r) => (await import('@/app/api/class-tree/feed/route')).POST(r)),
  route('POST', 'class-tree/harvest', 'admin', async (r) => (await import('@/app/api/class-tree/harvest/route')).POST(r)),
  // Pets (PostgreSQL classes): the teacher's board, settings and name corrections.
  route('GET', 'pets', 'admin', async (r) => (await import('@/app/api/pets/route')).GET(r)),
  route('POST', 'pets/settings', 'admin', async (r) => (await import('@/app/api/pets/settings/route')).POST(r)),
  route('POST', 'pets/rename', 'admin', async (r) => (await import('@/app/api/pets/rename/route')).POST(r)),
  route('POST', 'pets/growth', 'admin', async (r) => (await import('@/app/api/pets/growth/route')).POST(r)),
  // Student storage (보관함): digital products each student keeps; the teacher marks coupons used, gives or takes back.
  route('GET', 'bag/students/[studentId]', 'admin', async (r, c) => (await import('@/app/api/bag/students/[studentId]/route')).GET(r, c as never)),
  route('POST', 'bag/items/use', 'admin', async (r) => (await import('@/app/api/bag/items/use/route')).POST(r)),
  route('POST', 'bag/items/give', 'admin', async (r) => (await import('@/app/api/bag/items/give/route')).POST(r)),
  route('POST', 'bag/items/revoke', 'admin', async (r) => (await import('@/app/api/bag/items/revoke/route')).POST(r)),
  route('GET', 'bag/digital-products', 'public', async (r) => (await import('@/app/api/bag/digital-products/route')).GET(r)),
  route('POST', 'bag/digital-products', 'admin', async (r) => (await import('@/app/api/bag/digital-products/route')).POST(r)),
  route('GET', 'transactions', 'admin', async (r) => (await import('@/app/api/transactions/route')).GET(r)),
  route('POST', 'transactions/[transactionId]/cancel', 'admin', async (r, c) => (await import('@/app/api/transactions/[transactionId]/cancel/route')).POST(r, c as never)),
  // Self-service .xlsx import: the handler reads the multipart body itself under a fixed byte cap.
  { ...route('POST', 'migrations/xlsx/preview', 'admin', async (r) => (await import('@/app/api/migrations/xlsx/preview/route')).POST(r)), preserveCanonicalRequest: true },
  { ...route('POST', 'migrations/xlsx/commit', 'admin', async (r) => (await import('@/app/api/migrations/xlsx/commit/route')).POST(r)), preserveCanonicalRequest: true },
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
