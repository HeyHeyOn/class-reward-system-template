// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw Error('No database in unit tests.'); } }));
import type { TrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { XlsxImportConflictError } from './xlsxImportExecutor';
import { createXlsxImportHandlers, type XlsxImportDependencies } from './xlsxImportService';
import { buildSyntheticCrsWorkbook, writeSyntheticXlsx } from './testing/syntheticCrsWorkbook';

const origin = 'https://classes.example.invalid';
const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha', displayName: '알파', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const };
const session = { subject: 'owner-subject', email: 'owner@example.invalid', issuedAt: Date.now() };
const membership = { id: 'm', tenantId: tenant.id, userId: 'u', googleSubject: session.subject, role: 'OWNER' as const };
const context = { tenant, session, membership } as TrustedTenantRequestContext;
const empty = { students: 0, products: 0, promotions: 0, tasks: 0, transactions: 0 };
let xlsx: Buffer;
let digest: string;

beforeAll(async () => {
  xlsx = await writeSyntheticXlsx(buildSyntheticCrsWorkbook(new Date()).workbook);
  digest = createHash('sha256').update(xlsx).digest('hex');
});

function handlers(overrides: Partial<XlsxImportDependencies> = {}) {
  return createXlsxImportHandlers({
    getContext: () => context,
    runTenantSnapshot: (async () => empty) as unknown as XlsxImportDependencies['runTenantSnapshot'],
    runTenantTransaction: (async () => { throw Error('unexpected write'); }) as XlsxImportDependencies['runTenantTransaction'],
    getNewClassSetup: async () => null,
    ...overrides,
  });
}

function request(fields: Record<string, string> = {}, options: { bytes?: Buffer; name?: string; headers?: Record<string, string> } = {}) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(options.bytes ?? xlsx)], options.name ?? 'crs.xlsx'));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(`${origin}/api/c/alpha/migrations/xlsx/preview`, { method: 'POST', body: form,
    headers: { origin, 'sec-fetch-site': 'same-origin', ...options.headers } });
}

describe('xlsx import handlers', () => {
  it('previews the current state of an empty active class without writing', async () => {
    const response = await handlers().preview(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, mode: 'import', slug: 'alpha', fileName: 'crs.xlsx', fileDigest: digest, canImport: true,
      blocked: null, summary: { students: 6, products: 2, tasks: 4 } });
    expect(body.tasks.find((task: { taskId: string }) => task.taskId === 'TB')).toMatchObject({ schedule: '매주 월 09:00', ready: 3, completed: 1 });
  });

  it('marks a class that already has data as blocked', async () => {
    const response = await handlers({ runTenantSnapshot: (async () => ({ ...empty, students: 1 })) as never }).preview(request());
    expect(await response.json()).toMatchObject({ canImport: false, blocked: 'NOT_EMPTY' });
  });

  it('starts only a new class of its owner', async () => {
    const draft = { ...context, tenant: { ...tenant, lifecycle: 'DRAFT' as const } };
    const refused = await handlers({ getContext: () => draft }).preview(request());
    expect(refused.status).toBe(403);
    const getNewClassSetup = vi.fn(async () => ({ slug: 'alpha', displayName: '알파', lifecycle: 'DRAFT' as const }));
    const allowed = await handlers({ getContext: () => draft, getNewClassSetup }).preview(request());
    expect(await allowed.json()).toMatchObject({ mode: 'start', canImport: true });
    expect(getNewClassSetup).toHaveBeenCalledWith('alpha', session.subject);
    const admin = { ...draft, membership: { ...membership, role: 'ADMIN' as const } };
    expect((await handlers({ getContext: () => admin, getNewClassSetup }).preview(request())).status).toBe(403);
  });

  it.each([
    ['outside the tenant dispatcher', { getContext: () => undefined }, {}, 404],
    ['a compatibility (password) session', { getContext: () => ({ tenant, compatibilitySession: { tenantId: tenant.id } }) as TrustedTenantRequestContext }, {}, 403],
    ['a cross-site request', {}, { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['a foreign origin', {}, { headers: { origin: 'https://evil.example.invalid' } }, 403],
    ['a non-xlsx file name', {}, { name: 'students.csv' }, 415],
    ['a file that is not a workbook', {}, { bytes: Buffer.from('hello'), name: 'fake.xlsx' }, 415],
  ])('refuses %s', async (_label, overrides, options, status) => {
    const response = await handlers(overrides as Partial<XlsxImportDependencies>).preview(request({}, options as never));
    expect(response.status).toBe(status);
  });

  it('refuses a non-multipart body', async () => {
    const response = await handlers().preview(new Request(`${origin}/api/c/alpha/migrations/xlsx/preview`, { method: 'POST',
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }));
    expect(response.status).toBe(415);
  });

  it('commits only the previewed file with a valid operation', async () => {
    const run = vi.fn();
    const commit = (fields: Record<string, string>) => handlers({ runTenantTransaction: run as never }).commit(request(fields));
    expect((await commit({ operationId: 'not-a-uuid', fileDigest: digest })).status).toBe(400);
    expect((await commit({ operationId: '30000000-0000-4000-8000-000000000001', fileDigest: 'e'.repeat(64) })).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a file with blocking problems before any transaction', async () => {
    const broken = buildSyntheticCrsWorkbook(new Date());
    broken.workbook.Products[1] = ['P1', '', 2, 10, true, '', '', 1];
    const bytes = await writeSyntheticXlsx(broken.workbook);
    const run = vi.fn();
    const response = await handlers({ runTenantTransaction: run as never }).commit(request({
      operationId: '30000000-0000-4000-8000-000000000001', fileDigest: createHash('sha256').update(bytes).digest('hex') }, { bytes }));
    expect(response.status).toBe(422);
    expect((await response.json()).issues).toContainEqual({ level: 'error', sheet: 'Products', row: 2, message: '상품명(name)이 비어 있어요.' });
    expect(run).not.toHaveBeenCalled();
  });

  it('maps refusals, rolled-back failures and uncertain outcomes', async () => {
    const fields = { operationId: '30000000-0000-4000-8000-000000000001', fileDigest: digest };
    const notEmpty = await handlers({ runTenantTransaction: (async () => { throw new XlsxImportConflictError('NOT_EMPTY'); }) as never }).commit(request(fields));
    expect(notEmpty.status).toBe(409);
    expect(await notEmpty.json()).toMatchObject({ code: 'NOT_EMPTY' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A step that fails inside the transaction: the runner rolled everything back.
    const failingTx = { execute: async () => { throw Error('Task administration operation conflict.'); } };
    const failed = await handlers({ runTenantTransaction: (async (_id: string, callback: (tx: unknown) => Promise<unknown>) => callback(failingTx)) as never })
      .commit(request(fields));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ code: 'IMPORT_FAILED' });
    // A lost COMMIT acknowledgment: the same request may be repeated safely.
    const uncertain = await handlers({ runTenantTransaction: (async () => { throw Error('Connection terminated'); }) as never }).commit(request(fields));
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ retryable: true });
    expect(JSON.stringify(error.mock.calls)).not.toContain('가람');
    error.mockRestore();
  });
});
