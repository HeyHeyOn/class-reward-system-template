// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentQrCodes } from '@/server/repositories/configuredStudentQrCodes';
import { StudentQrCodeError } from '@/server/repositories/database/studentQrCodes';
import { POST } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/legacyDeploymentMode', () => ({ legacyWriteFreezeResponse: vi.fn(() => null) }));
vi.mock('@/server/repositories/configuredStudentQrCodes', () => ({ createConfiguredStudentQrCodes: vi.fn() }));
vi.mock('@/server/repositories/database/studentQrCodes', () => ({
  StudentQrCodeError: class extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  },
}));

const post = (body: unknown, contentType = 'application/json', url = 'http://localhost/api/students/qr-reissue') =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body) });

describe('POST /api/students/qr-reissue', () => {
  const reissue = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(legacyWriteFreezeResponse).mockReturnValue(null);
    reissue.mockResolvedValue({ reissued: 2 });
    vi.mocked(createConfiguredStudentQrCodes).mockResolvedValue({ reissue } as never);
  });

  it('issues new codes for the chosen students', async () => {
    const response = await POST(post({ studentIds: ['S001', 'S002'] }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reissued: 2 });
    expect(reissue).toHaveBeenCalledExactlyOnceWith(['S001', 'S002']);
  });

  it('answers a frozen legacy deployment before anything else', async () => {
    vi.mocked(legacyWriteFreezeResponse).mockReturnValue(Response.json({ error: 'frozen' }, { status: 503 }));
    expect((await POST(post({ studentIds: ['S001'] }))).status).toBe(503);
    expect(isAuthorizedAdminRequest).not.toHaveBeenCalled();
  });

  it('requires a signed-in teacher', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    expect((await POST(post({ studentIds: ['S001'] }))).status).toBe(401);
    expect(createConfiguredStudentQrCodes).not.toHaveBeenCalled();
  });

  it.each([
    [post({ studentIds: ['S001'], extra: true })],
    [post({ ids: ['S001'] })],
    [post(['S001'])],
    [post({ studentIds: ['S001'] }, 'text/plain')],
    [post({ studentIds: ['S001'] }, 'application/json', 'http://localhost/api/students/qr-reissue?x=1')],
  ])('refuses a request that is not exactly { studentIds } %#', async (request) => {
    expect((await POST(request)).status).toBe(400);
    expect(reissue).not.toHaveBeenCalled();
  });

  it('passes on the class answer when a student is missing', async () => {
    reissue.mockRejectedValue(new StudentQrCodeError('STUDENT_NOT_FOUND', '학생을 찾지 못했어요.', 404));
    const response = await POST(post({ studentIds: ['S009'] }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '학생을 찾지 못했어요.', code: 'STUDENT_NOT_FOUND' });
  });
});
