import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankApp } from './BankApp';

const tasks = [
  { taskId: 'T001', title: '책 10분 읽기', description: '책을 10분 읽었으면 완료', reward: 5, maxCompletionsPerStudent: 2, isActive: true, sortOrder: 1 },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), { status: init?.status ?? 200, headers: { 'Content-Type': 'application/json' } });
}

function deferredResponse(payload: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return {
    resolve,
    response: gate.then(() => jsonResponse(payload)),
  };
}

describe('BankApp', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green' });
      if (url === '/api/tasks') return jsonResponse(tasks);
      if (url === '/api/bank/balance?studentId=S001') return jsonResponse({ studentId: 'S001', name: '김민준', number: 1, balance: 12 });
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') return jsonResponse({ task: tasks[0], student: { studentId: 'S001', name: '김민준', balance: 17 }, completedCount: 1, remainingCompletions: 1 });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('checks a student balance from the bank QR popup', async () => {
    render(<BankApp />);
    expect(await screen.findByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '잔액 확인' }));
    expect(await screen.findByRole('dialog', { name: '잔액 확인 QR 인식' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 잔액 확인' }));
    expect(await screen.findByRole('dialog', { name: '잔액 확인' })).toBeTruthy();
    expect(document.body.textContent).toContain('김민준 학생의 현재 잔액은 12별입니다.');
  });

  it('shows a loading popup while loading tasks from the bank home', async () => {
    const taskRequest = deferredResponse(tasks);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green' });
      if (url === '/api/tasks') return taskRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 확인' }));

    expect(await screen.findByRole('dialog', { name: '과제 목록 불러오는 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('과제 목록을 불러오는 중입니다.');

    taskRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '과제 목록' })).toBeTruthy();
  });

  it('shows a loading popup while completing a task after QR recognition', async () => {
    const completeRequest = deferredResponse({ task: tasks[0], student: { studentId: 'S001', name: '김민준', balance: 17 }, completedCount: 1, remainingCompletions: 1 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green' });
      if (url === '/api/tasks') return jsonResponse(tasks);
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') return completeRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 확인' }));
    fireEvent.click(await screen.findByRole('button', { name: /책 10분 읽기/ }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 완료하기' }));

    expect(await screen.findByRole('dialog', { name: '과제 완료 처리 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 보상을 지급하는 중입니다.');

    completeRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
  });

  it('shows tasks, opens detail, completes with QR, and returns to detail on close', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 확인' }));
    expect(await screen.findByRole('dialog', { name: '과제 목록' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /책 10분 읽기/ }));
    expect(await screen.findByRole('dialog', { name: '책 10분 읽기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 완료하기' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/T001/complete', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
    expect(document.body.textContent).toContain('김민준 학생에게 5별 지급 완료');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('dialog', { name: '책 10분 읽기' })).toBeTruthy();
  });
});
