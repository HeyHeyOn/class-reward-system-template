import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, openAdminMenu, openProductEditor, openStudentEditor } from './testing/adminUi';
import { PATCH as saveStudents } from '@/app/api/students/batch/route';
import { PATCH as saveProducts } from '@/app/api/products/batch/route';
import { cancelTransaction, getProducts, getStudents, getStudentRecordById, type SheetsStore } from '@/server/sheetsRepository';
import type { AtomicSheetMutation, OperationalSheetName } from '@/server/storage/tabularStore';

vi.mock('server-only', () => ({}));
vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: () => true,
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: async () => store }));

const OP = 'd0200000-0000-4000-8000-000000000001';
let rows: Record<string, string[][]>;
let store: SheetsStore;
let mutations: AtomicSheetMutation[];
let beforeWrite: (() => void) | undefined;
let readFailure: boolean;
let loseResponse: boolean;
let responseOverride: unknown;
let responseGate: Promise<void> | undefined;
let requests: Array<{ url: string; body: Record<string, unknown> }>;

function apply(mutation: AtomicSheetMutation) {
  for (const update of mutation.updates) rows[update.sheetName][update.rowNumber - 1][update.columnNumber - 1] = String(update.value);
  for (const append of mutation.appends) rows[append.sheetName].push(append.values.map(String));
}

