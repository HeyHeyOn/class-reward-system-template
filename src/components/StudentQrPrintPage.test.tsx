import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentQrPrintPage } from './StudentQrPrintPage';

const students = [
  { studentId: 'S001', name: '김민준', balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', balance: 1200, status: 'ACTIVE' },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StudentQrPrintPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/c/alpha-class/admin/student-qrs');
    let blobNumber = 0;
    const NativeURL = URL;
    class TestURL extends NativeURL {}
    Object.assign(TestURL, { createObjectURL: vi.fn(() => `blob:qr-${++blobNumber}`), revokeObjectURL: vi.fn() });
    vi.stubGlobal('URL', TestURL);
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).endsWith('/students')
      ? jsonResponse(students)
      : new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })));
    vi.stubGlobal('print', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('POSTs exact student bodies once and renders only blob URLs', async () => {
    render(<StudentQrPrintPage />);

    expect(await screen.findByText('김민준')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('img', { name: '김민준 QR 코드' }).getAttribute('src')).toBe('blob:qr-1'));
    expect(screen.getByRole('img', { name: '이서연 QR 코드' }).getAttribute('src')).toBe('blob:qr-2');
    const qrCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/qrcode'));
    expect(qrCalls).toHaveLength(2);
    expect(qrCalls[0]).toEqual(['/api/c/alpha-class/qrcode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'student', studentId: 'S001' }), signal: expect.any(AbortSignal),
    }]);
    expect(qrCalls[1]?.[1]?.body).toBe(JSON.stringify({ kind: 'student', studentId: 'S002' }));
    expect(screen.getAllByRole('img').every((image) => !String(image.getAttribute('src')).includes('?value='))).toBe(true);
    expect(screen.getAllByRole('img').every((image) => !String(image.getAttribute('src')).includes('S001'))).toBe(true);
  });

  it('revokes every object URL on unmount', async () => {
    const view = render(<StudentQrPrintPage />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-2');
  });

  it('handles a QR failure without a broken image or fetch loop', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith('/students')
      ? jsonResponse([students[0]]) : jsonResponse({ error: 'failed' }, { status: 404 }));
    render(<StudentQrPrintPage />);
    await screen.findByText('김민준');
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/qrcode'))).toHaveLength(1));
    expect(screen.queryByRole('img', { name: '김민준 QR 코드' })).toBeNull();
    expect(screen.getByText('QR 생성 실패')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'QR 카드 인쇄하기' })).toHaveProperty('disabled', true);
  });

  it('keeps printing disabled while QR generation is pending and retries a failed generation', async () => {
    let resolveFirstQr!: (response: Response) => void;
    let resolveRetryQr!: (response: Response) => void;
    const firstQr = new Promise<Response>((resolve) => { resolveFirstQr = resolve; });
    const retryQr = new Promise<Response>((resolve) => { resolveRetryQr = resolve; });
    let qrAttempt = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).endsWith('/students')) return jsonResponse([students[0]]);
      qrAttempt += 1;
      return qrAttempt === 1 ? firstQr : retryQr;
    });
    render(<StudentQrPrintPage />);

    await screen.findByText('김민준');
    const printButton = screen.getByRole('button', { name: 'QR 카드 인쇄하기' });
    expect(printButton).toHaveProperty('disabled', true);
    fireEvent.click(printButton);
    expect(print).not.toHaveBeenCalled();

    resolveFirstQr(jsonResponse({ error: 'not an svg' }));
    expect(await screen.findByText('QR 생성 실패')).toBeTruthy();
    expect(printButton).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'QR 생성 다시 시도' }));
    expect(screen.getByText('QR 생성 중')).toBeTruthy();
    expect(printButton).toHaveProperty('disabled', true);
    resolveRetryQr(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } }));
    await waitFor(() => expect(printButton).toHaveProperty('disabled', false));
    fireEvent.click(printButton);
    expect(print).toHaveBeenCalledOnce();
  });

  it('prints the current QR card page', async () => {
    render(<StudentQrPrintPage />);
    await screen.findByText('김민준');
    await screen.findByRole('img', { name: '김민준 QR 코드' });
    fireEvent.click(screen.getByRole('button', { name: 'QR 카드 인쇄하기' }));
    expect(print).toHaveBeenCalledOnce();
  });
});
