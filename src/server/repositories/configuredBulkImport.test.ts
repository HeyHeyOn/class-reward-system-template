import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkImportUnsupportedError } from '@/server/bulkImport/errors';
import { workbookBytes } from '@/server/bulkImport/testing/workbookFixtures';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import {
  createConfiguredProductImport,
  createConfiguredStudentImport,
  createProductImportRepositoryCreators,
  createStudentImportRepositoryCreators,
} from './configuredBulkImport';
import { getCompatibilityCentralTenantContext } from './configuredRepository';
import { createDatabaseProductImport, createDatabaseStudentImport } from './database/bulkImportCommands';

vi.mock('server-only', () => ({}));

const OPERATION_ID = '10000000-0000-4000-8000-0000000000c1';

describe('configured bulk import storage selection', () => {
  it('refuses legacy unscoped Google Sheets storage clearly', async () => {
    const students = await createConfiguredStudentImport({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: getCompatibilityCentralTenantContext,
      creators: createStudentImportRepositoryCreators(),
    });
    await expect(students.preview(new Uint8Array([1]))).rejects.toBeInstanceOf(BulkImportUnsupportedError);
    await expect(students.commit({ operationId: OPERATION_ID, rows: [] })).rejects.toBeInstanceOf(BulkImportUnsupportedError);
    const products = await createConfiguredProductImport({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: getCompatibilityCentralTenantContext,
      creators: createProductImportRepositoryCreators(),
    });
    await expect(products.preview(new Uint8Array([1]))).rejects.toBeInstanceOf(BulkImportUnsupportedError);
  });

  it('always uses the request tenant on scoped /c/{slug} requests, whatever the global env says', async () => {
    const createDatabaseStudentImportSpy = vi.fn(() => ({ loadExisting: vi.fn(), commit: vi.fn() }));
    const tenantId = '20000000-0000-4000-8000-0000000000aa';
    await runWithTrustedTenantRequestContext(
      { tenant: { id: tenantId, lifecycle: 'ACTIVE' } as never },
      () => createConfiguredStudentImport({
        env: { CLASS_STORE_STORAGE: 'sheets' },
        getCentralTenantContext: getCompatibilityCentralTenantContext,
        creators: createStudentImportRepositoryCreators({
          withTenantTransaction: vi.fn() as never,
          createDatabaseStudentImport: createDatabaseStudentImportSpy as never,
          createDatabaseProductImport: vi.fn() as never,
        }),
      }),
    );
    expect(createDatabaseStudentImportSpy).toHaveBeenCalledWith(expect.objectContaining({ tenantId }));
  });
});

describe('configured bulk import on PostgreSQL (PGlite)', () => {
  let harness: PgliteDatabaseHarness;

  beforeEach(async () => {
    harness = await createPgliteDatabaseHarness();
  });

  afterEach(async () => harness?.close());

  function options<T>(creators: T) {
    return {
      env: {
        CLASS_STORE_STORAGE: 'postgresql',
        CLASS_STORE_CENTRAL_TENANT_ID: harness.tenantOneId,
        CLASS_STORE_CENTRAL_TENANT_STATUS: 'ACTIVE',
      },
      getCentralTenantContext: getCompatibilityCentralTenantContext,
      creators,
    };
  }

  const dependencies = () => ({
    withTenantTransaction: harness.runTenantTransaction,
    createDatabaseStudentImport,
    createDatabaseProductImport,
  });

  it('previews against the class, then commits only what the preview accepted', async () => {
    await harness.database.query(
      `INSERT INTO students (tenant_id, student_id, name, status, version, created_at, updated_at)
       VALUES ($1, '02', '이미 있음', 'ACTIVE', 1, now(), now())`, [harness.tenantOneId],
    );
    await harness.database.query(
      'INSERT INTO accounts (tenant_id, student_id, balance, version, updated_at) VALUES ($1, \'02\', 0, 1, now())',
      [harness.tenantOneId],
    );
    const importer = await createConfiguredStudentImport(options(createStudentImportRepositoryCreators(dependencies())));
    const bytes = await workbookBytes([{ name: '학생 명단', rows: [
      ['학생 번호 (필수)', '이름 (필수)', '처음 잔액 (선택)'], ['01', '김민준', 300], ['02', '중복', 0], ['03', '박도윤'],
    ] }]);

    const preview = await importer.preview(bytes);
    expect(preview.rows.map((row) => row.studentId)).toEqual(['01', '03']);
    expect(preview.errors).toEqual([{ rowNumber: 3, column: '학생 번호', message: '이미 등록된 학생 번호예요 (이미 있음).' }]);
    // Preview writes nothing.
    const before = await harness.database.query('SELECT count(*)::int AS count FROM operations');
    expect(before.rows).toEqual([{ count: 0 }]);

    const result = await importer.commit({ operationId: OPERATION_ID, rows: preview.rows });
    expect(result).toMatchObject({ created: 2, replayed: false });
    const students = await harness.database.query<{ student_id: string }>(
      'SELECT student_id FROM students WHERE tenant_id=$1 ORDER BY student_id', [harness.tenantOneId],
    );
    expect(students.rows.map((row) => row.student_id)).toEqual(['01', '02', '03']);
  });

  it('places automatic product sort orders after the current products', async () => {
    await harness.database.query(
      `INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order, version, created_at, updated_at)
       VALUES ($1, 'P001', '기존', 100, 0, true, 12, 1, now(), now())`, [harness.tenantOneId],
    );
    const importer = await createConfiguredProductImport(options(createProductImportRepositoryCreators(dependencies())));
    const bytes = await workbookBytes([{ name: '상품 목록', rows: [['상품 이름', '가격'], ['사탕', 100], ['기존', 200]] }]);
    const preview = await importer.preview(bytes);
    expect(preview.rows).toEqual([expect.objectContaining({ name: '사탕', sortOrder: 13 })]);
    expect(preview.errors).toEqual([expect.objectContaining({ rowNumber: 3, message: '이미 같은 이름의 상품이 있어요 (P001).' })]);
    const result = await importer.commit({ operationId: OPERATION_ID, rows: preview.rows });
    expect(result.items).toEqual([{ rowNumber: 2, productId: 'P002', name: '사탕' }]);
  });
});