beforeEach(() => {
  rows = {
    Students: [['studentId', 'name', 'balance', 'qrValue', 'status'], ['S001', '학생', '90', 'S001', 'ACTIVE']],
    Products: [['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'], ['P001', '연필', '10', '2', 'TRUE', '', '', '1']],
    Transactions: [
      ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
      ['SALE', '2026-09-29T00:00:00.000Z', 'S001', '학생', JSON.stringify([{ productId: 'P001', name: '연필', price: 10, quantity: 1, subtotal: 10 }]), '10', '100', '90', 'COMPLETED', 'kiosk'],
    ],
    Settings: [['key', 'value']], Adjustments: [['adjustmentId']],
  };
  mutations = []; requests = []; beforeWrite = undefined; readFailure = false; loseResponse = false; responseOverride = undefined; responseGate = undefined;
  const claims = new Set<string>();
  const read = async (name: OperationalSheetName) => {
    if (readFailure) throw Error('최신 목록을 읽지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    return structuredClone(rows[name] ?? []);
  };
  store = {
    getRows: read, getRowsFresh: read,
    async updateCell(name, row, column, value) { rows[name][row - 1][rows[name][0].indexOf(column)] = String(value); },
    async updateCells(name, updates) {
      beforeWrite?.(); beforeWrite = undefined;
      for (const u of updates) await store.updateCell(name, u.rowNumber, u.columnName, u.value);
    },
    async appendRow(name, values) { rows[name].push(values); },
    async applyAtomicMutation(mutation) {
      beforeWrite?.(); beforeWrite = undefined;
      const proposed = [...(mutation.uniqueClaim ? [mutation.uniqueClaim] : []), ...(mutation.uniqueClaims ?? [])];
      if (proposed.some((claim) => claims.has(claim.name))) throw Error('duplicate claim');
      proposed.forEach((claim) => claims.add(claim.name));
      mutations.push(structuredClone(mutation)); apply(mutation);
    },
    async hasAtomicClaim(name) { return claims.has(name); },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      const request = new Request(`http://localhost${url}`, init);
      const response = await (url === '/api/students/batch' ? saveStudents(request) : saveProducts(request));
      await responseGate;
      if (loseResponse && response.ok) { loseResponse = false; throw Error('응답 유실'); }
      if (responseOverride !== undefined) return Response.json(responseOverride);
      return response;
    }
    if (url === '/api/students') return Response.json(await getStudents(store));
    if (url.startsWith('/api/products')) {
      const products = await getProducts(store);
      return Response.json({ products, mutationPreconditions: products.map(({ productId }) => ({ productId, expectedVersion: 1 })) });
    }
    return Response.json(url.startsWith('/api/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/*
 * Lists are read-only after the redesign: each student/product is edited in its own panel whose
 * `저장` sends a one-row batch (`학생 1명 저장 완료` / `상품 1개 저장 완료`) and closes the panel on success.
 * `저장` is disabled until the panel is dirty, so "save without changes" cases now change a non-numeric field.
 */
type Kind = 'student' | 'product';
async function openEditor() {
  render(<AdminManagePage />);
  await openAdminMenu('학생');
  await screen.findByRole('button', { name: 'S001 학생 편집' });
}
async function productTab() { await openAdminMenu('매점'); await screen.findByRole('button', { name: 'P001 연필 편집' }); }
const studentName = (id: string) => rows.Students.find((row) => row[0] === id)![1];
const productName = (id: string) => rows.Products.find((row) => row[0] === id)![1];
async function openPanel(kind: Kind, id: string) {
  return kind === 'student' ? openStudentEditor(id, studentName(id)) : openProductEditor(id, productName(id));
}
/** Flips the non-numeric active switch (student 활성 / product 판매중). */
function toggleActive(panel: HTMLElement, kind: Kind, id: string) {
  fireEvent.click(within(panel).getByRole('switch', { name: `${id} ${kind === 'student' ? '활성' : '판매중'}` }));
}
/** Renames the row (a non-numeric edit that keeps the student active, so getStudents still lists it). */
function renameRow(panel: HTMLElement, kind: Kind, id: string) {
  fireEvent.change(within(panel).getByLabelText(`${id} ${kind === 'student' ? '이름' : '상품명'}`), { target: { value: `${kind === 'student' ? studentName(id) : productName(id)} 수정` } });
}
function setField(panel: HTMLElement, label: string, value: string) {
  fireEvent.change(within(panel).getByLabelText(label), { target: { value } });
}
const panelName = (kind: Kind, id: string) => `${id} ${kind === 'student' ? '학생' : '상품'} 편집`;
const savedText = (kind: Kind) => kind === 'student' ? '학생 1명 저장 완료' : '상품 1개 저장 완료';
/** Presses the panel's `저장`; resolves once the save succeeded (panel closed + success notice). */
async function saveExpectingSuccess(panel: HTMLElement, kind: Kind, id: string) {
  const sent = requests.length;
  fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
  await waitFor(() => expect(requests.length).toBeGreaterThan(sent));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: panelName(kind, id) })).toBeNull());
  await findNotice(savedText(kind));
}
const successNoticeShown = () => screen.queryAllByRole('status').some((notice) => notice.textContent?.includes('저장 완료'));
function restoreBetweenReadAndWrite() { rows.Students[1][2] = '100'; rows.Products[1][3] = '3'; }
function patch(handler: typeof saveStudents, body: unknown) {
  return handler(new Request('http://localhost/api/batch', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

describe('D-02 real local Sheets route/repository stale editor regression', () => {
  it('preserves cancellation restoration for panel saves without an adjustment', async () => {
    await openEditor();
    let panel = await openPanel('student', 'S001');
    toggleActive(panel, 'student', 'S001');
    await cancelTransaction(store, 'SALE', OP);
    expect((await getStudents(store))[0].balance).toBe(100);
    expect((await getProducts(store))[0].stock).toBe(3);
    await saveExpectingSuccess(panel, 'student', 'S001');
    expect.soft((await getStudentRecordById(store, 'S001'))?.student).toMatchObject({ balance: 100, status: 'INACTIVE' });
    expect.soft(rows.Transactions.slice(1).some((r) => r[8] === 'ADMIN_ADJUSTMENT')).toBe(false);
    await productTab();
    panel = await openPanel('product', 'P001');
    toggleActive(panel, 'product', 'P001');
    await saveExpectingSuccess(panel, 'product', 'P001');
    expect.soft((await getProducts(store))[0]).toMatchObject({ stock: 3, isActive: false });
    expect(requests[0].url).toBe('/api/students/batch');
    expect(requests[0].body.students).toHaveLength(1);
    expect((requests[0].body.students as object[])[0]).not.toHaveProperty('balance');
    expect(requests[1].body.products).toHaveLength(1);
    expect((requests[1].body.products as object[])[0]).not.toHaveProperty('stock');
  });

  it('does not write untouched numeric cells even if restoration occurs after repository read', async () => {
    await openEditor();
    let panel = await openPanel('student', 'S001');
    renameRow(panel, 'student', 'S001');
    beforeWrite = restoreBetweenReadAndWrite;
    await saveExpectingSuccess(panel, 'student', 'S001');
    expect((await getStudents(store))[0].balance).toBe(100);
    await productTab(); rows.Products[1][3] = '2';
    panel = await openPanel('product', 'P001');
    renameRow(panel, 'product', 'P001');
    beforeWrite = restoreBetweenReadAndWrite;
    await saveExpectingSuccess(panel, 'product', 'P001');
    expect((await getProducts(store))[0].stock).toBe(3);
  });

  it('preserves explicit numeric edits and subsequent cancellation', async () => {
    await openEditor();
    let panel = await openPanel('student', 'S001');
    setField(panel, 'S001 잔액', '125');
    await saveExpectingSuccess(panel, 'student', 'S001');
    expect((await getStudents(store))[0].balance).toBe(125);
    await productTab();
    panel = await openPanel('product', 'P001');
    setField(panel, 'P001 재고', '5');
    await saveExpectingSuccess(panel, 'product', 'P001');
    expect((await getProducts(store))[0].stock).toBe(5);
    await cancelTransaction(store, 'SALE', OP);
    expect((await getStudents(store))[0].balance).toBe(135);
    expect((await getProducts(store))[0].stock).toBe(6);
  });

  it.each(['student', 'product'] as const)('fails closed on %s fresh-read failure without success UI', async (kind) => {
    await openEditor(); if (kind === 'product') await productTab();
    const id = kind === 'student' ? 'S001' : 'P001';
    const panel = await openPanel(kind, id);
    renameRow(panel, kind, id);
    readFailure = true;
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
    await findNotice(/최신 목록을 읽지 못했습니다/);
    expect(mutations).toHaveLength(0);
    expect(successNoticeShown()).toBe(false);
    expect(screen.getByRole('dialog', { name: panelName(kind, id) })).toBeTruthy();
  });

  it.each(['student', 'product'] as const)('retries a lost %s response with the same operationId, without restoring stale numbers', async (kind) => {
    await openEditor(); if (kind === 'product') await productTab();
    const id = kind === 'student' ? 'S001' : 'P001';
    const panel = await openPanel(kind, id);
    renameRow(panel, kind, id);
    loseResponse = true; fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
    await findNotice(/응답 유실/);
    expect(successNoticeShown()).toBe(false);
    await cancelTransaction(store, 'SALE', OP);
    // The panel stays open with the same draft; the retry must replay the identical request.
    await saveExpectingSuccess(screen.getByRole('dialog', { name: panelName(kind, id) }), kind, id);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.operationId).toEqual(expect.any(String));
    expect(requests[1].body).toEqual(requests[0].body);
    expect((await getStudents(store))[0].balance).toBe(100);
    expect((await getProducts(store))[0].stock).toBe(3);
  });

  it('rejects product operationId reuse with a changed payload and replays no numeric write', async () => {
    const product = { ...(await getProducts(store))[0], stock: 7 };
    expect((await patch(saveProducts, { operationId: OP, products: [product] })).status).toBe(200);
    rows.Products[1][3] = '8';
    expect((await patch(saveProducts, { operationId: OP, products: [product] })).status).toBe(200);
    expect((await getProducts(store))[0].stock).toBe(8);
    expect((await patch(saveProducts, { operationId: OP, products: [{ ...product, stock: 9 }] })).ok).toBe(false);
    expect((await getProducts(store))[0].stock).toBe(8);
  });

  it('saves only the edited row and does not resend a previously saved numeric edit', async () => {
    rows.Students.push(['S002', '학생2', '50', 'S002', 'ACTIVE']);
    rows.Products.push(['P002', '지우개', '5', '4', 'TRUE', '', '', '2']);
    await openEditor();
    // Saving S001 must not carry S002's numbers.
    let panel = await openPanel('student', 'S001');
    toggleActive(panel, 'student', 'S001');
    await saveExpectingSuccess(panel, 'student', 'S001');
    expect(requests[0].body.students).toEqual([expect.objectContaining({ studentId: 'S001' })]);
    expect((await getStudentRecordById(store, 'S002'))?.student.balance).toBe(50);
    panel = await openPanel('student', 'S002');
    setField(panel, 'S002 잔액', '75');
    await saveExpectingSuccess(panel, 'student', 'S002');
    expect((await getStudentRecordById(store, 'S002'))?.student.balance).toBe(75);
    rows.Students[2][2] = '80';
    panel = await openPanel('student', 'S002');
    setField(panel, 'S002 이름', '학생2 수정');
    await saveExpectingSuccess(panel, 'student', 'S002');
    expect(requests).toHaveLength(3);
    expect((requests[2].body.students as object[])[0]).not.toHaveProperty('balance');
    expect((await getStudentRecordById(store, 'S002'))?.student).toMatchObject({ name: '학생2 수정', balance: 80 });
    await productTab();
    panel = await openPanel('product', 'P001');
    toggleActive(panel, 'product', 'P001');
    await saveExpectingSuccess(panel, 'product', 'P001');
    expect(requests[3].body.products).toEqual([expect.objectContaining({ productId: 'P001' })]);
    expect((await getProducts(store)).find((p) => p.productId === 'P002')?.stock).toBe(4);
    panel = await openPanel('product', 'P002');
    setField(panel, 'P002 재고', '9');
    await saveExpectingSuccess(panel, 'product', 'P002');
    expect((await getProducts(store)).find((p) => p.productId === 'P002')?.stock).toBe(9);
    rows.Products[2][3] = '10';
    panel = await openPanel('product', 'P002');
    setField(panel, 'P002 상품명', '지우개2');
    await saveExpectingSuccess(panel, 'product', 'P002');
    expect((requests[5].body.products as object[])[0]).not.toHaveProperty('stock');
    expect((await getProducts(store)).find((p) => p.productId === 'P002')).toMatchObject({ name: '지우개2', stock: 10 });
  });

  it.each(['student', 'product'] as const)('does not report success for malformed %s success responses', async (kind) => {
    await openEditor(); if (kind === 'product') await productTab();
    const id = kind === 'student' ? 'S001' : 'P001';
    const panel = await openPanel(kind, id);
    renameRow(panel, kind, id);
    responseOverride = [];
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
    await findNotice(/저장 결과를 확인하지 못했습니다.*새로고침/);
    expect(successNoticeShown()).toBe(false);
  });

  it('fails closed on a numeric student replay after a later cancellation rather than applying twice', async () => {
    const students = [{ studentId: 'S001', name: '학생', status: 'ACTIVE', balance: 125 }];
    expect((await patch(saveStudents, { operationId: OP, students })).status).toBe(200);
    await cancelTransaction(store, 'SALE', 'd0200000-0000-4000-8000-000000000002');
    const count = mutations.length;
    expect((await patch(saveStudents, { operationId: OP, students })).ok).toBe(false);
    expect(mutations).toHaveLength(count);
    expect((await getStudents(store))[0].balance).toBe(135);
    expect((await patch(saveStudents, { operationId: OP, students: [{ ...students[0], balance: 140 }] })).ok).toBe(false);
    expect(mutations).toHaveLength(count);
  });

  it('deduplicates overlapping product operation IDs atomically and permits a read-only retry', async () => {
    const product = { ...(await getProducts(store))[0], stock: 7 };
    const results = await Promise.all([1, 2].map(() => patch(saveProducts, { operationId: OP, products: [product] })));
    expect(results.some((response) => response.ok)).toBe(true);
    expect(mutations).toHaveLength(1);
    rows.Products[1][3] = '8';
    expect((await patch(saveProducts, { operationId: OP, products: [product] })).ok).toBe(true);
    expect(mutations).toHaveLength(1);
    expect((await getProducts(store))[0].stock).toBe(8);
  });

  it('rejects explicit null numeric fields and legacy product payloads without an operation ID', async () => {
    expect((await patch(saveStudents, { operationId: OP, students: [{ studentId: 'S001', name: '학생', status: 'ACTIVE', balance: null }] })).status).toBe(400);
    const product = (await getProducts(store))[0];
    expect((await patch(saveProducts, { operationId: OP, products: [{ ...product, stock: null }] })).status).toBe(400);
    expect((await patch(saveProducts, { products: [product] })).status).toBe(400);
    expect(mutations).toHaveLength(0);
  });

  it.each(['student', 'product'] as const)('clears committed %s numeric intent so a later non-numeric save sends no number', async (kind) => {
    await openEditor(); if (kind === 'product') await productTab();
    const id = kind === 'student' ? 'S001' : 'P001';
    const numericLabel = kind === 'student' ? 'S001 잔액' : 'P001 재고';
    const nameLabel = kind === 'student' ? 'S001 이름' : 'P001 상품명';
    let panel = await openPanel(kind, id);
    setField(panel, numericLabel, kind === 'student' ? '125' : '5');
    let release!: () => void;
    responseGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    // While the save is in flight the panel is inert; it cannot take further edits.
    expect(panel.getAttribute('inert')).not.toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: panelName(kind, id) })).toBeNull());
    await findNotice(savedText(kind));
    await cancelTransaction(store, 'SALE', OP);
    panel = await openPanel(kind, id);
    setField(panel, nameLabel, '나중 편집');
    await saveExpectingSuccess(panel, kind, id);
    const sent = kind === 'student' ? requests[1].body.students : requests[1].body.products;
    expect((sent as object[])[0]).toMatchObject({ name: '나중 편집' });
    expect((sent as object[])[0]).not.toHaveProperty(kind === 'student' ? 'balance' : 'stock');
    if (kind === 'student') expect((await getStudents(store))[0].balance).toBe(135);
    else expect((await getProducts(store))[0].stock).toBe(6);
  });
});
