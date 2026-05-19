import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentQrPrintPage } from './StudentQrPrintPage';

const students = [
  { studentId: 'S001', name: '김민준', number: 1, balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', number: 2, balance: 1200, status: 'ACTIVE' },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StudentQrPrintPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(students)));
    vi.stubGlobal('print', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads students and renders printable QR cards for each student', async () => {
    render(<StudentQrPrintPage />);

    expect(await screen.findByText('김민준')).toBeTruthy();
    expect(screen.getByText('이서연')).toBeTruthy();

    const minjunQr = screen.getByRole('img', { name: '김민준 QR 코드' });
    expect(minjunQr.getAttribute('src')).toBe('/api/qrcode?value=S001');
    expect(screen.getByText('1번 · S001')).toBeTruthy();

    const seoyeonQr = screen.getByRole('img', { name: '이서연 QR 코드' });
    expect(seoyeonQr.getAttribute('src')).toBe('/api/qrcode?value=S002');
    expect(screen.getByText('2번 · S002')).toBeTruthy();
  });

  it('prints the current QR card page', async () => {
    render(<StudentQrPrintPage />);

    await screen.findByText('김민준');
    fireEvent.click(screen.getByRole('button', { name: 'QR 카드 인쇄하기' }));

    expect(print).toHaveBeenCalledOnce();
  });
});
