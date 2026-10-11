import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminManagePage,
  getProductExpectedVersion,
  parseProductAdminEnvelope,
} from './AdminManagePage';
import { THEME_PALETTES } from './uiTheme';
import {
  confirmDialog,
  findNotice,
  findTaskRow,
  openAdminMenu,
  openNewProductEditor,
  openNewStudentEditor,
  openNewTaskEditor,
  openProductEditor,
  openStudentEditor,
  openTaskEditor,
  selectionBar,
  taskEditorPanel,
} from './testing/adminUi';

const students = [
  { studentId: 'S001', name: '김민준', balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', balance: 1500, status: 'ACTIVE' },
];
const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 19, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 },
];
function adminProductEnvelope(
  rows = products,
  versions = rows.map((_, index) => index + 11),
) {
  return {
    products: rows,
    mutationPreconditions: rows.map((product, index) => ({
      productId: product.productId,
      expectedVersion: versions[index],
    })),
  };
}
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

/** Opens the 과제 tab and waits for the seeded task rows. */
async function renderTasks(title = '책 읽기') {
  render(<AdminManagePage />);
  await openAdminMenu('과제');
  await findTaskRow(title);
}

function fetchCalls(url: string, method?: string) {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === url
    && (method === undefined || (init?.method ?? 'GET') === method));
}

function lastBody(url: string, method: string) {
  const calls = fetchCalls(url, method);
  return JSON.parse(String(calls.at(-1)?.[1]?.body ?? 'null'));
}

function noticeTexts() {
  return [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')].map((node) => node.textContent ?? '');
}

function deferredResponse(payload: unknown, init?: ResponseInit) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return { resolve, response: gate.then(() => jsonResponse(payload, init)) };
}

describe('parseProductAdminEnvelope', () => {
  const product = (overrides: Record<string, unknown> = {}) => ({
    productId: 'P001',
    name: '연필',
    price: 300,
    stock: 19,
    isActive: true,
    sortOrder: 1,
    ...overrides,
  });
  const envelope = (rows: unknown[], versions?: unknown[]) => ({
    products: rows,
    mutationPreconditions: rows.map((row, index) => ({
      productId: (row as { productId?: unknown }).productId,
      expectedVersion: versions?.[index] ?? index + 1,
    })),
  });

  it('accepts empty envelopes and optional product text both absent and present', () => {
    const empty = parseProductAdminEnvelope({ products: [], mutationPreconditions: [] });
    expect(empty.products).toEqual([]);
    expect([...empty.mutationPreconditions]).toEqual([]);

    const parsed = parseProductAdminEnvelope(envelope([
      product(),
      product({ productId: 'P002', imageUrl: '', category: '문구' }),
    ], [7, 8]));
    expect(parsed.products).toEqual([
      product(),
      product({ productId: 'P002', imageUrl: '', category: '문구' }),
    ]);
    expect([...parsed.mutationPreconditions]).toEqual([['P001', 7], ['P002', 8]]);
    expect(getProductExpectedVersion(parsed, 'P002')).toBe(8);
  });

  it('returns freshly detached products and a fresh precondition map', () => {
    const source = envelope([product({ imageUrl: 'before' })], [9]);
    const parsed = parseProductAdminEnvelope(source);
    source.products[0] = product({ imageUrl: 'after' });
    source.mutationPreconditions[0].expectedVersion = 10;
    expect(parsed.products[0]).toEqual(product({ imageUrl: 'before' }));
    expect(getProductExpectedVersion(parsed, 'P001')).toBe(9);
  });

  it.each([
    ['missing outer key', { products: [] }],
    ['extra outer key', { products: [], mutationPreconditions: [], extra: true }],
    ['custom outer prototype', Object.assign(Object.create(null), { products: [], mutationPreconditions: [] })],
  ])('rejects %s', (_label, value) => {
    expect(() => parseProductAdminEnvelope(value)).toThrow();
  });

  it('rejects symbol outer keys and accessors without invoking their hooks', () => {
    const withSymbol = { products: [], mutationPreconditions: [], [Symbol('extra')]: true };
    expect(() => parseProductAdminEnvelope(withSymbol)).toThrow();

    let hooks = 0;
    const withGetter = { mutationPreconditions: [] } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'products', {
      enumerable: true,
      configurable: true,
      get() { hooks += 1; return []; },
    });
    expect(() => parseProductAdminEnvelope(withGetter)).toThrow();
    expect(hooks).toBe(0);
  });

  it.each([
    ['sparse products', (() => { const value = [product(), product({ productId: 'P002' })]; delete value[0]; return value; })()],
    ['decorated products', Object.assign([product()], { extra: true })],
    ['exotic products', Object.setPrototypeOf([product()], Object.create(Array.prototype))],
    ['sparse preconditions', (() => { const value = [{ productId: 'P001', expectedVersion: 1 }]; delete value[0]; return value; })()],
    ['decorated preconditions', Object.assign([{ productId: 'P001', expectedVersion: 1 }], { extra: true })],
    ['exotic preconditions', Object.setPrototypeOf([{ productId: 'P001', expectedVersion: 1 }], Object.create(Array.prototype))],
  ])('rejects %s arrays', (label, array) => {
    const value = label.includes('products')
      ? { products: array, mutationPreconditions: [{ productId: 'P001', expectedVersion: 1 }] }
      : { products: [product()], mutationPreconditions: array };
    expect(() => parseProductAdminEnvelope(value)).toThrow();
  });

  it('rejects noncanonical array descriptors', () => {
    const rows = [product()];
    Object.defineProperty(rows, '0', { value: rows[0], enumerable: false, writable: true, configurable: true });
    expect(() => parseProductAdminEnvelope({
      products: rows,
      mutationPreconditions: [{ productId: 'P001', expectedVersion: 1 }],
    })).toThrow();
  });

  it.each([
    ['missing field', (() => { const value = product(); delete (value as { stock?: unknown }).stock; return value; })()],
    ['extra field', product({ extra: true })],
    ['custom prototype', Object.assign(Object.create(null), product())],
    ['blank id', product({ productId: '' })],
    ['untrimmed id', product({ productId: ' P001' })],
    ['blank name', product({ name: ' ' })],
    ['boxed name', product({ name: new String('연필') })],
    ['negative price', product({ price: -1 })],
    ['unsafe price', product({ price: Number.MAX_SAFE_INTEGER + 1 })],
    ['fractional stock', product({ stock: 1.5 })],
    ['boxed active', product({ isActive: new Boolean(true) })],
    ['sort order below int32', product({ sortOrder: -2147483649 })],
    ['sort order above int32', product({ sortOrder: 2147483648 })],
    ['boxed optional text', product({ imageUrl: new String('image') })],
  ])('rejects malformed product: %s', (_label, row) => {
    expect(() => parseProductAdminEnvelope(envelope([row]))).toThrow();
  });

  it('rejects product accessors without invoking them', () => {
    let hooks = 0;
    const row = product();
    Object.defineProperty(row, 'name', {
      enumerable: true,
      configurable: true,
      get() { hooks += 1; return '연필'; },
    });
    expect(() => parseProductAdminEnvelope(envelope([row]))).toThrow();
    expect(hooks).toBe(0);
  });

  it('rejects duplicate product IDs', () => {
    expect(() => parseProductAdminEnvelope(envelope([product(), product()]))).toThrow();
  });

  it.each([
    ['count mismatch', { products: [product()], mutationPreconditions: [] }],
    ['order mismatch', {
      products: [product(), product({ productId: 'P002' })],
      mutationPreconditions: [{ productId: 'P002', expectedVersion: 1 }, { productId: 'P001', expectedVersion: 2 }],
    }],
    ['identity mismatch', {
      products: [product()],
      mutationPreconditions: [{ productId: 'P999', expectedVersion: 1 }],
    }],
    ['duplicate precondition IDs', {
      products: [product(), product({ productId: 'P002' })],
      mutationPreconditions: [{ productId: 'P001', expectedVersion: 1 }, { productId: 'P001', expectedVersion: 2 }],
    }],
    ['zero version', envelope([product()], [0])],
    ['max safe version', envelope([product()], [Number.MAX_SAFE_INTEGER])],
    ['boxed version', envelope([product()], [new Number(1)])],
  ])('rejects malformed preconditions: %s', (_label, value) => {
    expect(() => parseProductAdminEnvelope(value)).toThrow();
  });

  it('rejects precondition extras and accessors without invoking hooks', () => {
    expect(() => parseProductAdminEnvelope({
      products: [product()],
      mutationPreconditions: [{ productId: 'P001', expectedVersion: 1, extra: true }],
    })).toThrow();

    let hooks = 0;
    const precondition = { productId: 'P001' } as Record<string, unknown>;
    Object.defineProperty(precondition, 'expectedVersion', {
      enumerable: true,
      configurable: true,
      get() { hooks += 1; return 1; },
    });
    expect(() => parseProductAdminEnvelope({ products: [product()], mutationPreconditions: [precondition] })).toThrow();
    expect(hooks).toBe(0);
  });
});

