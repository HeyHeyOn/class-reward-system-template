import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, openAdminMenu, openNewProductEditor, openNewStudentEditor, openProductEditor, openStudentEditor } from './testing/adminUi';

let studentCreated: boolean;
let productCreated: boolean;
let refreshFails: boolean;
let mutations: { path: string; body: Record<string, unknown> }[];
const originalStudent = { studentId: 'S000', name: '기존 학생', balance: 10, status: 'ACTIVE', studentVersion: 1, accountVersion: 1 };
const originalProduct = { productId: 'P001', name: '기존 상품', price: 10, stock: 10, isActive: true, sortOrder: 1 };

beforeEach(() => {
  sessionStorage.clear(); window.history.replaceState(null, '', '/c/creation-test/admin');
  studentCreated = false; productCreated = false; refreshFails = false; mutations = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'PATCH') {
      mutations.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ error: 'Test stops at the submitted edit' }, { status: 409 });
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (path.endsWith('/students')) {
        studentCreated = true;
        const { operationId: _operationId, ...student } = body; void _operationId;
        return Response.json(student, { status: 201 });
      }
      if (path.endsWith('/products')) {
        productCreated = true;
        const { operationId: _operationId, ...product } = body; void _operationId;
        return Response.json(product, { status: 201 });
      }
    }
    if (path.endsWith('/students?includeInactive=1')) {
      if (refreshFails && studentCreated) return Response.json({}, { status: 503 });
      return Response.json({ storage: 'postgresql', students: [originalStudent, ...(studentCreated ? [{
        studentId: 'S001', name: '등록 학생', balance: 75, status: 'ACTIVE', studentVersion: 2, accountVersion: 3,
      }] : [])] });
    }
    if (path.endsWith('/products?includeInactive=1')) return Response.json({
      products: [originalProduct, ...(productCreated ? [{ productId: 'P002', name: '등록 상품', price: 10, stock: 2, isActive: true, sortOrder: 0 }] : [])],
      mutationPreconditions: [{ productId: 'P001', expectedVersion: 1 }, ...(productCreated ? [{ productId: 'P002', expectedVersion: 3 }] : [])],
    });
    return Response.json(path.endsWith('/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
async function open(menu: '학생' | '매점') {
  render(<AdminManagePage />);
  await openAdminMenu(menu);
}
const edit = (panel: HTMLElement, label: string, value: string) => fireEvent.change(within(panel).getByLabelText(label), { target: { value } });
const value = (panel: HTMLElement, label: string) => (within(panel).getByLabelText(label) as HTMLInputElement).value;
const save = (panel: HTMLElement) => fireEvent.click(within(panel).getByRole('button', { name: '저장' }));
async function addStudent() {
  await screen.findByRole('button', { name: 'S000 기존 학생 편집' });
  const panel = await openNewStudentEditor();
  edit(panel, '새 학생 ID', 'S001'); edit(panel, '새 학생 이름', '등록 학생'); edit(panel, '새 학생 잔액', '100');
  fireEvent.click(within(panel).getByRole('button', { name: '새 학생 추가' }));
  const notice = await findNotice('S001 추가 완료');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '학생 추가' })).toBeNull());
  return notice;
}

// The former "preserve another row's unsaved draft" halves of the first two tests were removed: rows are no longer
// editable inline and only one editor panel can be open, so an unsaved draft on another row cannot coexist with creation.
it('new student edits use the entire refreshed balance/version pair', async () => {
  await open('학생'); await addStudent();
  const panel = await openStudentEditor('S001', '등록 학생');
  expect(value(panel, 'S001 잔액')).toBe('75');
  edit(panel, 'S001 이름', '바뀐 이름'); save(panel);
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].body.students).toEqual([
    { studentId: 'S001', name: '바뀐 이름', balance: 75, status: 'ACTIVE', expectedStudentVersion: 2, expectedAccountVersion: 3 },
  ]);
});
it('new product edits use refreshed stock and its matching version', async () => {
  await open('매점'); await screen.findByRole('button', { name: 'P001 기존 상품 편집' });
  const creator = await openNewProductEditor();
  edit(creator, '새 상품명', '등록 상품'); edit(creator, '새 상품 가격', '10'); edit(creator, '새 상품 재고', '3');
  fireEvent.click(within(creator).getByRole('button', { name: '새 상품 추가' }));
  await findNotice('P002 추가 완료');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '상품 추가' })).toBeNull());
  const panel = await openProductEditor('P002', '등록 상품');
  expect(value(panel, 'P002 재고')).toBe('2');
  edit(panel, 'P002 상품명', '바뀐 상품'); save(panel);
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0].body.products).toEqual([
    expect.objectContaining({ productId: 'P002', name: '바뀐 상품', stock: 2, expectedProductVersion: 3 }),
  ]);
});
it('a successful creation with failed refresh stays registered and refuses unversioned edits', async () => {
  await open('학생'); refreshFails = true;
  const notice = await addStudent();
  expect(notice.textContent).toContain('등록되었지만 편집 정보를 불러오지 못했습니다');
  const panel = await openStudentEditor('S001', '등록 학생');
  expect(value(panel, 'S001 이름')).toBe('등록 학생');
  edit(panel, 'S001 이름', '바뀐 이름'); save(panel);
  await findNotice('학생 버전을 확인할 수 없습니다');
  expect(mutations).toHaveLength(0);
});
