import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, openAdminMenu, selectionBar } from './testing/adminUi';
let bodies: string[];
let fail: 'loss' | 'conflict' | 'shape' | undefined;
let version: number;
let gate: Promise<void> | undefined;
let reads: number;
const rows = [
  { productId: 'P1', name: 'Batch One', price: 10, stock: 90, isActive: true, sortOrder: 1 },
  { productId: 'P2', name: 'Batch Two', price: 20, stock: 0, isActive: false, sortOrder: 2 },
];
beforeEach(() => {
  window.history.replaceState(null, '', '/c/d08-a/admin');
  bodies = []; fail = undefined; version = 3; gate = undefined; reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/products/batch') && init?.method === 'DELETE') {
      bodies.push(String(init.body)); await gate;
      if (fail === 'loss') { fail = undefined; throw new Error('응답 유실'); }
      if (fail === 'conflict') return Response.json({ error: '상품 정보가 변경되었습니다.', code: 'STALE_VERSION' }, { status: 409 });
      if (fail === 'shape') return Response.json({});
      const operationId = JSON.parse(String(init.body)).operationId;
      return Response.json({ productIds: ['P1', 'P2'], ...(operationId ? { operationId } : {}) });
    }
    if (url.endsWith('/products?includeInactive=1')) {
      reads += 1;
      return Response.json({ products: rows, mutationPreconditions: rows.map((p) => ({ productId: p.productId, expectedVersion: version })) });
    }
    // The unscoped legacy (Sheets) student endpoint keeps its plain-array contract.
    if (url === '/api/students') return Response.json([]);
    if (url.includes('/students')) return Response.json({ storage: 'postgresql', students: [] });
    return Response.json(url.includes('/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
const rowButton = (id: string, name: string) => screen.queryByRole('button', { name: `${id} ${name} 편집` });
async function open() {
  render(<AdminManagePage />);
  await openAdminMenu('매점');
  await screen.findByRole('button', { name: 'P1 Batch One 편집' });
  fireEvent.click(screen.getByRole('checkbox', { name: '전체 상품 선택' }));
}
/** Selection bar 삭제 → generic confirm dialog. */
async function requestRemove() {
  fireEvent.click(within(selectionBar()).getByRole('button', { name: '삭제' }));
  return screen.findByRole('dialog', { name: /상품 2개를 삭제할까요/ });
}
const confirmButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: '삭제' });
const confirmRemove = (dialog: HTMLElement) => fireEvent.click(confirmButton(dialog));
const remove = async () => confirmRemove(await requestRemove());
const waitRemoved = () => waitFor(() => expect(rowButton('P1', 'Batch One')).toBeNull());
const refresh = () => fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
describe('D08 scoped admin batch DELETE displayed snapshot', () => {
  it('sends multiple displayed versions and operation ID to tenant URL, removes only acknowledged rows', async () => {
    await open(); version = 4; await remove();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0])).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), products: [
      { productId: 'P1', expectedProductVersion: 3 }, { productId: 'P2', expectedProductVersion: 3 },
    ] });
    await waitRemoved();
    expect(rowButton('P2', 'Batch Two')).toBeNull(); expect(reads).toBe(1);
    await findNotice('선택 상품 2개 삭제 완료');
  });
  it('retries identical bytes/ID after lost response and suppresses a double submission', async () => {
    await open(); let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; });
    fail = 'loss'; const confirm = confirmButton(await requestRemove()); fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(bodies).toHaveLength(1)); release();
    await findNotice('새로고침');
    expect(bodies).toHaveLength(1);
    await waitFor(() => expect(rowButton('P1', 'Batch One')).toBeTruthy()); await remove();
    await waitFor(() => expect(bodies).toHaveLength(2)); expect(bodies[1]).toBe(bodies[0]);
    await waitRemoved();
  });
  it.each(['conflict', 'shape'] as const)('keeps selected rows on %s; explicit refresh creates a new attempt', async (failure) => {
    await open(); fail = failure; await remove();
    await findNotice('새로고침');
    await waitFor(() => expect(rowButton('P1', 'Batch One')).toBeTruthy()); expect(reads).toBe(1);
    expect(within(selectionBar()).getByRole('button', { name: '삭제' })).toBeTruthy();
    refresh(); await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }).hasAttribute('disabled')).toBe(false));
    fail = undefined; await remove(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
  });
  it('does not change the unscoped legacy batch body', async () => {
    window.history.replaceState(null, '', '/admin'); await open(); await remove();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0])).toEqual({ productIds: ['P1', 'P2'] });
    await waitRemoved();
  });
});
