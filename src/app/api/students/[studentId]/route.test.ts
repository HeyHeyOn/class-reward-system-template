import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredStudentReader: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
  getStudentById: vi.fn(),
  updateStudentDetails: vi.fn(),
  deleteStudent: vi.fn(),
}));

vi.mock('@/server/repositories/configuredStudents', () => ({
  createConfiguredStudentReader: mocks.createConfiguredStudentReader,
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: mocks.createConfiguredSheetsReader,
  createConfiguredSheetsStore: mocks.createConfiguredSheetsStore,
}));
vi.mock('@/server/sheetsRepository', () => ({
  getStudentById: mocks.getStudentById,
  updateStudentDetails: mocks.updateStudentDetails,
  deleteStudent: mocks.deleteStudent,
}));

import { GET } from '@/app/api/students/[studentId]/route';

const student = { studentId: 'S 1', name: '학생', balance: 100, status: 'ACTIVE' };
const request = new Request('https://example.test/api/students/S%201');
const context = { params: Promise.resolve({ studentId: 'S%201' }) };

describe('student by-id GET read authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the decoded ID to the configured student reader', async () => {
    const configuredReader = {
      getStudents: vi.fn(),
      getStudentById: vi.fn(async () => student),
    };
    mocks.createConfiguredStudentReader.mockResolvedValueOnce(configuredReader);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(student);
    expect(configuredReader.getStudentById).toHaveBeenCalledWith('S 1');
    expect(configuredReader.getStudents).not.toHaveBeenCalled();
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(mocks.getStudentById).not.toHaveBeenCalled();
  });

  it('preserves the existing 404 response when the configured reader returns null', async () => {
    const configuredReader = {
      getStudents: vi.fn(),
      getStudentById: vi.fn(async () => null),
    };
    mocks.createConfiguredStudentReader.mockResolvedValueOnce(configuredReader);

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '학생을 찾을 수 없습니다.' });
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('preserves the existing by-id error projection', async () => {
    mocks.createConfiguredStudentReader.mockRejectedValueOnce(new Error('student unavailable'));

    const response = await GET(request, context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'student unavailable' });
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
  });
});