describe('AdminManagePage', () => {
  beforeEach(() => {
    let t001AssignmentStatus = [
      { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'EVENT', assignmentSource: 'QR' },
      { studentId: 'S002', name: '이서연', assigned: false, completed: false, assignmentOrigin: 'EVENT', assignmentSource: 'ADMIN' },
    ];
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
    let qrBlobNumber = 0;
    // Preserve the URL constructor for deferred modules resolved by the test runner.
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:manage-qr-${++qrBlobNumber}`);
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('50000000-0000-4000-8000-000000000001');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/students') {
          if (init?.method === 'POST') return jsonResponse({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });
          return jsonResponse(students);
        }
        if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
        if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
        if (url === '/api/promotions') return jsonResponse({ promotions: [], mutationPreconditions: [] });
        if (url === '/api/transactions') return jsonResponse(transactions);
        if (url.startsWith('/api/bank/student?studentId=')) {
          const scanned = decodeURIComponent(url.slice(url.indexOf('=') + 1));
          const studentId = scanned.startsWith('csq1.') ? 'S001' : scanned.trim();
          const student = students.find((item) => item.studentId === studentId && item.status === 'ACTIVE');
          return student
            ? jsonResponse({ studentId: student.studentId, name: student.name, balance: student.balance })
            : jsonResponse({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });
        }
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
          const body = JSON.parse(String(init.body)) as { students: Array<{ studentId: string }> };
          return jsonResponse([
            { ...students[0], name: '김민준 수정', balance: 4000 },
            students[1],
          ].filter((student) => body.students.some((entry) => entry.studentId === student.studentId)));
        }
        if (url === '/api/students/batch' && init?.method === 'DELETE') return jsonResponse({ studentIds: ['S001', 'S002'] });
        if (url === '/api/products/batch' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { products: Array<{ productId: string }> };
          return jsonResponse([
            { ...products[0], name: '연필 세트', price: 900, imageUrl: 'https://example.com/new-pencil.png' },
            products[1],
          ].filter((product) => body.products.some((entry) => entry.productId === product.productId)));
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

        if (url === '/api/qrcode' && init?.method === 'POST') return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
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

    await screen.findByRole('heading', { level: 1, name: '학급 매점' });
    expect(screen.queryByRole('tab', { name: '행사 관리' })).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });

    await openAdminMenu('매점');
    const storeTabs = screen.getByRole('tablist', { name: '매점 관리 메뉴' });
    expect(within(storeTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['상품·재고', '행사 관리']);
    expect(within(storeTabs).getByRole('tab', { name: '상품·재고' }).getAttribute('aria-selected')).toBe('true');
    const promotionsTab = within(storeTabs).getByRole('tab', { name: '행사 관리' });
    const initialPromotionsPanel = document.getElementById(promotionsTab.getAttribute('aria-controls')!);
    expect(initialPromotionsPanel).toBeTruthy();
    expect(initialPromotionsPanel?.hidden).toBe(true);
    expect(initialPromotionsPanel?.getAttribute('aria-labelledby')).toBe(promotionsTab.id);
    expect(initialPromotionsPanel?.textContent).toBe('');
    expect(screen.getByRole('button', { name: '상품 추가' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });

    fireEvent.click(promotionsTab);

    expect(await screen.findByRole('tabpanel', { name: '행사 관리' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '행사 만들기' })).toBeTruthy();
    expect(screen.getByLabelText('연필 (P001) 대상')).toBeTruthy();
    expect(screen.getByText('등록된 행사가 없습니다.')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });
  });

  it('links store tabs to panels and supports wrapped roving keyboard navigation without refetching promotions', async () => {
    render(<AdminManagePage />);
    await openAdminMenu('매점');

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
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/promotions')).toHaveLength(1));
  });

  it('exposes stable primary tab/panel relationships with wrapped roving keyboard selection', async () => {
    render(<AdminManagePage />);
    await screen.findByRole('heading', { level: 1, name: '학급 매점' });
    const tablist = screen.getByRole('tablist', { name: '관리자 메뉴' });
    const primaryTabs = within(tablist).getAllByRole('tab');
    const tabKeys = ['home', 'students', 'products', 'tasks', 'pets', 'tree', 'currency', 'transactions', 'settings'];
    expect(primaryTabs.map((tab) => tab.textContent)).toEqual(['홈', '학생', '매점', '과제', '펫 키우기', '나무 키우기', '지급·회수', '거래 내역', '설정']);
    const last = primaryTabs.length - 1;
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
    expect(document.activeElement).toBe(primaryTabs[last]);
    expect(primaryTabs[last].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(primaryTabs[last], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(primaryTabs[0]);
    fireEvent.keyDown(primaryTabs[0], { key: 'End' });
    expect(document.activeElement).toBe(primaryTabs[last]);
    fireEvent.keyDown(primaryTabs[last], { key: 'Home' });
    expect(document.activeElement).toBe(primaryTabs[0]);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/promotions')).toBe(false);
  });

  it('makes the task panel inert for history, closes on Escape, and restores the exact opener', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor: 'black' });
      if (url === '/api/tasks/T001/history') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    await openAdminMenu('과제');
    const panel = await openTaskEditor('책 읽기');
    const background = screen.getByTestId('admin-background');
    expect(background.hasAttribute('inert')).toBe(true);
    const opener = within(panel).getByRole('button', { name: 'T001 기록 보기' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    const close = within(dialog).getByRole('button', { name: '닫기' });
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '과제 기록' })).toBeNull();
    expect(taskEditorPanel('책 읽기').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('confirms a named task deletion without browser confirm and locks duplicate confirmation', async () => {
    const deletion = deferredResponse({ taskId: 'T001' });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001' && init?.method === 'DELETE' ? deletion.response : fallback(input, init));
    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    const opener = within(panel).getByRole('button', { name: 'T001 과제 삭제' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '책 읽기 과제 삭제 확인' });
    expect(within(dialog).getByText(/책 읽기/)).toBeTruthy();
    expect(screen.getByTestId('admin-background').hasAttribute('inert')).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(fetchCalls('/api/tasks/T001', 'DELETE')).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
    const confirmDelete = within(dialog).getByRole('button', { name: '과제 삭제 확인' });
    expect(document.activeElement).toBe(confirmDelete);
    fireEvent.click(confirmDelete);
    fireEvent.click(confirmDelete);
    expect(confirmDelete).toHaveProperty('disabled', true);
    expect(fetchCalls('/api/tasks/T001', 'DELETE')).toHaveLength(1);
    deletion.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 삭제 확인' })).toBeNull());
    await findNotice('T001 과제 삭제 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 편집' })).toBeNull());
    expect(screen.queryByRole('button', { name: '책 읽기 과제 편집' })).toBeNull();
    expect(screen.getByRole('button', { name: '수학 학습지 과제 편집' })).toBeTruthy();
  });

  it('cancels task deletion by button or Escape without a request and restores focus', async () => {
    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    const opener = within(panel).getByRole('button', { name: 'T001 과제 삭제' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '과제 삭제 취소' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '책 읽기 과제 삭제 확인' }), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole('dialog', { name: '책 읽기 과제 삭제 확인' })).toBeNull();
    expect(taskEditorPanel('책 읽기')).toBeTruthy();
    expect(fetchCalls('/api/tasks/T001', 'DELETE')).toHaveLength(0);
  });

  it('keeps a failed task deletion confirmation open and retryable', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001' && init?.method === 'DELETE'
      ? jsonResponse({ error: '삭제 서버 오류' }, { status: 500 })
      : fallback(input, init));
    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    fireEvent.click(within(panel).getByRole('button', { name: 'T001 과제 삭제' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 삭제 확인' }));

    const dialog = await screen.findByRole('dialog', { name: '책 읽기 과제 삭제 확인' });
    await waitFor(() => {
      expect(within(dialog).getByText(/삭제 응답을 확인하지 못했습니다\./)).toBeTruthy();
      expect(dialog.textContent).not.toContain('삭제 서버 오류');
      expect(within(dialog).getByRole('button', { name: '과제 삭제 확인' })).toHaveProperty('disabled', false);
    });
    expect((await findNotice('삭제 응답을 확인하지 못했습니다.')).textContent).not.toContain('삭제 서버 오류');
    expect(screen.getByRole('button', { name: '책 읽기 과제 편집', hidden: true })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '과제 삭제 확인' }));
    await waitFor(() => expect(fetchCalls('/api/tasks/T001', 'DELETE')).toHaveLength(2));
  });

  it('keeps the product draft when switching store subtabs', async () => {
    render(<AdminManagePage />);
    await openAdminMenu('매점');
    const editor = await openNewProductEditor();
    fireEvent.change(within(editor).getByLabelText('새 상품명'), { target: { value: '작성 중인 상품' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '상품 추가' })).toBeNull();

    const storeTabs = screen.getByRole('tablist', { name: '매점 관리 메뉴' });
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '행사 관리' }));
    await screen.findByRole('tabpanel', { name: '행사 관리' });
    fireEvent.change(await screen.findByLabelText('행사명'), { target: { value: '작성 중인 행사' } });
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '상품·재고' }));

    fireEvent.click(screen.getByRole('button', { name: '상품 추가' }));
    // An unsent new-product draft survives closing and reopening the panel.
    expect(within(await screen.findByRole('dialog', { name: '상품 추가' })).getByLabelText('새 상품명')).toHaveProperty('value', '작성 중인 상품');
    fireEvent.keyDown(screen.getByRole('dialog', { name: '상품 추가' }), { key: 'Escape' });
    fireEvent.click(within(storeTabs).getByRole('tab', { name: '행사 관리' }));
    expect(screen.getByLabelText('행사명')).toHaveProperty('value', '작성 중인 행사');
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/promotions')).toHaveLength(1));
  });

  it('lists each task as a read-only row with a selection checkbox and a single editor button', async () => {
    await renderTasks();

    const row = screen.getAllByTestId('task-row')[0];
    expect(within(row).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(row).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(row).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['T001 선택']);
    expect(within(row).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['책 읽기 과제 편집']);
    expect(within(row).getByText('책 읽기')).toBeTruthy();

    const panel = await openTaskEditor('책 읽기');
    expect(within(within(panel).getByRole('tablist', { name: '과제 편집 메뉴' })).getAllByRole('tab').map((tab) => tab.textContent))
      .toEqual(['기본 정보', '반복', '학생 현황']);
    expect(within(panel).getByRole('button', { name: 'T001 기록 보기' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'T001 과제 삭제' })).toBeTruthy();
    expect(within(panel).getByLabelText('T001 과제명')).toHaveProperty('value', '책 읽기');
  });

  it.each([
    ...(['white', 'black', 'navy'] as const).map((name) => [name, THEME_PALETTES[name].shell, THEME_PALETTES[name].surface, THEME_PALETTES[name].border] as const),
  ] as const)('applies semantic %s theme variables to admin-owned surfaces and controls', async (themeColor, shellColor, surfaceColor, borderColor) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/tasks/T001/assignments') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    const shell = await screen.findByTestId('admin-shell');
    expect(shell.className).toContain('bg-[var(--theme-shell)]');
    expect(shell.className).toContain('text-[var(--theme-text)]');
    expect(shell.style.getPropertyValue('--theme-shell')).toBe(shellColor);
    expect(shell.style.getPropertyValue('--theme-surface')).toBe(surfaceColor);
    expect(shell.style.getPropertyValue('--theme-border')).toBe(borderColor);

    await openAdminMenu('학생');
    const editor = await openNewStudentEditor();
    const input = within(editor).getByLabelText('새 학생 이름');
    expect(editor.className).toContain('bg-[var(--theme-surface)]');
    expect(editor.className).toContain('text-[var(--theme-text)]');
    expect(input.className).toContain('bg-[var(--theme-input)]');
    expect(input.className).toContain('text-[var(--theme-text)]');
    expect(`${editor.className} ${input.className}`).not.toMatch(/bg-white|text-slate-(?:950|700)/);
    fireEvent.keyDown(editor, { key: 'Escape' });

    await openAdminMenu('과제');
    const panel = await openTaskEditor('책 읽기', '학생 현황');
    const loading = await within(panel).findByRole('status', { name: '과제 부여 상태 불러오는 중' });
    expect(loading.className).toContain('var(--theme-surface)');
    expect(loading.className).not.toMatch(/bg-white|text-slate-/);
  });

  it.each(['white', 'black', 'navy'] as const)('passes the normalized %s theme into task history dialogs', async (themeColor) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/tasks/T001/history') return new Promise<Response>(() => undefined);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    await openAdminMenu('과제');
    const panel = await openTaskEditor('책 읽기');
    fireEvent.click(within(panel).getByRole('button', { name: 'T001 기록 보기' }));

    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    expect(dialog.style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES[themeColor].shell);
    expect(dialog.className).toContain('border-[var(--theme-border)]');
    expect(dialog.className).toContain('bg-[var(--theme-surface)]');
    expect(dialog.className).toContain('text-[var(--theme-text)]');
    expect(dialog.innerHTML).not.toMatch(/bg-white|bg-slate-|text-slate-|border-slate-/);
  });

  it.each(['white', 'black', 'navy'] as const)('uses semantic %s panel, currency input, and loading/result surfaces', async (themeColor) => {
    const currencyRequest = deferredResponse([{ studentId: 'S001', balance: 3900 }]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor });
      if (url === '/api/bank/student?studentId=S001') return jsonResponse({ studentId: 'S001', name: '김민준', balance: 3200 });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return currencyRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<AdminManagePage />);
    await screen.findByTestId('admin-shell');

    await openAdminMenu('매점');
    const productPanel = await openProductEditor('P001', '연필');
    expect(productPanel.className).toContain('bg-[var(--theme-surface)]');
    expect(productPanel.className).toContain('text-[var(--theme-text)]');
    expect(within(productPanel).getByLabelText('P001 이미지 주소').className).toContain('bg-[var(--theme-input)]');
    expect(productPanel.className).not.toContain('bg-white');
    fireEvent.click(within(productPanel).getByRole('button', { name: '취소' }));

    await openAdminMenu('지급·회수');
    const amountInput = screen.getByLabelText('지급/회수 금액');
    expect(amountInput.className).toContain('bg-[var(--theme-input)]');
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
    await act(async () => currencyRequest.resolve());
    const resultDialog = await screen.findByRole('dialog', { name: '화폐 지급 성공' });
    expect(resultDialog.className).toContain('bg-[var(--theme-surface)]');
    expect(resultDialog.className).not.toContain('bg-white');
    expect(within(resultDialog).getByText('S001 학생에게 700 지급 완료')).toBeTruthy();
  });

  it('removes student number fields and prints QR cards with ID only', async () => {
    render(<AdminManagePage />);
    await openAdminMenu('학생');
    await screen.findAllByTestId('student-row');

    const editor = await openNewStudentEditor();
    expect(within(editor).queryByLabelText('새 학생 번호')).toBeNull();
    fireEvent.keyDown(editor, { key: 'Escape' });
    const studentEditor = await openStudentEditor('S001', '김민준');
    expect(within(studentEditor).queryByLabelText('S001 번호')).toBeNull();
    fireEvent.keyDown(studentEditor, { key: 'Escape' });

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'QR 카드 발급' }));

    const dialog = screen.getByRole('dialog', { name: '선택 학생 QR 발급' });
    expect(within(dialog).getAllByText('S001').length).toBeGreaterThan(0);
    expect(screen.queryByText(/1번/)).toBeNull();
  });

  /** Opens the 학생 현황 tab of a task panel and waits for the assignment status GET. */
  async function openAssignmentPanel(title = '책 읽기') {
    const panel = await openTaskEditor(title, '학생 현황');
    await within(panel).findByTestId('task-assignment-row-S001');
    await waitFor(() => expect(within(panel).queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    return panel;
  }

  /** Bulk 부여/부여 취소/완료/미완료 buttons shown while assignment rows are selected (not the filter toggles). */
  function bulkAssignmentButton(container: HTMLElement, name: string) {
    return within(container).getAllByRole('button', { name }).find((button) => !button.hasAttribute('aria-pressed'))!;
  }

  it('assigns tasks to selected student IDs and immediately saves existing task assignments', async () => {
    await renderTasks();

    const editor = await openNewTaskEditor();
    fireEvent.click(within(editor).getByRole('tab', { name: /^대상 학생/ }));
    expect(within(editor).getByText(/고른 학생만 은행에서 이 과제를 보고 완료할 수 있습니다/)).toBeTruthy();
    expect(within(editor).getByLabelText('전체 학생 행 선택')).toBeTruthy();
    fireEvent.click(within(editor).getByLabelText('S001 김민준 부여 상태'));
    fireEvent.click(within(editor).getByRole('tab', { name: /^기본 정보/ }));
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(within(editor).getByRole('button', { name: '과제 만들기' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"allowedStudentIds":["S001"]'),
    })));
    await findNotice('T003 과제 추가 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());

    fireEvent.click(await findTaskRow('책 읽기'));
    const panel = await screen.findByRole('dialog', { name: '책 읽기 과제 편집' });
    fireEvent.click(within(panel).getByRole('tab', { name: /^학생 현황/ }));
    await within(panel).findByTestId('task-assignment-row-S001');
    await waitFor(() => expect(within(panel).queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    expect((within(panel).getByLabelText('S001 김민준 행 선택') as HTMLInputElement).checked).toBe(false);
    const s001Assignment = within(panel).getByRole('button', { name: 'S001 김민준 부여 상태' });
    expect(s001Assignment.textContent).toContain('부여');
    expect(s001Assignment.getAttribute('aria-pressed')).toBe('true');
    const s001Row = within(panel).getByTestId('task-assignment-row-S001');
    // Assignment/completion origins are bookkeeping, not shown to the teacher.
    expect(s001Row.textContent).not.toContain('부여 QR');
    expect(s001Row.innerHTML.indexOf('aria-label="S001 김민준 행 선택"')).toBeLessThan(s001Row.innerHTML.indexOf('김민준</span>'));
    const s001Completion = within(panel).getByRole('button', { name: 'S001 김민준 완료 상태' });
    expect(s001Completion.textContent).toBe('완료');
    expect(s001Completion.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(s001Assignment);
    expect(within(panel).getByRole('button', { name: 'S001 김민준 부여 상태' }).textContent).toBe('미부여');
    expect(within(panel).getByRole('button', { name: 'S001 김민준 완료 상태' }).textContent).toBe('완료');
    expect(within(panel).getByRole('tab', { name: /^학생 현황/ }).querySelector('[aria-label="저장 안 됨"]')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'S001 김민준 부여 상태' }));
    expect((within(panel).getByLabelText('S002 이서연 행 선택') as HTMLInputElement).checked).toBe(false);
    const s002Completion = within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' });
    expect(s002Completion.textContent).toBe('미완료');
    expect(s002Completion.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(panel).getByLabelText('S002 이서연 행 선택'));
    fireEvent.click(bulkAssignmentButton(panel, '부여'));
    fireEvent.click(within(panel).getByLabelText('S001 김민준 행 선택'));
    fireEvent.click(bulkAssignmentButton(panel, '완료'));
    expect(within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');
    fireEvent.click(within(panel).getByRole('button', { name: 'S001 김민준 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(1));
    expect(lastBody('/api/tasks/assignments/batch', 'POST')).toEqual({ targets: [{
      taskId: 'T001',
      operations: [
        { studentId: 'S001', assigned: false, source: 'ADMIN' },
        { studentId: 'S002', assigned: true, completed: true, source: 'ADMIN' },
      ],
    }] });
    expect(fetchCalls('/api/tasks/T001/assignments', 'PATCH')).toHaveLength(0);
    await findNotice('과제 부여 저장 완료');

    // The panel reloads the saved status once the assignment list changed.
    await waitFor(() => expect(within(taskEditorPanel('책 읽기')).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여'));
    const reopened = taskEditorPanel('책 읽기');
    expect(within(reopened).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');
    expect(within(reopened).getByRole('button', { name: 'S001 김민준 부여 상태' }).textContent).toBe('미부여');
    fireEvent.click(within(reopened).getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(await screen.findByRole('button', { name: '완료 기록 초기화 확인' }));
    await findNotice('완료 기록 3건 초기화 완료');
    await waitFor(() => expect(within(taskEditorPanel('책 읽기')).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('미완료'));
    const afterReset = taskEditorPanel('책 읽기');
    expect(within(afterReset).getByRole('button', { name: 'S001 김민준 부여 상태' }).textContent).toBe('미부여');
    expect(within(afterReset).getByRole('button', { name: 'S001 김민준 완료 상태' }).textContent).toBe('미완료');
    expect(within(afterReset).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여');
    fireEvent.click(within(afterReset).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 편집' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'QR로 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 1명');
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

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(await screen.findByRole('button', { name: '완료 기록 초기화 확인' }));

    const dialog = await screen.findByRole('dialog', { name: '완료 기록 초기화 확인' });
    await waitFor(() => expect(within(dialog).getByText('temporary reset failure')).toBeTruthy());
    await findNotice('temporary reset failure');
    fireEvent.click(within(dialog).getByRole('button', { name: '완료 기록 초기화 확인' }));
    await waitFor(() => expect(resetBodies).toHaveLength(2));
    await findNotice('완료 기록 1건 초기화 완료');

    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(resetBodies).toEqual([
      { taskIds: ['T001'], operationId: '60000000-0000-4000-8000-000000000001' },
      { taskIds: ['T001'], operationId: '60000000-0000-4000-8000-000000000001' },
    ]);
  });

  it('does not send assignment commands when the loaded desired state is unchanged', async () => {
    await renderTasks();
    const panel = await openAssignmentPanel();

    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await findNotice('과제 부여 저장 완료');
    expect(fetchCalls('/api/tasks/T001/assignments', 'PATCH')).toHaveLength(0);
    expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(0);
  });

  it('accepts a successful batch response that omits optional fields without reconciling', async () => {
    const baseFetch = vi.mocked(fetch);
    const defaultFetch = baseFetch.getMockImplementation()!;
    let assignmentGetCount = 0;
    const getsAtSave: number[] = [];
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') {
        getsAtSave.push(assignmentGetCount);
        return jsonResponse({ appliedCount: 2, failures: [] });
      }
      if (url === '/api/tasks/T001/assignments') assignmentGetCount += 1;
      return defaultFetch(input, init);
    });

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'S001 김민준 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await findNotice('과제 부여 저장 완료');
    expect(getsAtSave).toEqual([1]);
    expect(noticeTexts().join(' ')).not.toContain('일부 저장 실패');
    // No reconciliation read: the only later GET is the panel reloading the saved list.
    await waitFor(() => expect(assignmentGetCount).toBe(2));
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
    const baseFetch = vi.mocked(fetch);
    const defaultFetch = baseFetch.getMockImplementation()!;
    let assignmentGetCount = 0;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/assignments/batch' && init?.method === 'POST') return jsonResponse(payload);
      if (url === '/api/tasks/T001/assignments') assignmentGetCount += 1;
      return defaultFetch(input, init);
    });

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await findNotice('과제 부여 저장 결과를 확인하지 못했습니다.');
    expect(noticeTexts().join(' ')).not.toContain('private');
    expect(assignmentGetCount).toBe(1);
    const current = taskEditorPanel('책 읽기');
    expect(within(current).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여');
    expect(within(current).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');

    fireEvent.click(within(current).getByRole('button', { name: '닫기' }));
    await confirmDialog('저장하지 않고 닫기');
    fireEvent.click(await screen.findByRole('button', { name: 'QR로 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 1명');
  });

  it('sends explicit unassignment with a standalone completion intent for an unassigned student', async () => {
    await renderTasks();
    const panel = await openAssignmentPanel();

    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/assignments/batch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targets: [{
        taskId: 'T001',
        operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }],
      }] }),
    })));
  });

  it('reconciles a failed complete-then-unassign command and retries the explicit paired intent', async () => {
    const baseFetch = vi.mocked(fetch);
    const defaultFetch = baseFetch.getMockImplementation()!;
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

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    expect((await findNotice('과제 부여 일부 저장 실패')).textContent).toContain('책 읽기 (T001) · 이서연 (S002): 작업 실패');
    expect(noticeTexts().join(' ')).not.toContain('provider stack detail');
    expect(assignmentGetCount).toBe(2);
    const current = taskEditorPanel('책 읽기');
    expect(within(current).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('미부여');
    expect(within(current).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');
    expect(noticeTexts()).not.toContain('과제 부여 저장 완료');

    fireEvent.click(within(current).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(batchBodies).toHaveLength(2));
    expect(batchBodies).toEqual([
      { targets: [{ taskId: 'T001', operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }] }] },
      { targets: [{ taskId: 'T001', operations: [{ studentId: 'S002', assigned: false, completed: true, source: 'ADMIN' }] }] },
    ]);
    expect(fetchCalls('/api/tasks/T001/assignments', 'PATCH')).toHaveLength(0);
    await findNotice('과제 부여 저장 완료');
  });

  it('keeps the reconciled assignment cache when a failed edit is discarded', async () => {
    const baseFetch = vi.mocked(fetch);
    const defaultFetch = baseFetch.getMockImplementation()!;
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

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'S002 이서연 완료 상태' }));
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
    await findNotice('과제 부여 일부 저장 실패');
    fireEvent.click(within(taskEditorPanel('책 읽기')).getByRole('button', { name: '닫기' }));
    await confirmDialog('저장하지 않고 닫기');

    fireEvent.click(await screen.findByRole('button', { name: 'QR로 부여' }));
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' }).textContent).toContain('부여 2명');
    fireEvent.click(screen.getByRole('button', { name: '책 읽기 과제 선택' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));
    expect(await screen.findByText('이미 이 과제가 부여된 학생입니다.')).toBeTruthy();
  });

  it('assigns a selected task to a scanned student QR, saves it immediately, and shows saving progress', async () => {
    const signedQr = 'csq1.current.c2lnbmVkLXN0dWRlbnQ.signature';
    const qrTaskSave = deferredResponse({
      taskId: 'T002',
      students: [
        { studentId: 'S001', assigned: false, completed: false },
        { studentId: 'S002', assigned: true, completed: false },
      ],
    });
    const baseFetch = vi.mocked(fetch);
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === `/api/bank/student?studentId=${encodeURIComponent(signedQr)}`) return jsonResponse({ studentId: 'S002', name: '이서연', balance: 1500 });
      if (url === '/api/tasks/T002/assignments' && init?.method === 'PATCH') return qrTaskSave.response;
      if (url === '/api/tasks/T002/assignments') return jsonResponse({ taskId: 'T002', students: [
        { studentId: 'S001', assigned: false, completed: false },
        { studentId: 'S002', assigned: true, completed: false },
      ] });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    await renderTasks();

    fireEvent.click(screen.getByRole('button', { name: 'QR로 부여' }));
    expect(screen.getByRole('dialog', { name: 'QR로 과제 부여' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '수학 학습지 과제 선택' }));
    const scanDialog = screen.getByRole('dialog', { name: '수학 학습지 QR 과제 부여' });
    expect(within(scanDialog).getByText('수학 학습지')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: signedQr } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    // The lookup overlay can close before the next assertion on a loaded machine; check the found element itself.
    const recognizing = await screen.findByRole('dialog', { name: 'QR 인식 중' });
    expect(within(recognizing).getByText('QR을 인식했습니다. 과제를 부여하는 중입니다.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/T002/assignments', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ studentId: 'S002', assigned: true, source: 'QR' }),
    })));
    expect(fetch).toHaveBeenCalledWith(`/api/bank/student?studentId=${encodeURIComponent(signedQr)}`, { cache: 'no-store' });
    expect(fetchCalls('/api/tasks/batch', 'PATCH')).toHaveLength(0);
    qrTaskSave.resolve();

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 성공' })).toBeTruthy();
    expect(screen.getByText('과제가 부여되었습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 찍기' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'QR 과제 부여 성공' }), { key: 'Escape' });
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'QR로 과제 부여' }), { key: 'Escape' });

    const panel = await openAssignmentPanel('수학 학습지');
    expect(within(panel).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여');
  });

  it('shows a specific failure when QR task assignment scans a duplicate or invalid QR', async () => {
    await renderTasks();

    fireEvent.click(screen.getByRole('button', { name: 'QR로 부여' }));
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

  it('shows loading popups while saving student, product, and task panel changes', async () => {
    const studentSave = deferredResponse([{ ...students[0], name: '김민준 수정', balance: 3200 }]);
    const productSave = deferredResponse([{ ...products[0], name: '연필 세트' }]);
    const taskSave = deferredResponse([{ ...tasks[0], title: '책 읽기 수정' }]);
    const baseFetch = vi.mocked(fetch);
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === '/api/students/batch' && init?.method === 'PATCH') return studentSave.response;
      if (url === '/api/products/batch' && init?.method === 'PATCH') return productSave.response;
      if (url === '/api/tasks/batch' && init?.method === 'PATCH') return taskSave.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await openAdminMenu('학생');
    const studentPanel = await openStudentEditor('S001', '김민준');
    fireEvent.change(within(studentPanel).getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.click(within(studentPanel).getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    studentSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
    await findNotice('학생 1명 저장 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'S001 학생 편집' })).toBeNull());

    await openAdminMenu('매점');
    const productPanel = await openProductEditor('P001', '연필');
    fireEvent.change(within(productPanel).getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.click(within(productPanel).getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    productSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
    await findNotice('상품 1개 저장 완료');

    await openAdminMenu('과제');
    const taskPanel = await openTaskEditor('책 읽기');
    fireEvent.change(within(taskPanel).getByLabelText('T001 과제명'), { target: { value: '책 읽기 수정' } });
    fireEvent.click(within(taskPanel).getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    taskSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
    await findNotice('과제 1개 저장 완료');
  });

  it('refreshes student, product, and task lists with a loading popup from section headers', async () => {
    const refreshedStudents = [{ ...students[0], name: '김민준 새로고침', balance: 4100 }, students[1]];
    const refreshedProducts = [{ ...products[0], name: '연필 리필', stock: 30 }, products[1]];
    const refreshedTasks = [{ ...tasks[0], title: '책 읽기 새로고침' }, tasks[1]];
    let studentFetchCount = 0;
    let productFetchCount = 0;
    let taskFetchCount = 0;
    const studentRefresh = deferredResponse(refreshedStudents);
    const productRefresh = deferredResponse(adminProductEnvelope(refreshedProducts, [21, 22]));
    const taskRefresh = deferredResponse(refreshedTasks);
    const baseFetch = vi.mocked(fetch);
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') {
        studentFetchCount += 1;
        return studentFetchCount === 1 ? jsonResponse(students) : studentRefresh.response;
      }
      if (url === '/api/products?includeInactive=1') {
        productFetchCount += 1;
        return productFetchCount === 1 ? jsonResponse(adminProductEnvelope()) : productRefresh.response;
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
    await openAdminMenu('학생');
    fireEvent.click(screen.getByRole('button', { name: '학생 명단 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('최신 목록을 불러오는 중입니다.')).toBeTruthy();
    studentRefresh.resolve();
    await screen.findByRole('button', { name: 'S001 김민준 새로고침 편집' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    await openAdminMenu('매점');
    fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    productRefresh.resolve();
    await screen.findByRole('button', { name: 'P001 연필 리필 편집' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    await openAdminMenu('과제');
    fireEvent.click(screen.getByRole('button', { name: '과제 설정 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    taskRefresh.resolve();
    await findTaskRow('책 읽기 새로고침');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());
  });

  it('commits no product half when the initial admin envelope is malformed', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse({
        products,
        mutationPreconditions: [{ productId: 'P001', expectedVersion: 11 }],
      });
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor: 'blue' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '학급 정보 불러오는 중' })).toBeNull());
    await openAdminMenu('매점');
    expect(screen.queryByRole('button', { name: 'P001 연필 편집' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'P002 지우개 편집' })).toBeNull();
    expect(screen.queryAllByTestId('product-row')).toHaveLength(0);
  });

  it('retains the previously validated product pair after a malformed refresh', async () => {
    let productFetchCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') {
        productFetchCount += 1;
        return productFetchCount === 1
          ? jsonResponse(adminProductEnvelope(products, [31, 32]))
          : jsonResponse({
            products: [{ ...products[0], name: '절대 반영되면 안 됨' }, products[1]],
            mutationPreconditions: [
              { productId: 'P001', expectedVersion: 0 },
              { productId: 'P002', expectedVersion: 42 },
            ],
          });
      }
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', themeColor: 'blue' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await openAdminMenu('매점');
    expect(await screen.findByRole('button', { name: 'P001 연필 편집' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));

    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'P001 연필 편집' })).toBeTruthy();
    expect(screen.queryByText('절대 반영되면 안 됨')).toBeNull();
  });

  describe('Gate C2 single product deletion', () => {
    const deleteCalls = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).startsWith('/api/products/') && init?.method === 'DELETE');

    async function openProductDelete(productId = 'P001', name = '연필') {
      await openAdminMenu('매점');
      const panel = await openProductEditor(productId, name);
      const opener = within(panel).getByRole('button', { name: `${productId} 상품 삭제` });
      opener.focus();
      fireEvent.click(opener);
      return { panel, opener, dialog: screen.getByRole('dialog', { name: /상품 삭제 확인/ }) };
    }

    it('opens without deleting and cancel or Escape clears the attempt and restores the opener', async () => {
      render(<AdminManagePage />);
      const { opener, dialog, panel } = await openProductDelete();
      expect(within(dialog).getByText(/연필/)).toBeTruthy();
      expect(panel.hasAttribute('inert')).toBe(true);
      expect(deleteCalls()).toHaveLength(0);
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 취소' }));
      await waitFor(() => expect(document.activeElement).toBe(opener));
      fireEvent.click(opener);
      fireEvent.keyDown(screen.getByRole('dialog', { name: /상품 삭제 확인/ }), { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: /상품 삭제 확인/ })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(screen.getByRole('dialog', { name: 'P001 상품 편집' })).toBeTruthy();
      expect(deleteCalls()).toHaveLength(0);
    });

    it('blocks a locally created product with no loaded precondition before UUID generation or fetch', async () => {
      render(<AdminManagePage />);
      await openAdminMenu('매점');
      const editor = await openNewProductEditor();
      fireEvent.change(within(editor).getByLabelText('새 상품명'), { target: { value: '새 상품' } });
      fireEvent.click(within(editor).getByRole('button', { name: '새 상품 추가' }));
      await findNotice('P003 추가 완료');
      vi.mocked(crypto.randomUUID).mockClear();
      const panel = await openProductEditor('P003', '간식쿠폰');
      fireEvent.click(within(panel).getByRole('button', { name: 'P003 상품 삭제' }));
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      const dialog = screen.getByRole('dialog', { name: /상품 삭제 확인/ });
      expect((await within(dialog).findByText(/새로고침/)).textContent).toContain('상품 삭제 전 목록을 새로고침해 주세요.');
      expect(crypto.randomUUID).not.toHaveBeenCalled();
      expect(deleteCalls()).toHaveLength(0);
    });

    it('sends the exact encoded URL, header, and version-bound body and locks duplicate confirmation', async () => {
      const pending = deferredResponse({ productId: 'P/001' });
      const encodedProducts = [{ ...products[0], productId: 'P/001' }, products[1]];
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope(encodedProducts, [41, 42]));
        if (String(input) === '/api/products/P%2F001' && init?.method === 'DELETE') return pending.response;
        return fallback(input, init);
      });
      vi.mocked(crypto.randomUUID).mockReturnValue('a0000000-0000-4000-8000-00000000000b');
      render(<AdminManagePage />);
      const { dialog } = await openProductDelete('P/001');
      const confirmDelete = within(dialog).getByRole('button', { name: '상품 삭제 확인' });
      fireEvent.click(confirmDelete);
      fireEvent.click(confirmDelete);
      expect(confirmDelete).toHaveProperty('disabled', true);
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(dialog.isConnected).toBe(true);
      expect(dialog.getAttribute('aria-label')).toBe('연필 상품 삭제 확인');
      expect(deleteCalls()).toEqual([['/api/products/P%2F001', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: 'a0000000-0000-4000-8000-00000000000b', expectedProductVersion: 41 }),
      }]]);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
      pending.resolve();
      await findNotice('P/001 삭제 완료');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'P/001 상품 편집' })).toBeNull());
      expect(screen.queryByRole('button', { name: 'P/001 연필 편집' })).toBeNull();
    });

    it('keeps keyboard focus and the active attempt isolated while deletion is pending', async () => {
      const pending = deferredResponse({ productId: 'P001' });
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') return pending.response;
        return fallback(input, init);
      });
      vi.mocked(crypto.randomUUID).mockReturnValue('10000000-0000-4000-8000-000000000001');
      render(<AdminManagePage />);
      const { dialog, opener } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      expect(within(dialog).getByRole('button', { name: '상품 삭제 확인', hidden: true })).toHaveProperty('disabled', true);
      // The obscured panel's delete button cannot start a second attempt while one is pending.
      fireEvent.click(opener);
      expect(document.querySelectorAll('[role="dialog"][aria-label$="상품 삭제 확인"]')).toHaveLength(1);
      expect(dialog.isConnected).toBe(true);
      expect(within(dialog).getByText(/연필/)).toBeTruthy();
      expect(within(dialog).queryByText(/지우개/)).toBeNull();
      expect(deleteCalls()).toHaveLength(1);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

      pending.resolve();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull());
      expect(await screen.findByRole('button', { name: 'P002 지우개 편집' })).toBeTruthy();
    });

    it('rejects a noncanonical UUID without normalizing or fetching', async () => {
      vi.mocked(crypto.randomUUID).mockReturnValue('A0000000-0000-4000-8000-00000000000B');
      render(<AdminManagePage />);
      const { dialog } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      expect(await within(dialog).findByText(/삭제 요청을 만들지 못했습니다/)).toBeTruthy();
      expect(deleteCalls()).toHaveLength(0);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    });

    const ambiguousCases: Array<[string, () => Promise<Response>]> = [
      ['transport rejection', async () => { throw new Error('private transport detail'); }],
      ['non-2xx', async () => jsonResponse({ error: 'private backend detail' }, { status: 503 })],
      ['malformed JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } } as unknown as Response)],
      ['missing productId', async () => ({ ok: true, json: async () => ({}) } as Response)],
      ['extra field', async () => ({ ok: true, json: async () => ({ productId: 'P001', extra: true }) } as Response)],
      ['symbol field', async () => ({ ok: true, json: async () => ({ productId: 'P001', [Symbol('extra')]: true }) } as Response)],
      ['non-writable data', async () => ({ ok: true, json: async () => {
        const value = { productId: 'P001' };
        Object.defineProperty(value, 'productId', { value: 'P001', enumerable: true, writable: false, configurable: true });
        return value;
      } } as Response)],
      ['custom prototype', async () => ({ ok: true, json: async () => Object.assign(Object.create(null), { productId: 'P001' }) } as Response)],
      ['boxed productId', async () => ({ ok: true, json: async () => ({ productId: new String('P001') }) } as Response)],
      ['wrong productId', async () => ({ ok: true, json: async () => ({ productId: 'P002' }) } as Response)],
    ];

    it.each(ambiguousCases)('retains the exact attempt, the panel draft, and selection after ambiguous %s', async (_label, failure) => {
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/products/P001' && init?.method === 'DELETE' ? failure() : fallback(input, init));
      render(<AdminManagePage />);
      await openAdminMenu('매점');
      fireEvent.click(await screen.findByLabelText('P001 선택'));
      fireEvent.click(screen.getByLabelText('P002 선택'));
      const panel = await openProductEditor('P001', '연필');
      fireEvent.change(within(panel).getByLabelText('P001 가격'), { target: { value: '350' } });
      fireEvent.click(within(panel).getByRole('button', { name: 'P001 상품 삭제' }));
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      const dialog = await screen.findByRole('dialog', { name: /상품 삭제 확인/ });
      const error = await within(dialog).findByText(/상품 삭제 결과를 확인하지 못했습니다/);
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(deleteCalls()[0][1]).toEqual(deleteCalls()[1][1]);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeTruthy();
      expect(within(panel).getByLabelText('P001 가격')).toHaveProperty('value', '350');
      expect(screen.getByLabelText('P001 선택')).toHaveProperty('checked', true);
      expect(screen.getByLabelText('P002 선택')).toHaveProperty('checked', true);
      expect(error.textContent).not.toContain('private');
      expect(noticeTexts().join(' ')).not.toContain('private');
    });

    it('does not invoke an accessor and mints a new UUID after Escape dismisses a failed attempt', async () => {
      let hooks = 0;
      const hostile = {} as Record<string, unknown>;
      Object.defineProperty(hostile, 'productId', { enumerable: true, configurable: true, get() { hooks += 1; return 'P001'; } });
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/products/P001' && init?.method === 'DELETE' ? ({ ok: true, json: async () => hostile } as Response) : fallback(input, init));
      vi.mocked(crypto.randomUUID).mockReturnValueOnce('10000000-0000-4000-8000-000000000001').mockReturnValueOnce('20000000-0000-4000-8000-000000000002');
      render(<AdminManagePage />);
      const { opener } = await openProductDelete();
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      const failedDialog = await screen.findByRole('dialog', { name: /상품 삭제 확인/ });
      await within(failedDialog).findByText(/상품 삭제 결과를 확인하지 못했습니다/);
      fireEvent.keyDown(failedDialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: /상품 삭제 확인/ })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(opener));
      fireEvent.click(opener);
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(hooks).toBe(0);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
      expect(deleteCalls().map(([, init]) => init?.body)).toEqual([
        JSON.stringify({ operationId: '10000000-0000-4000-8000-000000000001', expectedProductVersion: 11 }),
        JSON.stringify({ operationId: '20000000-0000-4000-8000-000000000002', expectedProductVersion: 11 }),
      ]);
    });

    it('retains an attempt across same-version and malformed refreshes, but invalidates it on changed versions', async () => {
      let productGet = 0;
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') {
          productGet += 1;
          if (productGet === 1) return jsonResponse(adminProductEnvelope(products, [11, 12]));
          if (productGet === 2) return jsonResponse(adminProductEnvelope([{ ...products[0], name: '서버 연필' }, products[1]], [11, 12]));
          if (productGet === 3) return jsonResponse({ products, mutationPreconditions: [] });
          return jsonResponse(adminProductEnvelope(products, [21, 12]));
        }
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') return jsonResponse({ productId: 'wrong' });
        return fallback(input, init);
      });
      render(<AdminManagePage />);
      const { dialog } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      await within(dialog).findByText(/상품 삭제 결과를 확인하지 못했습니다/);
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침', hidden: true }));
      await screen.findByDisplayValue('서버 연필');
      expect(screen.getByRole('dialog', { name: /상품 삭제 확인/ })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침', hidden: true }));
      await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
      expect(screen.getByRole('dialog', { name: /상품 삭제 확인/ })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침', hidden: true }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /상품 삭제 확인/ })).toBeNull());
    });

    it('clears the retained attempt, dialog, and panel when a valid refresh removes the target', async () => {
      let productGet = 0;
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') {
          productGet += 1;
          return productGet === 1
            ? jsonResponse(adminProductEnvelope(products, [11, 12]))
            : jsonResponse(adminProductEnvelope([products[1]], [12]));
        }
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') return jsonResponse({ productId: 'wrong' });
        return fallback(input, init);
      });
      render(<AdminManagePage />);
      const { dialog } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      await within(dialog).findByText(/상품 삭제 결과를 확인하지 못했습니다/);
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침', hidden: true }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /상품 삭제 확인/ })).toBeNull());
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'P001 상품 편집' })).toBeNull());
      expect(screen.queryByRole('button', { name: 'P001 연필 편집' })).toBeNull();
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    });

    it('guards a late old success after version-changing refresh', async () => {
      const oldDelete = deferredResponse({ productId: 'P001' });
      let productGet = 0;
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') {
          productGet += 1;
          return jsonResponse(productGet === 1 ? adminProductEnvelope(products, [11, 12]) : adminProductEnvelope([{ ...products[0], name: '새 버전 연필' }, products[1]], [99, 12]));
        }
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') return oldDelete.response;
        return fallback(input, init);
      });
      render(<AdminManagePage />);
      await openProductDelete();
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침', hidden: true }));
      await screen.findByDisplayValue('새 버전 연필');
      expect(screen.queryByRole('dialog', { name: /상품 삭제 확인/ })).toBeNull();
      oldDelete.resolve();
      await act(async () => undefined);
      expect(screen.getByLabelText('P001 상품명')).toHaveProperty('value', '새 버전 연필');
      expect(screen.getByRole('button', { name: 'P001 새 버전 연필 편집', hidden: true })).toBeTruthy();
    });

    it('does not let an older settings reload resurrect a product deleted after that reload started', async () => {
      const staleLoad = deferredResponse(adminProductEnvelope(products, [11, 12]));
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      let productGets = 0;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') {
          productGets += 1;
          if (productGets === 2) return staleLoad.response;
        }
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') {
          return jsonResponse({ productId: 'P001' });
        }
        return fallback(input, init);
      });
      vi.mocked(crypto.randomUUID).mockReturnValue('10000000-0000-4000-8000-000000000001');
      render(<AdminManagePage />);
      await openAdminMenu('설정');
      await screen.findByText('학생 2명 · 상품 2개 연결됨');
      fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-new' } });
      fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));
      await waitFor(() => expect(productGets).toBe(2));

      const { dialog } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull());

      staleLoad.resolve();
      await act(async () => undefined);
      expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull();
      expect(screen.getByRole('button', { name: 'P002 지우개 편집', hidden: true })).toBeTruthy();
    });

    it('applies unrelated settings from a stale manual product refresh without restoring deleted products', async () => {
      const staleProducts = deferredResponse(adminProductEnvelope(products, [11, 12]));
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      let productGets = 0;
      let staleRefreshStarted = false;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) === '/api/products?includeInactive=1') {
          productGets += 1;
          if (productGets === 2) {
            staleRefreshStarted = true;
            return staleProducts.response;
          }
        }
        if (String(input) === '/api/settings' && !init?.method && staleRefreshStarted) {
          return jsonResponse({ currencyUnit: '달', appTitle: '새 매점', bankTitle: '새 은행', themeColor: 'purple', fontFamily: 'default' });
        }
        if (String(input) === '/api/products/P001' && init?.method === 'DELETE') {
          return jsonResponse({ productId: 'P001' });
        }
        return fallback(input, init);
      });
      vi.mocked(crypto.randomUUID).mockReturnValue('10000000-0000-4000-8000-000000000001');
      const { container } = render(<AdminManagePage />);
      await openAdminMenu('매점');
      await screen.findByRole('button', { name: 'P001 연필 편집' });
      fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
      await waitFor(() => expect(productGets).toBe(2));

      // The refresh overlay is still pending; the deletion runs from the panel behind it.
      fireEvent.click(screen.getByRole('button', { name: 'P001 연필 편집', hidden: true }));
      fireEvent.click(await screen.findByRole('button', { name: 'P001 상품 삭제', hidden: true }));
      fireEvent.click(await screen.findByRole('button', { name: '상품 삭제 확인', hidden: true }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull());
      staleProducts.resolve();
      await waitFor(() => expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.purple.shell));
      expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull();
    });

    it('removes only the confirmed target and preserves unrelated selection and preconditions', async () => {
      vi.mocked(crypto.randomUUID).mockReturnValueOnce('10000000-0000-4000-8000-000000000001').mockReturnValueOnce('20000000-0000-4000-8000-000000000002');
      render(<AdminManagePage />);
      await openAdminMenu('매점');
      fireEvent.click(await screen.findByLabelText('P001 선택'));
      fireEvent.click(screen.getByLabelText('P002 선택'));
      const { dialog } = await openProductDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'P001 연필 편집', hidden: true })).toBeNull());
      await findNotice('P001 삭제 완료');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'P001 상품 편집' })).toBeNull());
      expect(screen.getByLabelText('P002 선택')).toHaveProperty('checked', true);
      expect(within(selectionBar()).getByText('1개 선택됨')).toBeTruthy();
      const second = await openProductEditor('P002', '지우개');
      fireEvent.click(within(second).getByRole('button', { name: 'P002 상품 삭제' }));
      fireEvent.click(screen.getByRole('button', { name: '상품 삭제 확인' }));
      await waitFor(() => expect(deleteCalls()).toHaveLength(2));
      expect(deleteCalls()[1][1]?.body).toBe(JSON.stringify({ operationId: '20000000-0000-4000-8000-000000000002', expectedProductVersion: 12 }));
    });
  });

  it('renders the sidebar menu, shortcuts, and settings with the redesigned design language', async () => {
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    expect(screen.queryByText('Class Reward System')).toBeNull();
    const logo = screen.getByRole('img', { name: '학급 보상 시스템 로고' });
    expect(logo.className).toContain('bg-[var(--theme-accent-text)]');
    expect(logo.className).toContain("[mask-image:url('/class-reward-system-icon.png')]");
    expect(logo.className).not.toContain('bg-white');
    const adminTabs = screen.getByRole('tablist', { name: '관리자 메뉴' });
    expect(adminTabs).toBe(screen.getByTestId('admin-tabs'));
    expect(within(adminTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['홈', '학생', '매점', '과제', '펫 키우기', '나무 키우기', '지급·회수', '거래 내역', '설정']);
    expect(screen.getByRole('tab', { name: '홈' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: '홈' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /시스템 생성기/ })).toBeNull();
    for (const [name, href] of [['매점 열기 새 탭 열림', '/'], ['은행 열기 새 탭 열림', '/bank']] as const) {
      const links = screen.getAllByRole('link', { name });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.getAttribute('href')).toBe(href);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
      }
    }
    expect(screen.getByRole('link', { name: '학생 QR 인쇄 새 탭 열림' }).getAttribute('href')).toBe('/admin/student-qrs');
    const shell = container.querySelector('[data-testid="admin-shell"]') as HTMLElement;
    expect(shell.className).toContain('bg-[var(--theme-shell)]');
    expect(shell.style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.blue.shell);
    expect(shell.getAttribute('style')).toContain('SchoolSafeBoardMarker');

    await openAdminMenu('설정');
    expect(await screen.findByText('학생 2명 · 상품 2개 연결됨')).toBeTruthy();
    expect(await screen.findByDisplayValue('별')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 매점')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 은행')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '테마 색상' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '하늘' })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('글꼴')).toBeTruthy();
    expect(screen.getByDisplayValue('학교안심 보드마카')).toBeTruthy();
    expect(screen.getByRole('button', { name: '설정 저장' })).toHaveProperty('disabled', true);
  });

  it('shares the store, the bank, and the admin page from the shortcuts with an address and a QR', async () => {
    render(<AdminManagePage />);
    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '은행 공유' }));
    const dialog = await screen.findByRole('dialog', { name: '학급 은행 공유' });
    expect((within(dialog).getByLabelText('주소') as HTMLInputElement).value).toBe(`${window.location.origin}/bank`);
    expect(within(dialog).getByRole('button', { name: '은행' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '관리자 페이지 공유' }));
    const adminDialog = await screen.findByRole('dialog', { name: '관리자 페이지 공유' });
    expect((within(adminDialog).getByLabelText('주소') as HTMLInputElement).value).toBe(`${window.location.origin}/admin`);
    expect(within(adminDialog).getByText('선생님 전용 주소예요')).toBeTruthy();
  });

  it('uses the updated admin transaction, currency, and product image helper wording', async () => {
    render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();

    await openAdminMenu('거래 내역');
    expect(await screen.findByTestId('transaction-row-TX001')).toBeTruthy();
    expect(screen.getByText('1건')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '최근 거래 (1)' })).toBeNull();

    await openAdminMenu('지급·회수');
    expect(screen.getByText('학생 QR을 찍을 때마다 같은 금액이 한 번씩 처리됩니다.')).toBeTruthy();
    expect(screen.getByText(/회수할 금액이 잔액보다 크면 잔액이 음수가 됩니다/)).toBeTruthy();

    await openAdminMenu('매점');
    const panel = await openProductEditor('P001', '연필');
    expect(within(panel).getByLabelText('P001 이미지 주소')).toHaveProperty('value', 'https://example.com/pencil.png');
    expect(within(panel).getByText("인터넷 이미지에서 마우스 오른쪽 버튼 → '이미지 주소 복사' 후 붙여 넣으세요.")).toBeTruthy();
    expect(within(panel).getByRole('img', { name: '상품 이미지 미리보기' }).getAttribute('src')).toBe('https://example.com/pencil.png');
    expect(screen.queryByRole('dialog', { name: '상품 이미지 등록' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'P001 이미지 주소 편집' })).toBeNull();
  });

  it('saves the selected font family from system settings', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let settingsGets = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/settings' && init?.method !== 'POST' && ++settingsGets === 2) {
        // The child form loads settings independently of the parent heading.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return originalFetch(input, init);
    });
    render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    await openAdminMenu('설정');
    await screen.findByText('학생 2명 · 상품 2개 연결됨');
    expect(screen.getByRole('button', { name: '설정 저장' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('글꼴'), { target: { value: 'school-safe-poster' } });
    expect(screen.getByRole('button', { name: '설정 저장' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => {
      const settingsPost = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/settings' && init?.method === 'POST');
      expect(settingsPost).toBeTruthy();
      expect(JSON.parse(String(settingsPost?.[1]?.body))).toMatchObject({ fontFamily: 'school-safe-poster' });
    });
  });

  it('uses the green and black admin palettes through theme variables', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'green', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container, unmount } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.green.shell);
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-green-50');
    unmount();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'black', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const secondRender = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    const shell = secondRender.container.querySelector('[data-testid="admin-shell"]') as HTMLElement;
    expect(shell.style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.black.shell);
    expect(shell.className).toContain('text-[var(--theme-text)]');
    expect(shell.className).not.toContain('bg-slate-100');
    await openAdminMenu('학생');
    const panel = await openStudentEditor('S001', '김민준');
    expect(within(panel).getByLabelText('S001 이름').className).toContain('bg-[var(--theme-input)]');
    expect(within(panel).getByLabelText('S001 이름').className).toContain('text-[var(--theme-text)]');
    expect(within(panel).getByLabelText('S001 이름').className).not.toMatch(/bg-slate-50|text-slate-950/);
  });

  it('uses a blue-leaning low-saturation navy admin palette', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'navy', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.navy.shell);
    expect(screen.getByRole('tab', { name: '홈' }).className).toContain('bg-[var(--theme-accent-solid)]');
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
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime', adminPasswordConfigured: true });
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      if (url === '/api/qrcode' && init?.method === 'POST') return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await screen.findByRole('heading', { level: 1, name: '학급 매점' });
    await openAdminMenu('설정');
    await screen.findByText('학생 2명 · 상품 2개 연결됨');
    fireEvent.change(screen.getByLabelText('관리자 암호 설정'), { target: { value: 'new-admin-pass' } });
    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    expect(await screen.findByText('관리자 QR 로그인 코드')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '학급 정보 불러오는 중' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('img', { name: '관리자 로그인 QR' }).getAttribute('src')).toBe('blob:manage-qr-1'));
    expect(fetch).toHaveBeenCalledWith('/api/qrcode', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ kind: 'admin', password: 'new-admin-pass' }),
    }));
    expect(vi.mocked(fetch).mock.calls.every(([input]) => !String(input).includes('class-store-admin:'))).toBe(true);

    reloadGate.resolve();
    await waitFor(() => expect(screen.getByText(/시스템 설정을 저장/)).toBeTruthy());
    expect(screen.getByText('관리자 QR 로그인 코드')).toBeTruthy();
  });

  it('shows a full screen loading dialog until admin sheet data and theme are loaded', async () => {
    const studentGate = deferredResponse(students);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return studentGate.response;
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<AdminManagePage />);

    expect(screen.getByRole('dialog', { name: '학급 정보 불러오는 중' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: '학급 매점' })).toBeNull();

    studentGate.resolve();
    expect(await screen.findByRole('heading', { level: 1, name: '학급 매점' })).toBeTruthy();
    expect((container.querySelector('[data-testid="admin-shell"]') as HTMLElement).style.getPropertyValue('--theme-shell')).toBe(THEME_PALETTES.white.shell);
  });

  it('lazy-mounts payment history in its existing ARIA shell and preserves it after first opening', async () => {
    render(<AdminManagePage />);

    const transactionsTab = await screen.findByRole('tab', { name: '거래 내역' });
    const transactionsPanel = document.getElementById('admin-panel-transactions');
    await waitFor(() => expect(fetchCalls('/api/settings')).toHaveLength(1));
    expect(transactionsTab.getAttribute('aria-controls')).toBe('admin-panel-transactions');
    expect(transactionsPanel).toBeTruthy();
    expect(transactionsPanel?.hidden).toBe(true);
    expect(transactionsPanel?.getAttribute('aria-labelledby')).toBe(transactionsTab.id);
    expect(transactionsPanel?.textContent).toBe('');
    expect(fetchCalls('/api/transactions')).toHaveLength(0);

    fireEvent.click(transactionsTab);

    const row = await screen.findByTestId('transaction-row-TX001');
    expect(within(row).getByText('김민준')).toBeTruthy();
    expect(within(row).getByText(/연필 ×2/)).toBeTruthy();
    expect(within(row).getByText('-600별')).toBeTruthy();
    expect(fetchCalls('/api/transactions')).toHaveLength(1);
    expect(fetchCalls('/api/settings')).toHaveLength(2);

    fireEvent.click(within(screen.getByRole('group', { name: '거래 필터' })).getByRole('button', { name: '수입' }));
    expect(screen.queryByTestId('transaction-row-TX001')).toBeNull();
    expect(screen.getByText('표시 0건')).toBeTruthy();
    await openAdminMenu('과제');
    expect(transactionsPanel?.hidden).toBe(true);
    fireEvent.click(transactionsTab);

    expect(screen.getByText('표시 0건')).toBeTruthy();
    expect(screen.getByRole('button', { name: '수입' }).getAttribute('aria-pressed')).toBe('true');
    expect(fetchCalls('/api/transactions')).toHaveLength(1);
    expect(fetchCalls('/api/settings')).toHaveLength(2);
  });

  it('mounts payment history once when the primary tab is selected with the keyboard', async () => {
    render(<AdminManagePage />);

    const currencyTab = await screen.findByRole('tab', { name: '지급·회수' });
    currencyTab.focus();
    fireEvent.keyDown(currencyTab, { key: 'ArrowRight' });

    const transactionsTab = screen.getByRole('tab', { name: '거래 내역' });
    expect(document.activeElement).toBe(transactionsTab);
    expect(transactionsTab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByTestId('transaction-row-TX001')).toBeTruthy();
    fireEvent.keyDown(transactionsTab, { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('tab', { name: '지급·회수' }), { key: 'ArrowRight' });
    expect(fetchCalls('/api/transactions')).toHaveLength(1);
  });

  it('reloads admin lists from the shared sheet after saving sheet settings', async () => {
    render(<AdminManagePage />);

    await openAdminMenu('설정');
    await screen.findByText('학생 2명 · 상품 2개 연결됨');
    fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-new' } });
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '햇살반 매점' } });
    fireEvent.change(screen.getByLabelText('은행 제목'), { target: { value: '햇살반 은행' } });
    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));

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

  it('edits one student and one product in their panels and saves exactly that row', async () => {
    render(<AdminManagePage />);

    await openAdminMenu('학생');
    expect(await screen.findByRole('button', { name: 'S001 김민준 편집' })).toBeTruthy();
    expect(screen.getByTestId('student-header-row').textContent).toContain('이름');
    expect(screen.getByTestId('student-header-row').textContent).toContain('잔액');
    expect(screen.queryByRole('button', { name: 'S001 학생 저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: '선택 저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: '전체 저장' })).toBeNull();
    expect(screen.queryByLabelText('S001 이름')).toBeNull();

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'QR 카드 발급' }));
    const qrDialog = await screen.findByRole('dialog', { name: '선택 학생 QR 발급' });
    expect(document.body.classList.contains('qr-selection-printing')).toBe(true);
    const printDocument = document.querySelector('[data-qr-print-document]');
    expect(printDocument).toBeTruthy();
    expect(printDocument?.querySelector('[data-qr-print-grid]')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByAltText('김민준 QR 코드')[0].getAttribute('src')).toBe('blob:manage-qr-1'));
    expect(screen.queryByAltText('이서연 QR 코드')).toBeNull();
    const qrCalls = fetchCalls('/api/qrcode');
    expect(qrCalls).toHaveLength(1);
    expect(qrCalls[0]?.[1]).toEqual({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'student', studentId: 'S001' }), signal: expect.any(AbortSignal),
    });
    expect(screen.getAllByAltText('김민준 QR 코드').every((image) => !String(image.getAttribute('src')).includes('S001'))).toBe(true);
    fireEvent.click(within(qrDialog).getAllByRole('button', { name: '닫기' }).at(-1)!);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:manage-qr-1');
    expect(document.body.classList.contains('qr-selection-printing')).toBe(false);

    const studentPanel = await openStudentEditor('S001', '김민준');
    expect(within(studentPanel).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true);
    fireEvent.change(within(studentPanel).getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.change(within(studentPanel).getByLabelText('S001 잔액'), { target: { value: '4000' } });
    fireEvent.click(within(studentPanel).getByRole('button', { name: '저장' }));
    await findNotice('학생 1명 저장 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'S001 학생 편집' })).toBeNull());
    expect(screen.getByRole('button', { name: 'S001 김민준 수정 편집' })).toBeTruthy();

    await openAdminMenu('매점');
    expect(await screen.findByRole('button', { name: 'P001 연필 편집' })).toBeTruthy();
    expect(screen.getByTestId('product-header-row').textContent).toContain('상품');
    expect(screen.getByTestId('product-header-row').textContent).toContain('가격');
    expect(screen.getByTestId('product-header-row').textContent).not.toContain('ID');
    expect(screen.queryByRole('button', { name: 'P001 상품 저장' })).toBeNull();
    const productPanel = await openProductEditor('P001', '연필');
    fireEvent.change(within(productPanel).getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.change(within(productPanel).getByLabelText('P001 가격'), { target: { value: '900' } });
    fireEvent.change(within(productPanel).getByLabelText('P001 이미지 주소'), { target: { value: 'https://example.com/new-pencil.png' } });
    fireEvent.click(within(productPanel).getByRole('button', { name: '저장' }));

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
          operationId: '50000000-0000-4000-8000-000000000001',
          products: [
            { productId: 'P001', name: '연필 세트', price: 900, isActive: true, imageUrl: 'https://example.com/new-pencil.png', category: '문구', sortOrder: 1 },
          ],
        }),
      });
    });
    expect(fetch).not.toHaveBeenCalledWith('/api/students/S001', expect.objectContaining({ method: 'PATCH' }));
    expect(fetch).not.toHaveBeenCalledWith('/api/products/P001', expect.objectContaining({ method: 'PATCH' }));

    await findNotice('상품 1개 저장 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'P001 상품 편집' })).toBeNull());
    expect(screen.getByRole('button', { name: 'P001 연필 세트 편집' })).toBeTruthy();
  });

  it('renders student, product, and task lists as labelled tables with header rows', async () => {
    render(<AdminManagePage />);

    await openAdminMenu('학생');
    const studentList = await screen.findByRole('table', { name: '학생 명단' });
    expect(studentList).toBe(screen.getByTestId('student-list'));
    expect(within(studentList).getAllByRole('columnheader').map((cell) => cell.textContent?.trim()).filter(Boolean)).toEqual(['번호', '이름', '잔액', '상태']);
    expect(within(studentList).getAllByTestId('student-row')).toHaveLength(2);
    expect(within(studentList).getByLabelText('전체 학생 선택')).toBeTruthy();

    await openAdminMenu('매점');
    const productList = await screen.findByRole('table', { name: '상품 목록' });
    expect(productList).toBe(screen.getByTestId('product-list'));
    expect(within(productList).getAllByRole('columnheader').map((cell) => cell.textContent?.trim()).filter(Boolean)).toEqual(['상품', '가격', '재고', '상태']);
    expect(within(productList).getAllByTestId('product-row')).toHaveLength(2);

    await openAdminMenu('과제');
    const taskList = await screen.findByRole('table', { name: '과제 목록' });
    expect(taskList).toBe(screen.getByTestId('task-list-scroll'));
    expect(within(taskList).getAllByRole('columnheader').map((cell) => cell.textContent?.trim()).filter(Boolean)).toEqual(['과제', '보상', '이번 회차 완료', '상태']);
    expect(within(taskList).getAllByTestId('task-row')).toHaveLength(2);
    for (const list of [studentList, productList, taskList]) expect(list.className).toContain('divide-[var(--crs-line)]');
  });

  it('supports selectable rows with bulk student balance editing and deletion', async () => {
    render(<AdminManagePage />);

    await openAdminMenu('학생');
    expect(await screen.findByRole('button', { name: 'S001 김민준 편집' })).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: '선택 항목 작업' })).toBeNull();

    fireEvent.click(screen.getByLabelText('전체 학생 선택'));
    expect(within(selectionBar()).getByText('2명 선택됨')).toBeTruthy();
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '잔액 변경' }));
    const balanceDialog = await screen.findByRole('dialog', { name: '잔액 한꺼번에 바꾸기' });
    fireEvent.change(within(balanceDialog).getByLabelText('선택 학생 금액'), { target: { value: '5000' } });
    fireEvent.click(within(within(balanceDialog).getByRole('group', { name: '선택 학생 작업' })).getByRole('button', { name: '이 금액으로 맞추기' }));
    fireEvent.click(within(balanceDialog).getByRole('button', { name: '2명에게 적용' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'], mode: 'set', amount: 5000, operationId: '50000000-0000-4000-8000-000000000001' }),
      });
    });
    await findNotice('선택 학생 2명 수정 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '잔액 한꺼번에 바꾸기' })).toBeNull());

    fireEvent.click(within(selectionBar()).getByRole('button', { name: '삭제' }));
    await confirmDialog('삭제');
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'] }),
      });
    });
    await findNotice('선택 학생 2명 삭제 완료');
    expect(noticeTexts().some((text) => /S00[12] 삭제 완료/.test(text))).toBe(false);

    await openAdminMenu('매점');
    expect(await screen.findByRole('button', { name: 'P001 연필 편집' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('전체 상품 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '삭제' }));
    await confirmDialog('삭제');
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/products/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ['P001', 'P002'] }),
      });
    });
    await findNotice('선택 상품 2개 삭제 완료');
    expect(noticeTexts().some((text) => /P00[12] 삭제 완료/.test(text))).toBe(false);
  });

  it('manages bank tasks with a single-row panel save, bulk delete, and new-task creation', async () => {
    await renderTasks();
    expect(screen.getByTestId('task-header-row').textContent).not.toContain('ID');
    expect(screen.queryByRole('button', { name: 'T001 과제 저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: '선택 저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'T001 상세 설정 편집' })).toBeNull();
    expect(screen.getByTestId('task-panel').className).toContain('space-y-5');
    expect(screen.getByTestId('task-list-card')).toBeTruthy();

    const panel = await openTaskEditor('책 읽기');
    expect(within(panel).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true);
    expect(within(panel).getByRole('button', { name: '되돌리기' })).toHaveProperty('disabled', true);
    fireEvent.change(within(panel).getByLabelText('T001 과제명'), { target: { value: '책 읽기 수정' } });
    fireEvent.change(within(panel).getByLabelText('T001 보상'), { target: { value: '7' } });
    fireEvent.change(within(panel).getByLabelText('T001 과제 설명'), { target: { value: '책 20분 읽기' } });
    expect(within(panel).getByRole('tab', { name: /^기본 정보/ }).querySelector('[aria-label="저장 안 됨"]')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { taskId: 'T001', title: '책 읽기 수정', description: '책 20분 읽기', reward: 7, isActive: true, sortOrder: 1, allowedStudentIds: ['S001'], availableFrom: null, dueAt: null, prerequisiteTaskId: null },
        ],
      }),
    }));
    await findNotice('과제 1개 저장 완료');
    expect(fetch).not.toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' }));
    await waitFor(() => expect(within(taskEditorPanel('책 읽기 수정')).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true));
    fireEvent.click(within(taskEditorPanel('책 읽기 수정')).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 수정 과제 편집' })).toBeNull());

    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    expect(within(selectionBar()).queryByRole('button', { name: '초기화' })).toBeNull();
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '삭제' }));
    await confirmDialog('삭제');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T001', 'T002'] }),
    }));
    await findNotice('선택 과제 2개 삭제 완료');
    expect(await screen.findByText('첫 과제를 만들어 보세요')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '새 과제' })[0]);
    const editor = await screen.findByRole('dialog', { name: '새 과제' });
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(within(editor).getByRole('button', { name: '과제 만들기' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'POST' })));
    await findNotice('T001 과제 추가 완료');
    expect(await findTaskRow('영어 단어')).toBeTruthy();
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

    await renderTasks();
    const editor = await openNewTaskEditor();
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: ' 영어 단어 ' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '10' } });
    const create = within(editor).getByRole('button', { name: '과제 만들기' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(fetchCalls('/api/tasks', 'POST')).toHaveLength(1);

    first.resolve();
    await findNotice('temporary task failure');
    expect(screen.getByRole('dialog', { name: '새 과제' })).toBe(editor);
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.click(create);
    malformed.resolve();
    await findNotice('과제를 추가하지 못했습니다.');
    expect(screen.queryByRole('button', { name: '영어 단어 과제 편집', hidden: true })).toBeNull();
    fireEvent.click(create);
    valid.resolve();
    await findNotice('T003 과제 추가 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());
    expect(await findTaskRow('영어 단어')).toBeTruthy();

    expect(fetchCalls('/api/tasks', 'POST').map(([, init]) => JSON.parse(String(init?.body)).operationId)).toEqual([
      '50000000-0000-4000-8000-000000000051',
      '50000000-0000-4000-8000-000000000051',
      '50000000-0000-4000-8000-000000000051',
    ]);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    const reopened = await openNewTaskEditor();
    expect(within(reopened).getByLabelText('새 과제명')).toHaveProperty('value', '');
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

    await renderTasks();
    const editor = await openNewTaskEditor();
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '첫 과제' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '1' } });
    fireEvent.click(within(editor).getByRole('button', { name: '과제 만들기' }));
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '새 초안' } });
    fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '2' } });

    first.resolve();
    await findNotice('T003 과제 추가 완료');
    await findTaskRow('첫 과제');
    const reopened = await openNewTaskEditor();
    expect(within(reopened).getByLabelText('새 과제명')).toHaveProperty('value', '새 초안');
    expect(within(reopened).getByLabelText('새 과제 보상')).toHaveProperty('value', '2');
    fireEvent.click(within(reopened).getByRole('button', { name: '과제 만들기' }));
    second.resolve();
    await findTaskRow('새 초안');

    expect(fetchCalls('/api/tasks', 'POST').map(([, init]) => JSON.parse(String(init?.body)).operationId)).toEqual([
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

    await renderTasks();
    const editor = await openNewTaskEditor();
    fireEvent.click(within(editor).getByRole('tab', { name: /^대상 학생/ }));
    fireEvent.click(within(editor).getByLabelText('전체 학생 행 선택'));
    fireEvent.click(within(editor).getByRole('tab', { name: /^기본 정보/ }));
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '순서 과제' } });
    fireEvent.click(within(editor).getByRole('tab', { name: /^반복/ }));
    fireEvent.click(within(within(editor).getByRole('group', { name: '반복 주기' })).getByRole('button', { name: '매주' }));
    fireEvent.click(within(editor).getByRole('button', { name: '금요일' }));
    fireEvent.click(within(editor).getByRole('button', { name: '과제 만들기' }));

    await waitFor(() => expect(fetchCalls('/api/tasks', 'POST')).toHaveLength(1));
    const body = lastBody('/api/tasks', 'POST');
    expect(body.allowedStudentIds).toEqual(['S001', 'S002']);
    expect(body.schedule.recurrence).toMatchObject({ type: 'WEEKLY', weekdays: [1, 5] });
    await findNotice('과제를 추가하지 못했습니다.');
    expect(screen.queryByRole('button', { name: '순서 과제 과제 편집', hidden: true })).toBeNull();
  });

  it('creates new student and product rows through POST APIs', async () => {
    render(<AdminManagePage />);

    await openAdminMenu('학생');
    const studentEditor = await openNewStudentEditor();
    fireEvent.change(within(studentEditor).getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(within(studentEditor).getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.click(within(studentEditor).getByRole('button', { name: '새 학생 추가' }));
    await findNotice('S003 추가 완료');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '학생 추가' })).toBeNull());
    expect(screen.getByRole('button', { name: 'S003 박도윤 편집' })).toBeTruthy();

    await openAdminMenu('매점');
    const productEditor = await openNewProductEditor();
    fireEvent.change(within(productEditor).getByLabelText('새 상품명'), { target: { value: '간식쿠폰' } });
    fireEvent.change(within(productEditor).getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(within(productEditor).getByLabelText('새 상품 재고'), { target: { value: '5' } });
    fireEvent.change(within(productEditor).getByLabelText('새 상품 카테고리'), { target: { value: '쿠폰' } });
    fireEvent.change(within(productEditor).getByLabelText('새 상품 이미지 주소'), { target: { value: 'https://example.com/snack.png' } });
    fireEvent.change(within(productEditor).getByLabelText('새 상품 정렬'), { target: { value: '3' } });
    fireEvent.click(within(productEditor).getByRole('button', { name: '새 상품 추가' }));

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

    await findNotice('P003 추가 완료');
    expect(await screen.findByRole('button', { name: 'P003 간식쿠폰 편집' })).toBeTruthy();
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
    await openAdminMenu('학생');
    const editor = await openNewStudentEditor();
    fireEvent.change(within(editor).getByLabelText('새 학생 ID'), { target: { value: ' S003 ' } });
    fireEvent.change(within(editor).getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    const create = within(editor).getByRole('button', { name: '새 학생 추가' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(fetchCalls('/api/students', 'POST')).toHaveLength(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    first.resolve();
    await findNotice('temporary student failure');
    fireEvent.change(within(editor).getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.click(create);
    malformed.resolve();
    await findNotice('학생을 추가하지 못했습니다.');
    expect(within(editor).getByLabelText('새 학생 ID')).toHaveProperty('value', 'S003');
    expect(screen.queryByRole('button', { name: 'S003 박도윤 편집', hidden: true })).toBeNull();

    fireEvent.click(create);
    valid.resolve();
    await findNotice('S003 추가 완료');
    expect(await screen.findByRole('button', { name: 'S003 박도윤 편집' })).toBeTruthy();
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    const bodies = fetchCalls('/api/students', 'POST').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000031',
    ]);
    const reopened = await openNewStudentEditor();
    expect(within(reopened).getByLabelText('새 학생 ID')).toHaveProperty('value', '');
    expect(within(reopened).getByLabelText('새 학생 이름')).toHaveProperty('value', '');
  });

  it('gives a changed student draft a new operation ID after an earlier creation succeeds', async () => {
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
    await openAdminMenu('학생');
    const editor = await openNewStudentEditor();
    fireEvent.change(within(editor).getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(within(editor).getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.click(within(editor).getByRole('button', { name: '새 학생 추가' }));
    first.resolve();
    await findNotice('S003 추가 완료');
    expect(await screen.findByRole('button', { name: 'S003 박도윤 편집' })).toBeTruthy();

    const next = await openNewStudentEditor();
    fireEvent.change(within(next).getByLabelText('새 학생 ID'), { target: { value: 'S004' } });
    fireEvent.change(within(next).getByLabelText('새 학생 이름'), { target: { value: '새 초안' } });
    fireEvent.change(within(next).getByLabelText('새 학생 잔액'), { target: { value: '-10' } });
    fireEvent.click(within(next).getByRole('button', { name: '새 학생 추가' }));
    second.resolve();
    expect(await screen.findByRole('button', { name: 'S004 새 초안 편집' })).toBeTruthy();
    const bodies = fetchCalls('/api/students', 'POST').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000041',
      '50000000-0000-4000-8000-000000000042',
    ]);
    expect(bodies[1]).toMatchObject({ studentId: 'S004', name: '새 초안', balance: -10 });
  });

  it('suppresses synchronous duplicate product creation and reuses a failed unchanged attempt ID', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000021')
      .mockReturnValueOnce('50000000-0000-4000-8000-000000000022');
    const first = deferredResponse({ error: 'temporary failure' }, { status: 400 });
    const second = deferredResponse({
      productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5,
      isActive: true, imageUrl: '', category: '', sortOrder: 3,
    });
    const responses = [first.response, second.response];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    await openAdminMenu('매점');
    const editor = await openNewProductEditor();
    fireEvent.change(within(editor).getByLabelText('새 상품명'), { target: { value: '간식쿠폰' } });
    fireEvent.change(within(editor).getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(within(editor).getByLabelText('새 상품 재고'), { target: { value: '5' } });
    const create = within(editor).getByRole('button', { name: '새 상품 추가' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(fetchCalls('/api/products', 'POST')).toHaveLength(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

    first.resolve();
    await findNotice('temporary failure');
    fireEvent.click(create);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    second.resolve();
    await findNotice('P003 추가 완료');

    const bodies = fetchCalls('/api/products', 'POST').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '상품 추가' })).toBeNull());
    const reopened = await openNewProductEditor();
    expect(within(reopened).getByLabelText('새 상품명')).toHaveProperty('value', '');
    expect(within(reopened).getByLabelText('새 상품 가격')).toHaveProperty('value', '0');
  });

  it('retains the product attempt and draft after a malformed 2xx response', async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('50000000-0000-4000-8000-000000000025');
    const created = {
      productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5,
      isActive: true, imageUrl: '', category: '', sortOrder: 3,
    };
    const responses = [jsonResponse({}), jsonResponse(created)];
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === '/api/products' && init?.method === 'POST'
        ? responses.shift()!
        : fallback(input, init));

    render(<AdminManagePage />);
    await openAdminMenu('매점');
    const editor = await openNewProductEditor();
    const name = within(editor).getByLabelText('새 상품명');
    const create = within(editor).getByRole('button', { name: '새 상품 추가' });
    fireEvent.change(name, { target: { value: '간식쿠폰' } });
    fireEvent.change(within(editor).getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(within(editor).getByLabelText('새 상품 재고'), { target: { value: '5' } });

    fireEvent.click(create);
    await findNotice('상품을 추가하지 못했습니다.');
    expect(name).toHaveProperty('value', '간식쿠폰');
    expect(screen.getByRole('dialog', { name: '상품 추가' })).toBe(editor);

    fireEvent.click(create);
    await findNotice('P003 추가 완료');
    const bodies = fetchCalls('/api/products', 'POST').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '상품 추가' })).toBeNull());
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
    await openAdminMenu('매점');
    const editor = await openNewProductEditor();
    const name = within(editor).getByLabelText('새 상품명');
    const create = within(editor).getByRole('button', { name: '새 상품 추가' });
    fireEvent.change(name, { target: { value: '간식쿠폰' } });
    fireEvent.click(create);
    await findNotice('temporary failure');

    fireEvent.change(name, { target: { value: '다른쿠폰' } });
    fireEvent.click(create);
    await waitFor(() => expect(fetchCalls('/api/products', 'POST')).toHaveLength(2));

    const bodies = fetchCalls('/api/products', 'POST').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.operationId)).toEqual([
      '50000000-0000-4000-8000-000000000031',
      '50000000-0000-4000-8000-000000000032',
    ]);
  });

  async function startCurrencyScan(mode: '지급' | '회수', amount: string) {
    await openAdminMenu('지급·회수');
    fireEvent.click(within(screen.getByRole('group', { name: '지급 또는 회수' })).getByRole('button', { name: mode }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: amount } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    return screen.findByRole('dialog', { name: '학생 QR 인식' });
  }

  async function openBulkBalance(studentIds: string[]) {
    await openAdminMenu('학생');
    for (const id of studentIds) fireEvent.click(await screen.findByLabelText(`${id} 선택`));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '잔액 변경' }));
    return screen.findByRole('dialog', { name: '잔액 한꺼번에 바꾸기' });
  }

  it('shows a loading popup after recognizing a currency QR before the result popup', async () => {
    const currencyRequest = deferredResponse([{ studentId: 'S001', balance: 3900 }]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/bank/student?studentId=S001') return jsonResponse({ studentId: 'S001', name: '김민준', balance: 3200 });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return currencyRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    const scanner = await startCurrencyScan('지급', '700');
    fireEvent.change(within(scanner).getByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(within(scanner).getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: '화폐 지급 처리 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 화폐를 지급하는 중입니다.');
    currencyRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
  });

  it('adjusts one scanned student from the currency grant/collect tab with result popups', async () => {
    const signedQr = 'csq1.current.c2lnbmVkLXN0dWRlbnQ.signature';
    render(<AdminManagePage />);

    await openAdminMenu('지급·회수');
    expect(screen.getByRole('heading', { name: '화폐 지급·회수' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'QR 인식 시작' })).toHaveProperty('disabled', true);
    const scanner = await startCurrencyScan('지급', '700');
    expect(within(screen.getByRole('group', { name: '지급 또는 회수', hidden: true })).getByRole('button', { name: '지급', hidden: true }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(within(scanner).getByLabelText('학생 QR 직접 입력'), { target: { value: signedQr } });
    fireEvent.click(within(scanner).getByRole('button', { name: '직접 입력 적용' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(`/api/bank/student?studentId=${encodeURIComponent(signedQr)}`, { cache: 'no-store' });
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001'], mode: 'add', amount: 700, operationId: '50000000-0000-4000-8000-000000000001' }),
      });
    });
    const result = await screen.findByRole('dialog', { name: '화폐 지급 성공' });
    expect(within(result).getByText('S001 학생에게 700 지급 완료')).toBeTruthy();
    expect(within(result).getAllByRole('button', { name: '닫기' }).length).toBeGreaterThan(0);
    fireEvent.click(within(result).getByRole('button', { name: '다음 학생' }));
    expect(await screen.findByRole('dialog', { name: '학생 QR 인식' })).toBeTruthy();
    expect(screen.getByLabelText('학생 QR 직접 입력')).toHaveProperty('value', '');
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
    const dialog = await openBulkBalance(['S001']);
    fireEvent.click(within(within(dialog).getByRole('group', { name: '선택 학생 작업' })).getByRole('button', { name: '더하기' }));
    fireEvent.change(within(dialog).getByLabelText('선택 학생 금액'), { target: { value: '10' } });
    const apply = within(dialog).getByRole('button', { name: '1명에게 적용' });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(fetchCalls('/api/students/bulk')).toHaveLength(1);
    expect(uuid).toHaveBeenCalledTimes(1);

    first.resolve();
    await findNotice('temporary failure');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '잔액 한꺼번에 바꾸기' })).toBeNull());
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '잔액 변경' }));
    const retryDialog = await screen.findByRole('dialog', { name: '잔액 한꺼번에 바꾸기' });
    expect(within(retryDialog).getByLabelText('선택 학생 금액')).toHaveProperty('value', '10');
    fireEvent.click(within(retryDialog).getByRole('button', { name: '1명에게 적용' }));
    expect(uuid).toHaveBeenCalledTimes(1);
    second.resolve();
    await findNotice('선택 학생 1명 수정 완료');
    const bodies = fetchCalls('/api/students/bulk').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ studentIds: ['S001'], mode: 'add', amount: 10 });
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
    const dialog = await openBulkBalance(['S001']);
    fireEvent.change(within(dialog).getByLabelText('선택 학생 금액'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '1명에게 적용' }));
    await findNotice('temporary failure');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '잔액 한꺼번에 바꾸기' })).toBeNull());
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '잔액 변경' }));
    const again = await screen.findByRole('dialog', { name: '잔액 한꺼번에 바꾸기' });
    fireEvent.change(within(again).getByLabelText('선택 학생 금액'), { target: { value: '11' } });
    fireEvent.click(within(again).getByRole('button', { name: '1명에게 적용' }));
    await waitFor(() => expect(fetchCalls('/api/students/bulk')).toHaveLength(2));
    const ids = fetchCalls('/api/students/bulk').map(([, init]) => JSON.parse(String(init?.body)).operationId);
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
    const scanner = await startCurrencyScan('지급', '700');
    fireEvent.change(within(scanner).getByLabelText('학생 QR 직접 입력'), { target: { value: ' S001 ' } });
    fireEvent.click(within(scanner).getByRole('button', { name: '직접 입력 적용' }));
    const failed = await screen.findByRole('dialog', { name: '화폐 지급 실패' });
    fireEvent.click(within(failed).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '학생 QR 인식' })).toBeNull();
    const bodies = fetchCalls('/api/students/bulk').map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ studentIds: ['S001'], mode: 'add', amount: 700, operationId: '50000000-0000-4000-8000-000000000001' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('shows a failure popup with retry and cancel when a scanned currency adjustment fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(adminProductEnvelope());
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/bank/student?studentId=S002') return jsonResponse({ studentId: 'S002', name: '이서연', balance: 1500 });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return jsonResponse({ error: '잔액은 0보다 작아질 수 없습니다.' }, { status: 400 });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    const scanner = await startCurrencyScan('회수', '9999');
    fireEvent.change(within(scanner).getByLabelText('학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(within(scanner).getByRole('button', { name: '직접 입력 적용' }));

    const result = await screen.findByRole('dialog', { name: '화폐 회수 실패' });
    expect(within(result).getByText('잔액은 0보다 작아질 수 없습니다.')).toBeTruthy();
    expect(within(result).getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(within(result).getByRole('button', { name: '취소' })).toBeTruthy();
  });

  /** Value shown next to a TaskScheduleProjection label (현재 일정 / 현재 회차 / 다음 회차 시작 / 새 회차 처리). */
  function projectionValue(container: HTMLElement, label: string) {
    const term = within(container).getAllByText(label).find((node) => node.tagName === 'DT');
    return term?.nextElementSibling?.textContent ?? null;
  }

  function recurrenceType(container: HTMLElement, label: '반복 없음' | '매일' | '매주' | '매월') {
    return within(within(container).getByRole('group', { name: '반복 주기' })).getByRole('button', { name: label });
  }

  async function openBulkRecurrence() {
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '선택 과제 반복 설정' }));
    return screen.findByRole('dialog', { name: '과제 기한 설정' });
  }

  async function openBulkAssignment() {
    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: '선택 과제 학생 부여' }));
    return screen.findByRole('dialog', { name: '과제 부여' });
  }

  it('edits recurring schedules with strict payloads from the 반복 tab and shows current-cycle origins', async () => {
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
      if (url === '/api/tasks/T001/assignments') return jsonResponse({
        taskId: 'T001', cycleId: 'cycle-2', startsAt: '2026-09-01T00:00:00.000Z', endsAt: null, transition: 'NATURAL_BOUNDARY',
        students: [
          { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'DEFAULT', completionOrigin: 'CARRY' },
          { studentId: 'S002', name: '이서연', assigned: false, completed: false, assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' },
        ],
      });
      return fallback(input, init);
    });
    await renderTasks();
    const initialRow = screen.getAllByTestId('task-row')[0];
    expect(within(initialRow).queryByText(/현재 회차|S001 부여/)).toBeNull();
    expect(within(initialRow).getByText('매주 화 09:00')).toBeTruthy();

    const panel = await openTaskEditor('책 읽기');
    fireEvent.change(within(panel).getByLabelText('T001 과제명'), { target: { value: '저장 안 한 제목' } });
    fireEvent.change(within(panel).getByLabelText('T001 보상'), { target: { value: '77' } });
    fireEvent.change(within(panel).getByLabelText('시작 시각'), { target: { value: '2030-01-01T10:00' } });
    fireEvent.change(within(panel).getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(within(panel).getByLabelText('선행 과제'), { target: { value: 'T002' } });

    const editing = taskEditorPanel('저장 안 한 제목');
    fireEvent.click(within(editing).getByRole('tab', { name: /^반복/ }));
    await within(editing).findByRole('group', { name: '반복 주기' });
    expect(recurrenceType(editing, '매주').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(recurrenceType(editing, '매월'));
    fireEvent.change(within(editing).getByLabelText('반복 시간'), { target: { value: '17:45' } });
    fireEvent.change(within(editing).getByLabelText('반복 날짜'), { target: { value: '31' } });
    fireEvent.click(within(editing).getByRole('switch', { name: '회차마다 부여 초기화' }));
    expect(within(editing).getByRole('tab', { name: /^반복/ }).querySelector('[aria-label="저장 안 됨"]')).toBeTruthy();
    fireEvent.click(within(editing).getByRole('button', { name: '반복 설정 저장' }));

    await waitFor(() => expect(fetchCalls('/api/tasks/T001', 'PATCH')).toHaveLength(1));
    const body = lastBody('/api/tasks/T001', 'PATCH');
    expect(body).toEqual({
      schedule: { recurrence: { type: 'MONTHLY', time: '17:45', dayOfMonth: 31 }, timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true },
      availableFrom: '2030-01-01T01:00:00.000Z',
      dueAt: '2030-01-02T03:30:00.000Z',
      prerequisiteTaskId: 'T002',
    });
    expect(body.schedule).not.toHaveProperty('ruleVersion');
    expect(body.schedule).not.toHaveProperty('effectiveFrom');
    await waitFor(() => expect(projectionValue(taskEditorPanel('저장 안 한 제목'), '현재 일정')).toBe('매월 31일 17:45'));
    expect(screen.queryByRole('dialog', { name: '과제 기한 설정' })).toBeNull();

    fireEvent.click(within(taskEditorPanel('저장 안 한 제목')).getByRole('tab', { name: /^기본 정보/ }));
    const basic = taskEditorPanel('저장 안 한 제목');
    expect(within(basic).getByLabelText('T001 과제명')).toHaveProperty('value', '저장 안 한 제목');
    expect(within(basic).getByLabelText('T001 보상')).toHaveProperty('value', '77');
    fireEvent.click(within(basic).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(fetchCalls('/api/tasks/batch', 'PATCH')).toHaveLength(1));
    const definition = lastBody('/api/tasks/batch', 'PATCH');
    expect(definition.tasks).toHaveLength(1);
    expect(definition.tasks[0]).not.toHaveProperty('schedule');
    expect(definition.tasks[0]).toMatchObject({
      taskId: 'T001', title: '저장 안 한 제목', reward: 77,
      availableFrom: '2030-01-01T01:00:00.000Z',
      dueAt: '2030-01-02T03:30:00.000Z',
      prerequisiteTaskId: 'T002',
    });
    await findNotice('과제 1개 저장 완료');

    const saved = await screen.findByRole('dialog', { name: /과제 편집$/ });
    fireEvent.click(within(saved).getByRole('tab', { name: /^학생 현황/ }));
    const row = await within(saved).findByTestId('task-assignment-row-S001');
    await waitFor(() => expect(row.textContent).toContain('김민준'));
    expect(row.textContent).not.toMatch(/기본값|이월/);
    expect(within(saved).getByText(/이번 회차/)).toBeTruthy();
    fireEvent.click(within(saved).getByRole('button', { name: 'S002 이서연 부여 상태' }));
    fireEvent.click(within(saved).getByRole('button', { name: '저장' }));
    await findNotice('과제 부여 저장 완료');
  });

  it('preserves unsaved definition edits while reconciling a saved schedule projection', async () => {
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
        return jsonResponse(taskGetCount === 1 ? serverRows : [refreshedTask, { ...tasks[1], title: '서버 수학' }]);
      }
      if (url === '/api/tasks/T001' && init?.method === 'PATCH') return jsonResponse(scheduledTask);
      return fallback(input, init);
    });

    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    fireEvent.change(within(panel).getByLabelText('T001 과제 설명'), { target: { value: '저장 안 한 설명' } });
    fireEvent.change(within(panel).getByLabelText('T001 보상'), { target: { value: '77' } });
    fireEvent.click(within(panel).getByRole('tab', { name: /^반복/ }));
    fireEvent.change(await within(panel).findByLabelText('반복 시간'), { target: { value: '10:30' } });
    fireEvent.click(within(panel).getByRole('button', { name: '반복 설정 저장' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    await waitFor(() => expect(projectionValue(taskEditorPanel('책 읽기'), '현재 일정')).toBe('매일 10:30'));
    fireEvent.click(within(taskEditorPanel('책 읽기')).getByRole('tab', { name: /^기본 정보/ }));
    expect(within(taskEditorPanel('책 읽기')).getByLabelText('T001 과제 설명')).toHaveProperty('value', '저장 안 한 설명');
    expect(within(taskEditorPanel('책 읽기')).getByLabelText('T001 보상')).toHaveProperty('value', '77');
    expect(screen.getByRole('button', { name: '수학 학습지 과제 편집', hidden: true })).toBeTruthy();
  });

  it('preserves unsaved definition edits while reconciling only reset task projections', async () => {
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
        return jsonResponse(taskGetCount === 1 ? [staleTask, tasks[1]] : [resetTask, { ...tasks[1], title: '서버 수학' }]);
      }
      if (url === '/api/tasks/completions/reset' && init?.method === 'POST') return jsonResponse({ taskIds: ['T001'], deletedCount: 1 });
      return fallback(input, init);
    });

    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    fireEvent.change(within(panel).getByLabelText('T001 과제 설명'), { target: { value: '초기화와 무관한 설명' } });
    fireEvent.change(within(panel).getByLabelText('T001 보상'), { target: { value: '88' } });
    fireEvent.click(within(panel).getByRole('tab', { name: /^학생 현황/ }));
    await within(panel).findByTestId('task-assignment-row-S001');
    await waitFor(() => expect(within(panel).queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    fireEvent.click(within(panel).getByRole('button', { name: '완료 기록 초기화' }));
    fireEvent.click(await screen.findByRole('button', { name: '완료 기록 초기화 확인' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    await findNotice('완료 기록 1건 초기화 완료');
    fireEvent.click(within(taskEditorPanel('책 읽기')).getByRole('tab', { name: /^기본 정보/ }));
    expect(within(taskEditorPanel('책 읽기')).getByLabelText('T001 과제 설명')).toHaveProperty('value', '초기화와 무관한 설명');
    expect(within(taskEditorPanel('책 읽기')).getByLabelText('T001 보상')).toHaveProperty('value', '88');
    expect(screen.getByRole('button', { name: '수학 학습지 과제 편집', hidden: true })).toBeTruthy();
  });

  it('shows an effective pending schedule in the list and recurrence tab without a timezone control', async () => {
    const currentSchedule = { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false } as const;
    const pendingSchedule = { ruleVersion: 2, effectiveFrom: '2001-01-01T00:00:00.000Z', timeZone: 'Europe/Paris', recurrence: { type: 'WEEKLY', weekdays: [5], time: '16:30' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: true } as const;
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tasks?includeInactive=1') return jsonResponse([{ ...tasks[0], schedule: currentSchedule, pendingSchedule }]);
      return fallback(input, init);
    });

    await renderTasks();
    const row = screen.getByTestId('task-row');
    expect(within(row).getByText('매주 금 16:30')).toBeTruthy();
    expect(within(row).queryByText('매일 09:00')).toBeNull();
    const panel = await openTaskEditor('책 읽기', '반복');
    await within(panel).findByRole('group', { name: '반복 주기' });
    expect(projectionValue(panel, '현재 일정')).toBe('매주 금 16:30');
    expect(projectionValue(panel, '새 회차 처리')).toBe('완료 지움 · 부여 지움');
    expect(recurrenceType(panel, '매주').getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getByLabelText('반복 시간')).toHaveProperty('value', '16:30');
    expect(within(panel).getByRole('button', { name: '금요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).queryByLabelText('과제 시간대')).toBeNull();
  });

  /** Creates 영어 단어 with a daily 14:00 recurrence from the new-task panel. */
  async function createDailyTask(extra: (editor: HTMLElement) => void = () => undefined) {
    const editor = await openNewTaskEditor();
    fireEvent.change(within(editor).getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    extra(editor);
    fireEvent.click(within(editor).getByRole('tab', { name: /^반복/ }));
    fireEvent.click(recurrenceType(editor, '매일'));
    fireEvent.change(within(editor).getByLabelText('반복 시간'), { target: { value: '14:00' } });
    fireEvent.click(within(editor).getByRole('button', { name: '과제 만들기' }));
  }

  it('refreshes a newly created task projection without replacing the other task rows', async () => {
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

    await renderTasks();
    await createDailyTask((editor) => {
      fireEvent.change(within(editor).getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
      fireEvent.change(within(editor).getByLabelText('새 과제 보상'), { target: { value: '10' } });
      fireEvent.change(within(editor).getByLabelText('새 과제 정렬'), { target: { value: '3' } });
    });

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(lastBody('/api/tasks', 'POST').schedule).toMatchObject({ recurrence: { type: 'DAILY', time: '14:00' } });
    expect(await findTaskRow('영어 단어 (서버)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '책 읽기 과제 편집' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '수학 학습지 과제 편집' })).toBeTruthy();
    expect(screen.getAllByTestId('task-row')).toHaveLength(3);
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

    await renderTasks();
    await createDailyTask();

    await findNotice('T003 과제 추가 완료');
    await findNotice('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다: projection unavailable');
    expect(await findTaskRow('영어 단어')).toBeTruthy();
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

    await renderTasks();
    await createDailyTask();

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(await findTaskRow('영어 단어')).toBeTruthy();
    await findNotice('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다');
    expect(fetchCalls('/api/tasks', 'POST')).toHaveLength(1);
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

    await renderTasks();
    await createDailyTask();

    await waitFor(() => expect(taskGetCount).toBe(2));
    expect(await findTaskRow('영어 단어')).toBeTruthy();
    await findNotice('과제는 추가되었지만 회차 정보를 새로고침하지 못했습니다');
    expect(fetchCalls('/api/tasks', 'POST')).toHaveLength(1);
  });

  it('keeps the applied recurrence draft of a new task across tabs and reopening', async () => {
    await renderTasks();
    const editor = await openNewTaskEditor();
    fireEvent.click(within(editor).getByRole('tab', { name: /^반복/ }));
    fireEvent.click(recurrenceType(editor, '매일'));
    fireEvent.change(within(editor).getByLabelText('반복 시간'), { target: { value: '14:25' } });
    fireEvent.click(within(editor).getByRole('tab', { name: /^기본 정보/ }));
    fireEvent.click(within(editor).getByRole('tab', { name: /^반복/ }));
    expect(recurrenceType(editor, '매일').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).getByLabelText('반복 시간')).toHaveProperty('value', '14:25');

    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());
    const reopened = await openNewTaskEditor();
    fireEvent.click(within(reopened).getByRole('tab', { name: /^반복/ }));
    expect(recurrenceType(reopened, '매일').getAttribute('aria-pressed')).toBe('true');
    expect(within(reopened).getByLabelText('반복 시간')).toHaveProperty('value', '14:25');
    expect(within(reopened).getByText('미리보기: 매일 14:25')).toBeTruthy();
  });

  it('ignores an older assignment status response after the same task panel is closed and reopened', async () => {
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

    await renderTasks();
    const panel = await openTaskEditor('책 읽기', '학생 현황');
    await within(panel).findByRole('status', { name: '과제 부여 상태 불러오는 중' });
    fireEvent.click(within(panel).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 편집' })).toBeNull());
    const reopened = await openTaskEditor('책 읽기', '학생 현황');
    await waitFor(() => expect(assignmentGetCount).toBe(2));

    await act(async () => {
      second.resolve();
      await second.response;
    });
    await waitFor(() => expect(within(reopened).queryByRole('status', { name: '과제 부여 상태 불러오는 중' })).toBeNull());
    expect(within(reopened).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여');
    expect(within(reopened).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');

    await act(async () => {
      first.resolve();
      await first.response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(reopened).getByRole('button', { name: 'S002 이서연 부여 상태' }).textContent).toBe('부여');
    expect(within(reopened).getByRole('button', { name: 'S002 이서연 완료 상태' }).textContent).toBe('완료');
  });

  it('does not show an assignment editor or notice for an error from a closed request', async () => {
    const staleError = deferredResponse({ error: '뒤늦은 부여 조회 오류' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => (
      String(input) === '/api/tasks/T001/assignments' && !init?.method ? staleError.response : fallback(input, init)
    ));

    await renderTasks();
    const panel = await openTaskEditor('책 읽기', '학생 현황');
    await within(panel).findByRole('status', { name: '과제 부여 상태 불러오는 중' });
    fireEvent.click(within(panel).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 편집' })).toBeNull());

    await act(async () => {
      staleError.resolve();
      await staleError.response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(noticeTexts().join(' ')).not.toContain('뒤늦은 부여 조회 오류');
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
    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    fireEvent.click(within(panel).getByRole('button', { name: 'T001 기록 보기' }));
    const history = screen.getByRole('dialog', { name: '과제 기록' });
    expect(within(history).getByRole('status', { name: '과제 기록 불러오는 중' })).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: '닫기' }));
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog', { name: '과제 기록' })).toBeNull();
    fireEvent.keyDown(taskEditorPanel('책 읽기'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '책 읽기 과제 편집' })).toBeNull());

    const second = await openTaskEditor('수학 학습지');
    fireEvent.click(within(second).getByRole('button', { name: 'T002 기록 보기' }));
    const errorDialog = screen.getByRole('dialog', { name: '과제 기록' });
    expect((await within(errorDialog).findByRole('alert')).textContent).toContain('기록 서버 오류');
    expect(errorDialog.textContent).toContain('수학 학습지 (T002)');
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

    await renderTasks();
    const panel = await openTaskEditor('책 읽기', '반복');
    await within(panel).findByRole('group', { name: '반복 주기' });
    expect(projectionValue(panel, '현재 일정')).toBe('매주 화 09:00');
    fireEvent.click(recurrenceType(panel, '매월'));
    fireEvent.change(within(panel).getByLabelText('반복 시간'), { target: { value: '17:45' } });
    fireEvent.change(within(panel).getByLabelText('반복 날짜'), { target: { value: '31' } });
    expect(within(panel).getByText('29~31일이 없는 달은 그 달 마지막 날로 바뀝니다.')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '반복 설정 저장' }));

    await waitFor(() => expect(taskGetCount).toBe(2));
    await waitFor(() => expect(projectionValue(taskEditorPanel('책 읽기'), '현재 일정')).toBe('매월 31일 17:45'));
    expect(projectionValue(taskEditorPanel('책 읽기'), '현재 회차')).not.toContain('2026. 8. 25.');
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

    await renderTasks();
    expect(screen.getByTestId('task-row').textContent).toContain('1 / 1명');
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: '완료 기록 초기화' }));
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(within(confirmation).getByText(/이미 지급한 보상은 회수되지 않습니다/)).toBeTruthy();
    expect(within(confirmation).getByText(/같은 회차에서 학생이 은행에서 다시 완료하면 보상을 또 받을 수 있습니다/)).toBeTruthy();
    expect(fetchCalls('/api/tasks/completions/reset', 'POST')).toHaveLength(0);
    fireEvent.click(within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' }));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(taskGetCount).toBe(2));
    await findNotice('완료 기록 1건 초기화 완료');
    expect(screen.getByTestId('task-row').textContent).toContain('0 / 1명');
  });

  it('summarizes recurrence in compact task rows and shows themed schedule details in the 반복 tab', async () => {
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

    await renderTasks();
    const row = screen.getByTestId('task-row');
    expect(within(row).getByText('매주 화 09:00')).toBeTruthy();
    expect(within(row).getByText('1명 부여')).toBeTruthy();
    expect(row.textContent).toContain('0 / 1명');
    expect(within(row).queryByText(/현재 일정|현재 회차|다음 회차 시작/)).toBeNull();

    const panel = await openTaskEditor('책 읽기', '반복');
    await within(panel).findByRole('group', { name: '반복 주기' });
    expect(projectionValue(panel, '현재 일정')).toBe('매주 화 09:00');
    expect(projectionValue(panel, '현재 회차')).toContain('~');
    expect(projectionValue(panel, '다음 회차 시작')).not.toBe('없음 (상시 과제)');
    expect(projectionValue(panel, '새 회차 처리')).toBe('완료 지움 · 부여 유지');
    expect(within(panel).queryByLabelText('과제 시간대')).toBeNull();
    expect(panel.innerHTML).not.toContain('violet-');
    expect(panel.innerHTML).toContain('var(--crs-line)');
  });

  it('disables assignment save while status GET is pending and explains admin completion reward behavior', async () => {
    const pending = deferredResponse({ taskId: 'T001', students: [] });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/T001/assignments' && !init?.method ? pending.response : fallback(input, init));

    await renderTasks();
    const panel = await openTaskEditor('책 읽기', '학생 현황');
    await within(panel).findByRole('status', { name: '과제 부여 상태 불러오는 중' });
    expect(within(panel).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true);
    expect(within(panel).getByText(/여기서 완료로 표시하면 보상은 지급되지 않습니다/)).toBeTruthy();
    pending.resolve();
    await waitFor(() => expect(within(panel).getByRole('button', { name: '저장' })).toHaveProperty('disabled', false));
  });

  it('opens bulk recurrence blank, names the snapshotted targets, and sends one batch request', async () => {
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/schedules/batch' && init?.method === 'POST'
      ? jsonResponse({ updatedTaskIds: ['T001', 'T002'] })
      : fallback(input, init));
    await renderTasks();
    const dialog = await openBulkRecurrence();

    expect(within(dialog).getByText('대상: 책 읽기, 수학 학습지')).toBeTruthy();
    expect(within(dialog).getByText(/선택한 모든 과제에 같은 반복 규칙을 적용합니다/)).toBeTruthy();
    for (const type of ['반복 없음', '매일', '매주', '매월'] as const) expect(recurrenceType(dialog, type).getAttribute('aria-pressed')).toBe('false');
    expect(within(dialog).queryByLabelText('반복 시간')).toBeNull();
    expect(within(dialog).queryByRole('group', { name: '반복 요일' })).toBeNull();
    expect(within(dialog).queryByLabelText('반복 날짜')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '반복 설정 저장' })).toHaveProperty('disabled', true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/assignments'))).toBe(false);

    fireEvent.click(recurrenceType(dialog, '매일'));
    fireEvent.change(within(dialog).getByLabelText('반복 시간'), { target: { value: '10:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '반복 설정 저장' }));
    await waitFor(() => expect(fetchCalls('/api/tasks/schedules/batch', 'POST')).toHaveLength(1));
    expect(lastBody('/api/tasks/schedules/batch', 'POST')).toEqual({
      taskIds: ['T001', 'T002'],
      schedule: { recurrence: { type: 'DAILY', time: '10:30' }, timeZone: 'Asia/Seoul', resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '과제 기한 설정' })).toBeNull());
  });

  it('requires an explicit valid rule before bulk recurrence can be saved', async () => {
    await renderTasks();
    const dialog = await openBulkRecurrence();
    const save = within(dialog).getByRole('button', { name: '반복 설정 저장' });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.click(recurrenceType(dialog, '매주'));
    const weekdays = within(dialog).getByRole('group', { name: '반복 요일' });
    expect(within(weekdays).getByRole('button', { name: '월요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByLabelText('반복 시간')).toHaveProperty('value', '09:00');
    expect(save).toHaveProperty('disabled', false);
    // The last selected weekday cannot be removed, so a weekly rule always names a day.
    fireEvent.click(within(weekdays).getByRole('button', { name: '월요일' }));
    expect(within(weekdays).getByRole('button', { name: '월요일' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(weekdays).getByRole('button', { name: '수요일' }));
    fireEvent.click(within(weekdays).getByRole('button', { name: '월요일' }));
    expect(within(weekdays).getByRole('button', { name: '월요일' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(weekdays).getByRole('button', { name: '수요일' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(recurrenceType(dialog, '매월'));
    expect(within(dialog).getByLabelText('반복 날짜')).toHaveProperty('value', '1');
    fireEvent.change(within(dialog).getByLabelText('반복 날짜'), { target: { value: '' } });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('반복 날짜'), { target: { value: '15' } });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.change(within(dialog).getByLabelText('반복 시간'), { target: { value: '' } });
    expect(save).toHaveProperty('disabled', true);
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
    await renderTasks();
    const dialog = await openBulkAssignment();

    expect(within(dialog).getByText('대상: 책 읽기, 수학 학습지')).toBeTruthy();
    expect(within(dialog).getByText(/선택한 모든 과제에 같은 변경을 적용합니다/)).toBeTruthy();
    expect(within(dialog).getByText(/고르지 않은 학생은 그대로 둡니다/)).toBeTruthy();
    expect(within(dialog).getByLabelText('S001 김민준 부여 작업')).toHaveProperty('value', '');
    expect(within(dialog).getAllByRole('option', { name: '부여 그대로', hidden: true })).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/api\/tasks\/T00\d\/assignments/.test(String(url)))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.change(within(dialog).getByLabelText('S002 이서연 완료 작업'), { target: { value: 'completed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await findNotice(/중단.*책 읽기.*김민준.*수학 학습지.*이서연.*호환/);
    expect(JSON.parse(String(fetchCalls('/api/tasks/assignments/batch', 'POST')[0][1]?.body))).toEqual({ targets: [
      { taskId: 'T001', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
        { studentId: 'S002', completed: true, source: 'ADMIN' },
      ] },
      { taskId: 'T002', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
        { studentId: 'S002', completed: true, source: 'ADMIN' },
      ] },
    ] });

    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(2));
    expect(lastBody('/api/tasks/assignments/batch', 'POST')).toEqual({ targets: [
      { taskId: 'T001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] },
      { taskId: 'T002', operations: [{ studentId: 'S002', completed: true, source: 'ADMIN' }] },
    ] });
    await findNotice('과제 부여 저장 완료');
  });

  it('applies selected-student bulk controls to explicit row operations and save state', async () => {
    await renderTasks();
    const dialog = await openBulkAssignment();
    const save = within(dialog).getByRole('button', { name: '저장' });
    fireEvent.click(within(dialog).getByLabelText('S001 김민준 행 선택'));
    fireEvent.click(within(dialog).getByLabelText('S002 이서연 행 선택'));
    expect(within(dialog).getByText('2명 선택')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '부여 취소' }));
    expect(within(dialog).getByLabelText('S001 김민준 부여 작업')).toHaveProperty('value', 'unassigned');
    expect(within(dialog).getByLabelText('S002 이서연 부여 작업')).toHaveProperty('value', 'unassigned');
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(within(dialog).getByRole('button', { name: '완료' }));
    expect(within(dialog).getByLabelText('S001 김민준 완료 작업')).toHaveProperty('value', 'completed');
    expect(within(dialog).getByLabelText('S002 이서연 완료 작업')).toHaveProperty('value', 'completed');
  });

  it('makes the panel inert under reset confirmation, traps focus, and restores the reset opener on cancel', async () => {
    await renderTasks();
    const panel = await openAssignmentPanel();
    const resetOpener = within(panel).getByRole('button', { name: '완료 기록 초기화' });
    resetOpener.focus();
    fireEvent.click(resetOpener);

    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    const confirm = within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' });
    const close = within(confirmation).getByRole('button', { name: '닫기' });
    const cancel = within(confirmation).getByRole('button', { name: '취소' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirmation, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(confirmation, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull();
    expect(panel.hasAttribute('aria-hidden')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(resetOpener));
    expect(fetchCalls('/api/tasks/completions/reset', 'POST')).toHaveLength(0);
  });

  it('exposes only a focus-trapped loading modal while assignment save is pending and restores focus on failure', async () => {
    const pending = deferredResponse({ error: '저장 실패' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/assignments/batch' && init?.method === 'POST'
      ? pending.response
      : fallback(input, init));

    await renderTasks();
    const assignment = await openBulkAssignment();
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    const save = within(assignment).getByRole('button', { name: '저장' });
    save.focus();
    fireEvent.click(save);
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
    expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(1);

    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
    await findNotice('저장 실패');
    expect(screen.getByRole('dialog', { name: '과제 부여' })).toBe(assignment);
    await waitFor(() => expect(document.activeElement).toBe(save));
  });

  it('locks every recurrence control behind the only accessible loading modal while schedule save is pending', async () => {
    const pending = deferredResponse({ error: '일정 저장 실패' }, { status: 500 });
    const baseFetch = vi.mocked(fetch);
    const fallback = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input, init) => String(input) === '/api/tasks/schedules/batch' && init?.method === 'POST'
      ? pending.response
      : fallback(input, init));

    await renderTasks();
    const recurrence = await openBulkRecurrence();
    fireEvent.click(recurrenceType(recurrence, '매일'));
    fireEvent.change(within(recurrence).getByLabelText('반복 시간'), { target: { value: '09:30' } });
    const save = within(recurrence).getByRole('button', { name: '반복 설정 저장' });
    save.focus();
    fireEvent.click(save);

    const loading = await screen.findByRole('dialog', { name: '반복 설정 저장 중' });
    expect(screen.getAllByRole('dialog')).toEqual([loading]);
    expect(recurrence.getAttribute('aria-hidden')).toBe('true');
    expect(recurrence.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(loading);
    const controls = [
      ...within(recurrence).getAllByRole('button', { hidden: true }),
      ...within(recurrence).getAllByRole('switch', { hidden: true }),
      within(recurrence).getByLabelText('반복 시간'),
      within(recurrence).getByLabelText('시작 시각'),
      within(recurrence).getByLabelText('기한'),
    ];
    for (const control of controls) expect(control.closest('[inert]')).toBe(recurrence);
    fireEvent.keyDown(recurrence, { key: 'Escape' });
    fireEvent.keyDown(loading, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(loading);

    pending.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '반복 설정 저장 중' })).toBeNull());
    await findNotice('일정 저장 실패');
    expect(screen.getByRole('dialog', { name: '과제 기한 설정' })).toBe(recurrence);
    await waitFor(() => expect(document.activeElement).toBe(save));
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

    await renderTasks();
    const assignment = await openBulkAssignment();
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.click(within(assignment).getByRole('button', { name: '저장' }));
    await findNotice(/수학 학습지.*김민준.*작업 실패/);

    fireEvent.click(within(assignment).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(2));
    expect(lastBody('/api/tasks/assignments/batch', 'POST')).toEqual({ targets: [{ taskId: 'T002', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] }] });
    await findNotice(/저장은 완료.*기존 호환 목록.*수학 학습지.*새로고침/);
    expect(noticeTexts()).not.toContain('과제 부여 저장 완료');
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

    await renderTasks();
    const assignment = await openBulkAssignment();
    fireEvent.change(within(assignment).getByLabelText('S001 김민준 부여 작업'), { target: { value: 'assigned' } });
    fireEvent.click(within(assignment).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '과제 부여' })).toBeNull());
    await findNotice(/과제 부여 저장은 완료됐지만.*목록 새로고침 실패.*새로고침/);
    expect(fetchCalls('/api/tasks/assignments/batch', 'POST')).toHaveLength(1);
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

    await renderTasks();
    const panel = await openAssignmentPanel();
    fireEvent.click(within(panel).getByRole('button', { name: '완료 기록 초기화' }));
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull());
    await findNotice(/초기화는 완료됐지만 목록 새로고침 실패.*새로고침/);
    // The pre-reset assignment editor is discarded: the panel either waits for 다시 불러오기 or shows a freshly read status.
    await waitFor(() => {
      const panelNow = taskEditorPanel('책 읽기');
      const reloaded = fetchCalls('/api/tasks/T001/assignments').length >= 2;
      expect(reloaded || within(panelNow).queryByTestId('task-assignment-row-S001') === null).toBe(true);
    });
    expect(fetchCalls('/api/tasks/completions/reset', 'POST')).toHaveLength(1);
  });

  it('keeps reset inside the assignment tab, confirms in-app, locks mutation, and refreshes tasks once', async () => {
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
    await renderTasks();
    expect(screen.queryByRole('button', { name: 'T001 완료 기록 초기화' })).toBeNull();
    expect(screen.queryByRole('button', { name: '완료 기록 초기화' })).toBeNull();
    const panel = await openAssignmentPanel();
    const opener = within(panel).getByRole('button', { name: '완료 기록 초기화' });
    fireEvent.click(opener);
    const confirmation = screen.getByRole('dialog', { name: '완료 기록 초기화 확인' });
    expect(within(confirmation).getByText(/이미 지급한 보상은 회수되지 않습니다/)).toBeTruthy();
    expect(within(confirmation).getByText(/다시 완료하면 보상을 또 받을 수 있습니다/)).toBeTruthy();
    expect(fetchCalls('/api/tasks/completions/reset')).toHaveLength(0);
    const confirmReset = within(confirmation).getByRole('button', { name: '완료 기록 초기화 확인' });
    fireEvent.click(confirmReset);
    fireEvent.click(confirmReset);
    expect(confirmReset).toHaveProperty('disabled', true);
    expect(fetchCalls('/api/tasks/completions/reset')).toHaveLength(1);
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '완료 기록 초기화 중' })).toBeTruthy();
    expect(confirmation.isConnected).toBe(true);
    reset.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '완료 기록 초기화 확인' })).toBeNull());
    await findNotice('완료 기록 1건 초기화 완료');
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(taskGets).toBe(2);
  });

  it('renders the task panel as a full-height sheet whose body scrolls and whose date controls shrink safely', async () => {
    await renderTasks();
    const panel = await openTaskEditor('책 읽기');
    expect(panel.className).toContain('h-full');
    expect(panel.className).toContain('w-full');
    expect(panel.className).toContain('max-w-[560px]');
    const body = within(panel).getByLabelText('T001 과제명').closest('.overflow-y-auto');
    expect(body?.className).toContain('overscroll-contain');
    expect(body?.className).toContain('min-h-0');

    for (const input of [within(panel).getByLabelText('시작 시각'), within(panel).getByLabelText('기한')]) {
      expect(input).toHaveProperty('type', 'datetime-local');
      expect(input.className.split(/\s+/)).toEqual(expect.arrayContaining(['block', 'w-full', 'min-w-0']));
    }
    fireEvent.click(within(panel).getByRole('tab', { name: /^반복/ }));
    await within(panel).findByRole('group', { name: '반복 주기' });
    fireEvent.click(recurrenceType(panel, '매일'));
    const recurrenceTime = within(panel).getByLabelText('반복 시간');
    expect(recurrenceTime.className.split(/\s+/)).toEqual(expect.arrayContaining(['block', 'w-full', 'min-w-0']));
    expect(within(panel).getByRole('group', { name: '반복 주기' }).className).toContain('max-w-full');
  });

  it('edits availability and prerequisite in 기본 정보 and shows clear admin status badges', async () => {
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
      if (String(input) === '/api/tasks/batch' && init?.method === 'PATCH') return jsonResponse([datedTasks[0]]);
      return fallback(input, init);
    });

    await renderTasks();
    const rows = screen.getAllByTestId('task-row');
    const statusOf = (title: string) => rows.find((row) => within(row).queryByText(title))!;
    expect(within(statusOf('책 읽기')).getAllByText('진행 중').length).toBeGreaterThan(0);
    expect(within(statusOf('수학 학습지')).getAllByText('시작 전').length).toBeGreaterThan(0);
    expect(within(statusOf('만료 과제')).getAllByText('마감됨').length).toBeGreaterThan(0);
    expect(within(statusOf('비활성 과제')).getAllByText('숨김').length).toBeGreaterThan(0);

    const panel = await openTaskEditor('책 읽기');
    expect(within(panel).getByLabelText('시작 시각')).toHaveProperty('type', 'datetime-local');
    expect(within(panel).getByLabelText('기한')).toHaveProperty('type', 'datetime-local');
    const prerequisite = within(panel).getByLabelText('선행 과제');
    expect(within(prerequisite).queryByRole('option', { name: '비활성 과제' })).toBeNull();
    expect(within(prerequisite).queryByRole('option', { name: '책 읽기' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: '시작 시각 지우기' }));
    expect(within(panel).getByLabelText('시작 시각')).toHaveProperty('value', '');
    fireEvent.change(within(panel).getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(prerequisite, { target: { value: 'T002' } });
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(fetchCalls('/api/tasks/batch', 'PATCH')).toHaveLength(1));
    expect(lastBody('/api/tasks/batch', 'PATCH').tasks).toEqual([
      expect.objectContaining({ taskId: 'T001', availableFrom: null, dueAt: '2030-01-02T03:30:00.000Z', prerequisiteTaskId: 'T002' }),
    ]);
    expect(fetchCalls('/api/tasks/T001', 'PATCH')).toHaveLength(0);
  });

  it('uses multi-select weekday buttons in the bulk recurrence dialog and excludes prerequisite', async () => {
    await renderTasks();
    const dialog = await openBulkRecurrence();
    expect(within(dialog).queryByLabelText('선행 과제')).toBeNull();
    expect(within(dialog).getByLabelText('시작 시각')).toBeTruthy();
    expect(within(dialog).getByLabelText('기한')).toBeTruthy();
    fireEvent.click(recurrenceType(dialog, '매주'));
    const weekdays = within(dialog).getByRole('group', { name: '반복 요일' });
    fireEvent.click(within(weekdays).getByRole('button', { name: '목요일' }));
    expect(within(weekdays).getByRole('button', { name: '월요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(weekdays).getByRole('button', { name: '목요일' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByText('미리보기: 매주 월, 목 09:00')).toBeTruthy();
  });

  it('does not copy a new-task availability draft into an existing task editor', async () => {
    await renderTasks();
    const editor = await openNewTaskEditor();
    fireEvent.change(within(editor).getByLabelText('시작 시각'), { target: { value: '2030-01-01T10:00' } });
    fireEvent.change(within(editor).getByLabelText('기한'), { target: { value: '2030-01-02T12:30' } });
    fireEvent.change(within(editor).getByLabelText('선행 과제'), { target: { value: 'T002' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());

    const panel = await openTaskEditor('책 읽기');
    expect(within(panel).getByLabelText('시작 시각')).toHaveProperty('value', '');
    expect(within(panel).getByLabelText('기한')).toHaveProperty('value', '');
    expect(within(panel).getByLabelText('선행 과제')).toHaveProperty('value', '');
    fireEvent.click(within(panel).getByRole('tab', { name: /^반복/ }));
    expect(await within(panel).findByRole('group', { name: '반복 주기' })).toBeTruthy();
    expect(recurrenceType(panel, '반복 없음').getAttribute('aria-pressed')).toBe('true');
  });

  it('disables selected-student printing while QR generation is pending or failed and retries on reopen', async () => {
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    let resolveFirstQr!: (response: Response) => void;
    const firstQr = new Promise<Response>((resolve) => { resolveFirstQr = resolve; });
    let qrAttempt = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== '/api/qrcode') return baseFetch(input, init);
      qrAttempt += 1;
      return qrAttempt === 1
        ? firstQr
        : new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    });
    render(<AdminManagePage />);

    await openAdminMenu('학생');
    fireEvent.click(await screen.findByLabelText('S001 선택'));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'QR 카드 발급' }));
    const dialog = await screen.findByRole('dialog', { name: '선택 학생 QR 발급' });
    const printButton = within(dialog).getByRole('button', { name: '인쇄' });
    expect(printButton).toHaveProperty('disabled', true);

    resolveFirstQr(jsonResponse({ error: 'not an svg' }));
    expect(await screen.findAllByText('QR 생성 실패')).toHaveLength(2);
    expect(printButton).toHaveProperty('disabled', true);

    fireEvent.click(within(dialog).getAllByRole('button', { name: '닫기' }).at(-1)!);
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'QR 카드 발급' }));
    const retried = await screen.findByRole('dialog', { name: '선택 학생 QR 발급' });
    const retriedPrintButton = within(retried).getByRole('button', { name: '인쇄' });
    await waitFor(() => expect(retriedPrintButton).toHaveProperty('disabled', false));
    expect(qrAttempt).toBe(2);
  });
});
