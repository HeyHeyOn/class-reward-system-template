import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankApp } from './BankApp';

const tasks = [
  { taskId: 'T001', title: '책 10분 읽기', description: '책을 10분 읽었으면 완료', reward: 5, isActive: true, sortOrder: 1 },
];
const publicTasks = [{ taskId: 'PUB1', title: '공개 독서 과제', description: '누구나 볼 수 있는 설명', reward: 8, sortOrder: 1, dueAt: '2030-01-02T03:30:00.000Z', recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '09:00' }, prerequisiteTitle: '준비 과제', prerequisiteMessage: '준비 과제를 먼저 완료해 주세요.' }];

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

function completionSuccess(operationId: string, projectedTasks: unknown[] = tasks.map((task) => ({
  ...task,
  allowedStudentIds: ['S001'],
  studentStatus: { studentId: 'S001', assigned: true, completed: true },
})), task = tasks[0]) {
  return {
    task: { taskId: task.taskId, title: task.title, reward: task.reward },
    student: { studentId: 'S001', name: '김민준' },
    tasks: projectedTasks,
    operation: { operationId, state: 'SUCCESS' },
  };
}

async function identifyTaskStudent(studentId = 'S001') {
  fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
  fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: studentId } });
  fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));
}

describe('BankApp', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: vi.fn(() => 'operation-001') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green', fontFamily: 'nanum-barun-gothic', qrManualInputEnabled: true });
      if (url === '/api/bank/tasks') return jsonResponse(publicTasks);
      if (url === '/api/tasks?studentId=S001') return jsonResponse(tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: false } })));
      if (url === '/api/bank/balance?studentId=S001') return jsonResponse({
        studentId: 'S001',
        name: '김민준',
        number: 1,
        balance: 12,
        transactions: [
          { transactionId: 'T001', timestamp: '2026-05-21T00:00:00.000Z', studentId: 'S001', studentName: '김민준', items: [{ productId: 'P001', name: '연필', price: 3, quantity: 2, subtotal: 6 }], totalAmount: 6, balanceBefore: 18, balanceAfter: 12, status: 'COMPLETED', operator: 'kiosk' },
          { transactionId: 'T002', timestamp: '2026-05-21T01:00:00.000Z', studentId: 'S001', studentName: '김민준', items: [{ productId: 'TASK', name: '책 읽기', price: -5, quantity: 1, subtotal: -5 }], totalAmount: -5, balanceBefore: 12, balanceAfter: 17, status: 'TASK_REWARD', operator: 'bank' },
          { transactionId: 'T003', timestamp: '2026-05-21T02:00:00.000Z', studentId: 'S001', studentName: '김민준', items: [{ productId: 'P002', name: '지우개', price: 2, quantity: 1, subtotal: 2 }], totalAmount: 2, balanceBefore: 17, balanceAfter: 15, status: 'CANCELLED', operator: 'kiosk', cancelledAt: '2026-05-21T02:30:00.000Z' },
        ],
      });
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') {
        const operationId = JSON.parse(String(init.body)).operationId;
        return jsonResponse(completionSuccess(operationId));
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
  });

  afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); });

  it('renders the bank immediately with defaults while settings load in the background', async () => {
    const settingsRequest = deferredResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'white', qrManualInputEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return settingsRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    const { container } = render(<BankApp />);

    expect(screen.queryByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeNull();
    expect(screen.getByRole('heading', { name: '학급 은행' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '내 계좌' })).toBeTruthy();

    settingsRequest.resolve();
    expect(await screen.findByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).toContain('bg-[#FCFCFC]');
  });

  it('applies the selected green pastel theme to the bank shell with distinct primary actions', async () => {
    const { container } = render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).toContain('bg-[#DCF5C9]');
    expect(container.querySelector('[data-testid="bank-shell"]')?.getAttribute('style')).toContain('NanumBarunGothic');
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).not.toContain('bg-green-50');
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).not.toContain('bg-lime-50');
    expect(screen.queryByText('CLASS BANK')).toBeNull();
    expect(screen.getByText('- 내 계좌 버튼을 눌러 잔액과 거래 내역을 확인할 수 있어요.')).toBeTruthy();
    expect(screen.getByText('- 과제 완료 버튼을 눌러 과제를 확인하고 완료할 수 있어요.')).toBeTruthy();
    expect(screen.getByText('(※ 일부 과제는 허용된 학생만 완료할 수 있습니다.)')).toBeTruthy();
    expect(screen.queryByText('QR로 잔액을 확인하고 과제 보상을 받을 수 있어요.')).toBeNull();
    expect(screen.getByRole('button', { name: '내 계좌' }).className).toContain('bg-[#A5C78B]');
    expect(screen.getByRole('button', { name: '과제 완료' }).className).toContain('bg-[#DCF5C9]');
    expect(screen.getByRole('button', { name: '내 계좌' }).className).not.toContain('bg-[#DCF5C9]');
    expect(screen.getByRole('button', { name: '과제 완료' }).className).not.toContain('bg-[#A5C78B]');
    expect(screen.getByRole('button', { name: '내 계좌' }).className).not.toContain('bg-sky-500');
    expect(screen.getByRole('button', { name: '과제 완료' }).className).not.toContain('bg-emerald-500');
  });

  it('uses a darker but not pure-black shell for the black bank theme', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '검정 은행', currencyUnit: '별', themeColor: 'black', qrManualInputEnabled: true });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    const { container } = render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '검정 은행' })).toBeTruthy();
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).toContain('bg-[#1F1F1F]');
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).not.toContain('bg-slate-100');
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).not.toContain('bg-black');
  });

  it('keeps white and black bank theme action buttons readable and theme-colored', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '흰색 은행', currencyUnit: '별', themeColor: 'white', qrManualInputEnabled: true });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
    const { unmount } = render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '흰색 은행' })).toBeTruthy();
    const whiteBalanceButton = screen.getByRole('button', { name: '내 계좌' });
    const whiteTasksButton = screen.getByRole('button', { name: '과제 완료' });
    expect(whiteBalanceButton.className).toContain('bg-[#1F1F1F]');
    expect(whiteBalanceButton.className).toContain('text-[#FCFCFC]');
    expect(whiteBalanceButton.className).toContain('border-[#1F1F1F]');
    expect(whiteBalanceButton.className).not.toContain('text-sky-950');
    expect(whiteBalanceButton.className).not.toContain('border-sky-200');
    expect(whiteTasksButton.className).toContain('bg-white');
    expect(whiteTasksButton.className).toContain('text-[#1F1F1F]');
    expect(whiteTasksButton.className).toContain('border-[#1F1F1F]');
    expect(whiteTasksButton.className).not.toContain('text-indigo-950');
    expect(whiteTasksButton.className).not.toContain('border-indigo-300');
    unmount();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '검정 은행', currencyUnit: '별', themeColor: 'black', qrManualInputEnabled: true });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
    render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '검정 은행' })).toBeTruthy();
    const blackBalanceButton = screen.getByRole('button', { name: '내 계좌' });
    const blackTasksButton = screen.getByRole('button', { name: '과제 완료' });
    expect(blackBalanceButton.className).toContain('bg-[#FCFCFC]');
    expect(blackBalanceButton.className).toContain('text-[#1F1F1F]');
    expect(blackBalanceButton.className).toContain('border-[#FCFCFC]');
    expect(blackTasksButton.className).toContain('bg-[#2B2B2B]');
    expect(blackTasksButton.className).toContain('text-[#FCFCFC]');
    expect(blackTasksButton.className).toContain('border-[#FCFCFC]');
    expect(blackBalanceButton.className).not.toContain('text-sky-950');
    expect(blackTasksButton.className).not.toContain('text-indigo-950');
  });

  it('uses a blue-leaning low-saturation navy bank palette', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '남색 은행', currencyUnit: '별', themeColor: 'navy', qrManualInputEnabled: true });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
    const { container } = render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '남색 은행' })).toBeTruthy();
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).toContain('bg-[#DCE8F4]');
    expect(screen.queryByText('CLASS BANK')).toBeNull();
    expect(screen.getByRole('button', { name: '내 계좌' }).className).toContain('bg-[#7FA6C7]');
    expect(container.querySelector('[data-testid="bank-shell"]')?.className).not.toContain('bg-[#8F97CF]');
  });

  it('shows task rewards without any completion-count wording and uses a larger detail description', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();

    expect(await screen.findByRole('dialog', { name: '과제 완료' })).toBeTruthy();
    expect(document.body.textContent).toContain('보상 5별');
    expect(document.body.textContent).not.toContain('회까지');
    expect(document.body.textContent).not.toContain('가능 횟수');
    expect(document.body.textContent).not.toContain('가능횟수');

    fireEvent.click(screen.getByRole('button', { name: /책 10분 읽기/ }));
    expect(await screen.findByRole('dialog', { name: '책 10분 읽기' })).toBeTruthy();
    const description = screen.getByTestId('bank-task-description');
    expect(description.className).toContain('text-lg');
    expect(description.className).toContain('leading-relaxed');
    expect(document.body.textContent).toContain('보상5별');
    expect(document.body.textContent).not.toContain('회까지');
    expect(document.body.textContent).not.toContain('가능 횟수');
    expect(document.body.textContent).not.toContain('가능횟수');
    expect(document.body.textContent).not.toContain('학생당 1회');
    expect(document.body.textContent).not.toContain('완료 기준');
  });

  it('keeps black bank task-list cards readable on dark local backgrounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '검정 은행', currencyUnit: '별', themeColor: 'black', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') return jsonResponse(tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: false } })));
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
    render(<BankApp />);

    expect(await screen.findByRole('heading', { name: '검정 은행' })).toBeTruthy();
    await identifyTaskStudent();
    const taskButton = await screen.findByRole('button', { name: /책 10분 읽기/ });
    expect(taskButton.className).toContain('bg-[#2B2B2B]');
    expect(taskButton.className).toContain('text-[#FCFCFC]');
  });

  it('checks a student balance from the bank QR popup', async () => {
    render(<BankApp />);
    expect(await screen.findByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '내 계좌' }));
    expect(await screen.findByRole('dialog', { name: '내 계좌 QR 인식' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 내 계좌 확인' }));
    expect(await screen.findByRole('dialog', { name: '내 계좌' })).toBeTruthy();
    expect(document.body.textContent).toContain('김민준 학생의 현재 잔액은 12별입니다.');
    expect(screen.getByRole('heading', { name: '거래 내역 (3)' })).toBeTruthy();
    expect(document.body.textContent).toContain('-6별');
    expect(document.body.textContent).toContain('+5별');
    expect(document.body.textContent).toContain('연필 × 2');
    expect(document.body.textContent).not.toContain('T001');
    expect(screen.queryByRole('button', { name: /거래 취소/ })).toBeNull();
  });

  it('emphasizes the balance sentence and keeps recent transactions in a scrollable compact block', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '내 계좌' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 내 계좌 확인' }));

    expect(await screen.findByRole('dialog', { name: '내 계좌' })).toBeTruthy();
    const balanceSentence = screen.getByTestId('bank-balance-sentence');
    expect(balanceSentence.className).toContain('text-xl');
    expect(balanceSentence.className).toContain('sm:text-2xl');
    const transactionBlock = screen.getByTestId('bank-recent-transactions');
    expect(transactionBlock.className).toContain('max-h-72');
    expect(transactionBlock.className).toContain('overflow-y-auto');
    expect(transactionBlock.className).not.toContain('aspect-square');
    expect(transactionBlock.className).toContain('mx-auto');
    expect(transactionBlock.className).toContain('max-w-sm');
  });

  it('filters balance transactions between all, income, and expense tabs', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '내 계좌' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 내 계좌 확인' }));

    expect(await screen.findByRole('heading', { name: '거래 내역 (3)' })).toBeTruthy();
    expect(screen.getByText('연필 × 2')).toBeTruthy();
    expect(screen.getByText('책 읽기 × 1')).toBeTruthy();
    expect(screen.getByTestId('bank-transaction-amount-T003').className).toContain('text-sky-700');

    fireEvent.click(screen.getByRole('button', { name: '수입' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (1)' })).toBeTruthy();
    expect(screen.queryByText('연필 × 2')).toBeNull();
    expect(screen.getByText('책 읽기 × 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '지출' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (2)' })).toBeTruthy();
    expect(screen.getByText('연필 × 2')).toBeTruthy();
    expect(screen.getByText('지우개 × 1')).toBeTruthy();
    expect(screen.queryByText('책 읽기 × 1')).toBeNull();
  });

  it('shows a loading popup after recognizing a balance QR before the balance result', async () => {
    const balanceRequest = deferredResponse({ studentId: 'S001', name: '김민준', number: 1, balance: 12, transactions: [] });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') return jsonResponse(tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: false } })));
      if (url === '/api/bank/balance?studentId=S001') return balanceRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '내 계좌' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 내 계좌 확인' }));

    expect(await screen.findByRole('dialog', { name: '내 계좌 확인 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 내 계좌를 불러오는 중입니다.');
    balanceRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '내 계좌' })).toBeTruthy();
  });

  it('shows a loading popup while loading tasks from the bank home', async () => {
    const taskRequest = deferredResponse(tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: false } })));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') return taskRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    void identifyTaskStudent();

    expect(await screen.findByRole('dialog', { name: '과제 목록 불러오는 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('과제 목록을 불러오는 중입니다.');

    taskRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '과제 완료' })).toBeTruthy();
  });

  it('shows a loading popup while completing a task after QR recognition', async () => {
    const projected = tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: true } }));
    const completeRequest = deferredResponse(completionSuccess('operation-001', projected));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '별', themeColor: 'green', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') return jsonResponse(tasks.map((task) => ({ ...task, allowedStudentIds: ['S001'], studentStatus: { studentId: 'S001', assigned: true, completed: false } })));
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') return completeRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: /책 10분 읽기/ }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));

    expect(await screen.findByRole('dialog', { name: '과제 완료 처리 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('과제 완료를 기록하고 보상을 지급하는 중입니다.');

    completeRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
  });

  it('shows tasks, opens detail, completes with QR, and returns to detail on close', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    expect(await screen.findByRole('dialog', { name: '과제 완료' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /책 10분 읽기/ }));
    expect(await screen.findByRole('dialog', { name: '책 10분 읽기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/T001/complete', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
    expect(document.body.textContent).toContain('김민준 학생에게 5별 지급 완료');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('dialog', { name: '책 10분 읽기' })).toBeTruthy();
  });

  it('identifies the student before fetching and displays only authoritative current assignments', async () => {
    const projectedTasks = [
      { ...tasks[0], allowedStudentIds: [], currentCycle: { cycleId: 'cycle-1', startsAt: '2026-05-20T00:00:00.000Z', endsAt: '2026-05-27T00:00:00.000Z' }, studentStatus: { studentId: 'S 001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'T002', title: '배정 안 된 과제', allowedStudentIds: ['S 001'], currentCycle: { cycleId: 'cycle-1', startsAt: '2026-05-20T00:00:00.000Z', endsAt: null }, studentStatus: { studentId: 'S 001', assigned: false, completed: false } },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ bankTitle: '별빛 은행', currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S%20001') return jsonResponse(projectedTasks);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
    expect(await screen.findByRole('dialog', { name: '과제 완료 QR 인식' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S 001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));

    expect(await screen.findByRole('dialog', { name: '과제 완료' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/tasks?studentId=S%20001', expect.objectContaining({ cache: 'no-store' }));
    expect(screen.getByRole('button', { name: /책 10분 읽기/ })).toBeTruthy();
    expect(screen.queryByText('배정 안 된 과제')).toBeNull();
    expect(document.body.textContent).not.toContain('미완료');
    expect(document.body.textContent).toContain('기한: 없음');
    expect(document.body.textContent).toContain('반복: 없음');
    expect(document.body.textContent).not.toContain('현재 회차');
    expect(document.body.textContent).not.toContain('다음 초기화');
  });

  it('shows unmet prerequisite guidance and disables completion before sending a request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ bankTitle: '별빛 은행', currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/bank/tasks') return jsonResponse([]);
      if (url === '/api/tasks?studentId=S001') return jsonResponse([{
        ...tasks[0], studentStatus: { studentId: 'S001', assigned: true, completed: false },
        prerequisiteTitle: '먼저 할 일', prerequisiteStatus: 'REQUIRED',
        prerequisiteMessage: "선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요.",
      }]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    await screen.findByRole('dialog', { name: '과제 완료' });
    expect(document.body.textContent).toContain("선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요.");
    fireEvent.click(screen.getByRole('button', { name: /책 10분 읽기/ }));
    expect(screen.getByRole('button', { name: '완료하기' })).toHaveProperty('disabled', true);
    expect(fetch).not.toHaveBeenCalledWith('/api/tasks/T001/complete', expect.anything());
  });

  it('uses allowedStudentIds only as legacy assignment fallback and never guesses completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ bankTitle: '별빛 은행', currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') return jsonResponse([
        { ...tasks[0], allowedStudentIds: ['S001'] },
        { ...tasks[0], taskId: 'T002', title: '전체 허용으로 추측하면 안 됨', allowedStudentIds: [] },
      ]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));

    await screen.findByRole('dialog', { name: '과제 완료' });
    expect(screen.getByRole('button', { name: /책 10분 읽기/ })).toBeTruthy();
    expect(screen.queryByText('전체 허용으로 추측하면 안 됨')).toBeNull();
    expect(document.body.textContent).not.toContain('완료 정보 없음');
    expect(document.body.textContent).not.toContain('미완료');
    expect(document.body.textContent).not.toContain('완료됨');
  });

  it('ignores a stale task response when another student is identified', async () => {
    const studentA = deferredResponse([{ ...tasks[0], title: 'A 학생 과제', allowedStudentIds: ['A'], studentStatus: { studentId: 'A', assigned: true, completed: false } }]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ bankTitle: '별빛 은행', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=A') return studentA.response;
      if (url === '/api/tasks?studentId=B') return jsonResponse([{ ...tasks[0], title: 'B 학생 과제', allowedStudentIds: ['B'], studentStatus: { studentId: 'B', assigned: true, completed: false } }]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
    const input = await screen.findByLabelText('QR 값 직접 입력');
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));
    fireEvent.change(input, { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));

    expect(await screen.findByRole('button', { name: /B 학생 과제/ })).toBeTruthy();
    studentA.resolve();
    await waitFor(() => expect(screen.queryByText('A 학생 과제')).toBeNull());
    expect(screen.getByRole('button', { name: /B 학생 과제/ })).toBeTruthy();
  });

  it('uses the completion response as the authoritative student projection without an extra GET', async () => {
    const before = { ...tasks[0], allowedStudentIds: ['S001'], currentCycle: { cycleId: 'cycle-1', startsAt: '2026-05-20T00:00:00.000Z', endsAt: '2026-05-27T00:00:00.000Z' }, studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const after = { ...before, studentStatus: { ...before.studentStatus, completed: true } };
    let studentFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/settings') return jsonResponse({ bankTitle: '별빛 은행', currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/tasks?studentId=S001') { studentFetches += 1; return jsonResponse([before]); }
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') return jsonResponse(completionSuccess('operation-001', [after], before));
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));
    fireEvent.click(await screen.findByRole('button', { name: /책 10분 읽기/ }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));

    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
    expect(studentFetches).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const refreshedDetail = await screen.findByRole('dialog', { name: '책 10분 읽기' });
    expect(within(refreshedDetail).getByText('완료됨').className).toContain('sr-only');
    expect(screen.queryByRole('button', { name: '완료하기' })).toBeNull();
    fireEvent.click(within(refreshedDetail).getByRole('button', { name: '닫기' }));
    expect(await screen.findByText('이름: 김민준')).toBeTruthy();
  });

  it('prevents a second completion while the same operation response is still pending', async () => {
    const before = { ...tasks[0], studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const after = { ...before, studentStatus: { ...before.studentStatus, completed: true } };
    const complete = deferredResponse(completionSuccess('operation-001', [after], before));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?studentId=S001') return jsonResponse([before]);
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') return complete.response;
      return base(input, init);
    });

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    expect(await screen.findByRole('dialog', { name: '과제 완료 처리 중' })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/api/tasks/T001/complete' && init?.method === 'POST')).toHaveLength(1);
    complete.resolve();
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
  });

  it('starts a five-task linked carousel on the first incomplete third slide and exposes its indicator', async () => {
    const linkedTasks = Array.from({ length: 5 }, (_, index) => ({
      ...tasks[0],
      taskId: `C${index + 1}`,
      title: `연결 과제 ${index + 1}`,
      sortOrder: index + 1,
      prerequisiteTaskId: index === 0 ? undefined : `C${index}`,
      studentStatus: { studentId: 'S001', assigned: true, completed: index < 2 },
    }));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse({ bankTitle: '검정 은행', currencyUnit: '별', themeColor: 'black', qrManualInputEnabled: true });
      if (String(input) === '/api/tasks?studentId=S001') return jsonResponse(linkedTasks);
      return base(input, init);
    });

    render(<BankApp />);
    await screen.findByRole('heading', { name: '검정 은행' });
    await identifyTaskStudent();

    const carousel = await screen.findByRole('region', { name: '연결 과제 1 연결 과제 묶음' });
    expect(within(carousel).getByRole('group', { name: '3 / 5: 연결 과제 3' })).toBeTruthy();
    expect(within(carousel).getByRole('button', { name: '연결 과제 3' })).toBeTruthy();
    expect(within(carousel).queryByRole('button', { name: '연결 과제 2' })).toBeNull();
    const inactiveSlide = carousel.querySelector('[aria-label="2 / 5: 연결 과제 2"]');
    const activeSlide = carousel.querySelector('[aria-label="3 / 5: 연결 과제 3"]');
    expect(inactiveSlide?.hasAttribute('inert')).toBe(true);
    expect(activeSlide?.hasAttribute('inert')).toBe(false);
    const indicator = within(carousel).getByTestId('task-carousel-indicator');
    expect(carousel.className).toContain('relative');
    expect(indicator.className).toContain('absolute');
    expect(indicator.className).toContain('bottom-');
    const activeIndicator = within(carousel).getByRole('button', { name: '3번째 과제 보기' });
    expect(activeIndicator.getAttribute('aria-current')).toBe('true');
    expect(activeIndicator.className).toContain('h-8');
    expect(activeIndicator.querySelector('span')?.className).toContain('h-2');
    expect(activeIndicator.querySelector('span')?.className).toContain('rounded-full');
    expect(activeIndicator.querySelector('span')?.className).toContain('bg-white');
    expect(activeIndicator.className).toContain('focus-visible:outline-2');
    expect(carousel.textContent).not.toContain('○');
  });

  it('navigates a linked task carousel with next and indicator controls', async () => {
    const linkedTasks = Array.from({ length: 3 }, (_, index) => ({
      ...tasks[0], taskId: `N${index + 1}`, title: `탐색 과제 ${index + 1}`, sortOrder: index + 1,
      prerequisiteTaskId: index ? `N${index}` : undefined,
      studentStatus: { studentId: 'S001', assigned: true, completed: false },
    }));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(linkedTasks) : base(input, init));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const carousel = await screen.findByRole('region', { name: '탐색 과제 1 연결 과제 묶음' });
    fireEvent.click(within(carousel).getByRole('button', { name: '다음 과제' }));
    expect(within(carousel).getByRole('button', { name: '탐색 과제 2' })).toBeTruthy();
    expect(within(carousel).getByRole('button', { name: '2번째 과제 보기' }).getAttribute('aria-current')).toBe('true');
    const previousArrow = within(carousel).getByRole('button', { name: '이전 과제' });
    const nextArrow = within(carousel).getByRole('button', { name: '다음 과제' });
    expect(previousArrow.querySelector('path')?.getAttribute('d')).toContain('H5');
    expect(nextArrow.querySelector('path')?.getAttribute('d')).toContain('h14');
    fireEvent.click(within(carousel).getByRole('button', { name: '3번째 과제 보기' }));
    expect(within(carousel).getByRole('button', { name: '탐색 과제 3' })).toBeTruthy();
    expect(within(carousel).getByRole('button', { name: '이전 과제' })).toBeTruthy();
  });

  it('makes every linked-task slide and card stretch to the carousel height', async () => {
    const linkedTasks = [
      { ...tasks[0], taskId: 'HEIGHT1', title: '짧은 과제', description: '짧음', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'HEIGHT2', title: '두 줄 이상으로 길어질 수 있는 아주 긴 과제 제목', description: '긴 설명', prerequisiteTaskId: 'HEIGHT1', dueAt: '2030-01-02T03:30:00.000Z', recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '09:00' }, studentStatus: { studentId: 'S001', assigned: true, completed: false } },
    ];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(linkedTasks) : base(input, init));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();

    const carousel = await screen.findByRole('region', { name: '짧은 과제 연결 과제 묶음' });
    const scroller = carousel.querySelector('[data-testid="task-carousel-scroller"]');
    const slides = Array.from(carousel.querySelectorAll('[data-testid="task-carousel-slide"]'));
    expect(scroller?.className).toContain('items-stretch');
    expect(slides).toHaveLength(2);
    for (const slide of slides) {
      expect(slide.className).toContain('flex');
      const slideButton = slide.querySelector('button');
      expect(slideButton?.className).toContain('h-full');
      expect(slideButton?.className).not.toContain('pb-12');
    }
  });

  it('returns from a linked-task detail to the same active slide and vertical list position', async () => {
    const linkedTasks = Array.from({ length: 3 }, (_, index) => ({
      ...tasks[0], taskId: `ROUND${index + 1}`, title: `왕복 과제 ${index + 1}`,
      prerequisiteTaskId: index ? `ROUND${index}` : undefined,
      studentStatus: { studentId: 'S001', assigned: true, completed: false },
    }));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(linkedTasks) : base(input, init));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const listBeforeDetail = await screen.findByRole('dialog', { name: '과제 완료' });
    listBeforeDetail.scrollTop = 240;
    fireEvent.scroll(listBeforeDetail);
    let carousel = await screen.findByRole('region', { name: '왕복 과제 1 연결 과제 묶음' });
    fireEvent.click(within(carousel).getByRole('button', { name: '3번째 과제 보기' }));
    fireEvent.click(within(carousel).getByRole('button', { name: '왕복 과제 3' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '왕복 과제 3' })).getByRole('button', { name: '닫기' }));

    carousel = await screen.findByRole('region', { name: '왕복 과제 1 연결 과제 묶음' });
    expect(screen.getByRole('dialog', { name: '과제 완료' }).scrollTop).toBe(240);
    expect(within(carousel).getByRole('button', { name: '왕복 과제 3' })).toBeTruthy();
    expect(within(carousel).getByRole('button', { name: '3번째 과제 보기' }).getAttribute('aria-current')).toBe('true');
  });

  it('returns from a completed-task detail to that completed card instead of the first incomplete slide', async () => {
    const linkedTasks = [
      { ...tasks[0], taskId: 'COMPLETE1', title: '미완료 첫째', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'COMPLETE2', title: '완료 둘째', prerequisiteTaskId: 'COMPLETE1', studentStatus: { studentId: 'S001', assigned: true, completed: true } },
    ];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(linkedTasks) : base(input, init));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    let carousel = await screen.findByRole('region', { name: '미완료 첫째 연결 과제 묶음' });
    fireEvent.click(within(carousel).getByRole('button', { name: '2번째 과제 보기' }));
    fireEvent.click(within(carousel).getByRole('button', { name: '완료 둘째, 완료됨' }));
    const detail = await screen.findByRole('dialog', { name: '완료 둘째' });
    expect(within(detail).queryByRole('button', { name: '완료하기' })).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: '닫기' }));

    carousel = await screen.findByRole('region', { name: '미완료 첫째 연결 과제 묶음' });
    expect(within(carousel).getByRole('button', { name: '완료 둘째, 완료됨' })).toBeTruthy();
    expect(within(carousel).getByRole('button', { name: '2번째 과제 보기' }).getAttribute('aria-current')).toBe('true');
  });

  it('renders a singleton task without carousel controls or an indicator', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const taskList = await screen.findByRole('dialog', { name: '과제 완료' });
    expect(within(taskList).getByRole('button', { name: '책 10분 읽기' })).toBeTruthy();
    expect(within(taskList).queryByRole('button', { name: '다음 과제' })).toBeNull();
    expect(within(taskList).queryByRole('button', { name: '이전 과제' })).toBeNull();
    expect(within(taskList).queryByRole('button', { name: '1번째 과제 보기' })).toBeNull();
  });

  it('dims a locked task card but still opens its detail with completion disabled', async () => {
    const locked = { ...tasks[0], taskId: 'LOCKED', title: '잠긴 과제', prerequisiteStatus: 'REQUIRED', prerequisiteMessage: '먼저 선행 과제를 완료하세요.', studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse([locked]) : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const card = await screen.findByRole('button', { name: '잠긴 과제, 완료 불가' });
    expect(card.className).not.toContain('brightness-75');
    expect(card.className).not.toContain('opacity-70');
    expect(card.className).not.toContain('pb-12');
    expect(within(card).getByTestId('task-card-content').className).toContain('opacity-60');
    const lockPill = within(card).getByText('선행 완료 필요');
    expect(lockPill.className).toContain('absolute');
    expect(lockPill.className).toContain('top-3');
    expect(lockPill.className).toContain('right-3');
    expect(lockPill.className).not.toContain('bottom-');
    expect(within(card).getByText('잠긴 과제').className).toContain('max-w-[calc(100%-7rem)]');
    expect(card.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(card).getByText('먼저 선행 과제를 완료하세요.').className).toContain('sr-only');
    fireEvent.click(card);
    expect(await screen.findByRole('dialog', { name: '잠긴 과제' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '완료하기' })).toHaveProperty('disabled', true);
  });

  it('dims completed cards with a filled unrotated pill and removes inline completion metadata', async () => {
    const completed = { ...tasks[0], title: '끝낸 과제', studentStatus: { studentId: 'S001', assigned: true, completed: true } };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse({ bankTitle: '검정 은행', currencyUnit: '별', themeColor: 'black', qrManualInputEnabled: true });
      if (String(input) === '/api/tasks?studentId=S001') return jsonResponse([completed]);
      return base(input, init);
    });
    render(<BankApp />);
    await screen.findByRole('heading', { name: '검정 은행' });
    await identifyTaskStudent();
    const card = await screen.findByRole('button', { name: '끝낸 과제, 완료됨' });
    expect(card.className).not.toContain('brightness-75');
    expect(card.className).not.toContain('opacity-70');
    expect(within(card).getByTestId('task-card-content').className).not.toContain('opacity-60');
    const completedOverlay = within(card).getByTestId('task-card-completed-overlay');
    expect(completedOverlay.className).toContain('absolute');
    expect(completedOverlay.className).toContain('inset-0');
    expect(completedOverlay.className).toContain('bg-black/');
    const stamp = within(card).getByText('완료됨');
    expect(stamp.className).toContain('rounded-full');
    expect(stamp.className).toContain('bg-emerald-700');
    expect(stamp.className).toContain('text-white');
    expect(stamp.className).toContain('top-3');
    expect(stamp.className).not.toContain('rotate-');
    expect(stamp.className).not.toContain('border-4');
    expect(card.textContent).toContain('보상 5별');
    expect(card.textContent).not.toMatch(/·\s*(완료됨|미완료|완료 정보 없음)/);
    fireEvent.click(card);
    const detail = await screen.findByRole('dialog', { name: '끝낸 과제' });
    expect(within(detail).queryByRole('button', { name: '완료하기' })).toBeNull();
    expect(within(detail).getByText('완료됨').className).toContain('sr-only');
  });

  it('keeps partially complete groups before all-complete groups without reordering chain slides', async () => {
    const projected = [
      { ...tasks[0], taskId: 'DONE', title: '완료 단독', sortOrder: 1, studentStatus: { studentId: 'S001', assigned: true, completed: true } },
      { ...tasks[0], taskId: 'P1', title: '부분 첫째', sortOrder: 20, studentStatus: { studentId: 'S001', assigned: true, completed: true } },
      { ...tasks[0], taskId: 'P2', title: '부분 둘째', sortOrder: 10, prerequisiteTaskId: 'P1', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
    ];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(projected) : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const dialog = await screen.findByRole('dialog', { name: '과제 완료' });
    const partial = within(dialog).getByRole('region', { name: '부분 첫째 연결 과제 묶음' });
    const complete = within(dialog).getByRole('button', { name: '완료 단독, 완료됨' });
    expect(partial.compareDocumentPosition(complete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(partial).getByRole('group', { name: '2 / 2: 부분 둘째' })).toBeTruthy();
    fireEvent.click(within(partial).getByRole('button', { name: '1번째 과제 보기' }));
    const completedSlide = within(partial).getByRole('button', { name: '부분 첫째, 완료됨' });
    expect(within(completedSlide).getByTestId('task-card-completed-overlay')).toBeTruthy();
    fireEvent.click(within(partial).getByRole('button', { name: '2번째 과제 보기' }));
    const incompleteSlide = within(partial).getByRole('button', { name: '부분 둘째' });
    expect(within(incompleteSlide).queryByTestId('task-card-completed-overlay')).toBeNull();
  });

  it('replaces the whole refreshed projection, unlocks the next task, and recalculates the active slide', async () => {
    const first = { ...tasks[0], taskId: 'R1', title: '새로고침 첫째', sortOrder: 1, studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const second = { ...tasks[0], taskId: 'R2', title: '새로고침 둘째', sortOrder: 2, prerequisiteTaskId: 'R1', prerequisiteStatus: 'REQUIRED' as const, prerequisiteMessage: '첫째를 먼저 완료하세요.', studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const refreshed = [
      { ...first, studentStatus: { ...first.studentStatus, completed: true } },
      { ...second, prerequisiteStatus: 'SATISFIED' as const, prerequisiteMessage: undefined },
    ];
    let projections = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/bank/student?studentId=')) return jsonResponse({ studentId: decodeURIComponent(url.split('=').at(-1) ?? ''), name: url.includes('studentId=B') ? '학생 B' : url.includes('studentId=A') ? '학생 A' : '김민준' });
      if (url === '/api/tasks?studentId=S001') { projections += 1; return jsonResponse([first, second]); }
      if (url === '/api/tasks/R1/complete' && init?.method === 'POST') return jsonResponse(completionSuccess('operation-001', refreshed, first));
      return base(input, init);
    });
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '새로고침 첫째' }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    await screen.findByRole('dialog', { name: '과제 완료 성공' });
    expect(projections).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const refreshedDetail = await screen.findByRole('dialog', { name: '새로고침 첫째' });
    expect(within(refreshedDetail).queryByRole('button', { name: '완료하기' })).toBeNull();
    fireEvent.click(within(refreshedDetail).getByRole('button', { name: '닫기' }));
    const carousel = await screen.findByRole('region', { name: '새로고침 첫째 연결 과제 묶음' });
    const next = within(carousel).getByRole('button', { name: '새로고침 둘째' });
    expect(next.className).not.toContain('brightness-75');
    fireEvent.click(next);
    expect(screen.getByRole('button', { name: '완료하기' })).toHaveProperty('disabled', false);
  });

  it('keeps the bank home within one dynamic viewport and scrolls only the public task body', async () => {
    const manyPublicTasks = Array.from({ length: 18 }, (_, index) => ({
      ...publicTasks[0],
      taskId: `PUB${index + 1}`,
      title: `공개 과제 ${index + 1}`,
      sortOrder: index + 1,
    }));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/bank/tasks') return jsonResponse(manyPublicTasks);
      return base(input, init);
    });

    const { container } = render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    expect(await screen.findByRole('button', { name: /공개 과제 18/ })).toBeTruthy();

    const shell = container.querySelector('[data-testid="bank-shell"]');
    const home = screen.getByTestId('bank-home-layout');
    const header = screen.getByTestId('bank-home-header');
    const catalog = screen.getByRole('region', { name: '공개 과제 목록' });
    const taskBody = screen.getByTestId('public-task-list-body');
    const actions = screen.getByTestId('bank-home-actions');

    expect(shell?.className).toContain('h-[100dvh]');
    expect(shell?.className).toContain('overflow-hidden');
    expect(home.className).toContain('h-full');
    expect(home.className).toContain('min-h-0');
    expect(header.className).toContain('shrink-0');
    expect(catalog.className).toContain('min-h-0');
    expect(catalog.className).toContain('flex-1');
    expect(taskBody.className).toContain('min-h-0');
    expect(taskBody.className).toContain('overflow-y-auto');
    expect(taskBody.className).toContain('overscroll-contain');
    expect(actions.className).toContain('shrink-0');
    expect(home.className).not.toContain('overflow-y-auto');
    expect(catalog.className).not.toContain('overflow-y-auto');
    expect(actions.className).not.toContain('overflow-y-auto');
  });

  it('always keeps bank home actions in two columns with compact mobile and roomier sm sizing', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });

    const actions = screen.getByTestId('bank-home-actions');
    expect(actions.className).toContain('grid-cols-2');
    expect(actions.className).not.toContain('sm:grid-cols-2');

    for (const name of ['내 계좌', '과제 완료']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('py-4');
      expect(button.className).toContain('text-lg');
      expect(button.className).toContain('sm:py-8');
      expect(button.className).toContain('sm:text-3xl');
    }
  });

  it('loads the public catalog independently above actions and opens a read-only student-safe detail', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    const catalog = await screen.findByRole('region', { name: '공개 과제 목록' });
    const publicCard = within(catalog).getByRole('button', { name: /공개 독서 과제/ });
    expect(catalog.compareDocumentPosition(screen.getByRole('button', { name: '내 계좌' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(publicCard.textContent).toContain('기한: 2030년 1월 2일 오후 12:30까지');
    expect(publicCard.textContent).toContain('반복: 매주 월, 목');
    expect(catalog.textContent).not.toMatch(/현재 회차|다음 초기화|자연 경계|studentId|allowedStudentIds/);
    fireEvent.click(publicCard);
    const detail = screen.getByRole('dialog', { name: '공개 독서 과제' });
    expect(within(detail).getByText('누구나 볼 수 있는 설명')).toBeTruthy();
    expect(within(detail).getByText(/보상.*8별/)).toBeTruthy();
    expect(within(detail).getByText('선행 과제: 준비 과제')).toBeTruthy();
    expect(within(detail).getByText('준비 과제를 먼저 완료해 주세요.')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /완료/ })).toBeNull();
  });

  it('shows a retryable public catalog error without blocking bank actions', async () => {
    let attempts = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/bank/tasks') return attempts++ === 0 ? jsonResponse({ error: '공개 목록 오류' }, { status: 503 }) : jsonResponse(publicTasks);
      return base(input, init);
    });
    render(<BankApp />);
    expect(await screen.findByText('공개 목록 오류')).toBeTruthy();
    expect(screen.getByRole('button', { name: '내 계좌' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '공개 과제 다시 시도' }));
    expect(await screen.findByText('공개 독서 과제')).toBeTruthy();
  });

  it('uses one themed surface with sibling SVG edge controls hidden on touch', async () => {
    const linkedTasks = Array.from({ length: 2 }, (_, index) => ({
      ...tasks[0], taskId: `SURFACE${index + 1}`, title: `표면 과제 ${index + 1}`,
      prerequisiteTaskId: index ? 'SURFACE1' : undefined,
      studentStatus: { studentId: 'S001', assigned: true, completed: false },
    }));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks?studentId=S001' ? jsonResponse(linkedTasks) : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();

    const carousel = await screen.findByRole('region', { name: '표면 과제 1 연결 과제 묶음' });
    expect(carousel.className).toContain('rounded-2xl');
    expect(carousel.className).toContain('border');
    const activeCard = within(carousel).getByRole('button', { name: '표면 과제 1' });
    expect(activeCard.className).not.toContain('rounded-2xl');
    expect(activeCard.className).not.toContain('border-slate-200');
    for (const name of ['이전 과제', '다음 과제']) {
      const arrow = within(carousel).getByRole('button', { name });
      expect(arrow.querySelector('svg')).toBeTruthy();
      expect(arrow.className).toContain('hidden');
      expect(arrow.className).toContain('[@media(hover:hover)_and_(pointer:fine)]:flex');
      expect(arrow.className).toContain('hover:opacity-100');
      expect(activeCard.contains(arrow)).toBe(false);
    }
  });

  it('renders public linked tasks as a carousel and public singleton with working details', async () => {
    const catalog = [
      { ...publicTasks[0], taskId: 'P1', title: '공개 연결 1', sortOrder: 1 },
      { ...publicTasks[0], taskId: 'P2', title: '공개 연결 2', sortOrder: 2, prerequisiteTaskId: 'P1', prerequisiteStatus: 'REQUIRED' as const, prerequisiteMessage: '학생별 잠금처럼 보이면 안 됩니다.' },
      { ...publicTasks[0], taskId: 'ONLY', title: '공개 단독', sortOrder: 3 },
    ];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/bank/tasks' ? jsonResponse(catalog) : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });

    const publicRegion = await screen.findByRole('region', { name: '공개 연결 1 연결 과제 묶음' });
    expect(within(publicRegion).getByRole('button', { name: '공개 연결 1' })).toBeTruthy();
    fireEvent.click(within(publicRegion).getByRole('button', { name: '다음 과제' }));
    const publicSecond = within(publicRegion).getByRole('button', { name: '공개 연결 2' });
    expect(publicSecond.className).not.toContain('opacity-70');
    expect(within(publicRegion).queryByRole('button', { name: '공개 연결 2, 완료 불가' })).toBeNull();
    fireEvent.click(publicSecond);
    expect(await screen.findByRole('dialog', { name: '공개 연결 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '공개 단독' }));
    expect(await screen.findByRole('dialog', { name: '공개 단독' })).toBeTruthy();
  });

  it('shows the student name under the completion title without QR or rescan controls', async () => {
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const dialog = await screen.findByRole('dialog', { name: '과제 완료' });
    expect(within(dialog).getByText('이름: 김민준')).toBeTruthy();
    expect(dialog.textContent).not.toContain('학생 QR:');
    expect(within(dialog).queryByRole('button', { name: '다른 학생 QR 인식' })).toBeNull();
  });

  it('does not open a successful task list when the name lookup fails', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/bank/student?studentId=S001'
      ? jsonResponse({ error: '학생 이름을 불러오지 못했습니다.' }, { status: 503 })
      : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    expect(await screen.findByText('학생 이름을 불러오지 못했습니다.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '과제 완료' })).toBeNull();
  });

  it.each([
    ['mismatched student ID', { studentId: 'OTHER', name: '다른 학생' }],
    ['blank student name', { studentId: 'S001', name: '   ' }],
    ['non-string student name', { studentId: 'S001', name: { unsafe: true } }],
  ])('rejects an invalid student identity response: %s', async (_label, identity) => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/bank/student?studentId=S001'
      ? jsonResponse(identity)
      : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    expect(await screen.findByText('학생 정보를 확인하지 못했습니다.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '과제 완료' })).toBeNull();
  });

  it('atomically ignores stale task and name responses from an earlier student', async () => {
    const tasksA = deferredResponse([{ ...tasks[0], title: '느린 A 과제', allowedStudentIds: ['A'], studentStatus: { studentId: 'A', assigned: true, completed: false } }]);
    const nameA = deferredResponse({ studentId: 'A', name: '느린 A 이름' });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?studentId=A') return tasksA.response;
      if (url === '/api/bank/student?studentId=A') return nameA.response;
      if (url === '/api/tasks?studentId=B') return jsonResponse([{ ...tasks[0], title: '빠른 B 과제', allowedStudentIds: ['B'], studentStatus: { studentId: 'B', assigned: true, completed: false } }]);
      if (url === '/api/bank/student?studentId=B') return jsonResponse({ studentId: 'B', name: '빠른 B 이름' });
      return base(input, init);
    });
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    fireEvent.click(screen.getByRole('button', { name: '과제 완료' }));
    const input = await screen.findByLabelText('QR 값 직접 입력');
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));
    fireEvent.change(input, { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 과제 완료' }));
    expect(await screen.findByText('이름: 빠른 B 이름')).toBeTruthy();
    tasksA.resolve(); nameA.resolve();
    await waitFor(() => expect(screen.queryByText('느린 A 이름')).toBeNull());
    expect(screen.getByText('이름: 빠른 B 이름')).toBeTruthy();
    expect(screen.getByRole('button', { name: '빠른 B 과제' })).toBeTruthy();
  });

  it('keeps the shell usable with default settings and a compact retry banner when settings are unavailable', async () => {
    let attempts = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/settings'
      ? attempts++ === 0
        ? jsonResponse({ error: '설정을 불러올 수 없습니다.', code: 'SETTINGS_UNAVAILABLE' }, { status: 503 })
        : jsonResponse({ bankTitle: '복구된 은행', currencyUnit: '별', qrManualInputEnabled: true })
      : base(input, init));

    render(<BankApp />);
    expect(await screen.findByRole('heading', { name: '학급 은행' })).toBeTruthy();
    expect(screen.getByRole('status', { name: '설정 불러오기 실패' }).textContent).toContain('기본 설정으로 표시하고 있습니다.');
    expect(screen.getByRole('button', { name: '설정 다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '과제 완료' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '설정 다시 시도' }));
    expect(await screen.findByRole('heading', { name: '복구된 은행' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: '설정 불러오기 실패' })).toBeNull();
  });

  it('allows the same scanned student ID to retry after temporary student-data unavailability without leaking prior identity', async () => {
    let studentAttempts = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/bank/student?studentId=S001') {
        studentAttempts += 1;
        return studentAttempts === 1
          ? jsonResponse({ error: '학생 정보를 잠시 불러올 수 없습니다.', code: 'STUDENT_DATA_UNAVAILABLE' }, { status: 503 })
          : jsonResponse({ studentId: 'S001', name: '김민준' });
      }
      return base(input, init);
    });

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const failure = await screen.findByRole('dialog', { name: '학생 정보 일시 오류' });
    expect(within(failure).getByText('학생 정보를 잠시 불러올 수 없습니다.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('이름: 김민준');
    expect(within(failure).queryByLabelText('QR 값 직접 입력')).toBeNull();
    fireEvent.click(within(failure).getByRole('button', { name: '같은 학생 다시 시도' }));
    expect(await screen.findByText('이름: 김민준')).toBeTruthy();
    expect(studentAttempts).toBe(2);
  });

  it('shows permanent missing only for STUDENT_NOT_FOUND and does not offer an identity retry', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/bank/student?studentId=S001'
      ? jsonResponse({ error: '등록되지 않은 학생입니다.', code: 'STUDENT_NOT_FOUND' }, { status: 404 })
      : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const failure = await screen.findByRole('dialog', { name: '학생 확인 실패' });
    expect(within(failure).getByText('등록되지 않은 학생입니다.')).toBeTruthy();
    expect(within(failure).queryByRole('button', { name: '같은 학생 다시 시도' })).toBeNull();
  });

  it('blocks other tasks after an unknown outcome and only rechecks the original task with the same operation ID', async () => {
    const first = { ...tasks[0], studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const second = { ...tasks[0], taskId: 'T002', title: '다른 과제', sortOrder: 2, studentStatus: { studentId: 'S001', assigned: true, completed: false } };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?studentId=S001') return jsonResponse([first, second]);
      if (url === '/api/tasks/T001/complete' && init?.method === 'POST') {
        return jsonResponse({ error: '완료 상태를 확인하고 있습니다.', code: 'COMPLETION_STATUS_UNKNOWN', retryable: true }, { status: 503 });
      }
      return base(input, init);
    });

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const unknown = await screen.findByRole('dialog', { name: '완료 상태 확인 필요' });
    fireEvent.click(within(unknown).getByRole('button', { name: '과제 목록 유지' }));

    fireEvent.click(screen.getByRole('button', { name: '다른 과제' }));
    let detail = await screen.findByRole('dialog', { name: '다른 과제' });
    expect(within(detail).queryByRole('button', { name: '완료하기' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: '상태 다시 확인' })).toBeNull();
    expect(within(detail).getByText(/확인 중인 다른 과제 완료 작업/)).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: '닫기' }));
    const retainedList = await screen.findByRole('dialog', { name: '과제 완료' });

    fireEvent.click(within(retainedList).getByRole('button', { name: '책 10분 읽기' }));
    detail = await screen.findByRole('dialog', { name: '책 10분 읽기' });
    fireEvent.click(within(detail).getByRole('button', { name: '상태 다시 확인' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete')).toHaveLength(4));
    const operationIds = vi.mocked(fetch).mock.calls
      .filter(([url]) => String(url) === '/api/tasks/T001/complete')
      .map(([, init]) => JSON.parse(String(init?.body)).operationId);
    expect(operationIds).toEqual(['operation-001', 'operation-001', 'operation-001', 'operation-001']);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T002/complete')).toHaveLength(0);
  });

  it.each([
    ['COMPLETION_OPERATION_CONFLICT', '완료 요청 충돌'],
    ['COMPLETION_RECONCILIATION_REQUIRED', '수동 확인 필요'],
  ])('treats %s as terminal without automatic or manual completion retry', async (code, dialogName) => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks/T001/complete' && init?.method === 'POST'
      ? jsonResponse({ error: code === 'COMPLETION_OPERATION_CONFLICT' ? '같은 완료 요청의 내용이 일치하지 않습니다.' : '완료 상태를 자동으로 판단할 수 없습니다.', code, retryable: false }, { status: 409 })
      : base(input, init));

    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));

    const failure = await screen.findByRole('dialog', { name: dialogName });
    expect(within(failure).queryByRole('button', { name: '상태 다시 확인' })).toBeNull();
    expect(within(failure).queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete')).toHaveLength(1);
    fireEvent.click(within(failure).getByRole('button', { name: '과제 목록 유지' }));
    expect(await screen.findByText('이름: 김민준')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기' }));
    expect(within(await screen.findByRole('dialog', { name: '책 10분 읽기' })).queryByRole('button', { name: '완료하기' })).toBeNull();
  });

  it('changes delayed completion copy and guards duplicate completion clicks with one operation ID', async () => {
    const complete = deferredResponse(completionSuccess('operation-001'));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks/T001/complete' && init?.method === 'POST'
      ? complete.response
      : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    vi.useFakeTimers();
    const completeButton = screen.getByRole('button', { name: '완료하기' });
    fireEvent.click(completeButton);
    fireEvent.click(completeButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(screen.getByText('처리 상태를 확인하고 있습니다')).toBeTruthy();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ studentId: 'S001', operationId: 'operation-001' });
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    complete.resolve();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
  });

  it('recovers a non-JSON gateway response by retrying the same POST and never refreshes tasks with GET', async () => {
    let completions = 0;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks/T001/complete' && init?.method === 'POST') {
        completions += 1;
        return completions === 1
          ? new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
          : jsonResponse(completionSuccess('operation-001'));
      }
      return base(input, init);
    });
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await screen.findByRole('dialog', { name: '과제 완료 성공' })).toBeTruthy();
    const completionCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete');
    expect(completionCalls).toHaveLength(2);
    expect(completionCalls.map(([, init]) => JSON.parse(String(init?.body)).operationId)).toEqual(['operation-001', 'operation-001']);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks?studentId=S001')).toHaveLength(1);
  });

  it('retains the projection and uses the same operation ID for manual verification after malformed success retries', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/tasks/T001/complete' && init?.method === 'POST'
      ? jsonResponse({ task: tasks[0], student: { studentId: 'S001', name: '김민준' }, tasks: [null], operation: { operationId: 'operation-001', state: 'SUCCESS' } })
      : base(input, init));
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    fireEvent.click(await screen.findByRole('button', { name: '책 10분 읽기' }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const unknown = await screen.findByRole('dialog', { name: '완료 상태 확인 필요' });
    expect(within(unknown).getByText(/결과를 확인하지 못했습니다/)).toBeTruthy();
    const beforeManual = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete');
    expect(beforeManual).toHaveLength(3);
    fireEvent.click(within(unknown).getByRole('button', { name: '상태 다시 확인' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete')).toHaveLength(4));
    const unknownAgain = await screen.findByRole('dialog', { name: '완료 상태 확인 필요' });
    fireEvent.click(within(unknownAgain).getByRole('button', { name: '과제 목록 유지' }));
    const retainedList = await screen.findByRole('dialog', { name: '과제 완료' });
    expect(within(retainedList).getByRole('button', { name: '책 10분 읽기' })).toBeTruthy();
    const bodies = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks/T001/complete').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.every((body) => body.operationId === 'operation-001')).toBe(true);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('atomically adopts the success projection, preserves unrelated carousel selection, and safely returns to the retained list when the selected task disappeared', async () => {
    const before = [
      { ...tasks[0], taskId: 'A1', title: '대상 첫째', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'A2', title: '대상 둘째', prerequisiteTaskId: 'A1', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'B1', title: '별도 첫째', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
      { ...tasks[0], taskId: 'B2', title: '별도 둘째', prerequisiteTaskId: 'B1', studentStatus: { studentId: 'S001', assigned: true, completed: false } },
    ];
    const after = before.filter((task) => task.taskId !== 'A1');
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?studentId=S001') return jsonResponse(before);
      if (String(input) === '/api/tasks/A1/complete' && init?.method === 'POST') return jsonResponse(completionSuccess('operation-001', after, before[0]));
      return base(input, init);
    });
    render(<BankApp />);
    await screen.findByRole('heading', { name: '별빛 은행' });
    await identifyTaskStudent();
    const unrelated = await screen.findByRole('region', { name: '별도 첫째 연결 과제 묶음' });
    fireEvent.click(within(unrelated).getByRole('button', { name: '2번째 과제 보기' }));
    fireEvent.click(screen.getByRole('button', { name: '대상 첫째' }));
    fireEvent.click(screen.getByRole('button', { name: '완료하기' }));
    const success = await screen.findByRole('dialog', { name: '과제 완료 성공' });
    fireEvent.click(within(success).getByRole('button', { name: '닫기' }));
    const list = await screen.findByRole('dialog', { name: '과제 완료' });
    expect(within(list).queryByText('대상 첫째')).toBeNull();
    const retainedUnrelated = within(list).getByRole('region', { name: '별도 첫째 연결 과제 묶음' });
    expect(within(retainedUnrelated).getByRole('button', { name: '2번째 과제 보기' }).getAttribute('aria-current')).toBe('true');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/tasks?studentId=S001')).toHaveLength(1);
  });
});
