import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { confirmStudentLookup } from '@/server/studentLookup';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/studentLookup', () => ({ confirmStudentLookup: vi.fn() }));

const invalidQueryError = { error: '올바른 학생 ID를 입력해 주세요.' };
const missingStudentError = { error: '학생 정보를 찾을 수 없습니다.', code: 'STUDENT_NOT_FOUND' };
const unavailableError = {
  error: '학생 정보를 일시적으로 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  code: 'STUDENT_DATA_UNAVAILABLE',
};

describe('GET /api/bank/student', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
  });

  it('returns exactly the student-safe DTO for one confirmed active student', async () => {
    vi.mocked(confirmStudentLookup).mockResolvedValue({
      status: 'FOUND',
      student: {
        studentId: '001-A', name: '김학생', balance: 999999, status: 'ACTIVE', internalNote: 'secret',
      } as never,
    });
    const request = new Request('http://localhost/api/bank/student?studentId=%20%20001-A%20%20');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(confirmStudentLookup).toHaveBeenCalledWith(expect.anything(), '001-A');
    expect(body).toEqual({ studentId: '001-A', name: '김학생' });
    expect(Object.keys(body)).toEqual(['studentId', 'name']);
  });

  it.each([
    ['a missing studentId', 'http://localhost/api/bank/student'],
    ['a blank studentId', 'http://localhost/api/bank/student?studentId=%20%20'],
    ['multiple studentId values', 'http://localhost/api/bank/student?studentId=001&studentId=002'],
    ['an unsupported query key', 'http://localhost/api/bank/student?studentId=001&includeBalance=true'],
  ])('returns the fixed safe 400 for %s without reading Sheets', async (_description, url) => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidQueryError);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(confirmStudentLookup).not.toHaveBeenCalled();
  });

  it.each(['NOT_FOUND', 'INACTIVE'] as const)('returns a confirmed safe 404 for %s', async (status) => {
    vi.mocked(confirmStudentLookup).mockResolvedValue({ status });

    const response = await GET(new Request('http://localhost/api/bank/student?studentId=001'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(missingStudentError);
  });

  it('returns a retryable 503 instead of not-found for unavailable or malformed student data', async () => {
    vi.mocked(confirmStudentLookup).mockResolvedValue({ status: 'UNAVAILABLE' });

    const response = await GET(new Request('http://localhost/api/bank/student?studentId=001'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(unavailableError);
  });

  it('returns a fixed safe 503 without leaking provider errors', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(
      new Error('Google Sheets credential secret and Students!A:Z'),
    );

    const response = await GET(new Request('http://localhost/api/bank/student?studentId=001'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual(unavailableError);
    expect(JSON.stringify(body)).not.toContain('credential secret');
  });
});
