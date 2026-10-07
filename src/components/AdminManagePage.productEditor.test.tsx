import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@/domain/types';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, openAdminMenu, openProductEditor } from './testing/adminUi';

let row: Product;
let version: number;
let bodies: string[];
let reads: number;
let fail: 'loss' | 'conflict' | undefined;
let gate: Promise<void> | undefined;
const response = (data: unknown, status = 200) => Response.json(data, { status });
beforeEach(() => {
  window.history.replaceState(null, '', '/c/d06-a/admin');
  row = { productId: 'P1', name: 'D06 상품', price: 10, stock: 90, isActive: true, sortOrder: 1 };
  version = 3; reads = 0; bodies = []; fail = undefined; gate = undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/c/d06-a/products/batch' && init?.method === 'PATCH') {
      bodies.push(String(init.body));
      await gate;
      if (fail === 'loss') { fail = undefined; throw new Error('응답 유실'); }
      if (fail === 'conflict') return response({ code: 'STALE_VERSION', error: '상품 정보가 변경되었습니다.' }, 409);
      const submitted = JSON.parse(String(init.body)).products[0];
      const { expectedProductVersion, ...saved } = submitted;
      return response([{ ...saved, productVersion: expectedProductVersion + 1 }]);
    }
    if (url === '/api/c/d06-a/products?includeInactive=1') {
      reads += 1;
      return response({ products: [structuredClone(row)], mutationPreconditions: [{ productId: row.productId, expectedVersion: version }] });
    }
    if (url.includes('/students')) return response({ storage: 'postgresql', students: [] });
    return response(url.includes('/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

async function open() {
  render(<AdminManagePage />);
  await openAdminMenu('매점');
  await screen.findByRole('button', { name: 'P1 D06 상품 편집' });
}
const panel = () => screen.getByRole('dialog', { name: 'P1 상품 편집' });
const editor = (name = 'D06 상품') => openProductEditor('P1', name);
const edit = (field: '상품명' | '재고', value: string) => fireEvent.change(within(panel()).getByLabelText(`P1 ${field}`), { target: { value } });
const fieldValue = (field: '상품명' | '재고') => (within(panel()).getByLabelText(`P1 ${field}`) as HTMLInputElement).value;
const save = () => fireEvent.click(within(panel()).getByRole('button', { name: '저장' }));
const closePanel = () => {
  fireEvent.click(within(panel()).getByRole('button', { name: '취소' }));
  // Closing a panel with unsaved edits asks for confirmation first.
  const discard = screen.queryByRole('button', { name: '저장하지 않고 닫기' });
  if (discard) fireEvent.click(discard);
};
const refresh = () => fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
const waitPanelClosed = () => waitFor(() => expect(screen.queryByRole('dialog', { name: 'P1 상품 편집' })).toBeNull());

describe('D06 PG product editor displayed snapshot lifecycle', () => {
  it('sends displayed stock and version without a pre-submit read', async () => {
    await open(); await editor(); row = { ...row, stock: 100 }; version = 4;
    edit('상품명', 'Edited');
    save(); await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]).products).toEqual([{ productId: 'P1', name: 'Edited', price: 10, stock: 90,
      isActive: true, sortOrder: 1, imageUrl: '', category: '', expectedProductVersion: 3 }]);
    expect(reads).toBe(1);
    await findNotice('상품 1개 저장 완료');
    await waitPanelClosed();
  });
  it('retains identical ID and bytes after response loss; a changed draft gets a new ID', async () => {
    await open(); await editor(); edit('상품명', 'Edited');
    fail = 'loss'; save();
    await findNotice('응답 유실');
    expect(fieldValue('상품명')).toBe('Edited');
    fail = 'loss'; save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toBe(bodies[0]);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: '저장' }).hasAttribute('disabled')).toBe(false));
    edit('재고', '97');
    save(); await waitFor(() => expect(bodies).toHaveLength(3));
    expect(JSON.parse(bodies[2]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
  });
  it('409 preserves draft and guides explicit refresh, never silently reapplies stale stock', async () => {
    await open(); await editor();
    edit('상품명', 'Unsaved');
    edit('재고', '95');
    fail = 'conflict'; save();
    await findNotice('새로고침');
    expect(fieldValue('상품명')).toBe('Unsaved'); expect(fieldValue('재고')).toBe('95');
    expect(reads).toBe(1); expect(bodies).toHaveLength(1);
    row = { ...row, stock: 100 }; version = 4;
    closePanel(); await waitPanelClosed();
    refresh(); await waitFor(() => expect(reads).toBe(2));
    expect(bodies).toHaveLength(1);
    await editor();
    await waitFor(() => expect(fieldValue('재고')).toBe('100'));
    expect(fieldValue('상품명')).toBe('D06 상품');
    edit('재고', '110');
    fail = undefined; save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
    expect(JSON.parse(bodies[1]).products[0]).toMatchObject({ stock: 110, expectedProductVersion: 4 });
  });
  it('an explicit snapshot resets an ambiguous attempt even with identical values and version', async () => {
    await open(); await editor(); edit('상품명', 'Edited');
    fail = 'loss'; save();
    await findNotice('응답 유실');
    closePanel(); await waitPanelClosed();
    refresh(); await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }).hasAttribute('disabled')).toBe(false));
    await editor(); edit('상품명', 'Edited');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).products).toEqual(JSON.parse(bodies[0]).products);
    expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
  });
  it('advances version only together with the acknowledged row', async () => {
    await open(); await editor(); edit('상품명', 'First'); save();
    await findNotice('상품 1개 저장 완료');
    await waitPanelClosed();
    await editor('First');
    edit('상품명', 'Second');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).products[0]).toMatchObject({ name: 'Second', stock: 90, expectedProductVersion: 4 });
  });
  it('locks the panel while a save is pending and suppresses a duplicate submission', async () => {
    // Formerly: stock edited while pending kept the displayed version. The panel is now inert while
    // saving, so a mid-save edit is no longer reachable; the lock itself protects the snapshot.
    await open(); await editor(); edit('재고', '97');
    let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; });
    const saveButton = within(panel()).getByRole('button', { name: '저장' });
    fireEvent.click(saveButton); await waitFor(() => expect(bodies).toHaveLength(1));
    await screen.findByRole('dialog', { name: '변경 사항 저장 중' });
    const lockedPanel = document.querySelector('[role="dialog"][aria-label="P1 상품 편집"]');
    expect(lockedPanel?.getAttribute('aria-hidden')).toBe('true');
    expect(lockedPanel?.hasAttribute('inert')).toBe(true);
    fireEvent.click(saveButton);
    release(); await findNotice('상품 1개 저장 완료');
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).products[0]).toMatchObject({ stock: 97, expectedProductVersion: 3 });
    await waitPanelClosed();
    await editor(); edit('재고', '98');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).products[0]).toMatchObject({ stock: 98, expectedProductVersion: 4 });
  });
});
