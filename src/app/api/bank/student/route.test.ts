import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getStudentById } from '@/server/sheetsRepository';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ getStudentById: vi.fn() }));

const invalidQueryError = { error: '올바른 학생 ID를 입력해 주세요.' };
const missingStudentError = { error: '학생 정보를 찾을 수 없습니다.' };
const internalError = { error: '학생 정보를 불러오지 못했습니다.' };

describe('GET /api/bank/student', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
  });

  it('returns exactly the student-safe DTO for one active student and passes the request to the reader', async () => {
    vi.mocked(getStudentById).mockResolvedValue({
      studentId: '001-A',
      name: '김학생',
      balance: 999999,
      status: 'ACTIVE',
      internalNote: 'secret',
    } as never);
    const request = new Request('http://localhost/api/bank/student?studentId=%20%20001-A%20%20');

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(getStudentById).toHaveBeenCalledWith(expect.anything(), '001-A');
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
    expect(getStudentById).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing student', null],
    ['an inactive student', { studentId: '001', name: '김학생', balance: 10, status: 'INACTIVE' }],
  ])('returns the same fixed safe 404 for %s', async (_description, student) => {
    vi.mocked(getStudentById).mockResolvedValue(student as never);

    const response = await GET(new Request('http://localhost/api/bank/student?studentId=001'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(missingStudentError);
  });

  it('returns a fixed safe 500 without leaking reader errors', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(
      new Error('Google Sheets credential secret and Students!A:Z'),
    );

    const response = await GET(new Request('http://localhost/api/bank/student?studentId=001'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual(internalError);
    expect(JSON.stringify(body)).not.toContain('credential secret');
  });
});
