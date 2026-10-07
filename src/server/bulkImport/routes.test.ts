// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XLSX_CONTENT_TYPE } from '@/lib/bulkImport';
import { BulkImportCommitError, BulkImportFileError, BulkImportUnsupportedError } from './errors';
import { assertSafeXlsxContainer } from './xlsxContainer';

const state = vi.hoisted(() => ({
  authorized: true,
  frozen: null as Response | null,
  studentPreview: vi.fn(),
  studentCommit: vi.fn(),
  productPreview: vi.fn(),
  productCommit: vi.fn(),
  createStudentImport: vi.fn(),
  createProductImport: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: () => state.authorized }));
vi.mock('@/server/legacyDeploymentMode', () => ({ legacyWriteFreezeResponse: () => state.frozen }));
vi.mock('@/server/repositories/configuredBulkImport', () => ({
  createConfiguredStudentImport: state.createStudentImport,
  createConfiguredProductImport: state.createProductImport,
}));

import { GET as studentTemplate } from '@/app/api/students/import/template/route';
import { POST as studentPreview } from '@/app/api/students/import/preview/route';
import { POST as studentCommit } from '@/app/api/students/import/commit/route';
import { GET as productTemplate } from '@/app/api/products/import/template/route';
import { POST as productPreview } from '@/app/api/products/import/preview/route';
import { POST as productCommit } from '@/app/api/products/import/commit/route';

const OPERATION_ID = '10000000-0000-4000-8000-0000000000b1';
const STUDENT_ROW = { rowNumber: 2, studentId: '01', name: '김민준', balance: 0 };
const PRODUCT_ROW = { rowNumber: 2, name: '사탕', price: 100, stock: 0, category: null, imageUrl: null, sortOrder: 1, isActive: true };

beforeEach(() => {
  state.authorized = true;
  state.frozen = null;
  for (const spy of [state.studentPreview, state.studentCommit, state.productPreview, state.productCommit]) spy.mockReset();
  state.createStudentImport.mockReset().mockResolvedValue({ preview: state.studentPreview, commit: state.studentCommit });
  state.createProductImport.mockReset().mockResolvedValue({ preview: state.productPreview, commit: state.productCommit });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function upload(body: BodyInit | null, headers: Record<string, string> = { 'content-type': XLSX_CONTENT_TYPE }) {
  return new Request('http://localhost/api/students/import/preview', { method: 'POST', headers, body });
}

function commitRequest(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/students/import/commit', {
    method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body),
  });
}

const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

describe('admin-only access', () => {
  it.each([
    ['student template', () => studentTemplate(new Request('http://localhost/api/students/import/template'))],
    ['product template', () => productTemplate(new Request('http://localhost/api/products/import/template'))],
    ['student preview', () => studentPreview(upload(XLSX_BYTES))],
    ['product preview', () => productPreview(upload(XLSX_BYTES))],
    ['student commit', () => studentCommit(commitRequest({ operationId: OPERATION_ID, rows: [STUDENT_ROW] }))],
    ['product commit', () => productCommit(commitRequest({ operationId: OPERATION_ID, rows: [PRODUCT_ROW] }))],
  ])('%s refuses non-admins before touching storage', async (_label, call) => {
    state.authorized = false;
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: 'ADMIN_REQUIRED' });
    expect(state.createStudentImport).not.toHaveBeenCalled();
    expect(state.createProductImport).not.toHaveBeenCalled();
  });
});

describe('template download', () => {
  it.each([
    ['student', studentTemplate, '학생 명단 양식.xlsx', 'student-import-template.xlsx'],
    ['product', productTemplate, '매점 상품 양식.xlsx', 'product-import-template.xlsx'],
  ] as const)('%s template is an xlsx attachment with a Korean RFC 5987 filename', async (_label, handler, korean, ascii) => {
    const response = await handler(new Request('http://localhost/api/x/import/template'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XLSX_CONTENT_TYPE);
    expect(response.headers.get('content-disposition'))
      .toBe(`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(korean)}`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get('content-length'))).toBe(bytes.byteLength);
    expect(() => assertSafeXlsxContainer(bytes)).not.toThrow();
  });
});

