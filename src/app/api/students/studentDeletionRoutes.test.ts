// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantAdminContextDependencies } from '@/server/tenantAuth';

const m = vi.hoisted(() => ({
  access: {} as TenantAdminContextDependencies,
  deletion: { delete: vi.fn(), deleteBatch: vi.fn() },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => m.access }));
vi.mock('@/server/repositories/configuredStudentDeletion', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/configuredStudentDeletion')>(),
  createConfiguredStudentDeletion: vi.fn(async () => m.deletion),
}));

import { DELETE } from '@/app/api/c/[slug]/[...path]/route';
import { StudentAdminConflictError, StudentAdminRefusalError } from '@/server/repositories/database/studentCommands';

const A = 'e1400000-0000-4000-8000-000000000001';
const OPERATION = 'e1400000-0000-4000-8000-000000000011';
const send = (path: string[], body?: unknown) => DELETE(new Request(`https://test.invalid/api/c/class-a/${path.join('/')}`, {
  method: 'DELETE', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
}), { params: Promise.resolve({ slug: 'class-a', path }) });

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ['ADMIN_PASSWORD', 'AUTH_SECRET', 'MIGRATION_READ_ONLY']) vi.stubEnv(key, '');
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  Object.assign(m.access, {
    findBySlug: vi.fn(async () => ({ id: A, slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' })),
    getSession: vi.fn(() => ({ subject: 'teacher', email: 'teacher@example.test', issuedAt: Date.now() })),
    findByTenantAndSubject: vi.fn(async () => ({ id: 'm', tenantId: A, userId: 'u', googleSubject: 'teacher', role: 'OWNER' })),
  });
  m.deletion.delete.mockImplementation(async (studentId: string) => ({ studentId }));
  m.deletion.deleteBatch.mockImplementation(async (body: { students: Array<{ studentId: string }> }) => ({
    studentIds: body.students.map((row) => row.studentId) }));
});
afterEach(() => vi.unstubAllEnvs());

describe('student deletion for classes', () => {
  it('sends a batch deletion to the batch handler, not to the single-student route as student "batch"', async () => {
    const body = { operationId: OPERATION, students: [{ studentId: 'S1', expectedStudentVersion: 1 }, { studentId: 'S2', expectedStudentVersion: 3 }] };
    const response = await send(['students', 'batch'], body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ studentIds: ['S1', 'S2'] });
    expect(m.deletion.deleteBatch).toHaveBeenCalledWith(body);
    expect(m.deletion.delete).not.toHaveBeenCalled();
  });

  it('deletes one student with the version on screen', async () => {
    const body = { operationId: OPERATION, expectedStudentVersion: 2 };
    const response = await send(['students', 'S%201'], body);
    expect(response.status).toBe(200);
    expect(m.deletion.delete).toHaveBeenCalledWith('S 1', body);
  });

  it('answers refusals in Korean with what to do, and hides unexpected errors', async () => {
    m.deletion.delete.mockRejectedValueOnce(new StudentAdminConflictError('STALE_VERSION'));
    const stale = await send(['students', 'S1'], { operationId: OPERATION, expectedStudentVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('학생 정보가 그사이 바뀌었어요. 학생 목록을 새로 불러온 뒤 다시 삭제해 주세요.');

    m.deletion.delete.mockRejectedValueOnce(new StudentAdminRefusalError('STUDENT_NOT_FOUND', '이미 삭제했거나 없는 학생이 있어요. 학생 목록을 새로 불러와 주세요.'));
    const gone = await send(['students', 'S1'], { operationId: OPERATION, expectedStudentVersion: 1 });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: '이미 삭제했거나 없는 학생이 있어요. 학생 목록을 새로 불러와 주세요.', code: 'STUDENT_NOT_FOUND' });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.deletion.deleteBatch.mockRejectedValueOnce(new Error('private detail'));
    const failed = await send(['students', 'batch'], { operationId: OPERATION, students: [{ studentId: 'S1', expectedStudentVersion: 1 }] });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('private');
    errors.mockRestore();
  });

  it('refuses a body that is not JSON before deleting anything', async () => {
    const response = await DELETE(new Request('https://test.invalid/api/c/class-a/students/S1', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    }), { params: Promise.resolve({ slug: 'class-a', path: ['students', 'S1'] }) });
    expect(response.status).toBe(400);
    expect(m.deletion.delete).not.toHaveBeenCalled();
  });
});
