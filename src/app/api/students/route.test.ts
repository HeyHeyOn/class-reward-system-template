import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredStudentReader: vi.fn(),
  createConfiguredStudentCreation: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
  getStudents: vi.fn(),
  createStudent: vi.fn(),
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: vi.fn(() => Response.json(
    { error: '관리자 로그인이 필요합니다.' }, { status: 401 },
  )),
}));

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: mocks.isAuthorizedAdminRequest,
  unauthorizedAdminResponse: mocks.unauthorizedAdminResponse,
}));
vi.mock('@/server/repositories/configuredStudents', () => ({
  createConfiguredStudentReader: mocks.createConfiguredStudentReader,
}));
vi.mock('@/server/repositories/configuredStudentCreation', () => ({
  createConfiguredStudentCreation: mocks.createConfiguredStudentCreation,
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: mocks.createConfiguredSheetsReader,
  createConfiguredSheetsStore: mocks.createConfiguredSheetsStore,
}));
vi.mock('@/server/sheetsRepository', () => ({
  getStudents: mocks.getStudents,
  createStudent: mocks.createStudent,
}));

import { GET, POST } from '@/app/api/students/route';

const students = [{ studentId: 'S1', name: '학생', balance: 100, status: 'ACTIVE' }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthorizedAdminRequest.mockReturnValue(true);
});

describe('students GET read authority', () => {
  it('delegates the list to the configured student reader', async () => {
    const configuredReader = {
      getStudents: vi.fn(async () => students),
      getStudentById: vi.fn(),
    };
    mocks.createConfiguredStudentReader.mockResolvedValueOnce(configuredReader);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(students);
    expect(configuredReader.getStudents).toHaveBeenCalledOnce();
    expect(configuredReader.getStudentById).not.toHaveBeenCalled();
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(mocks.getStudents).not.toHaveBeenCalled();
  });

  it('preserves the existing list error projection', async () => {
    mocks.createConfiguredStudentReader.mockRejectedValueOnce(new Error('students unavailable'));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'students unavailable' });
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
  });
});

const validCreateBody = {
  operationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  studentId: ' S003 ',
  name: ' 박도윤 ',
  balance: -25,
  status: 'ACTIVE',
};

function studentPost(body: unknown, contentType = 'application/json') {
  return new Request('https://example.test/api/students', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function withoutCreateFields(...fields: string[]) {
  return Object.fromEntries(Object.entries(validCreateBody).filter(([key]) => !fields.includes(key)));
}

describe('students POST configured mutation authority', () => {
  it('authenticates first without inspecting an unauthorized body or resolving authority', async () => {
    mocks.isAuthorizedAdminRequest.mockReturnValueOnce(false);
    const request = studentPost('{');

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '관리자 로그인이 필요합니다.' });
    expect(mocks.unauthorizedAdminResponse).toHaveBeenCalledOnce();
    expect(mocks.createConfiguredStudentCreation).not.toHaveBeenCalled();
  });

  it('validates the exact body, passes it unchanged with the same Request, and returns versionless legacy output', async () => {
    const created = { studentId: 'S003', name: '박도윤', balance: -25, status: 'ACTIVE' };
    const create = vi.fn(async () => created);
    mocks.createConfiguredStudentCreation.mockResolvedValueOnce({ create });
    const request = studentPost(validCreateBody, 'application/json; charset=utf-8');

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(mocks.createConfiguredStudentCreation).toHaveBeenCalledWith(request);
    expect(create).toHaveBeenCalledWith(validCreateBody);
    expect(mocks.createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(mocks.createStudent).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong content type', validCreateBody, 'text/plain'],
    ['JSONP content type', validCreateBody, 'application/jsonp'],
    ['JSON sequence content type', validCreateBody, 'application/json-seq'],
    ['malformed JSON', '{', 'application/json'],
    ['array body', [], 'application/json'],
    ['unknown key', { ...validCreateBody, extra: true }, 'application/json'],
    ['missing operation ID', withoutCreateFields('operationId'), 'application/json'],
    ['missing student ID', withoutCreateFields('studentId'), 'application/json'],
    ['missing name', withoutCreateFields('name'), 'application/json'],
    ['missing balance', withoutCreateFields('balance'), 'application/json'],
    ['missing status', withoutCreateFields('status'), 'application/json'],
    ['uppercase operation UUID', { ...validCreateBody, operationId: validCreateBody.operationId.toUpperCase() }, 'application/json'],
    ['noncanonical operation UUID', { ...validCreateBody, operationId: '11111111-1111-0111-8111-111111111111' }, 'application/json'],
    ['blank student ID', { ...validCreateBody, studentId: '  ' }, 'application/json'],
    ['non-string student ID', { ...validCreateBody, studentId: 3 }, 'application/json'],
    ['blank name', { ...validCreateBody, name: '\t' }, 'application/json'],
    ['non-string name', { ...validCreateBody, name: ['박도윤'] }, 'application/json'],
    ['coerced balance', { ...validCreateBody, balance: '-25' }, 'application/json'],
    ['fractional balance', { ...validCreateBody, balance: 1.5 }, 'application/json'],
    ['unsafe balance', { ...validCreateBody, balance: Number.MAX_SAFE_INTEGER + 1 }, 'application/json'],
    ['unknown status', { ...validCreateBody, status: 'PENDING' }, 'application/json'],
    ['array status', { ...validCreateBody, status: ['ACTIVE'] }, 'application/json'],
  ])('rejects %s before resolving the configured root', async (_label, body, contentType) => {
    const response = await POST(studentPost(body, contentType));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '학생을 추가하지 못했습니다.' });
    expect(mocks.createConfiguredStudentCreation).not.toHaveBeenCalled();
  });

  it('accepts both statuses and signed safe-integer boundaries', async () => {
    const create = vi.fn(async (input) => input);
    mocks.createConfiguredStudentCreation.mockResolvedValue({ create });

    for (const [status, balance] of [['ACTIVE', Number.MIN_SAFE_INTEGER], ['INACTIVE', Number.MAX_SAFE_INTEGER]] as const) {
      const body = { ...validCreateBody, status, balance };
      const response = await POST(studentPost(body));
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(body);
    }
  });

  it('preserves Error messages and the non-Error Korean fallback as 400 responses', async () => {
    mocks.createConfiguredStudentCreation
      .mockRejectedValueOnce(new Error('configured unavailable'))
      .mockRejectedValueOnce('non-error');

    const configuredError = await POST(studentPost(validCreateBody));
    const fallbackError = await POST(studentPost(validCreateBody));

    expect(configuredError.status).toBe(400);
    expect(await configuredError.json()).toEqual({ error: 'configured unavailable' });
    expect(fallbackError.status).toBe(400);
    expect(await fallbackError.json()).toEqual({ error: '학생을 추가하지 못했습니다.' });
  });
});