describe('preview upload', () => {
  it('passes the uploaded bytes to the configured importer and returns its preview', async () => {
    const preview = { ok: true, kind: 'students', sheetName: '학생 명단', rows: [STUDENT_ROW], errors: [], notices: [], readRowCount: 1 };
    state.studentPreview.mockResolvedValue(preview);
    const response = await studentPreview(upload(XLSX_BYTES));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(preview);
    expect(state.createStudentImport).toHaveBeenCalledTimes(1);
    expect(Array.from(state.studentPreview.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(XLSX_BYTES));
  });

  it.each([
    ['multipart form data', 'multipart/form-data; boundary=x'],
    ['CSV', 'text/csv'],
    ['missing content type', ''],
  ])('refuses %s (also blocks simple cross-site form posts)', async (_label, contentType) => {
    const response = await productPreview(upload(XLSX_BYTES, contentType ? { 'content-type': contentType } : {}));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
    expect(state.createProductImport).not.toHaveBeenCalled();
  });

  it('refuses uploads over 2 MB by header and by actual size', async () => {
    const declared = await studentPreview(upload(XLSX_BYTES, {
      'content-type': XLSX_CONTENT_TYPE, 'content-length': String(3 * 1024 * 1024),
    }));
    expect(declared.status).toBe(413);
    const actual = await studentPreview(upload(new Uint8Array(2 * 1024 * 1024 + 10)));
    expect(actual.status).toBe(413);
    expect(await actual.json()).toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(state.createStudentImport).not.toHaveBeenCalled();
  });

  it('refuses an empty upload', async () => {
    const response = await studentPreview(upload(new Uint8Array()));
    expect(response.status).toBe(400);
    expect(state.createStudentImport).not.toHaveBeenCalled();
  });

  it.each([
    [new BulkImportFileError('NO_MATCHING_SHEET', '양식에 맞는 시트를 찾지 못했어요.'), 422, 'NO_MATCHING_SHEET'],
    [new BulkImportFileError('TOO_MANY_ROWS', '한 번에 200명까지'), 422, 'TOO_MANY_ROWS'],
    [new BulkImportFileError('FILE_TOO_LARGE', '파일 내용이 너무 커요.'), 413, 'FILE_TOO_LARGE'],
    [new BulkImportUnsupportedError(), 501, 'UNSUPPORTED'],
    [new Error('boom'), 500, 'INTERNAL'],
  ])('maps %s to HTTP %s', async (error, status, code) => {
    state.studentPreview.mockRejectedValue(error);
    const response = await studentPreview(upload(XLSX_BYTES));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code });
    if (error instanceof BulkImportFileError) expect(body.error).toBe(error.message);
  });
});

describe('commit', () => {
  it('returns the legacy freeze refusal before reading anything', async () => {
    state.frozen = Response.json({ code: 'MIGRATION_READ_ONLY' }, { status: 503 });
    state.authorized = false;
    const response = await studentCommit(commitRequest({ operationId: OPERATION_ID, rows: [STUDENT_ROW] }));
    expect(response.status).toBe(503);
    expect(state.createStudentImport).not.toHaveBeenCalled();
  });

  it('commits a well-formed request', async () => {
    const result = { ok: true, kind: 'products', operationId: OPERATION_ID, created: 1, replayed: false, items: [{ rowNumber: 2, productId: 'P001', name: '사탕' }] };
    state.productCommit.mockResolvedValue(result);
    const response = await productCommit(commitRequest({ operationId: OPERATION_ID, rows: [PRODUCT_ROW] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(state.productCommit).toHaveBeenCalledWith({ operationId: OPERATION_ID, rows: [PRODUCT_ROW] });
  });

  it.each([
    ['non-JSON content type', commitRequest({ operationId: OPERATION_ID, rows: [STUDENT_ROW] }, 'text/plain')],
    ['missing operationId', commitRequest({ rows: [STUDENT_ROW] })],
    ['unknown row key', commitRequest({ operationId: OPERATION_ID, rows: [{ ...STUDENT_ROW, status: 'INACTIVE' }] })],
    ['broken JSON', new Request('http://localhost/api/students/import/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operationId":',
    })],
  ])('refuses %s without opening storage', async (_label, request) => {
    const response = await studentCommit(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(state.createStudentImport).not.toHaveBeenCalled();
  });

  it.each([
    [new BulkImportCommitError('VALIDATION_FAILED', '바뀌었어요', [{ rowNumber: 2, column: '학생 번호', message: '이미 등록된 학생 번호예요 (김민준).' }]), 409, 'VALIDATION_FAILED'],
    [new BulkImportCommitError('OPERATION_CONFLICT', '이미 다른 내용으로'), 409, 'OPERATION_CONFLICT'],
    [Object.assign(new Error('Failed query: insert ... params: 01,김민준'), { cause: { code: '23505' } }), 409, 'VALIDATION_FAILED'],
    [new BulkImportUnsupportedError(), 501, 'UNSUPPORTED'],
    [new Error('connection reset'), 500, 'OUTCOME_UNCERTAIN'],
  ])('maps commit failure %s to HTTP %s', async (error, status, code) => {
    state.studentCommit.mockRejectedValue(error);
    const response = await studentCommit(commitRequest({ operationId: OPERATION_ID, rows: [STUDENT_ROW] }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code });
    if (error instanceof BulkImportCommitError && error.code === 'VALIDATION_FAILED') expect(body.errors).toEqual(error.issues);
  });

  it('never logs database parameters (student data) for unexpected failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.studentCommit.mockRejectedValue(Object.assign(new Error('Failed query: insert params: 01,김민준'), { cause: { code: '57P01' } }));
    await studentCommit(commitRequest({ operationId: OPERATION_ID, rows: [STUDENT_ROW] }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('김민준');
    expect(JSON.stringify(log.mock.calls)).toContain('57P01');
  });
});
