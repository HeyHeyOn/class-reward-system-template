import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { getTaskAssignmentStatus, updateTaskAssignmentStatus } from '@/server/sheetsRepository';
import { GET, PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: () => true, unauthorizedAdminResponse: () => new Response(null, { status: 401 }) }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn(), createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ getTaskAssignmentStatus: vi.fn(), updateTaskAssignmentStatus: vi.fn() }));

describe('PATCH /api/tasks/[taskId]/assignments', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns the optional physical assignment source from the write-free GET query', async () => {
    const reader = {};
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue(reader as never);
    vi.mocked(getTaskAssignmentStatus).mockResolvedValue({
      taskId: 'T1',
      students: [{ studentId: 'S1', name: 'Student', assigned: true, completed: false, assignmentSource: 'QR' }],
    });
    const response = await GET(new Request('http://localhost/api/tasks/T1/assignments'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      students: [{ studentId: 'S1', assignmentSource: 'QR' }],
    });
    expect(getTaskAssignmentStatus).toHaveBeenCalledWith(reader, 'T1');
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('awaits Next 16 params and sends one student desired state with ADMIN source', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskAssignmentStatus).mockResolvedValue({ taskId: 'T 1', students: [] });
    const params = Promise.resolve({ taskId: 'T%201' });
    const response = await PATCH(new Request('http://localhost/api/tasks/T%201/assignments', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: ' S1 ', assigned: true }),
    }), { params });
    expect(response.status).toBe(200);
    expect(updateTaskAssignmentStatus).toHaveBeenCalledWith(store, 'T 1', { studentId: ' S1 ', assigned: true, source: 'ADMIN' });
  });

  it('preserves an additive legacyMirrorWarning in canonical success responses', async () => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(updateTaskAssignmentStatus).mockResolvedValue({ taskId: 'T1', students: [], legacyMirrorWarning: 'LEGACY_MIRROR_UPDATE_FAILED' });
    const response = await PATCH(new Request('http://localhost/api/tasks/T1/assignments', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: 'S1', assigned: false }),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ taskId: 'T1', legacyMirrorWarning: 'LEGACY_MIRROR_UPDATE_FAILED' });
  });

  it('sends completion desired state as an ADMIN command', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskAssignmentStatus).mockResolvedValue({ taskId: 'T1', students: [] });
    const response = await PATCH(new Request('http://localhost/api/tasks/T1/assignments', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: 'S1', completed: false }),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(200);
    expect(updateTaskAssignmentStatus).toHaveBeenCalledWith(store, 'T1', { studentId: 'S1', completed: false, source: 'ADMIN' });
  });

  it('accepts an authenticated one-student QR assignment command', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskAssignmentStatus).mockResolvedValue({ taskId: 'T1', students: [] });
    const response = await PATCH(new Request('http://localhost/api/tasks/T1/assignments', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: 'S1', assigned: true, source: 'QR' }),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(200);
    expect(updateTaskAssignmentStatus).toHaveBeenCalledWith(store, 'T1', { studentId: 'S1', assigned: true, source: 'QR' });
  });

  it.each([
    ['null payload', null],
    ['array payload', []],
    ['missing assigned', { studentId: 'S1' }],
    ['string assigned', { studentId: 'S1', assigned: 'false' }],
    ['non-string studentId', { studentId: 1, assigned: true }],
    ['empty studentId', { studentId: '   ', assigned: false }],
    ['unknown key', { studentId: 'S1', assigned: true, allowedStudentIds: ['S1'] }],
    ['legacy full-set key', { studentId: 'S1', assigned: true, studentIds: ['S1'] }],
  ])('rejects %s before creating a Sheets store', async (_label, body) => {
    const response = await PATCH(new Request('http://localhost/api/tasks/T1/assignments', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ taskId: 'T1' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '과제 부여 요청 형식이 올바르지 않습니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskAssignmentStatus).not.toHaveBeenCalled();
  });
});
