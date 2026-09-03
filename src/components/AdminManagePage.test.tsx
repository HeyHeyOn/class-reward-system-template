import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';

const students = [
  { studentId: 'S001', name: '김민준', balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', balance: 1500, status: 'ACTIVE' },
];
const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 19, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 },
];
const tasks = [
  { taskId: 'T001', title: '책 읽기', description: '책 10분 읽기', reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: ['S001'] },
  { taskId: 'T002', title: '수학 학습지', description: '1장 풀기', reward: 10, isActive: true, sortOrder: 2, allowedStudentIds: [] },
];
const transactions = [
  {
    transactionId: 'TX001',
    timestamp: '2026-05-22T01:00:00.000Z',
    studentId: 'S001',
    studentName: '김민준',
    items: [{ productId: 'P001', name: '연필', price: 300, quantity: 2, lineTotal: 600 }],
    totalAmount: 600,
    balanceBefore: 3200,
    balanceAfter: 2600,
    status: 'COMPLETED',
    operator: 'kiosk',
  },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse(payload: unknown, init?: ResponseInit) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return { resolve, response: gate.then(() => jsonResponse(payload, init)) };
}

describe('AdminManagePage', () => {
  beforeEach(() => {
    let t001AssignmentStatus = [
      { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'EVENT', assignmentSource: 'QR' },
      { studentId: 'S002', name: '이서연', assigned: false, completed: false, assignmentOrigin: 'EVENT', assignmentSource: 'ADMIN' },
    ];
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('50000000-0000-4000-8000-000000000001');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/students') {
          if (init?.method === 'POST') return jsonResponse({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });
          return jsonResponse(students);
        }
        if (url === '/api/products?includeInactive=1') return jsonResponse(products);
        if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
        if (url === '/api/promotions') return jsonResponse([]);
        if (url === '/api/transactions') return jsonResponse(transactions);
        if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'purple', fontFamily: 'school-safe-poster', source: 'runtime' });
        if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', fontFamily: 'school-safe-board-marker', source: 'runtime' });
        if (url === '/api/products' && init?.method === 'POST') {
          return jsonResponse({ productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5, isActive: true, imageUrl: 'https://example.com/snack.png', category: '쿠폰', sortOrder: 3 });
        }
        if (url === '/api/tasks' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const schedule = body.schedule ?? { timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false };
          return jsonResponse({ taskId: body.taskId, title: body.title.trim(), description: body.description.trim(), reward: body.reward, isActive: body.isActive, sortOrder: body.sortOrder, allowedStudentIds: body.allowedStudentIds, createdAt: '2026-09-01T00:00:00.000Z', taskInstanceId: `I-${body.taskId}`, schedule: { ...schedule, ruleVersion: 1, effectiveFrom: '2026-09-01T00:00:00.000Z' }, pendingSchedule: null });
        }
        if (url === '/api/tasks/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...tasks[0], title: '책 읽기 수정', description: '책 20분 읽기', reward: 7 },
            tasks[1],
          ]);
        }
        if (url === '/api/tasks/batch' && init?.method === 'DELETE') return jsonResponse({ taskIds: ['T001', 'T002'] });
        if (url === '/api/tasks/completions/reset' && init?.method === 'POST') {
          t001AssignmentStatus = t001AssignmentStatus.map((row) => ({ ...row, completed: false }));
          return jsonResponse({ taskIds: ['T001', 'T002'], deletedCount: 3 });
        }
        if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as {
            targets?: Array<{ taskId?: string; operations?: Array<{ studentId?: string; assigned?: boolean; completed?: boolean }> }>;
          };
          for (const target of body.targets ?? []) {
            if (target.taskId !== 'T001') continue;
            for (const operation of target.operations ?? []) {
              t001AssignmentStatus = t001AssignmentStatus.map((row) => row.studentId === operation.studentId ? {
                ...row,
                ...(typeof operation.assigned === 'boolean' ? { assigned: operation.assigned } : {}),
                ...(typeof operation.completed === 'boolean' ? { completed: operation.completed } : {}),
              } : row);
            }
          }
          return jsonResponse({ appliedCount: body.targets?.flatMap((target) => target.operations ?? []).length ?? 0, aborted: false, failures: [], notAttempted: [], warnings: [] });
        }
        if (url === '/api/tasks/T001/assignments' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body ?? '{}'));
          t001AssignmentStatus = t001AssignmentStatus.map((row) => row.studentId === body.studentId ? {
            ...row,
            ...(typeof body.assigned === 'boolean' ? { assigned: body.assigned } : {}),
            ...(typeof body.completed === 'boolean' ? { completed: body.completed } : {}),
          } : row);
          return jsonResponse({ taskId: 'T001', students: t001AssignmentStatus });
        }
        if (url === '/api/tasks/T001/assignments') {
          return jsonResponse({ taskId: 'T001', students: t001AssignmentStatus });
        }
        if (url === '/api/tasks/T001' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body ?? '{}'));
          return jsonResponse({ ...tasks[0], ...body });
        }
        if (url === '/api/tasks/T001' && init?.method === 'DELETE') return jsonResponse({ taskId: 'T001' });
        if (url === '/api/students/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...students[0], name: '김민준 수정', balance: 4000 },
            students[1],
          ]);
        }
        if (url === '/api/students/batch' && init?.method === 'DELETE') return jsonResponse({ studentIds: ['S001', 'S002'] });
        if (url === '/api/products/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...products[0], name: '연필 세트', price: 900, imageUrl: 'https://example.com/new-pencil.png' },
            products[1],
          ]);
        }
        if (url === '/api/products/batch' && init?.method === 'DELETE') return jsonResponse({ productIds: ['P001', 'P002'] });
        if (url === '/api/students/S001' && init?.method === 'PATCH') {
          return jsonResponse({ ...students[0], name: '김민준 수정', balance: 4000 });
        }
        if (url === '/api/students/S002' && init?.method === 'PATCH') {
          return jsonResponse(students[1]);
        }
        if (url === '/api/students/S001' && init?.method === 'DELETE') return jsonResponse({ studentId: 'S001' });
        if (url === '/api/students/S002' && init?.method === 'DELETE') return jsonResponse({ studentId: 'S002' });
        if (url === '/api/products/P001' && init?.method === 'DELETE') return jsonResponse({ productId: 'P001' });
        if (url === '/api/products/P002' && init?.method === 'DELETE') return jsonResponse({ productId: 'P002' });
        if (url === '/api/students/bulk' && init?.method === 'PATCH') {
          return jsonResponse([
            { studentId: 'S001', balance: 5000 },
            { studentId: 'S002', balance: 5000 },
          ]);
        }
        if (url === '/api/products/P001' && init?.method === 'PATCH') {
          return jsonResponse({ ...products[0], name: '연필 세트', price: 900, imageUrl: 'https://example.com/new-pencil.png' });
        }
        if (url === '/api/products/P002' && init?.method === 'PATCH') {
          return jsonResponse(products[1]);
        }

        return jsonResponse({ error: 'not found' }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens promotions only from the store subtab and does not fetch them eagerly', async () => {
    render(<AdminManagePage />);

    await screen.findByRole('heading', { name: '학급 보상 시스템' });
    expect(screen.queryByRole('tab', { name: '행사 관리' })).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    const storeTabs = screen.getByRole('tablist', { name: '매점 관리 메뉴' });
    expect(within(storeTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['상품·재고', '행사 관리']);
    expect(within(storeTabs).getByRole('tab', { name: '상품·재고' }).getAttribute('aria-selected')).toBe('true');
    const promotionsTab = within(storeTabs).getByRole('tab', { name: '행사 관리' });
    const initialPromotionsPanel = document.getElementById(promotionsTab.getAttribute('aria-controls')!);
    expect(initialPromotionsPanel).toBeTruthy();
    expect(initialPromotionsPanel?.hidden).toBe(true);
    expect(initialPromotionsPanel?.getAttribute('aria-labelledby')).toBe(promotionsTab.id);
    expect(initialPromotionsPanel?.textContent).toBe('');
    expect(screen.getByRole('heading', { name: '새 상품 추가' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });

    fireEvent.click(promotionsTab);

    expect(await screen.findByRole('tabpanel', { name: '행사 관리' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '행사 만들기' })).toBeTruthy();
    expect(screen.getByLabelText('연필 (P001) 대상')).toBeTruthy();
    expect(screen.getByText('등록된 행사가 없습니다.')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });
  });

  it('links store tabs to panels and supports wrapped roving keyboard navigation without refetching promotions', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));

    const storeTabs = screen.getByRole('tablist', { name: '매점 관리 메뉴' });
    const inventoryTab = within(storeTabs).getByRole('tab', { name: '상품·재고' });
    const promotionsTab = within(storeTabs).getByRole('tab', { name: '행사 관리' });
    const inventoryPanel = screen.getByRole('tabpanel', { name: '상품·재고' });
    expect(inventoryTab.id).toBe('admin-store-tab-inventory');
    expect(inventoryTab.getAttribute('aria-controls')).toBe('admin-store-panel-inventory');
    expect(inventoryPanel.id).toBe('admin-store-panel-inventory');
    expect(inventoryPanel.getAttribute('aria-labelledby')).toBe(inventoryTab.id);
    expect(inventoryTab.tabIndex).toBe(0);
    expect(promotionsTab.tabIndex).toBe(-1);

    inventoryTab.focus();
    fireEvent.keyDown(inventoryTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(promotionsTab);
    expect(promotionsTab.getAttribute('aria-selected')).toBe('true');
    const promotionsPanel = await screen.findByRole('tabpanel', { name: '행사 관리' });
    expect(promotionsTab.getAttribute('aria-controls')).toBe('admin-store-panel-promotions');
    expect(promotionsPanel.id).toBe('admin-store-panel-promotions');
    expect(promotionsPanel.getAttribute('aria-labelledby')).toBe(promotionsTab.id);

    fireEvent.keyDown(promotionsTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(inventoryTab);
    fireEvent.keyDown(inventoryTab, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(promotionsTab);
    fireEvent.keyDown(promotionsTab, { key: 'Home' });
    expect(document.activeElement).toBe(inventoryTab);
    fireEvent.keyDown(inventoryTab, { key: 'End' });
    expect(document.activeElement).toBe(promotionsTab);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/promotions')).toHaveLength(1);
  });

  it('exposes stable primary tab/panel relationships with wrapped roving keyboard selection', async () => {
    render(<AdminManagePage />);
    await screen.findByRole('heading', { name: '학급 보상 시스템' });
    const tablist = screen.getByRole('tablist', { name: '관리자 메뉴' });
    const primaryTabs = within(tablist).getAllByRole('tab');
    const tabKeys = ['settings', 'students', 'products', 'tasks', 'transactions', 'currency'];
    primaryTabs.forEach((tab, index) => {
      expect(tab.id).toBe(`admin-tab-${tabKeys[index]}`);
      expect(tab.getAttribute('aria-controls')).toBe(`admin-panel-${tabKeys[index]}`);
      expect(tab.tabIndex).toBe(index === 0 ? 0 : -1);
      const panel = document.getElementById(`admin-panel-${tabKeys[index]}`);
      expect(panel).toBeTruthy();
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
      expect(panel?.hidden).toBe(index !== 0);
    });
    primaryTabs[0].focus();
    fireEvent.keyDown(primaryTabs[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(primaryTabs[5]);
    expect(primaryTabs[5].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(primaryTabs[5], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(primaryTabs[0]);
    fireEvent.keyDown(primaryTabs[0], { key: 'End' });
    expect(document.activeElement).toBe(primaryTabs[5]);
    fireEvent.keyDown(primaryTabs[5], { key: 'Home' });
    expect(document.activeElement).toBe(primaryTabs[0]);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/promotions')).toBe(false);
  });

  it('makes the admin background inert for history, closes on Escape, and restores the exact opener', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor: 'black' });
      if (url === '/api/tasks/T001/history') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const opener = screen.getByRole('button', { name: 'T001 기록 보기' });
    opener.focus();
    fireEvent.click(opener);
    const background = screen.getByTestId('admin-background');
    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    const close = within(dialog).getByRole('button', { name: '닫기' });
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '과제 기록' })).toBeNull();
    expect(background.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('confirms a named task deletion without browser confirm and locks duplicate confirmation', async () => {
    const deletion = deferredResponse({ taskId: 'T001' });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001' && init?.method === 'DELETE' ? deletion.response : fallback(input, init));
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const opener = screen.getByRole('button', { name: 'T001 과제 삭제' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '책 읽기 과제 삭제 확인' });
    expect(within(dialog).getByText(/책 읽기/)).toBeTruthy();
    expect(screen.getByTestId('admin-background').hasAttribute('inert')).toBe(true);
    expect(baseFetch.mock.calls.some(([url, init]) => String(url) === '/api/tasks/T001' && init?.method === 'DELETE')).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    const confirmDelete = within(dialog).getByRole('button', { name: '과제 삭제 확인' });
    expect(document.activeElement).toBe(confirmDelete);
    fireEvent.click(confirmDelete);
    fireEvent.click(confirmDelete);
    expect(confirmDelete).toHaveProperty('disabled', true);
    expect(baseFetch.mock.calls.filter(([url, init]) => String(url) === '/api/tasks/T001' && init?.method === 'DELETE')).toHaveLength(1);
    deletion.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 삭제 확인' })).toBeNull());
    expect(screen.queryByLabelText('T001 과제명')).toBeNull();
  });

  it('cancels task deletion by button or Escape without a request and restores focus', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const opener = screen.getByRole('button', { name: 'T001 과제 삭제' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '과제 삭제 취소' }));
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '책 읽기 과제 삭제 확인' }), { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/tasks/T001' && init?.method === 'DELETE')).toBe(false);
  });

  it('keeps a failed task deletion confirmation open and retryable', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001' && init?.method === 'DELETE'
      ? jsonResponse({ error: '삭제 서버 오류' }, { status: 500 })
      : fallback(input, init));
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 삭제' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 삭제 확인' }));

    const dialog = await screen.findByRole('dialog', { name: '책 읽기 과제 삭제 확인' });
    expect(within(dialog).getByRole('alert').textContent).toContain('삭제 서버 오류');
    expect(within(dialog).getByRole('button', { name: '과제 삭제 확인' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('T001 과제명')).toBeTruthy();
  });

  it.each(['black', 'navy'] as const)('uses semantic muted and hover colors on remaining %s admin surfaces', async (themeColor) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/tasks/T001/assignments') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    expect((await screen.findByText('학생')).className).toContain('text-[var(--theme-muted-text)]');
    fireEvent.click(screen.getByRole('tab', { name: '학생 관리' }));
    expect(screen.getByText('회수 후 음수 잔액 가능').className).toContain('text-[var(--theme-muted-text)]');
    fireEvent.click(screen.getByRole('tab', { name: '화폐 지급/회수' }));
    expect(screen.getByText(/QR코드를 인식하여/).closest('ul')?.className).toContain('text-[var(--theme-muted-text)]');
    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    const row = await screen.findByTestId('task-assignment-row-S001');
    expect(row.className).toContain('hover:bg-[var(--theme-hover)]');
    expect(row.className).toContain('hover:text-[var(--theme-hover-text)]');
    expect(screen.getByRole('status', { name: '과제 부여 상태 불러오는 중' }).className).not.toMatch(/bg-white|text-slate-600/);
  });

  it('keeps the product draft when switching store subtabs', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));
    fireEvent.change(screen.getByLabelText('새 상품명'), { target: { value: '작성 중인 상품' } });

    const storeTabs = screen.getByRole('tablist', { name: '매점 관리 메뉴' });
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '행사 관리' }));
    await screen.findByRole('tabpanel', { name: '행사 관리' });
    fireEvent.change(screen.getByLabelText('행사명'), { target: { value: '작성 중인 행사' } });
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '상품·재고' }));

    expect(screen.getByLabelText('새 상품명')).toHaveProperty('value', '작성 중인 상품');
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '행사 관리' }));
    expect(screen.getByLabelText('행사명')).toHaveProperty('value', '작성 중인 행사');
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/promotions')).toHaveLength(1);
  });

  it('places each task row action in a right-side group in the required keyboard order', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    const row = screen.getAllByTestId('task-row')[0];
    const nameField = within(row).getByLabelText('T001 과제명');
    const actions = within(row).getByTestId('task-row-actions');
    const buttons = within(actions).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'T001 기한 설정',
      'T001 기록 보기',
      'T001 과제 부여',
      'T001 과제 삭제',
    ]);
    expect(nameField.parentElement?.contains(actions)).toBe(false);
    expect(actions.compareDocumentPosition(nameField) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    for (const button of buttons) {
      expect(button.className).toContain('focus-visible:ring-[var(--theme-focus-ring)]');
      expect(button.className).toContain('focus-visible:ring-offset-[var(--theme-surface)]');
      expect(button.className).toContain('border');
    }
    expect(buttons[3].className).toContain('rose');
  });

  it.each([
    ['white', '#FCFCFC', '#FFFFFF', '#8A8A8A'],
    ['black', '#1F1F1F', '#2B2B2B', '#818181'],
    ['navy', '#111A2E', '#1B2945', '#7184A6'],
  ] as const)('applies semantic %s theme variables to admin-owned surfaces and controls', async (themeColor, shellColor, surfaceColor, borderColor) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    const shell = await screen.findByTestId('admin-shell');
    expect(shell.className).toContain('bg-[var(--theme-shell)]');
    expect(shell.className).toContain('text-[var(--theme-text)]');
    expect(shell.style.getPropertyValue('--theme-shell')).toBe(shellColor);
    expect(shell.style.getPropertyValue('--theme-surface')).toBe(surfaceColor);
    expect(shell.style.getPropertyValue('--theme-border')).toBe(borderColor);
    expect(screen.getByTestId('admin-header').className).toContain('bg-[var(--theme-surface)]');
    expect(screen.getByTestId('admin-tabs').className).toContain('border-[var(--theme-border)]');

    fireEvent.click(screen.getByRole('tab', { name: '학생 관리' }));
    const section = screen.getByRole('heading', { name: '새 학생 추가' }).closest('section');
    const input = screen.getByLabelText('새 학생 이름');
    expect(section?.className).toContain('bg-[var(--theme-surface)]');
    expect(input.className).toContain('bg-[var(--theme-input)]');
    expect(input.className).toContain('text-[var(--theme-text)]');
    expect(input.className).toContain('focus:ring-[var(--theme-focus-ring)]');
    expect(`${section?.className} ${input.className}`).not.toMatch(/bg-white|text-slate-(?:950|700)/);
  });

  it.each(['white', 'black', 'navy'] as const)('passes the normalized %s theme into task history dialogs', async (themeColor) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/tasks/T001/history') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기록 보기' }));

    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    expect(dialog.style.getPropertyValue('--theme-shell')).toBe(themeColor === 'white' ? '#FCFCFC' : themeColor === 'black' ? '#1F1F1F' : '#111A2E');
    expect(dialog.className).toContain('border-[var(--theme-border)]');
    expect(dialog.className).toContain('bg-[var(--theme-surface)]');
    expect(dialog.className).toContain('text-[var(--theme-text)]');
    expect(dialog.innerHTML).not.toMatch(/bg-white|bg-slate-|text-slate-|border-slate-/);
  });

  it.each(['white', 'black', 'navy'] as const)('uses semantic %s dialog, currency input, and loading/result surfaces', async (themeColor) => {
    const currencyRequest = deferredResponse([{ studentId: 'S001', balance: 3900 }]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return currencyRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    await screen.findByTestId('admin-shell');

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: 'P001 이미지 주소 편집' }));
    const imageDialog = screen.getByRole('dialog', { name: '상품 이미지 등록' });
    expect(imageDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(imageDialog.className).toContain('border-[var(--theme-border)]');
    expect(imageDialog.className).toContain('text-[var(--theme-text)]');
    expect(screen.getByLabelText('이미지 주소 전체 입력').className).toContain('bg-[var(--theme-input)]');
    expect(imageDialog.className).not.toContain('bg-white');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 상세 설정 편집' }));
    const taskDialog = screen.getByRole('dialog', { name: '과제 상세 설정 편집' });
    expect(taskDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(screen.getByLabelText('과제 상세 설정 전체 입력').className).toContain('focus:ring-[var(--theme-focus-ring)]');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    fireEvent.click(screen.getByRole('tab', { name: '화폐 지급/회수' }));
    const amountInput = screen.getByLabelText('지급/회수 금액');
    expect(amountInput.className).toContain('bg-[var(--theme-input)]');
    expect(amountInput.className).toContain('border-[var(--theme-border)]');
    expect(amountInput.className).toContain('text-[var(--theme-text)]');
    fireEvent.change(amountInput, { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    const scannerDialog = screen.getByRole('dialog', { name: '학생 QR 인식' });
    expect(scannerDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(screen.getByLabelText('학생 QR 직접 입력').className).toContain('bg-[var(--theme-input)]');
    fireEvent.change(screen.getByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    const loadingDialog = await screen.findByRole('dialog', { name: '화폐 지급 처리 중' });
    expect(loadingDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(loadingDialog.className).toContain('border-[var(--theme-border)]');
    await act(async () => currencyRequest.resolve());
    const resultDialog = await screen.findByRole('dialog', { name: '화폐 지급 성공' });
    expect(resultDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(within(resultDialog).getByRole('heading').className).toContain('bg-emerald-700');
    expect(resultDialog.className).not.toContain('bg-white');
    expect(within(resultDialog).getByText('S001 학생에게 700 지급 완료').className).toContain('bg-[var(--theme-surface-raised)]');
  });


  it('removes student number fields and prints QR cards with ID only', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));

    expect(screen.queryByLabelText('새 학생 번호')).toBeNull();
    expect(screen.queryByText('번호')).toBeNull();
    expect(screen.queryByLabelText('S001 번호')).toBeNull();

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 학생 QR 발급' }));

    expect(screen.getByRole('dialog', { name: '선택 학생 QR 발급' })).toBeTruthy();
    expect(screen.getAllByText('S001').length).toBeGreaterThan(0);
    expect(screen.queryByText(/1번/)).toBeNull();
  });

  it('assigns tasks to selected student IDs and immediately saves existing task assignments', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: '새 과제 과제 부여' }));
    expect(screen.getByText('선택된 학생만 이 과제를 완료할 수 있습니다. 아무 학생도 선택하지 않으면 아무도 완료할 수 없습니다.')).toBeTruthy();
    expect(screen.getByLabelText('전체 학생 행 선택')).toBeTruthy();
    expect(screen.getByLabelText('S001 김민준 행 선택')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('S001 김민준 행 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 부여 상태 일괄 변경'), { target: { value: 'assigned' } });
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"allowedStudentIds":["S001"]'),
    })));

    fireEvent.change(screen.getByLabelText('T002 과제명'), { target: { value: '수학 학습지 초안' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect(screen.getByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeTruthy();
    expect(await screen.findByText('완료 여부')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    expect((screen.getByLabelText('S001 김민준 행 선택') as HTMLInputElement).checked).toBe(false);
    const s001Assignment = screen.getByRole('button', { name: 'S001 김민준 부여 상태' });
    expect(s001Assignment.textContent).toContain('부여');
    expect(s001Assignment.className).toContain('bg-green');
    const s001Row = screen.getByTestId('task-assignment-row-S001');
    expect(s001Row.textContent).toContain('부여 QR');
    expect(s001Row.innerHTML.indexOf('aria-label=\"S001 김민준 행 선택\"')).toBeLessThan(s001Row.innerHTML.indexOf('김민준'));
    const s001Completion = screen.getByRole('button', { name: 'S001 김민준 완료 상태' });
    expect(s001Completion.tagName).toBe('BUTTON');
    expect(s001Completion.textContent).toContain('완료');
    expect(s001Completion.className).toContain('bg-blue');
    fireEvent.click(s001Assignment);
    expect(screen.getByRole('button', { name: 'S001 김민준 부여 상태' }).textContent).toContain('미부여');
    expect(screen.getByRole('button', { name: 'S001 김민준 완료 상태' }).textContent).toContain('완료');
    fireEvent.click(screen.getByRole('button', { name: 'S001 김민준 부여 상태' }));
    expect((screen.getByLabelText('S002 이서연 행 선택') as HTMLInputElement).checked).toBe(false);
    const s002Row = screen.getByTestId('task-assignment-row-S002');
    expect(s002Row.innerHTML.indexOf('aria-label=\"S002 이서연 행 선택\"')).toBeLessThan(s002Row.innerHTML.indexOf('이서연'));
    const s002Completion = screen.getByRole('button', { name: 'S002 이서연 완료 상태' });
    expect(s002Completion.tagName).toBe('BUTTON');
    expect(s002Completion.textContent).toContain('미완료');
    expect(s002Completion.className).toContain('bg-slate');
    fireEvent.click(screen.getByLabelText('S002 이서연 행 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 부여 상태 일괄 변경'), { target: { value: 'assigned' } });
    fireEvent.click(screen.getByLabelText('S001 김민준 행 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 완료 여부 일괄 변경'), { target: { value: 'completed' } });
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('완료');
    fireEvent.click(screen.getByRole('button', { name: 'S001 김민준 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url, init]) => String(url) === '/api/tasks/assignments/batch' && init?.method === 'POST')).toHaveLength(1));
    const assignmentBatchCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find(([url, init]) => String(url) === '/api/tasks/assignments/batch' && init?.method === 'POST')!;
    expect(JSON.parse(String((assignmentBatchCall[1] as RequestInit).body))).toEqual({ targets: [{
      taskId: 'T001',
      operations: [
        { studentId: 'S001', assigned: false, source: 'ADMIN' },
        { studentId: 'S002', assigned: true, completed: true, source: 'ADMIN' },
      ],
    }] });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => String(url) === '/api/tasks/T001/assignments' && init?.method === 'PATCH')).toBe(false);
    expect(alert).toHaveBeenCalledWith('과제 부여 저장 완료');
    expect(screen.getByLabelText('T002 과제명')).toHaveProperty('value', '수학 학습지 초안');

    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect(await screen.findByText('완료 여부')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
    const reopenedS002Completion = screen.getByRole('button', { name: 'S002 이서연 완료 상태' });
    expect(reopenedS002Completion.textContent).toContain('완료');
    expect(reopenedS002Completion.className).toContain('bg-blue');
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화 확인' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('완료 기록 3건 초기화 완료'));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    expect(screen.getByRole('button', { name: 'S001 김민준 부여 상태' }).textContent).toContain('미부여');
    expect(screen.getByRole('button', { name: 'S001 김민준 완료 상태' }).textContent).toContain('미완료');
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('미완료');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 학생 1명');
    fireEvent.click(screen.getByRole('button', { name: '책 읽기 과제 선택' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));
    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 실패' })).toBeTruthy();
    expect(screen.getByText('이미 이 과제가 부여된 학생입니다.')).toBeTruthy();
  });

  it('sends one canonical reset operation ID and reuses it when the open confirmation retries after failure', async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('60000000-0000-4000-8000-000000000001');
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const resetBodies: Array<Record<string, unknown>> = [];
    let resetAttempt = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks/completions/reset' && init?.method === 'POST') {
        resetBodies.push(JSON.parse(String(init.body)));
        resetAttempt += 1;
        return resetAttempt === 1
          ? jsonResponse({ error: 'temporary reset failure' }, { status: 400 })
          : jsonResponse({ taskIds: ['T001'], resetEventsAppended: 1, deletedCount: 1 });
      }
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화 확인' }));

    const dialog = await screen.findByRole('dialog', { name: '완료 기록 초기화 확인' });
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('temporary reset failure'));
    fireEvent.click(within(dialog).getByRole('button', { name: '완료 기록 초기화 확인' }));
    await waitFor(() => expect(resetBodies).toHaveLength(2));

    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(resetBodies).toEqual([
      { taskIds: ['T001'], operationId: '60000000-0000-4000-8000-000000000001' },
      { taskIds: ['T001'], operationId: '60000000-0000-4000-8000-000000000001' },
    ]);
  });

  it('does not send assignment commands when the loaded desired state is unchanged', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제 부여 저장 완료'));
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => String(url) === '/api/tasks/T001/assignments' && init?.method === 'PATCH')).toBe(false);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => String(url) === '/api/tasks/assignments/batch' && init?.method === 'POST')).toBe(false);
  });

  it('accepts a successful batch response that omits optional fields without reconciling', async () => {
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const defaultFetch = baseFetch.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let assignmentGetCount = 0;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        return jsonResponse({ appliedCount: 2, failures: [] });
      }
      if (url === '/api/tasks/T001/assignments') assignmentGetCount += 1;
      return defaultFetch(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'S001 김민준 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제 부여 저장 완료'));
    expect(screen.queryByRole('dialog', { name: '과제 부여' })).toBeNull();
    expect(assignmentGetCount).toBe(1);
  });

  it.each([
    ['missing appliedCount', { failures: [] }],
    ['negative appliedCount', { appliedCount: -1, failures: [] }],
    ['fractional appliedCount', { appliedCount: 0.5, failures: [] }],
    ['unsafe appliedCount', { appliedCount: Number.MAX_SAFE_INTEGER + 1, failures: [] }],
    ['appliedCount larger than the submitted command count', { appliedCount: 2, failures: [] }],
    ['missing failures', { appliedCount: 1 }],
    ['unexpected top-level detail', { appliedCount: 1, failures: [], detail: 'private' }],
    ['non-array failures', { appliedCount: 1, failures: {} }],
    ['non-boolean aborted', { appliedCount: 0, failures: [], aborted: 'false' }],
    ['non-array notAttempted', { appliedCount: 0, failures: [], notAttempted: {} }],
    ['non-array warnings', { appliedCount: 1, failures: [], warnings: {} }],
    ['foreign failure task', { appliedCount: 0, failures: [{ taskId: 'T002', studentId: 'S002', code: 'OPERATION_FAILED' }] }],
    ['foreign failure student', { appliedCount: 0, failures: [{ taskId: 'T001', studentId: 'S001', code: 'OPERATION_FAILED' }] }],
    ['unknown failure code', { appliedCount: 0, failures: [{ taskId: 'T001', studentId: 'S002', code: 'PRIVATE_PROVIDER_ERROR' }] }],
    ['failure with provider detail', { appliedCount: 0, failures: [{ taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED', message: 'private detail' }] }],
    ['malformed failure item', { appliedCount: 0, failures: [null] }],
    ['foreign notAttempted pair', { appliedCount: 0, failures: [], notAttempted: [{ taskId: 'T002', studentId: 'S002' }] }],
    ['notAttempted item with extra fields', { appliedCount: 0, failures: [], notAttempted: [{ taskId: 'T001', studentId: 'S002', detail: 'private' }] }],
    ['duplicate failure pair', { appliedCount: 0, failures: [{ taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED' }, { taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED' }] }],
    ['duplicate notAttempted pair', { appliedCount: 0, failures: [], notAttempted: [{ taskId: 'T001', studentId: 'S002' }, { taskId: 'T001', studentId: 'S002' }] }],
    ['duplicate pair across result lists', { appliedCount: 0, failures: [{ taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED' }], notAttempted: [{ taskId: 'T001', studentId: 'S002' }] }],
    ['unknown warning code', { appliedCount: 1, failures: [], warnings: [{ taskId: 'T001', code: 'PRIVATE_PROVIDER_WARNING' }] }],
    ['foreign warning task', { appliedCount: 1, failures: [], warnings: [{ taskId: 'T002', code: 'LEGACY_MIRROR_UPDATE_FAILED' }] }],
    ['duplicate warning', { appliedCount: 1, failures: [], warnings: [{ taskId: 'T001', code: 'LEGACY_MIRROR_UPDATE_FAILED' }, { taskId: 'T001', code: 'LEGACY_MIRROR_UPDATE_FAILED' }] }],
    ['warning with extra fields', { appliedCount: 1, failures: [], warnings: [{ taskId: 'T001', code: 'LEGACY_MIRROR_UPDATE_FAILED', detail: 'private' }] }],
  ])('rejects a malformed successful batch response: %s', async (_caseName, payload) => {
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const defaultFetch = baseFetch.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let assignmentGetCount = 0;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') return jsonResponse(payload);
      if (url === '/api/tasks/T001/assignments') assignmentGetCount += 1;
      return defaultFetch(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제 부여 저장 결과를 확인하지 못했습니다.'));
    expect(assignmentGetCount).toBe(1);
    expect(screen.getByRole('dialog', { name: '과제 부여' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('완료');

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 학생 1명');
  });

  it('sends explicit unassignment with a standalone completion intent for an unassigned student', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/assignments/batch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targets: [{
        taskId: 'T001',
        operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }],
      }] }),
    })));
  });

  it('reconciles a failed complete-then-unassign command and retries the explicit paired intent', async () => {
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const defaultFetch = baseFetch.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let assignmentStatus = [
      { studentId: 'S001', name: '김민준', assigned: true, completed: true },
      { studentId: 'S002', name: '이서연', assigned: true, completed: false },
    ];
    const batchBodies: Array<Record<string, unknown>> = [];
    let assignmentGetCount = 0;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        batchBodies.push(body);
        assignmentStatus = assignmentStatus.map((row) => row.studentId === 'S002' ? {
          ...row,
          assigned: false,
          ...(batchBodies.length > 1 ? { completed: true } : {}),
        } : row);
        return batchBodies.length === 1
          ? jsonResponse({ appliedCount: 0, aborted: false, failures: [{ taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED' }], notAttempted: [], warnings: [] })
          : jsonResponse({ appliedCount: 1, aborted: false, failures: [], notAttempted: [], warnings: [] });
      }
      if (url === '/api/tasks/T001/assignments') {
        assignmentGetCount += 1;
        return jsonResponse({ taskId: 'T001', students: assignmentStatus });
      }
      return defaultFetch(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('과제 부여 일부 저장 실패')));
    expect(alert).not.toHaveBeenCalledWith(expect.stringContaining('provider stack detail'));
    expect(assignmentGetCount).toBe(2);
    expect(screen.getByRole('dialog', { name: '과제 부여' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('미부여');
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('완료');
    expect(alert).not.toHaveBeenCalledWith('과제 부여 저장 완료');

    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(batchBodies).toHaveLength(2));
    expect(batchBodies).toEqual([
      { targets: [{ taskId: 'T001', operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }] }] },
      { targets: [{ taskId: 'T001', operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }] }] },
    ]);
    expect(baseFetch.mock.calls.some(([url, init]) => String(url) === '/api/tasks/T001/assignments' && init?.method === 'PATCH')).toBe(false);
    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제 부여 저장 완료'));
  });

  it('keeps the reconciled assignment cache when a failed edit is cancelled', async () => {
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const defaultFetch = baseFetch.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let assignmentStatus = [
      { studentId: 'S001', name: '김민준', assigned: true, completed: true },
      { studentId: 'S002', name: '이서연', assigned: false, completed: false },
    ];
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        assignmentStatus = assignmentStatus.map((row) => row.studentId === 'S002' ? { ...row, assigned: true } : row);
        return jsonResponse({ appliedCount: 0, aborted: false, failures: [{ taskId: 'T001', studentId: 'S002', code: 'OPERATION_FAILED' }], notAttempted: [], warnings: [] });
      }
      if (url === '/api/tasks/T001/assignments') return jsonResponse({ taskId: 'T001', students: assignmentStatus });
      return defaultFetch(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('과제 부여 일부 저장 실패')));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 학생 2명');
    fireEvent.click(screen.getByRole('button', { name: '책 읽기 과제 선택' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));
    expect(await screen.findByText('이미 이 과제가 부여된 학생입니다.')).toBeTruthy();
  });


  it('assigns a selected task to a scanned student QR, saves it immediately, and shows saving progress', async () => {
    const qrTaskSave = deferredResponse({
      taskId: 'T002',
      students: [
        { studentId: 'S001', assigned: false, completed: false },
        { studentId: 'S002', assigned: true, completed: false },
      ],
    });
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === '/api/tasks/T002/assignments' && init?.method === 'PATCH') return qrTaskSave.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    expect(screen.getByRole('dialog', { name: 'QR 과제 부여' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '수학 학습지 과제 선택' }));
    expect(screen.getByRole('dialog', { name: '수학 학습지 QR 과제 부여' })).toBeTruthy();
    expect(screen.getByText('수학 학습지')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 인식 중' })).toBeTruthy();
    expect(screen.getByText('QR을 인식했습니다. 과제를 부여하는 중입니다.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/T002/assignments', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ studentId: 'S002', assigned: true, source: 'QR' }),
    })));
    expect(baseFetch.mock.calls.some(([url, init]) => String(url) === '/api/tasks/batch' && init?.method === 'PATCH')).toBe(false);
    qrTaskSave.resolve();

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 성공' })).toBeTruthy();
    expect(screen.getByText('과제가 부여되었습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 찍기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    fireEvent.click(screen.getByRole('button', { name: 'T002 과제 부여' }));
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
  });

  it('shows a specific failure when QR task assignment scans a duplicate or invalid QR', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    fireEvent.click(screen.getByRole('button', { name: '책 읽기 과제 선택' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 실패' })).toBeTruthy();
    expect(screen.getByText('이미 이 과제가 부여된 학생입니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'UNKNOWN' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 실패' })).toBeTruthy();
    expect(screen.getByText('잘못된 QR입니다.')).toBeTruthy();
  });

  it('shows loading popups while saving student, product, and task changes', async () => {
    const studentSave = deferredResponse([{ ...students[0], name: '김민준 수정', balance: 3200 }, students[1]]);
    const productSave = deferredResponse([{ ...products[0], name: '연필 세트' }, products[1]]);
    const taskSave = deferredResponse([{ ...tasks[0], title: '책 읽기 수정' }, tasks[1]]);
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === '/api/students/batch' && init?.method === 'PATCH') return studentSave.response;
      if (url === '/api/products/batch' && init?.method === 'PATCH') return productSave.response;
      if (url === '/api/tasks/batch' && init?.method === 'PATCH') return taskSave.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    studentSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    productSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    taskSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
  });

  it('refreshes student, product, and task lists with a loading popup from section headers', async () => {
    const refreshedStudents = [{ ...students[0], name: '김민준 새로고침', balance: 4100 }, students[1]];
    const refreshedProducts = [{ ...products[0], name: '연필 리필', stock: 30 }, products[1]];
    const refreshedTasks = [{ ...tasks[0], title: '책 읽기 새로고침' }, tasks[1]];
    let studentFetchCount = 0;
    let productFetchCount = 0;
    let taskFetchCount = 0;
    const studentRefresh = deferredResponse(refreshedStudents);
    const productRefresh = deferredResponse(refreshedProducts);
    const taskRefresh = deferredResponse(refreshedTasks);
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') {
        studentFetchCount += 1;
        return studentFetchCount === 1 ? jsonResponse(students) : studentRefresh.response;
      }
      if (url === '/api/products?includeInactive=1') {
        productFetchCount += 1;
        return productFetchCount === 1 ? jsonResponse(products) : productRefresh.response;
      }
      if (url === '/api/tasks?includeInactive=1') {
        taskFetchCount += 1;
        return taskFetchCount === 1 ? jsonResponse(tasks) : taskRefresh.response;
      }
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '학생 명단 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('새로고침하는 중입니다.')).toBeTruthy();
    studentRefresh.resolve();
    await screen.findByDisplayValue('김민준 새로고침');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('새로고침하는 중입니다.')).toBeTruthy();
    productRefresh.resolve();
    await screen.findByDisplayValue('연필 리필');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 설정 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    taskRefresh.resolve();
    await screen.findByDisplayValue('책 읽기 새로고침');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());
  });

  it('renders unified admin tabs with kiosk-style design language', async () => {
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(screen.queryByText('Class Reward System')).toBeNull();
    expect(screen.queryByText('태블릿과 스마트폰에서 빠르게 학생 잔액과 상품 재고를 관리합니다.')).toBeNull();
    const logo = screen.getByRole('img', { name: '학급 보상 시스템 로고' });
    expect(logo).toBeTruthy();
    expect(logo.className).toContain('bg-[var(--theme-accent-text)]');
    expect(logo.className).toContain("[mask-image:url('/class-reward-system-icon.png')]");
    expect(logo.className).not.toContain('bg-white');
    expect(logo.parentElement?.className).not.toMatch(/bg-|shadow|rounded/);
    const adminTabs = screen.getByTestId('admin-tabs');
    const expectedMenuOrder = ['시스템 설정', '학생 관리', '매점 관리', '과제 설정', '거래 내역 확인', '화폐 지급/회수', '매점 바로가기', '은행 바로가기'];
    let previousIndex = -1;
    for (const menu of expectedMenuOrder) {
      const currentIndex = adminTabs.textContent?.indexOf(menu) ?? -1;
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
    expect(screen.getByRole('tab', { name: '시스템 설정' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '학생 관리' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '매점 관리' })).toBeTruthy();
    expect(await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /학생 QR 출력/ })).toBeNull();
    expect(screen.getByRole('tab', { name: '거래 내역 확인' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /거래 내역 확인/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /시스템 생성기/ })).toBeNull();
    const storeLink = screen.getByRole('link', { name: /매점 바로가기/ });
    const bankLink = screen.getByRole('link', { name: /은행 바로가기/ });
    expect(storeLink.getAttribute('href')).toBe('/');
    expect(storeLink.getAttribute('target')).toBe('_blank');
    expect(storeLink.getAttribute('rel')).toContain('noopener');
    expect(storeLink.textContent).toContain('↗');
    expect(bankLink.getAttribute('href')).toBe('/bank');
    expect(bankLink.getAttribute('target')).toBe('_blank');
    expect(bankLink.getAttribute('rel')).toContain('noopener');
    expect(bankLink.textContent).toContain('↗');
    expect(screen.getByRole('tab', { name: '과제 설정' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '화폐 지급/회수' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '사용 전 확인' })).toBeNull();
    expect(await screen.findByDisplayValue('별')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 매점')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 은행')).toBeTruthy();
    expect(screen.getByLabelText('테마 색상')).toBeTruthy();
    expect(screen.getByLabelText('글꼴')).toBeTruthy();
    expect(screen.getByDisplayValue('학교안심 보드마카')).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[var(--theme-shell)]');
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe('#EDF5FA');
    expect(container.querySelector('[data-testid="admin-shell"]')?.getAttribute('style')).toContain('SchoolSafeBoardMarker');
    expect(container.querySelector('[data-testid="admin-tabs"]')?.className).toContain('rounded-[1.5rem]');
    expect(screen.queryByText('Google Sheets 연결')).toBeNull();
    expect(screen.queryByText('잔액과 상태 관리')).toBeNull();
    expect(screen.queryByText('스프레드시트 연결')).toBeNull();
    expect(screen.queryByText('GOOGLE SHEETS')).toBeNull();
  });

  it('uses the updated admin transaction, currency, and product image helper wording', async () => {
    render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '거래 내역 확인' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (1)' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '최근 거래 (1)' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '화폐 지급/회수' }));
    expect(screen.queryByText('회수 금액이 현재 잔액보다 커도 관리자 화면에서는 음수 잔액으로 기록됩니다.')).toBeNull();
    expect(screen.getByText(/QR코드를 인식하여 화폐를 지급하거나 회수할 수 있습니다\./)).toBeTruthy();
    expect(screen.getByText(/회수하는 금액이 잔액보다 큰 경우/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: 'P001 이미지 주소 편집' }));
    expect(screen.getByRole('dialog', { name: '상품 이미지 등록' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '상품 이미지 등록' })).toBeTruthy();
    expect(screen.getByText('※ 상품 이미지 등록하는 방법')).toBeTruthy();
    expect(screen.getByText('① 구글 이미지 검색 등으로 원하는 상품 이미지를 찾습니다.')).toBeTruthy();
    expect(screen.getByText("② 원하는 이미지를 마우스로 우클릭(모바일에서는 꾹 누르기)하고 '이미지 주소 복사'를 선택합니다.")).toBeTruthy();
    expect(screen.getByText("③ 복사한 이미지 주소를 아래 창에 붙여넣고 '상품 이미지 적용' 버튼을 누릅니다.")).toBeTruthy();
    expect(screen.getByText("④ '전체 저장'을 눌러 상품 이미지를 저장 및 적용합니다.")).toBeTruthy();
    expect(screen.getByRole('button', { name: '상품 이미지 적용' })).toBeTruthy();
    expect(screen.queryByText('이미지 주소 편집')).toBeNull();
    expect(screen.queryByText('긴 이미지 URL은 여기에서 편하게 붙여넣고 수정합니다.')).toBeNull();
    expect(screen.queryByRole('button', { name: '이미지 주소 적용' })).toBeNull();
  });

  it('saves the selected font family from system settings', async () => {
    render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('글꼴'), { target: { value: 'school-safe-poster' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    await waitFor(() => {
      const settingsPost = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/settings' && init?.method === 'POST');
      expect(settingsPost).toBeTruthy();
      expect(JSON.parse(String(settingsPost?.[1]?.body))).toMatchObject({ fontFamily: 'school-safe-poster' });
    });
  });

  it('uses a softer balanced green admin theme and a darker black admin shell when selected', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'green', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container, unmount } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe('#DCF5C9');
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-green-50');
    unmount();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'black', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const secondRender = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect((secondRender.container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe('#1F1F1F');
    expect(secondRender.container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-slate-100');
    expect(screen.getByRole('heading', { name: '학급 보상 시스템' }).className).toContain('text-[var(--theme-text)]');
    expect(screen.queryByRole('heading', { name: '사용 전 확인' })).toBeNull();
    expect(screen.getByLabelText('매점 제목').className).toContain('bg-slate-50');
    expect(screen.getByLabelText('매점 제목').className).toContain('text-slate-950');
    fireEvent.click(screen.getByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByLabelText('S001 이름')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '새 학생 추가' }).className).toContain('text-[var(--theme-text)]');
    expect(screen.getByRole('heading', { name: '학생 명단' }).className).toContain('text-[var(--theme-text)]');
    expect(screen.getByLabelText('S001 이름').className).toContain('bg-[var(--theme-input)]');
    expect(screen.getByLabelText('S001 이름').className).toContain('text-[var(--theme-text)]');
  });

  it('uses a blue-leaning low-saturation navy admin palette', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'navy', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe('#111A2E');
    expect(screen.getByRole('tab', { name: '시스템 설정' }).className).toContain('bg-[var(--theme-accent-solid)]');
    expect(screen.getByRole('img', { name: '학급 보상 시스템 로고' }).className).toContain('bg-[var(--theme-accent-text)]');
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-[#8F97CF]');
  });


  it('keeps the one-time admin QR visible while linked sheet data reloads after password save', async () => {
    const reloadGate = deferredResponse(students);
    let studentCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') {
        studentCalls += 1;
        return studentCalls === 1 ? jsonResponse(students) : reloadGate.response;
      }
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime', adminPasswordConfigured: true });
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await screen.findByRole('heading', { name: '학급 보상 시스템' });
    fireEvent.change(screen.getByLabelText('관리자 암호 설정'), { target: { value: 'new-admin-pass' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    expect(await screen.findByText('관리자 QR 로그인 코드')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeNull();
    expect(screen.getByRole('img', { name: '관리자 로그인 QR' }).getAttribute('src')).toContain('class-store-admin%3Anew-admin-pass');

    reloadGate.resolve();
    await waitFor(() => expect(screen.getByText(/시스템 설정을 저장/)).toBeTruthy());
  });

  it('shows a full screen loading dialog until admin sheet data and theme are loaded', async () => {
    const studentGate = deferredResponse(students);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return studentGate.response;
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<AdminManagePage />);

    expect(screen.getByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '학급 보상 시스템' })).toBeNull();

    studentGate.resolve();
    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe('#FCFCFC');
  });

  it('lazy-mounts payment history in its existing ARIA shell and preserves it after first opening', async () => {
    render(<AdminManagePage />);

    const transactionsTab = await screen.findByRole('tab', { name: '거래 내역 확인' });
    const transactionsPanel = document.getElementById('admin-panel-transactions');
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/settings')).toHaveLength(2));
    expect(transactionsTab.getAttribute('aria-controls')).toBe('admin-panel-transactions');
    expect(transactionsPanel).toBeTruthy();
    expect(transactionsPanel?.hidden).toBe(true);
    expect(transactionsPanel?.getAttribute('aria-labelledby')).toBe(transactionsTab.id);
    expect(transactionsPanel?.textContent).toBe('');
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/transactions')).toHaveLength(0);

    fireEvent.click(transactionsTab);

    expect(await screen.findByRole('heading', { name: '거래 내역 (1)' })).toBeTruthy();
    expect(screen.getByText('김민준')).toBeTruthy();
    expect(screen.getByText('연필 × 2')).toBeTruthy();
    expect(screen.getAllByText('-600별').length).toBeGreaterThan(0);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/transactions')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/settings')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: '수입' }));
    expect(screen.getByRole('heading', { name: '거래 내역 (0)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    expect(transactionsPanel?.hidden).toBe(true);
    fireEvent.click(transactionsTab);

    expect(screen.getByRole('heading', { name: '거래 내역 (0)' })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/transactions')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/settings')).toHaveLength(3);
  });

  it('mounts payment history once when the primary tab is selected with the keyboard', async () => {
    render(<AdminManagePage />);

    const tasksTab = await screen.findByRole('tab', { name: '과제 설정' });
    tasksTab.focus();
    fireEvent.keyDown(tasksTab, { key: 'ArrowRight' });

    const transactionsTab = screen.getByRole('tab', { name: '거래 내역 확인' });
    expect(document.activeElement).toBe(transactionsTab);
    expect(transactionsTab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: '거래 내역 (1)' })).toBeTruthy();
    fireEvent.keyDown(transactionsTab, { key: 'ArrowLeft' });
    fireEvent.keyDown(tasksTab, { key: 'ArrowRight' });
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/transactions')).toHaveLength(1);
  });

  it('reloads admin lists from the shared sheet after saving sheet settings', async () => {
    render(<AdminManagePage />);

    await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개');
    fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-new' } });
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '햇살반 매점' } });
    fireEvent.change(screen.getByLabelText('은행 제목'), { target: { value: '햇살반 은행' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetIdOrUrl: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'blue', fontFamily: 'school-safe-board-marker', qrManualInputEnabled: false }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/students', { cache: 'no-store' });
      expect(fetch).toHaveBeenCalledWith('/api/products?includeInactive=1', { cache: 'no-store' });
    });

    expect(await screen.findByText('시스템 설정을 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔습니다.')).toBeTruthy();
  });

  it('uses top bulk save buttons and column headers instead of per-row save buttons', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(screen.getByTestId('student-header-row').textContent).toContain('이름');
    expect(screen.getByTestId('student-header-row').textContent).toContain('잔액');
    expect(screen.queryByRole('button', { name: 'S001 학생 저장' })).toBeNull();
    expect(screen.queryByRole('link', { name: /QR 출력/ })).toBeNull();
    expect(screen.getByRole('button', { name: '선택 학생 QR 발급' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 학생 QR 발급' }));
    const qrDialog = await screen.findByRole('dialog', { name: '선택 학생 QR 발급' });
    expect(qrDialog).toBeTruthy();
    expect(document.body.classList.contains('qr-selection-printing')).toBe(true);
    const printDocument = document.querySelector('[data-qr-print-document]');
    expect(printDocument).toBeTruthy();
    expect(printDocument?.querySelector('[data-qr-print-grid]')).toBeTruthy();
    expect(screen.getAllByAltText('김민준 QR 코드')[0].getAttribute('src')).toBe('/api/qrcode?value=S001');
    expect(screen.queryByAltText('이서연 QR 코드')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(document.body.classList.contains('qr-selection-printing')).toBe(false);

    fireEvent.change(screen.getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.change(screen.getByLabelText('S001 잔액'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 1명 저장 완료'));

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    expect(screen.getByTestId('product-header-row').textContent).toContain('상품명');
    expect(screen.getByTestId('product-header-row').textContent).not.toContain('ID');
    expect(screen.getByTestId('product-header-row').textContent).toContain('이미지');
    expect(screen.queryByRole('button', { name: 'P001 상품 저장' })).toBeNull();
    fireEvent.change(screen.getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.change(screen.getByLabelText('P001 가격'), { target: { value: '900' } });
    expect(screen.getByRole('button', { name: '선택 저장' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('P001 선택'));
    fireEvent.click(screen.getByRole('button', { name: 'P001 이미지 주소 편집' }));
    expect(await screen.findByRole('dialog', { name: '상품 이미지 등록' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('이미지 주소 전체 입력'), { target: { value: 'https://example.com/new-pencil.png' } });
    fireEvent.click(screen.getByRole('button', { name: '상품 이미지 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: '50000000-0000-4000-8000-000000000001',
          students: [
            { studentId: 'S001', name: '김민준 수정', balance: 4000, status: 'ACTIVE' },
            ],
        }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: [
            { productId: 'P001', name: '연필 세트', price: 900, stock: 19, isActive: true, imageUrl: 'https://example.com/new-pencil.png', category: '문구', sortOrder: 1 },
            ],
        }),
      });
    });
    expect(fetch).not.toHaveBeenCalledWith('/api/students/S001', expect.objectContaining({ method: 'PATCH' }));
    expect(fetch).not.toHaveBeenCalledWith('/api/products/P001', expect.objectContaining({ method: 'PATCH' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 상품 1개 저장 완료'));
  });

  it('uses semantic dividers for student, product, and task rows while retaining strong list borders', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    const studentList = await screen.findByTestId('student-list');
    expect(studentList.className).toContain('divide-[var(--theme-divider)]');
    expect(studentList.className).toContain('border-[var(--theme-border)]');

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    const productList = await screen.findByTestId('product-list');
    expect(productList.className).toContain('divide-[var(--theme-divider)]');
    expect(productList.className).toContain('border-[var(--theme-border)]');

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    const taskScroll = await screen.findByTestId('task-list-scroll');
    expect(taskScroll.className).toContain('border-[var(--theme-border)]');
    expect(screen.getAllByTestId('task-row')[0].parentElement?.className).toContain('divide-[var(--theme-divider)]');
    expect(screen.getAllByTestId('task-row')[0].parentElement?.className).not.toContain('divide-slate-100');
  });

  it('supports dense selectable rows with bulk student balance editing and deletion', async () => {
    const { container } = render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(container.querySelector('[data-testid="student-list"]')?.className).toContain('divide-y');
    expect(container.querySelector('[data-testid="student-list"]')?.className).toContain('divide-[var(--theme-divider)]');
    expect(container.querySelector('[data-testid="student-list"]')?.className).toContain('border-[var(--theme-border)]');
    const studentRow = container.querySelector('[data-testid="student-row"]');
    expect(studentRow?.className).toContain('grid-cols-[24px_56px_minmax(4rem,1fr)_78px_52px_42px]');
    expect(studentRow?.className).toContain('items-center');
    expect(studentRow?.className).toContain('py-1');
    expect(studentRow?.className).not.toContain('md:grid-cols');
    expect(container.querySelector('[data-testid="student-name-field"]')?.className).toContain('sr-only');

    fireEvent.click(screen.getByLabelText('전체 학생 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 금액'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('선택 학생 작업'), { target: { value: 'set' } });
    fireEvent.click(screen.getByRole('button', { name: '화폐 수정' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'], mode: 'set', amount: 5000, operationId: '50000000-0000-4000-8000-000000000001' }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 수정 완료'));

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'] }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('S001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('S002 삭제 완료');

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    expect(container.querySelector('[data-testid="product-list"]')?.className).toContain('divide-y');
    expect(container.querySelector('[data-testid="product-list"]')?.className).toContain('divide-[var(--theme-divider)]');
    expect(container.querySelector('[data-testid="product-list"]')?.className).toContain('border-[var(--theme-border)]');
    const productRow = container.querySelector('[data-testid="product-row"]');
    expect(productRow?.className).toContain('grid-cols-[24px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px]');
    expect(productRow?.className).toContain('items-center');
    expect(productRow?.className).toContain('py-1');
    expect(productRow?.className).not.toContain('md:grid-cols');
    expect(container.querySelector('[data-testid="product-name-field"]')?.className).toContain('sr-only');
    const imageButton = screen.getByRole('button', { name: 'P001 이미지 주소 편집' });
    expect(imageButton.className).toContain('truncate');
    fireEvent.click(imageButton);
    expect(await screen.findByRole('dialog', { name: '상품 이미지 등록' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByLabelText('전체 상품 선택'));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/products/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ['P001', 'P002'] }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 상품 2개 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('P001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('P002 삭제 완료');
  });



  it('manages bank tasks with selectable rows, bulk save/delete, completion reset, and description popup', async () => {
    const { container } = render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    expect(await screen.findByDisplayValue('책 읽기')).toBeTruthy();
    expect(screen.getByTestId('task-header-row').textContent).toContain('선택');
    expect(screen.getByTestId('task-header-row').textContent).not.toContain('ID');
    expect(screen.getByTestId('task-header-row').textContent).toContain('상세');
    expect(screen.getByTestId('task-header-row').textContent).not.toContain('저장');
    expect(screen.queryByRole('button', { name: 'T001 과제 저장' })).toBeNull();
    expect(screen.getByTestId('task-panel').className).toContain('min-w-0');
    expect(screen.getByTestId('new-task-card').className).toContain('min-w-0');
    expect(screen.getByTestId('task-list-card').className).toContain('min-w-0');
    expect(screen.getByTestId('task-list-scroll').className).toContain('overflow-x-auto');
    expect(screen.getByTestId('task-list-scroll').className).toContain('border-[var(--theme-border)]');
    expect(screen.getAllByTestId('task-row')[0].parentElement?.className).toContain('divide-[var(--theme-divider)]');
    expect(screen.getAllByTestId('task-row')[0].parentElement?.className).not.toContain('divide-slate-100');
    expect(screen.getByTestId('task-bulk-actions').className).toContain('flex-wrap');
    const taskRow = container.querySelector('[data-testid="task-row"]');
    expect(taskRow?.className).toContain('grid-cols-[24px_minmax(5rem,1fr)_64px_48px_38px_minmax(3rem,0.7fr)_minmax(180px,auto)]');
    expect(taskRow?.className).toContain('items-center');
    expect(screen.queryByLabelText('T001 설명')).toBeNull();

    fireEvent.change(screen.getByLabelText('T001 과제명'), { target: { value: '책 읽기 수정' } });
    fireEvent.change(screen.getByLabelText('T001 보상'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 상세 설정 편집' }));
    expect(await screen.findByRole('dialog', { name: '과제 상세 설정 편집' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('과제 상세 설정 전체 입력'), { target: { value: '책 20분 읽기' } });
    fireEvent.click(screen.getByRole('button', { name: '상세 설정 적용' }));
    expect(screen.getByRole('button', { name: '선택 저장' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('T001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { taskId: 'T001', title: '책 읽기 수정', description: '책 20분 읽기', reward: 7, isActive: true, sortOrder: 1, allowedStudentIds: ['S001'], availableFrom: null, dueAt: null, prerequisiteTaskId: null },
          ],
      }),
    }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 과제 1개 저장 완료'));
    expect(fetch).not.toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' }));

    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    expect(screen.queryByRole('button', { name: '초기화' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T001', 'T002'] }),
    }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 과제 2개 삭제 완료'));

        fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('T001 과제 추가 완료'));
  });

  it('suppresses duplicate task creation and reuses a canonical unchanged attempt through malformed 2xx', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000051')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000052');
    const first = deferredResponse({ error: 'temporary task failure' }, { status: 400 });
    const malformed = deferredResponse({ taskId: 'T003', title: '영어 단어', description: '5개 외우기', reward: 99, isActive: true, sortOrder: 1, allowedStudentIds: [] });
    const valid = deferredResponse({ taskId: 'T003', title: '영어 단어', description: '5개 외우기', reward: 10, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2026-09-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2026-09-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null });
    const responses = [first.response, malformed.response, valid.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/tasks' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: ' 영어 단어 ' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    const create = screen.getByRole('button', { name: '새 과제 추가' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === '/api/tasks' && init?.method === 'POST')).toHaveLength(1);

    first.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary task failure'));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.click(create);
    malformed.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제를 추가하지 못했습니다.'));
    expect(screen.queryByLabelText('T003 과제명')).toBeNull();
    fireEvent.click(create);
    valid.resolve();
    await screen.findByLabelText('T003 과제명');

    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000051',
      '50000000-0000-4000-8000-000000000051',
      '50000000-0000-4000-8000-000000000051',
    ]);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('새 과제명')).toHaveProperty('value', '');
  });

  it('preserves a newer in-flight task draft and allocates a new operation ID', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000061')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000062');
    const first = deferredResponse({ taskId: 'T003', title: '첫 과제', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2026-09-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2026-09-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null });
    const second = deferredResponse({ taskId: 'T004', title: '새 초안', description: '', reward: 2, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2026-09-01T00:01:00.000Z', taskInstanceId: 'I-T004', schedule: { ruleVersion: 1, effectiveFrom: '2026-09-01T00:01:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null });
    const responses = [first.response, second.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/tasks' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '첫 과제' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '새 초안' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '2' } });

    first.resolve();
    await screen.findByLabelText('T003 과제명');
    expect(screen.getByLabelText('새 과제명')).toHaveProperty('value', '새 초안');
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));
    second.resolve();
    await screen.findByLabelText('T004 과제명');

    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000061',
      '50000000-0000-4000-8000-000000000062',
    ]);
  });

  it('rejects noncanonical student and weekday ordering in a successful task response', async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks' && init?.method === 'POST') {
        return jsonResponse({
          taskId: 'T003', title: '순서 과제', description: '', reward: 0, isActive: true,
          sortOrder: 1, allowedStudentIds: ['S002', 'S001'],
          createdAt: '2026-09-01T00:00:00.000Z', taskInstanceId: 'I-T003',
          schedule: { ruleVersion: 1, effectiveFrom: '2026-09-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [5, 1] }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
          pendingSchedule: null,
        });
      }
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 과제 부여' }));
    fireEvent.click(screen.getByLabelText('전체 학생 행 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 부여 상태 일괄 변경'), { target: { value: 'assigned' } });
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '순서 과제' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'WEEKLY' } });
    fireEvent.click(screen.getByRole('button', { name: '금요일' }));
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제를 추가하지 못했습니다.'));
    expect(screen.queryByLabelText('T003 과제명')).toBeNull();
  });

  it('creates new student and product rows through POST APIs', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    await screen.findByDisplayValue('김민준');

    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
        fireEvent.change(screen.getByLabelText('새 상품명'), { target: { value: '간식쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('새 상품 카테고리'), { target: { value: '쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 이미지 주소'), { target: { value: 'https://example.com/snack.png' } });
    fireEvent.change(screen.getByLabelText('새 상품 정렬'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '새 상품 추가' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: '50000000-0000-4000-8000-000000000001', studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: '50000000-0000-4000-8000-000000000001', productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5, isActive: true, imageUrl: 'https://example.com/snack.png', category: '쿠폰', sortOrder: 3 }),
      });
    });

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('S003 추가 완료'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('P003 추가 완료'));
  });

  it('suppresses synchronous duplicate student creation and reuses an unchanged attempt through failure and malformed 2xx', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000031')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000032');
    const first = deferredResponse({ error: 'temporary student failure' }, { status: 400 });
    const malformed = deferredResponse({ studentId: 'S003', name: '박도윤', balance: 99, status: 'ACTIVE' });
    const valid = deferredResponse({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });
    const responses = [first.response, malformed.response, valid.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/students' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: ' S003 ' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    const create = screen.getByRole('button', { name: '새 학생 추가' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === '/api/students' && init?.method === 'POST')).toHaveLength(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary student failure'));
    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.click(create);
    malformed.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('학생을 추가하지 못했습니다.'));
    expect(screen.getByLabelText('새 학생 ID')).toHaveProperty('value', 'S003');
    expect(screen.queryByLabelText('S003 이름')).toBeNull();

    fireEvent.click(create);
    valid.resolve();
    await screen.findByLabelText('S003 이름');
    expect(alert).toHaveBeenCalledWith('S003 추가 완료');
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/students' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000031',
    ]);
    expect(screen.getByLabelText('새 학생 ID')).toHaveProperty('value', '');
    expect(screen.getByLabelText('새 학생 이름')).toHaveProperty('value', '');
  });

  it('preserves newer in-flight student draft edits and gives the changed draft a new operation ID', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000041')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000042');
    const first = deferredResponse({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });
    const second = deferredResponse({ studentId: 'S004', name: '새 초안', balance: -10, status: 'ACTIVE' });
    const responses = [first.response, second.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/students' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));
    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S004' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '새 초안' } });
    fireEvent.change(screen.getByLabelText('새 학생 잔액'), { target: { value: '-10' } });

    first.resolve();
    await screen.findByLabelText('S003 이름');
    expect(screen.getByLabelText('새 학생 ID')).toHaveProperty('value', 'S004');
    expect(screen.getByLabelText('새 학생 이름')).toHaveProperty('value', '새 초안');
    expect(screen.getByLabelText('새 학생 잔액')).toHaveProperty('value', '-10');

    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));
    second.resolve();
    await screen.findByLabelText('S004 이름');
    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/students' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000041',
      '50000000-0000-4000-8000-000000000042',
    ]);
  });

  it('suppresses synchronous duplicate product creation and reuses a failed unchanged attempt ID', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000021')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000022');
    const first = deferredResponse({ error: 'temporary failure' }, { status: 400 });
    const second = deferredResponse({
      productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5,
      isActive: true, imageUrl: '', category: '', sortOrder: 1,
    });
    const responses = [first.response, second.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));
    fireEvent.change(screen.getByLabelText('새 상품명'), { target: { value: '간식쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '5' } });
    const create = screen.getByRole('button', { name: '새 상품 추가' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === '/api/products' && init?.method === 'POST')).toHaveLength(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary failure'));
    fireEvent.click(create);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    second.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('P003 추가 완료'));

    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/products' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
    expect(screen.getByLabelText('새 상품명')).toHaveProperty('value', '');
    expect(screen.getByLabelText('새 상품 가격')).toHaveProperty('value', '0');
  });

  it('retains the product attempt and draft after a malformed 2xx response', async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('50000000-0000-4000-8000-000000000025');
    const created = {
      productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5,
      isActive: true, imageUrl: '', category: '', sortOrder: 1,
    };
    const responses = [jsonResponse({}), jsonResponse(created)];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));
    const name = screen.getByLabelText('새 상품명');
    const create = screen.getByRole('button', { name: '새 상품 추가' });
    fireEvent.change(name, { target: { value: '간식쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '5' } });

    fireEvent.click(create);
    await waitFor(() => expect(alert).toHaveBeenCalledWith('상품을 추가하지 못했습니다.'));
    expect(name).toHaveProperty('value', '간식쿠폰');

    fireEvent.click(create);
    await waitFor(() => expect(alert).toHaveBeenCalledWith('P003 추가 완료'));
    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/products' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
    expect(name).toHaveProperty('value', '');
  });

  it('preserves a newer product draft when an earlier creation succeeds', async () => {
    const created = {
      productId: 'P003', name: '상품 A', price: 1000, stock: 5,
      isActive: true, imageUrl: '', category: '', sortOrder: 1,
    };
    const request = deferredResponse(created);
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? request.response
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));
    const name = screen.getByLabelText('새 상품명');
    fireEvent.change(name, { target: { value: '상품 A' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '새 상품 추가' }));

    fireEvent.change(name, { target: { value: '상품 B' } });
    request.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('P003 추가 완료'));

    expect(name).toHaveProperty('value', '상품 B');
  });

  it('allocates a new product creation operation ID when a failed draft changes', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000031')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000032');
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? jsonResponse({ error: 'temporary failure' }, { status: 400 })
        : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '매점 관리' }));
    const name = screen.getByLabelText('새 상품명');
    const create = screen.getByRole('button', { name: '새 상품 추가' });
    fireEvent.change(name, { target: { value: '간식쿠폰' } });
    fireEvent.click(create);
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary failure'));

    fireEvent.change(name, { target: { value: '다른쿠폰' } });
    fireEvent.click(create);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === '/api/products' && init?.method === 'POST')).toHaveLength(2));

    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url, init]) => String(url) === '/api/products' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000032',
    ]);
  });

  it('shows a loading popup after recognizing a currency QR before the result popup', async () => {
    const currencyRequest = deferredResponse([{ studentId: 'S001', balance: 3900 }]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return currencyRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    fireEvent.click(screen.getByRole('button', { name: '지급' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    fireEvent.change(await screen.findByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: '화폐 지급 처리 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 화폐를 지급하는 중입니다.');
    currencyRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
  });

  it('adjusts one scanned student from the currency grant/collect tab with retryable result popups', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    expect(screen.getByRole('heading', { name: '화폐 지급/회수' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지급' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    expect(await screen.findByRole('dialog', { name: '학생 QR 인식' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001'], mode: 'add', amount: 700, operationId: '50000000-0000-4000-8000-000000000001' }),
      });
    });
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
    expect(screen.getByText('S001 학생에게 700 지급 완료')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '닫기' })).toBeTruthy();
  });

  it('guards same-tick bulk duplicates and reuses a failed semantic attempt operation ID', async () => {
    const first = deferredResponse({ error: 'temporary failure' }, { status: 400 });
    const second = deferredResponse([{ studentId: 'S001', balance: 3210 }]);
    const bulkResponses = [first.response, second.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/students/bulk' && init?.method === 'PATCH'
        ? bulkResponses.shift()!
        : fallback(input, init));
    const uuid = vi.mocked(crypto.randomUUID);

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.change(screen.getByRole('combobox', { name: '선택 학생 작업' }), { target: { value: 'add' } });
    fireEvent.change(screen.getByLabelText('선택 학생 금액'), { target: { value: '10' } });
    const apply = screen.getByRole('button', { name: '화폐 수정' });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/students/bulk')).toHaveLength(1);
    expect(uuid).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary failure'));
    fireEvent.click(apply);
    expect(uuid).toHaveBeenCalledTimes(1);
    second.resolve();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('선택 학생 1명 수정 완료'));
    const bodies = vi.mocked(fetch).mock.calls
      .filter(([url]) => String(url) === '/api/students/bulk')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
  });

  it('replaces a retained bulk operation ID when normalized semantics change', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000011')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000012');
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/students/bulk' && init?.method === 'PATCH'
        ? jsonResponse({ error: 'temporary failure' }, { status: 400 })
        : fallback(input, init));
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByLabelText('S001 선택'));
    const amount = screen.getByLabelText('선택 학생 금액');
    const apply = screen.getByRole('button', { name: '화폐 수정' });
    fireEvent.change(amount, { target: { value: '10' } });
    fireEvent.click(apply);
    await waitFor(() => expect(alert).toHaveBeenCalledWith('temporary failure'));
    fireEvent.change(amount, { target: { value: '11' } });
    fireEvent.click(apply);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/students/bulk')).toHaveLength(2));
    const ids = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/students/bulk')
      .map(([, init]) => JSON.parse(String(init?.body)).operationId);
    expect(ids).toEqual(['50000000-0000-4000-8000-000000000011', '50000000-0000-4000-8000-000000000012']);
  });

  it('retries the failed QR mutation itself with the same operation ID', async () => {
    let attempt = 0;
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/students/bulk' && init?.method === 'PATCH') {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: 'temporary failure' }, { status: 400 })
          : jsonResponse([{ studentId: 'S001', balance: 3900 }]);
      }
      return fallback(input, init);
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    fireEvent.change(await screen.findByLabelText('학생 QR 직접 입력'), { target: { value: ' S001 ' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));
    expect(await screen.findByRole('dialog', { name: '화폐 지급 실패' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '학생 QR 인식' })).toBeNull();
    const bodies = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/students/bulk')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ studentIds: ['S001'], mode: 'add', amount: 700, operationId: '50000000-0000-4000-8000-000000000001' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('shows a failure popup with retry and cancel when a scanned currency adjustment fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return jsonResponse({ error: '잔액은 0보다 작아질 수 없습니다.' }, { status: 400 });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    fireEvent.click(screen.getByRole('button', { name: '회수' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    fireEvent.change(await screen.findByLabelText('학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: '화폐 회수 실패' })).toBeTruthy();
    expect(screen.getByText('잔액은 0보다 작아질 수 없습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
  });

  it('edits recurring schedules with strict bulk payloads and shows current-cycle origins', async () => {
    const recurringTasks = [{
      ...tasks[0], taskInstanceId: 'instance-1',
      schedule: { ruleVersion: 2, effectiveFrom: '2026-08-25T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'WEEKLY', weekdays: [2], time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      currentCycle: { cycleId: 'cycle-1', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: ['S001'], students: [{ studentId: 'S001', assigned: true, completed: true, assignmentOrigin: 'CARRY', completionOrigin: 'EVENT' }] },
    }, tasks[1]];
    let scheduleSaved = false;
    const savedTask = {
      ...recurringTasks[0],
      availableFrom: '2030-01-01T01:00:00.000Z',
      dueAt: '2030-01-02T03:30:00.000Z',
      prerequisiteTaskId: 'T002',
      schedule: { ruleVersion: 3, effectiveFrom: '2026-08-25T12:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'MONTHLY', dayOfMonth: 31, time: '17:45' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: true },
    };
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(scheduleSaved ? [savedTask, recurringTasks[1]] : recurringTasks);
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') {
        scheduleSaved = true;
        return jsonResponse(savedTask);
      }
      if (url === '/api/tasks/T001/assignments' && init?.method === 'PATCH') return jsonResponse({
        taskId: 'T001', cycleId: 'cycle-2', startsAt: '2026-09-01T00:00:00.000Z', endsAt: null, transition: 'NATURAL_BOUNDARY',
        students: [
          { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'CARRY' },
          { studentId: 'S002', name: '이서연', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' },
        ],
      });
      if (url === '/api/tasks/T001/assignments') return jsonResponse({
        taskId: 'T001', cycleId: 'cycle-2', startsAt: '2026-09-01T00:00:00.000Z', endsAt: null, transition: 'NATURAL_BOUNDARY',
        students: [
          { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'DEFAULT', completionOrigin: 'CARRY' },
          { studentId: 'S002', name: '이서연', assigned: false, completed: false, assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' },
        ],
      });
      return fallback(input, init);
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const initialRow = (await screen.findAllByTestId('task-row'))[0];
    expect(within(initialRow).queryByText(/현재 회차:|S001 부여/)).toBeNull();

    fireEvent.change(screen.getByLabelText('T001 과제명'), { target: { value: '저장 안 한 제목' } });
    fireEvent.change(screen.getByLabelText('T001 보상'), { target: { value: '77' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: '2030-01-01T10:00' } });
    fireEvent.change(screen.getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(screen.getByLabelText('선행 과제'), { target: { value: 'T002' } });
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'MONTHLY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '17:45' } });
    fireEvent.change(screen.getByLabelText('반복 날짜'), { target: { value: '31' } });
    fireEvent.click(screen.getByLabelText('회차마다 부여 초기화'));
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));

    await waitFor(() => {
      expect(baseFetch).toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' }));
    });
    const singlePatchCall = baseFetch.mock.calls.find(([url, init]) => String(url) === '/api/tasks/T001' && init?.method === 'PATCH');
    const body = JSON.parse(String(singlePatchCall![1]?.body));
    expect(body).toEqual({
      schedule: { recurrence: { type: 'MONTHLY', time: '17:45', dayOfMonth: 31 }, timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true },
      availableFrom: '2030-01-01T01:00:00.000Z',
      dueAt: '2030-01-02T03:30:00.000Z',
      prerequisiteTaskId: 'T002',
    });
    expect(body.schedule).not.toHaveProperty('ruleVersion');
    expect(body.schedule).not.toHaveProperty('effectiveFrom');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '과제 기한 설정' })).toBeNull());
    expect(screen.getByLabelText('T001 과제명')).toHaveProperty('value', '저장 안 한 제목');
    expect(screen.getByLabelText('T001 보상')).toHaveProperty('value', '77');

    fireEvent.click(screen.getByLabelText('T001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));
    await waitFor(() => {
      const call = baseFetch.mock.calls.find(([url, init]) => String(url) === '/api/tasks/batch' && init?.method === 'PATCH');
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.tasks[0]).not.toHaveProperty('schedule');
      expect(body.tasks[0]).toMatchObject({
        title: '저장 안 한 제목', reward: 77,
        availableFrom: '2030-01-01T01:00:00.000Z',
        dueAt: '2030-01-02T03:30:00.000Z',
        prerequisiteTaskId: 'T002',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect(await screen.findByText(/현재 회차 부여·완료 상태/)).toBeTruthy();
    expect(await screen.findByText('부여 기본값 · 완료 이월')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('과제 부여 저장 완료'));
    expect(within(screen.getAllByTestId('task-row')[0]).queryByText(/S001 부여/)).toBeNull();
  });

  it('preserves another task row draft while reconciling a saved schedule projection', async () => {
    const scheduledTask = {
      ...tasks[0],
      taskInstanceId: 'instance-1',
      schedule: { ruleVersion: 1, effectiveFrom: '2026-08-25T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      currentCycle: { cycleId: 'old-cycle', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-08-26T00:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: ['S001'], students: [{ studentId: 'S001', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }] },
    } as const;
    const refreshedTask = {
      ...scheduledTask,
      schedule: { ...scheduledTask.schedule, ruleVersion: 2, recurrence: { type: 'DAILY', time: '10:30' } },
      currentCycle: { ...scheduledTask.currentCycle, cycleId: 'fresh-cycle', completedStudentIds: [], students: [{ studentId: 'S001', assigned: true, completed: false, assignmentOrigin: 'CARRY', completionOrigin: 'DEFAULT' }] },
    } as const;
    const serverRows = [scheduledTask, tasks[1]];
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse(taskGetCount === 1 ? serverRows : [refreshedTask, tasks[1]]);
      }
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') return jsonResponse(scheduledTask);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('T002 과제명'), { target: { value: '저장 안 한 제목' } });
    fireEvent.change(screen.getByLabelText('T002 보상'), { target: { value: '77' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    expect(await screen.findByText(/현재 일정: 매일 10:30/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('T002 과제명')).toHaveProperty('value', '저장 안 한 제목');
    expect(screen.getByLabelText('T002 보상')).toHaveProperty('value', '77');
  });

  it('preserves another task row draft while reconciling only reset task projections', async () => {
    const staleTask = {
      ...tasks[0],
      currentCycle: { cycleId: 'cycle-1', startsAt: '2026-08-25T00:00:00.000Z', endsAt: null, transition: 'PERMANENT', assignedStudentIds: ['S001'], completedStudentIds: ['S001'], students: [] },
    } as const;
    const resetTask = { ...staleTask, currentCycle: { ...staleTask.currentCycle, completedStudentIds: [] } } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse(taskGetCount === 1 ? [staleTask, tasks[1]] : [resetTask, tasks[1]]);
      }
      if (url === '/api/tasks/completions/reset' && init?.method === 'POST') return jsonResponse({ taskIds: ['T001'], deletedCount: 1 });
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('T002 과제명'), { target: { value: '초기화와 무관한 제목' } });
    fireEvent.change(screen.getByLabelText('T002 보상'), { target: { value: '88' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화 확인' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('T002 과제명')).toHaveProperty('value', '초기화와 무관한 제목');
    expect(screen.getByLabelText('T002 보상')).toHaveProperty('value', '88');
  });

  it('shows an effective pending schedule in the recurrence modal without a timezone control', async () => {
    const currentSchedule = { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false } as const;
    const pendingSchedule = { ruleVersion: 2, effectiveFrom: '2001-01-01T00:00:00.000Z', timeZone: 'Europe/Paris', recurrence: { type: 'WEEKLY', weekdays: [5], time: '16:30' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: true } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') return jsonResponse([{ ...tasks[0], schedule: currentSchedule, pendingSchedule }]);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const row = await screen.findByTestId('task-row');
    expect(within(row).getByRole('button', { name: 'T001 기한 설정' }).textContent).toBe('기한');
    expect(within(row).queryByText('매주 금 16:30')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'T001 기한 설정' }));
    expect(screen.getByText(/현재 일정: 매주 금 16:30/)).toBeTruthy();
    expect(screen.getByLabelText('반복 주기')).toHaveProperty('value', 'WEEKLY');
    expect(screen.getByLabelText('반복 시간')).toHaveProperty('value', '16:30');
    expect(screen.getByRole('button', { name: '금요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('과제 시간대')).toBeNull();
  });

  it('refreshes a newly created task projection without replacing other unsaved task drafts', async () => {
    const created = { taskId: 'T003', title: '영어 단어', description: '5개 외우기', reward: 10, isActive: true, sortOrder: 3, allowedStudentIds: [], createdAt: '2000-01-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '14:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null } as const;
    const projected = { ...created, title: '영어 단어 (서버)', currentCycle: { cycleId: 'new-cycle', startsAt: '2026-08-25T05:00:00.000Z', endsAt: '2026-08-26T05:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: [], students: [{ studentId: 'S001', assigned: true, completed: false, assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' }] } } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse(taskGetCount === 1 ? tasks : [projected]);
      }
      if (url === '/api/tasks' && init?.method === 'POST') return jsonResponse(created);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('T002 과제명'), { target: { value: '저장 안 한 수학 제목' } });
    fireEvent.change(screen.getByLabelText('T002 보상'), { target: { value: '91' } });
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('새 과제 정렬'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '14:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(screen.queryByText(/S001 부여/)).toBeNull();
    expect(screen.getByLabelText('T003 과제명')).toHaveProperty('value', '영어 단어 (서버)');
    expect(screen.getByLabelText('T002 과제명')).toHaveProperty('value', '저장 안 한 수학 제목');
    expect(screen.getByLabelText('T002 보상')).toHaveProperty('value', '91');
  });

  it('keeps a successfully created recurring task and reports a projection refresh failure separately', async () => {
    const created = { taskId: 'T003', title: '영어 단어', description: '', reward: 0, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2000-01-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '14:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return taskGetCount === 1 ? jsonResponse(tasks) : jsonResponse({ error: 'projection unavailable' }, { status: 503 });
      }
      if (url === '/api/tasks' && init?.method === 'POST') return jsonResponse(created);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '14:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('T003 과제 추가 완료'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다: projection unavailable')));
    expect(screen.getByLabelText('T003 과제명')).toHaveProperty('value', '영어 단어');
  });

  it('keeps the validated committed task when recurring refresh contains a malformed matching row', async () => {
    const created = { taskId: 'T003', title: '영어 단어', description: '', reward: 0, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2000-01-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '14:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse(taskGetCount === 1 ? tasks : [{ taskId: 'T003' }]);
      }
      if (url === '/api/tasks' && init?.method === 'POST') return jsonResponse(created);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '14:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(screen.getByLabelText('T003 과제명')).toHaveProperty('value', '영어 단어');
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다'));
    expect(baseFetch.mock.calls.filter(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['negative reward', { reward: -1 }, false],
    ['blank title', { title: ' ' }, false],
    ['blank task instance', { taskInstanceId: ' ' }, false],
    ['out-of-range sort order', { sortOrder: 2147483648 }, false],
    ['noncanonical duplicate students', { allowedStudentIds: [' S001', 'S001'] }, false],
    ['invalid availability', { availableFrom: 'not-an-instant' }, false],
    ['non-increasing availability', { availableFrom: '2026-09-02T00:00:00.000Z', dueAt: '2026-09-02T00:00:00.000Z' }, false],
    ['blank prerequisite', { prerequisiteTaskId: ' ' }, false],
    ['missing current cycle', {}, false],
    ['duplicate matching rows', {}, true],
  ])('keeps the committed task when refresh has %s', async (_label, patch, duplicate) => {
    const created = { taskId: 'T003', title: '영어 단어', description: '', reward: 0, isActive: true, sortOrder: 1, allowedStudentIds: [], createdAt: '2000-01-01T00:00:00.000Z', taskInstanceId: 'I-T003', schedule: { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '14:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pendingSchedule: null } as const;
    const malformed = { ...created, ...patch };
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse(taskGetCount === 1 ? tasks : duplicate ? [malformed, created] : [malformed]);
      }
      if (url === '/api/tasks' && init?.method === 'POST') return jsonResponse(created);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '14:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(screen.getByLabelText('T003 과제명')).toHaveProperty('value', '영어 단어');
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다'));
    expect(baseFetch.mock.calls.filter(([url, init]) => String(url) === '/api/tasks' && init?.method === 'POST')).toHaveLength(1);
  });

  it('reopens the new-task schedule editor with the applied recurrence draft', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '14:25' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));

    expect(screen.getByRole('button', { name: '새 과제 기한 설정' }).textContent).toBe('기한 설정');
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    expect(screen.getByLabelText('반복 주기')).toHaveProperty('value', 'DAILY');
    expect(screen.getByLabelText('반복 시간')).toHaveProperty('value', '14:25');
  });

  it('keeps a newly opened schedule editor when an earlier schedule save finishes', async () => {
    const firstSave = deferredResponse(tasks[0]);
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') return firstSave.response;
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));
    await waitFor(() => expect(baseFetch).toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' })));

    expect(screen.getByRole('button', { name: '취소', hidden: true })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'T002 기한 설정', hidden: true }));
    expect(screen.getByRole('dialog', { name: '과제 기한 설정' })).toBeTruthy();

    firstSave.resolve();
    await waitFor(() => expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks?includeInactive=1')).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '과제 기한 설정' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기한 설정 저장' })).toBeTruthy();
  });

  it('keeps the newer projection when consecutive schedule saves for the same task finish out of order', async () => {
    const initialTask = {
      ...tasks[0],
      schedule: { ruleVersion: 1, effectiveFrom: '2026-08-25T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      currentCycle: { cycleId: 'initial-cycle', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-08-26T00:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: [], students: [{ studentId: 'S001', assigned: true, completed: false, assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' }] },
    } as const;
    const firstProjectionTask = {
      ...initialTask,
      schedule: { ...initialTask.schedule, ruleVersion: 2, recurrence: { type: 'DAILY', time: '10:00' } },
      currentCycle: { ...initialTask.currentCycle, cycleId: 'first-cycle' },
    } as const;
    const secondProjectionTask = {
      ...initialTask,
      schedule: { ...initialTask.schedule, ruleVersion: 3, recurrence: { type: 'DAILY', time: '11:00' } },
      currentCycle: { ...initialTask.currentCycle, cycleId: 'second-cycle', assignedStudentIds: [], students: [{ studentId: 'S001', assigned: false, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' }] },
    } as const;
    const firstPatch = deferredResponse(initialTask);
    const secondPatch = deferredResponse(initialTask);
    const firstProjection = deferredResponse([firstProjectionTask]);
    const secondProjection = deferredResponse([secondProjectionTask]);
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let patchCount = 0;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') {
        patchCount += 1;
        return patchCount === 1 ? firstPatch.response : secondPatch.response;
      }
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        if (taskGetCount === 1) return jsonResponse([initialTask]);
        return taskGetCount === 2 ? firstProjection.response : secondProjection.response;
      }
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));
    await waitFor(() => expect(patchCount).toBe(1));

    expect(screen.getByRole('button', { name: '취소', hidden: true })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정', hidden: true }));
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '11:00' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));
    await waitFor(() => expect(patchCount).toBe(2));

    await act(async () => {
      firstPatch.resolve();
      await firstPatch.response;
    });
    await waitFor(() => expect(taskGetCount).toBe(2));
    await act(async () => {
      secondPatch.resolve();
      await secondPatch.response;
    });
    await waitFor(() => expect(taskGetCount).toBe(3));

    await act(async () => {
      secondProjection.resolve();
      await secondProjection.response;
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '과제 기한 설정' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    expect(screen.getByText(/현재 일정: 매일 11:00/)).toBeTruthy();

    await act(async () => {
      firstProjection.resolve();
      await firstProjection.response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText(/현재 일정: 매일 11:00/)).toBeTruthy();
    expect(screen.queryByText(/현재 일정: 매일 10:00/)).toBeNull();
  });

  it('ignores an older assignment status response after the same task is closed and reopened', async () => {
    const first = deferredResponse({
      taskId: 'T001',
      students: [
        { studentId: 'S001', name: '김민준', assigned: true, completed: false },
        { studentId: 'S002', name: '이서연', assigned: false, completed: false },
      ],
    });
    const second = deferredResponse({
      taskId: 'T001',
      students: [
        { studentId: 'S001', name: '김민준', assigned: true, completed: false },
        { studentId: 'S002', name: '이서연', assigned: true, completed: true },
      ],
    });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let assignmentGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks/T001/assignments' && !init?.method) {
        assignmentGetCount += 1;
        return assignmentGetCount === 1 ? first.response : second.response;
      }
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect(assignmentGetCount).toBe(2);

    await act(async () => {
      second.resolve();
      await second.response;
    });
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('완료');

    await act(async () => {
      first.resolve();
      await first.response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toContain('부여');
    expect(screen.getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toContain('완료');
  });

  it('does not show an assignment modal or alert for an error from a closed request', async () => {
    const staleError = deferredResponse({ error: '뒤늦은 부여 조회 오류' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => (
      String(input) === '/api/tasks/T001/assignments' && !init?.method ? staleError.response : fallback(input, init)
    ));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    await act(async () => {
      staleError.resolve();
      await staleError.response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog', { name: '과제 부여' })).toBeNull();
    expect(alert).not.toHaveBeenCalledWith('뒤늦은 부여 조회 오류');
  });

  it('ignores a closed history request and displays a later history error', async () => {
    const taskRows = [{ ...tasks[0], taskInstanceId: 'i1', schedule: { ruleVersion: 1, effectiveFrom: '2026-08-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false } }, { ...tasks[1], taskInstanceId: 'i2' }];
    const first = deferredResponse({ taskId: 'T001', currentLifecycle: { taskDefinitionExists: true, taskInstanceId: 'i1', currentCycleStatus: null }, cumulativeHistory: { eventCount: 0, lifecycles: [] } });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(taskRows);
      if (url === '/api/tasks/T001/history') return first.response;
      if (url === '/api/tasks/T002/history') return jsonResponse({ error: '기록 서버 오류' }, { status: 500 });
      return fallback(input, init);
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기록 보기' }));
    expect(screen.getByRole('status', { name: '과제 기록 불러오는 중' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog', { name: '과제 기록' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'T002 기록 보기' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('기록 서버 오류');
  });

  it('reconciles a schedule PATCH only from a fresh task-list cycle projection', async () => {
    const oldTask = {
      ...tasks[0],
      schedule: { ruleVersion: 1, effectiveFrom: '2026-08-25T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'WEEKLY', weekdays: [2], time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      currentCycle: { cycleId: 'old-cycle', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: ['S001'], students: [{ studentId: 'S001', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }] },
    } as const;
    const freshTask = {
      ...oldTask,
      schedule: { ...oldTask.schedule, ruleVersion: 2, recurrence: { type: 'MONTHLY', dayOfMonth: 31, time: '17:45' } },
      currentCycle: { ...oldTask.currentCycle, cycleId: 'fresh-cycle', startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-30T08:45:00.000Z', completedStudentIds: [], students: [{ studentId: 'S001', assigned: true, completed: false, assignmentOrigin: 'CARRY', completionOrigin: 'DEFAULT' }] },
    } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse([taskGetCount === 1 ? oldTask : freshTask]);
      }
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') return jsonResponse(oldTask);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'MONTHLY' } });
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '17:45' } });
    fireEvent.change(screen.getByLabelText('반복 날짜'), { target: { value: '31' } });
    expect(screen.getByText('29/30/31일이 없는 달은 해당 월 말일로 당겨집니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 저장' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    expect(await screen.findByText(/현재 일정: 매월 31일 17:45/)).toBeTruthy();
  });

  it('confirms resets with both reward warnings and replaces stale completion projection', async () => {
    const staleTask = {
      ...tasks[0],
      currentCycle: { cycleId: 'cycle-1', startsAt: '2026-08-25T00:00:00.000Z', endsAt: null, transition: 'PERMANENT', assignedStudentIds: ['S001'], completedStudentIds: ['S001'], students: [{ studentId: 'S001', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }] },
    } as const;
    const resetTask = { ...staleTask, currentCycle: { ...staleTask.currentCycle, completedStudentIds: [], students: [{ ...staleTask.currentCycle.students[0], completed: false, completionOrigin: 'DEFAULT' }] } } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGetCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks?includeInactive=1') {
        taskGetCount += 1;
        return jsonResponse([taskGetCount === 1 ? staleTask : resetTask]);
      }
      if (url === '/api/tasks/completions/reset' && init?.method === 'POST') return jsonResponse({ taskIds: ['T001'], deletedCount: 1 });
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(within(confirmation).getByText(/과거 지급 보상은 회수되지 않습니다/)).toBeTruthy();
    expect(within(confirmation).getByText(/같은 회차에서 은행으로 다시 완료하면 재보상될 수 있습니다/)).toBeTruthy();
    expect(baseFetch.mock.calls.some(([url, init]) => String(url) === '/api/tasks/completions/reset' && init?.method === 'POST')).toBe(false);
    fireEvent.click(within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' }));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(screen.queryByText(/S001 부여/)).toBeNull();
  });

  it('keeps task rows compact and moves themed schedule details into the recurrence modal', async () => {
    const recurringTask = {
      ...tasks[0],
      schedule: { ruleVersion: 2, effectiveFrom: '2026-08-25T00:00:00.000Z', timeZone: 'Europe/Paris', recurrence: { type: 'WEEKLY', weekdays: [2], time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      currentCycle: { cycleId: 'cycle-1', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001'], completedStudentIds: [], students: [{ studentId: 'S001', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' }] },
    } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') return jsonResponse([recurringTask]);
      if (String(input) === '/api/settings' && !init?.method) return jsonResponse({ spreadsheetId: 'sheet', currencyUnit: '별', themeColor: 'black' });
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    const row = (await screen.findByTestId('task-row'));
    expect(within(row).getByRole('button', { name: 'T001 기한 설정' }).textContent).toBe('기한');
    expect(within(row).getByRole('button', { name: 'T001 기록 보기' }).textContent).toBe('기록');
    expect(within(row).queryByText(/현재 일정:|현재 회차:|다음 자연 경계:|S001 부여/)).toBeNull();
    expect(screen.getByRole('button', { name: '새 과제 기한 설정' }).textContent).toBe('기한 설정');

    fireEvent.click(within(row).getByRole('button', { name: 'T001 기한 설정' }));
    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(within(dialog).getByText(/현재 일정: 매주 화 09:00/)).toBeTruthy();
    expect(within(dialog).getByText(/현재 회차:/)).toBeTruthy();
    expect(within(dialog).getByText(/다음 자연 경계:/)).toBeTruthy();
    expect(within(dialog).getByText(/초기화 대상: 완료 상태 초기화/)).toBeTruthy();
    expect(within(dialog).queryByLabelText('과제 시간대')).toBeNull();
    expect(dialog.innerHTML).not.toContain('violet-');
    expect(dialog.innerHTML).toContain('bg-[var(--theme-surface-raised)]');
  });

  it('disables assignment save while status GET is pending and explains admin completion reward behavior', async () => {
    const pending = deferredResponse({ taskId: 'T001', students: [] });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001/assignments' && !init?.method ? pending.response : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect(screen.getByRole('button', { name: '과제 부여 저장' })).toHaveProperty('disabled', true);
    expect(screen.getByText('관리자 완료는 보상 없이 표시됩니다.')).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: '과제 부여 저장' })).toHaveProperty('disabled', false));
  });

  it('opens bulk recurrence blank, names the snapshotted targets, and sends one batch request', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/schedules/batch' && init?.method === 'POST'
      ? jsonResponse({ updatedTaskIds: ['T001', 'T002'] })
      : fallback(input, init));
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 기한' }));

    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(within(dialog).getByText('대상: 책 읽기, 수학 학습지').getAttribute('title')).toBe('책 읽기, 수학 학습지');
    expect(within(dialog).getByText(/선택한 모든 과제에 같은 반복 설정/)).toBeTruthy();
    expect(within(dialog).getByLabelText('반복 주기')).toHaveProperty('value', '');
    expect(within(dialog).queryByLabelText('반복 시간')).toBeNull();
    expect(within(dialog).queryByLabelText('반복 요일')).toBeNull();
    expect(within(dialog).queryByLabelText('반복 날짜')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '기한 설정 저장' })).toHaveProperty('disabled', true);
    expect(baseFetch.mock.calls.some(([url]) => String(url).includes('/assignments'))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(within(dialog).getByLabelText('반복 시간'), { target: { value: '10:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '기한 설정 저장' }));
    await waitFor(() => expect(baseFetch.mock.calls.filter(([url, init]) => String(url) === '/api/tasks/schedules/batch' && init?.method === 'POST')).toHaveLength(1));
    const call = baseFetch.mock.calls.find(([url]) => String(url) === '/api/tasks/schedules/batch')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      taskIds: ['T001', 'T002'],
      schedule: { recurrence: { type: 'DAILY', time: '10:30' }, timeZone: 'Asia/Seoul', resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    });
  });

  it('requires an explicit weekday or month day for bulk recurrence', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 기한' }));
    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    const save = within(dialog).getByRole('button', { name: '기한 설정 저장' });

    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'WEEKLY' } });
    expect(within(dialog).getByRole('button', { name: '수요일' }).getAttribute('aria-pressed')).toBe('false');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('반복 시간'), { target: { value: '09:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '수요일' }));
    expect(within(dialog).getByRole('button', { name: '수요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(save).toHaveProperty('disabled', false);

    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'MONTHLY' } });
    expect(within(dialog).getByLabelText('반복 날짜')).toHaveProperty('value', '');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('반복 날짜'), { target: { value: '15' } });
    expect(save).toHaveProperty('disabled', false);
  });

  it('sends grouped ADMIN operations and retries only exact sparse failed pairs', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let postCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        postCount += 1;
        return postCount === 1
          ? jsonResponse({
            appliedCount: 1,
            aborted: true,
            failures: [{ taskId: 'T001', studentId: 'S001', code: 'OPERATION_FAILED' }],
            notAttempted: [{ taskId: 'T002', studentId: 'S002' }],
            warnings: [{ taskId: 'T001', code: 'LEGACY_MIRROR_UPDATE_FAILED' }],
          })
          : jsonResponse({ appliedCount: 2, failures: [] });
      }
      return fallback(input, init);
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));

    const dialog = screen.getByRole('dialog', { name: '과제 부여' });
    expect(within(dialog).getByText('대상: 책 읽기, 수학 학습지')).toBeTruthy();
    expect(within(dialog).getByText(/선택한 모든 과제에 같은 과제 부여 변경/)).toBeTruthy();
    expect(within(dialog).getByText(/기존 설정은 불러오지 않으며, 명시한 항목만 변경/)).toBeTruthy();
    expect(within(dialog).getByLabelText('S001 김민준 부여 작업')).toHaveProperty('value', '');
    expect(within(dialog).getByRole('button', { name: '과제 부여 저장' })).toHaveProperty('disabled', true);
    expect(baseFetch.mock.calls.some(([url]) => /\/api\/tasks\/T00\d\/assignments/.test(String(url)))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.change(within(dialog).getByLabelText('S002 이서연 완료 작업'), { target: { value: 'completed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringMatching(/중단.*책 읽기.*김민준.*수학 학습지.*이서연.*호환/)));
    const firstCall = baseFetch.mock.calls.find(([url]) => String(url) === '/api/tasks/assignments/batch')!;
    expect(JSON.parse(String(firstCall[1]?.body))).toEqual({ targets: [
      { taskId: 'T001', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
        { studentId: 'S002', completed: true, source: 'ADMIN' },
      ] },
      { taskId: 'T002', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
        { studentId: 'S002', completed: true, source: 'ADMIN' },
      ] },
    ] });

    fireEvent.click(within(dialog).getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/assignments/batch')).toHaveLength(2));
    const retryCall = baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/assignments/batch')[1];
    expect(JSON.parse(String(retryCall[1]?.body))).toEqual({ targets: [
      { taskId: 'T001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] },
      { taskId: 'T002', operations: [{ studentId: 'S002', completed: true, source: 'ADMIN' }] },
    ] });
  });

  it('applies selected-student bulk controls to explicit row operations and save state', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));
    const dialog = screen.getByRole('dialog', { name: '과제 부여' });
    const save = within(dialog).getByRole('button', { name: '과제 부여 저장' });
    fireEvent.click(within(dialog).getByLabelText('S001 김민준 행 선택'));
    fireEvent.click(within(dialog).getByLabelText('S002 이서연 행 선택'));

    fireEvent.change(within(dialog).getByLabelText('선택 학생 부여 상태 일괄 변경'), { target: { value: 'unassigned' } });
    expect(within(dialog).getByLabelText('S001 김민준 부여 작업')).toHaveProperty('value', 'unassigned');
    expect(within(dialog).getByLabelText('S002 이서연 부여 작업')).toHaveProperty('value', 'unassigned');
    expect(save).toHaveProperty('disabled', false);
    fireEvent.change(within(dialog).getByLabelText('선택 학생 완료 여부 일괄 변경'), { target: { value: 'completed' } });
    expect(within(dialog).getByLabelText('S001 김민준 완료 작업')).toHaveProperty('value', 'completed');
    expect(within(dialog).getByLabelText('S002 이서연 완료 작업')).toHaveProperty('value', 'completed');
  });

  it('keeps a newer recurrence dialog open when an older save completes', async () => {
    const pending = deferredResponse({ updatedTaskIds: ['T001', 'T002'] });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/schedules/batch' && init?.method === 'POST' ? pending.response : fallback(input, init));
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 기한' }));
    let dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(within(dialog).getByLabelText('반복 시간'), { target: { value: '09:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '기한 설정 저장' }));
    expect(within(dialog).getByRole('button', { name: '취소', hidden: true })).toHaveProperty('disabled', true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '기한 설정 저장 중' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'T002 기한 설정', hidden: true }));
    dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(within(dialog).getByText('대상: 수학 학습지')).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: '과제 기한 설정' })).getByText('대상: 수학 학습지')).toBeTruthy());
  });

  it('makes assignment inert under reset confirmation, traps focus, and restores the reset opener on cancel', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    const assignment = screen.getByRole('dialog', { name: '과제 부여' });
    const resetOpener = within(assignment).getByRole('button', { name: '완료 기록 초기화' });
    fireEvent.click(resetOpener);

    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(assignment.getAttribute('aria-hidden')).toBe('true');
    expect(assignment.hasAttribute('inert')).toBe(true);
    const confirm = within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' });
    const cancel = within(confirmation).getByRole('button', { name: '취소' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirmation, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(confirmation, { key: 'Tab' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull();
    expect(assignment.hasAttribute('aria-hidden')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(resetOpener));
  });

  it('exposes only a focus-trapped loading modal while assignment save is pending and restores focus on failure', async () => {
    const pending = deferredResponse({ error: '저장 실패' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST'
      ? pending.response
      : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));
    const assignment = screen.getByRole('dialog', { name: '과제 부여' });
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    const save = within(assignment).getByRole('button', { name: '과제 부여 저장' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Enter' });
    fireEvent.click(save);

    const loading = await screen.findByRole('dialog', { name: '변경 사항 저장 중' });
    expect(screen.getAllByRole('dialog')).toEqual([loading]);
    expect(assignment.getAttribute('aria-hidden')).toBe('true');
    expect(assignment.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(loading);
    fireEvent.keyDown(loading, { key: 'Tab' });
    expect(document.activeElement).toBe(loading);
    fireEvent.keyDown(loading, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '변경 사항 저장 중' })).toBe(loading);

    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '과제 부여' })).toBe(assignment);
    expect(document.activeElement).toBe(save);
  });

  it('locks every recurrence control behind the only accessible loading modal while schedule save is pending', async () => {
    const pending = deferredResponse({ error: '일정 저장 실패' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/schedules/batch' && init?.method === 'POST'
      ? pending.response
      : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 기한' }));
    const recurrence = screen.getByRole('dialog', { name: '과제 기한 설정' });
    fireEvent.change(within(recurrence).getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    fireEvent.change(within(recurrence).getByLabelText('반복 시간'), { target: { value: '09:30' } });
    const save = within(recurrence).getByRole('button', { name: '기한 설정 저장' });
    save.focus();
    fireEvent.click(save);

    const loading = await screen.findByRole('dialog', { name: '기한 설정 저장 중' });
    expect(screen.getAllByRole('dialog')).toEqual([loading]);
    expect(recurrence.getAttribute('aria-hidden')).toBe('true');
    expect(recurrence.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(loading);
    for (const control of within(recurrence).getAllByRole('combobox', { hidden: true }).concat(within(recurrence).getAllByRole('checkbox', { hidden: true }))) {
      expect(control.closest('[inert]')).toBe(recurrence);
    }
    fireEvent.keyDown(loading, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(loading);

    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '기한 설정 저장 중' })).toBeNull());
    expect(document.activeElement).toBe(save);
  });

  it('uses real batch failure codes, names failed task/student pairs, and reports mirror warnings without plain success', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let postCount = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        postCount += 1;
        return postCount === 1
          ? jsonResponse({ appliedCount: 3, failures: [{ taskId: 'T002', studentId: 'S001', code: 'OPERATION_FAILED' }] })
          : jsonResponse({ appliedCount: 1, failures: [], warnings: [{ taskId: 'T002', code: 'LEGACY_MIRROR_UPDATE_FAILED' }] });
      }
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));
    const assignment = screen.getByRole('dialog', { name: '과제 부여' });
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.click(within(assignment).getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringMatching(/수학 학습지.*김민준.*작업 실패/)));

    fireEvent.click(within(assignment).getByRole('button', { name: '과제 부여 저장' }));
    await waitFor(() => expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/assignments/batch')).toHaveLength(2));
    const retryBody = JSON.parse(String(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/assignments/batch')[1][1]?.body));
    expect(retryBody).toEqual({ targets: [{ taskId: 'T002', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] }] });
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringMatching(/저장은 완료.*기존 호환 목록.*수학 학습지.*새로고침/)));
    expect(alert).not.toHaveBeenCalledWith('과제 부여 저장 완료');
  });

  it('closes a committed assignment draft and reports refresh-only recovery without reposting', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGets = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') {
        taskGets += 1;
        return taskGets === 1 ? jsonResponse(tasks) : jsonResponse({ error: 'projection down' }, { status: 503 });
      }
      if (String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST') return jsonResponse({ appliedCount: 2, failures: [] });
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));
    const assignment = screen.getByRole('dialog', { name: '과제 부여' });
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.click(within(assignment).getByRole('button', { name: '과제 부여 저장' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '과제 부여' })).toBeNull());
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/과제 부여 저장은 완료됐지만.*목록 새로고침 실패.*새로고침/));
    expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/assignments/batch')).toHaveLength(1);
  });

  it('does not re-enable reset after its POST succeeds when projection refresh fails', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGets = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') {
        taskGets += 1;
        return taskGets === 1 ? jsonResponse(tasks) : jsonResponse({ error: 'projection down' }, { status: 503 });
      }
      if (String(input) === '/api/tasks/completions/reset' && init?.method === 'POST') return jsonResponse({ taskIds: ['T001'], deletedCount: 1 });
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: '과제 부여' })).toBeNull();
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/초기화는 완료됐지만 목록 새로고침 실패.*새로고침/));
    expect(baseFetch.mock.calls.filter(([url, init]) => String(url) === '/api/tasks/completions/reset' && init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps a newer assignment session usable when an older save completes', async () => {
    const pending = deferredResponse({ appliedCount: 2, failures: [] });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST'
      ? pending.response
      : fallback(input, init));

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 과제 부여' }));
    let assignment = screen.getByRole('dialog', { name: '과제 부여' });
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.click(within(assignment).getByRole('button', { name: '과제 부여 저장' }));
    await screen.findByRole('dialog', { name: '변경 사항 저장 중' });

    fireEvent.click(screen.getByRole('button', { name: 'T002 과제 부여', hidden: true }));
    assignment = screen.getByRole('dialog', { name: '과제 부여' });
    expect(within(assignment).getByText('대상: 수학 학습지')).toBeTruthy();
    expect(within(assignment).getByRole('button', { name: '과제 부여 저장' })).toHaveProperty('disabled', true);

    pending.resolve();
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: '과제 부여' })).getByText('대상: 수학 학습지')).toBeTruthy());
  });

  it('relocates reset into assignment, confirms in-app, locks mutation, and refreshes tasks once', async () => {
    const reset = deferredResponse({ taskIds: ['T001'], deletedCount: 1 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    let taskGets = 0;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') {
        taskGets += 1;
        return jsonResponse(tasks);
      }
      if (String(input) === '/api/tasks/completions/reset' && init?.method === 'POST') return reset.response;
      return fallback(input, init);
    });
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    expect(screen.queryByRole('button', { name: 'T001 완료 기록 초기화' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '완료 기록 초기화' }));
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(within(confirmation).getByText(/과거 지급 보상은 회수되지 않/)).toBeTruthy();
    expect(within(confirmation).getByText(/다시 완료하면 재보상/)).toBeTruthy();
    expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/completions/reset')).toHaveLength(0);
    const confirmReset = within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' });
    fireEvent.click(confirmReset);
    fireEvent.click(confirmReset);
    expect(confirmReset).toHaveProperty('disabled', true);
    expect(baseFetch.mock.calls.filter(([url]) => String(url) === '/api/tasks/completions/reset')).toHaveLength(1);
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '완료 기록 초기화 중' })).toBeTruthy();
    reset.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '완료 기록 초기화' })));
    expect(taskGets).toBe(2);
  });

  it('keeps the task deadline dialog within the mobile viewport and makes time controls shrink safely', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));

    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog.className).toContain('overflow-y-auto');
    expect(dialog.className).toContain('overflow-x-hidden');
    expect(dialog.className).toContain('overscroll-contain');
    expect(dialog.className).toContain('max-w-full');
    expect(dialog.className).toContain('min-w-0');

    for (const input of [within(dialog).getByLabelText('시작 시각'), within(dialog).getByLabelText('기한')]) {
      expect(input.parentElement?.className).toContain('min-w-0');
      expect(input.parentElement?.className).toContain('max-w-full');
      expect(input.className).toContain('min-w-0');
      expect(input.className.split(/\s+/)).toContain('w-full');
      expect(input.className).toContain('max-w-full');
      expect(input.className).toContain('text-base');
    }

    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'DAILY' } });
    const recurrenceTime = within(dialog).getByLabelText('반복 시간');
    const recurrenceShell = recurrenceTime.closest('[data-testid="task-recurrence-mobile-fields"]');
    expect(recurrenceShell).toBeTruthy();
    expect(recurrenceShell?.className).toContain('min-w-0');
    expect(recurrenceShell?.className).toContain('max-w-full');
    expect(recurrenceShell?.className).toContain('[&_input]:min-w-0');
    expect(recurrenceShell?.className).toContain('[&_input]:max-w-full');
    expect(recurrenceShell?.className).toContain('[&_input]:text-base');
  });

  it('places each availability badge to the left of its title input on the same row', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    const row = (await screen.findAllByTestId('task-row'))[0];
    const badge = within(row).getByText('진행 중');
    const titleInput = within(row).getByLabelText('T001 과제명');
    const titleRow = badge.parentElement;
    const inputWrapper = titleInput.closest('[data-testid="task-title-input-wrapper"]');

    expect(titleRow?.className).toContain('flex');
    expect(titleRow?.className).toContain('items-center');
    expect(titleRow?.className).toContain('min-w-0');
    expect(badge.className).toContain('shrink-0');
    expect(badge.className).toContain('whitespace-nowrap');
    expect(inputWrapper).toBeTruthy();
    expect(inputWrapper?.className).toContain('min-w-0');
    expect(inputWrapper?.className).toContain('flex-1');
    expect(badge.compareDocumentPosition(titleInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.className).toContain('grid-cols-[24px_minmax(5rem,1fr)_64px_48px_38px_minmax(3rem,0.7fr)_minmax(180px,auto)]');
  });

  it('edits availability, prerequisite, recurrence and shows clear admin status badges', async () => {
    const datedTasks = [
      { ...tasks[0], availableFrom: '2000-01-01T00:00:00Z', dueAt: '2999-01-01T00:00:00Z' },
      { ...tasks[1], availableFrom: '2999-01-01T00:00:00Z' },
      { ...tasks[0], taskId: 'T003', title: '만료 과제', dueAt: '2000-01-01T00:00:00Z' },
      { ...tasks[0], taskId: 'T004', title: '비활성 과제', isActive: false },
    ];
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') return jsonResponse(datedTasks);
      if (String(input) === '/api/tasks/T001' && init?.method === 'PATCH') return jsonResponse(datedTasks[0]);
      return fallback(input, init);
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    expect(screen.getByText('진행 중')).toBeTruthy();
    expect(screen.getByText('시작 전')).toBeTruthy();
    expect(screen.getByText('기한 만료')).toBeTruthy();
    expect(screen.getByText('수동 비활성')).toBeTruthy();
    expect(screen.getByRole('button', { name: '새 과제 기한 설정' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(within(dialog).getByRole('heading', { name: '기한 설정' })).toBeTruthy();
    expect(within(dialog).getByLabelText('시작 시각')).toHaveProperty('type', 'datetime-local');
    expect(within(dialog).getByLabelText('기한')).toHaveProperty('type', 'datetime-local');
    expect(within(dialog).getByLabelText('선행 과제')).toBeTruthy();
    expect(within(within(dialog).getByLabelText('선행 과제')).queryByRole('option', { name: '비활성 과제' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('시작 시각'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(within(dialog).getByLabelText('선행 과제'), { target: { value: 'T002' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '기한 설정 저장' }));

    await waitFor(() => expect(baseFetch).toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' })));
    const call = baseFetch.mock.calls.find(([url, init]) => String(url) === '/api/tasks/T001' && init?.method === 'PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ availableFrom: null, dueAt: '2030-01-02T03:30:00.000Z', prerequisiteTaskId: 'T002' });
  });

  it('uses multi-select weekday buttons in the bulk deadline dialog and excludes prerequisite', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 기한' }));
    const dialog = screen.getByRole('dialog', { name: '과제 기한 설정' });
    expect(within(dialog).queryByLabelText('선행 과제')).toBeNull();
    expect(within(dialog).getByText(/선행 과제는 개별 과제/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('반복 주기'), { target: { value: 'WEEKLY' } });
    const weekdays = within(dialog).getByRole('group', { name: '반복 요일' });
    fireEvent.click(within(weekdays).getByRole('button', { name: '목요일' }));
    expect(within(weekdays).getByRole('button', { name: '월요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(weekdays).getByRole('button', { name: '목요일' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not copy a new-task deadline draft into an existing task editor', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '새 과제 기한 설정' }));
    fireEvent.change(screen.getByLabelText('시작 시각'), { target: { value: '2030-01-01T10:00' } });
    fireEvent.change(screen.getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(screen.getByLabelText('선행 과제'), { target: { value: 'T002' } });
    fireEvent.click(screen.getByRole('button', { name: '기한 설정 적용' }));

    fireEvent.click(screen.getByRole('button', { name: 'T001 기한 설정' }));
    expect(screen.getByLabelText('시작 시각')).toHaveProperty('value', '');
    expect(screen.getByLabelText('기한')).toHaveProperty('value', '');
    expect(screen.getByLabelText('선행 과제')).toHaveProperty('value', '');
  });
});
