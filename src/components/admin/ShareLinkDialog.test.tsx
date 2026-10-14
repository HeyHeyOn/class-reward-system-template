import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const card = vi.hoisted(() => ({
  png: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  pdf: vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' })),
  download: vi.fn(),
}));

vi.mock('@/lib/shareCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shareCard')>()),
  shareCardPng: card.png,
  shareCardPdf: card.pdf,
  downloadBlob: card.download,
}));

import { ShareLinkDialog, type ShareTarget } from './ShareLinkDialog';

const PATHS = { store: '/c/class-a', bank: '/c/class-a/bank', admin: '/c/class-a/admin' } as const;
const origin = window.location.origin;

function open(initialTarget: ShareTarget = 'store') {
  const onClose = vi.fn();
  render(<ShareLinkDialog initialTarget={initialTarget} paths={PATHS} classLabel="5학년 2반" onClose={onClose} />);
  return { onClose, address: () => (screen.getByLabelText('주소') as HTMLInputElement).value };
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
}

beforeEach(() => {
  card.png.mockClear();
  card.pdf.mockClear();
  card.download.mockClear();
  setClipboard(vi.fn(async () => undefined));
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
});
afterEach(() => { cleanup(); });

describe('ShareLinkDialog', () => {
  it('shows the full address and a QR for the chosen page, and switches between pages', async () => {
    const { address } = open('store');

    expect(screen.getByRole('dialog', { name: '매점 공유' })).toBeTruthy();
    expect(address()).toBe(`${origin}/c/class-a`);
    const qr = await screen.findByRole('img', { name: '매점 QR 코드' });
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(/학생 기기나 교실 기기에서/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '은행' }));
    expect(screen.getByRole('dialog', { name: '은행 공유' })).toBeTruthy();
    expect(address()).toBe(`${origin}/c/class-a/bank`);
    expect(await screen.findByRole('img', { name: '은행 QR 코드' })).toBeTruthy();
  });

  it('marks the admin page as the teacher’s own and asks not to give it to students', () => {
    const { address } = open('admin');

    expect(address()).toBe(`${origin}/c/class-a/admin`);
    expect(screen.getByText('선생님 전용 주소예요')).toBeTruthy();
    expect(screen.getByText(/Google 계정으로 로그인해야 열려요\. 학생에게는 공유하지 마세요\./)).toBeTruthy();
  });

  it('copies the address', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    open('bank');

    fireEvent.click(screen.getByRole('button', { name: '주소 복사' }));
    expect(await screen.findByRole('button', { name: '복사했어요' })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(`${origin}/c/class-a/bank`);
    expect(screen.getByRole('status').textContent).toBe('주소를 복사했어요.');
  });

  it('copies the selected address the old way when the browser refuses the clipboard', async () => {
    setClipboard(vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }));
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);
    open('store');

    fireEvent.click(screen.getByRole('button', { name: '주소 복사' }));
    expect(await screen.findByRole('button', { name: '복사했어요' })).toBeTruthy();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('asks to copy by hand when no way of copying works', async () => {
    setClipboard(undefined);
    open('store');

    fireEvent.click(screen.getByRole('button', { name: '주소 복사' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('주소 칸을 길게 눌러 직접 복사해 주세요'));
    expect(screen.getByRole('button', { name: '주소 복사' })).toBeTruthy();
  });

  it('saves the share card as an image or a PDF named after the class and the page', async () => {
    open('admin');

    fireEvent.click(screen.getByRole('button', { name: '이미지로 저장' }));
    await waitFor(() => expect(card.download).toHaveBeenCalledTimes(1));
    expect(card.png).toHaveBeenCalledWith(expect.objectContaining({
      url: `${origin}/c/class-a/admin`, title: '관리자 페이지', classLabel: '5학년 2반', caution: '선생님 전용, Google 로그인 필요',
    }));
    expect(card.download).toHaveBeenLastCalledWith(expect.any(Blob), '5학년 2반-관리자 페이지-QR.png');
    expect(screen.getByRole('status').textContent).toBe('이미지 파일을 내려받았어요.');

    fireEvent.click(screen.getByRole('button', { name: '매점' }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF로 저장' }));
    await waitFor(() => expect(card.download).toHaveBeenCalledTimes(2));
    expect(card.pdf).toHaveBeenCalledWith(expect.objectContaining({ title: '매점', caution: undefined }));
    expect(card.download).toHaveBeenLastCalledWith(expect.any(Blob), '5학년 2반-매점-QR.pdf');
  });

  it('titles the store and bank cards with the names set in 설정', async () => {
    render(<ShareLinkDialog initialTarget="bank" paths={PATHS} classLabel="5학년 2반" titles={{ store: '별빛 매점', bank: ' 별빛 은행 ' }} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '별빛 은행 공유' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PDF로 저장' }));
    await waitFor(() => expect(card.download).toHaveBeenCalledTimes(1));
    expect(card.pdf).toHaveBeenCalledWith(expect.objectContaining({ title: '별빛 은행' }));
    expect(card.download).toHaveBeenLastCalledWith(expect.any(Blob), '5학년 2반-별빛 은행-QR.pdf');

    fireEvent.click(screen.getByRole('button', { name: '매점' }));
    fireEvent.click(screen.getByRole('button', { name: '이미지로 저장' }));
    await waitFor(() => expect(card.download).toHaveBeenCalledTimes(2));
    expect(card.png).toHaveBeenCalledWith(expect.objectContaining({ title: '별빛 매점' }));

    fireEvent.click(screen.getByRole('button', { name: '관리자 페이지' }));
    expect(screen.getByRole('dialog', { name: '관리자 페이지 공유' })).toBeTruthy();
  });

  it('says so when the file cannot be made', async () => {
    card.png.mockRejectedValueOnce(new Error('no canvas'));
    open('store');

    fireEvent.click(screen.getByRole('button', { name: '이미지로 저장' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('파일을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.'));
    expect(card.download).not.toHaveBeenCalled();
  });

  it('offers sending to another app only where the device can share', async () => {
    open('store');
    expect(screen.queryByRole('button', { name: '다른 앱으로 보내기' })).toBeNull();
    cleanup();

    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    open('bank');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '다른 앱으로 보내기' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: '5학년 2반 은행', url: `${origin}/c/class-a/bank` }));
  });
});
