import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParentConsentFormInput } from '@/lib/parentConsentForm';

const form = vi.hoisted(() => ({
  pdf: vi.fn<(input: ParentConsentFormInput, options: { fontFamily: string }) => Promise<Blob>>(async () => new Blob(['pdf'], { type: 'application/pdf' })),
  download: vi.fn(),
}));

vi.mock('@/lib/documentCanvas', () => ({ parentConsentFormPdf: form.pdf }));
vi.mock('@/lib/shareCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shareCard')>()),
  downloadBlob: form.download,
}));

import { ParentConsentFormDialog } from './ParentConsentFormDialog';

const FILE = '개인정보 수집·이용 동의서.pdf';

function open(classLabel = '5학년 2반') {
  const onClose = vi.fn();
  render(<ParentConsentFormDialog classLabel={classLabel} onClose={onClose} />);
  const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
  return {
    onClose,
    school: () => field(/학교 이름/),
    classInput: () => field(/학년·반/),
    teacher: () => field(/담임교사 이름/),
    due: () => field(/회신 기한/),
    downloadButton: () => screen.getByRole('button', { name: 'PDF로 내려받기' }) as HTMLButtonElement,
    status: () => screen.getByRole('status').textContent,
  };
}

beforeEach(() => {
  form.pdf.mockClear();
  form.download.mockClear();
});
afterEach(() => { cleanup(); });

describe('ParentConsentFormDialog', () => {
  it('explains why the consent is needed and what to do without it', () => {
    const view = open();

    expect(screen.getByRole('dialog', { name: '개인정보 수집·이용 동의서' })).toBeTruthy();
    expect(screen.getByText(/만 14세 미만 학생의 실명과 학년·반·번호를 입력하려면 법정대리인\(학부모\)의 동의가 필요해요/)).toBeTruthy();
    expect(screen.getByText(/이 동의서를 인쇄해 가정에 보내 서명을 받고, 받은 동의서는 선생님이 보관해 주세요/)).toBeTruthy();
    expect(screen.getByText('동의를 받지 않은 학생은 실명 대신 별명과 임의 번호로 등록해 주세요.')).toBeTruthy();
    expect(view.classInput().value).toBe('5학년 2반');
    expect(view.school().value).toBe('');
    expect(view.due().placeholder).toBe('예: 3월 15일');
    expect(view.status()).toBe('');
  });

  it('makes the PDF from what was filled in and downloads it named after the class', async () => {
    const view = open();
    fireEvent.change(view.school(), { target: { value: ' 햇살초등학교 ' } });
    fireEvent.change(view.classInput(), { target: { value: '6학년 1반' } });
    fireEvent.change(view.teacher(), { target: { value: '김하늘' } });
    fireEvent.change(view.due(), { target: { value: '3월 15일' } });

    fireEvent.click(view.downloadButton());
    await waitFor(() => expect(form.download).toHaveBeenCalledTimes(1));
    expect(form.pdf).toHaveBeenCalledWith(
      { schoolName: '햇살초등학교', classLabel: '6학년 1반', teacherName: '김하늘', dueDate: '3월 15일' },
      { fontFamily: expect.any(String) },
    );
    expect(form.pdf.mock.calls[0][1].fontFamily).not.toBe('');
    expect(form.download).toHaveBeenCalledWith(expect.any(Blob), `6학년 1반-${FILE}`);
    expect(view.status()).toBe('동의서 PDF를 내려받았어요.');
  });

  it('leaves empty fields blank and names the file 학급 without a class, with unsafe characters replaced', async () => {
    const view = open('');
    fireEvent.click(view.downloadButton());
    await waitFor(() => expect(form.download).toHaveBeenCalledTimes(1));
    expect(form.pdf).toHaveBeenLastCalledWith({ schoolName: '', classLabel: '', teacherName: '', dueDate: '' }, expect.anything());
    expect(form.download).toHaveBeenLastCalledWith(expect.any(Blob), `학급-${FILE}`);

    fireEvent.change(view.classInput(), { target: { value: '5/2반' } });
    fireEvent.click(view.downloadButton());
    await waitFor(() => expect(form.download).toHaveBeenCalledTimes(2));
    expect(form.download).toHaveBeenLastCalledWith(expect.any(Blob), `5-2반-${FILE}`);
  });

  it('shows the button as busy while the PDF is being made', async () => {
    let finish: (blob: Blob) => void = () => undefined;
    form.pdf.mockImplementationOnce(() => new Promise<Blob>((resolve) => { finish = resolve; }));
    const view = open();

    fireEvent.click(view.downloadButton());
    await waitFor(() => expect(view.downloadButton().disabled).toBe(true));
    expect((screen.getByRole('button', { name: '닫기' }) as HTMLButtonElement).disabled).toBe(true);
    finish(new Blob(['pdf'], { type: 'application/pdf' }));
    await waitFor(() => expect(view.downloadButton().disabled).toBe(false));
    expect(form.download).toHaveBeenCalledTimes(1);
    expect(view.status()).toBe('동의서 PDF를 내려받았어요.');
  });

  it('says so when the PDF cannot be made', async () => {
    form.pdf.mockRejectedValueOnce(new Error('no canvas'));
    const view = open();

    fireEvent.click(view.downloadButton());
    await waitFor(() => expect(view.status()).toBe('동의서를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.'));
    expect(form.download).not.toHaveBeenCalled();
    expect(view.downloadButton().disabled).toBe(false);
  });

  it('closes from the close button', () => {
    const view = open();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });
});
