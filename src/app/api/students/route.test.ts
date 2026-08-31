import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredStudentReader: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
  getStudents: vi.fn(),
  createStudent: vi.fn(),
}));

vi.mock('@/server/repositories/configuredStudents', () => ({
  createConfiguredStudentReader: mocks.createConfiguredStudentReader,
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: mocks.createConfiguredSheetsReader,
  createConfiguredSheetsStore: mocks.createConfiguredSheetsStore,
}));
vi.mock('@/server/sheetsRepository', () => ({
  getStudents: mocks.getStudents,
  createStudent: mocks.createStudent,
}));

import { GET } from '@/app/api/students/route';

const students = [{ studentId: 'S1', name: '학생', balance: 100, status: 'ACTIVE' }];

describe('students GET read authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
