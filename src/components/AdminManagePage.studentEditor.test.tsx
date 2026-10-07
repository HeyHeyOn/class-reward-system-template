import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, openAdminMenu, openStudentEditor } from './testing/adminUi';

let row: { studentId: string; name: string; balance: number; status: 'ACTIVE'; studentVersion: number; accountVersion: number };
let bodies: string[];
let reads: number;
let fail: 'loss' | 'conflict' | undefined;
let gate: Promise<void> | undefined;
const response = (data: unknown, status = 200) => Response.json(data, { status });
beforeEach(() => {
  window.history.replaceState(null, '', '/c/d05-a/admin');
  row = { studentId: 'S1', name: 'D05 학생', balance: 90, status: 'ACTIVE', studentVersion: 2, accountVersion: 3 };
  reads = 0; bodies = []; fail = undefined; gate = undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/c/d05-a/students/batch' && init?.method === 'PATCH') {
      bodies.push(String(init.body));
      await gate;
      if (fail === 'loss') { fail = undefined; throw new Error('응답 유실'); }
      if (fail === 'conflict') return response({ code: 'STALE_VERSION', error: '학생 정보가 변경되었습니다.' }, 409);
      const submitted = JSON.parse(String(init.body)).students[0];
      return response([{ studentId: submitted.studentId, name: submitted.name, balance: submitted.balance, status: submitted.status,
        studentVersion: submitted.expectedStudentVersion + 1, accountVersion: submitted.expectedAccountVersion + 1 }]);
    }
    if (url === '/api/c/d05-a/students?includeInactive=1') {
      reads += 1; return response({ storage: 'postgresql', students: [structuredClone(row)] });
    }
    // A normal GET must NOT be usable as an editor snapshot.
    if (url === '/api/c/d05-a/students') return response([{ studentId: 'S1', name: row.name, balance: row.balance, status: 'ACTIVE' }]);
    if (url.includes('/products')) return response({ products: [], mutationPreconditions: [] });
    return response(url.includes('/settings') ? {} : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

async function open() {
  render(<AdminManagePage />);
  await openAdminMenu('학생');
  await screen.findByRole('button', { name: 'S1 D05 학생 편집' });
}
const panel = () => screen.getByRole('dialog', { name: 'S1 학생 편집' });
const editor = (name = 'D05 학생') => openStudentEditor('S1', name);
const edit = (field: '이름' | '잔액', value: string) => fireEvent.change(within(panel()).getByLabelText(`S1 ${field}`), { target: { value } });
const fieldValue = (field: '이름' | '잔액') => (within(panel()).getByLabelText(`S1 ${field}`) as HTMLInputElement).value;
const save = () => fireEvent.click(within(panel()).getByRole('button', { name: '저장' }));
const closePanel = () => {
  fireEvent.click(within(panel()).getByRole('button', { name: '취소' }));
  // Closing a panel with unsaved edits asks for confirmation first.
  const discard = screen.queryByRole('button', { name: '저장하지 않고 닫기' });
  if (discard) fireEvent.click(discard);
};
const refresh = () => fireEvent.click(screen.getByRole('button', { name: '학생 명단 새로고침' }));
const waitPanelClosed = () => waitFor(() => expect(screen.queryByRole('dialog', { name: 'S1 학생 편집' })).toBeNull());

describe('D05 PG student editor displayed snapshot lifecycle', () => {
  it('sends the displayed balance and both versions without pre-submit re-reading', async () => {
    await open(); await editor();
    row = { ...row, balance: 100, accountVersion: 4 };
    edit('이름', 'Edited');
    save();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]).students).toEqual([{ studentId: 'S1', name: 'Edited', balance: 90, status: 'ACTIVE', expectedStudentVersion: 2, expectedAccountVersion: 3 }]);
    expect(reads).toBe(1);
    await findNotice('학생 1명 저장 완료');
    await waitPanelClosed();
  });
  it('keeps the identical ID AND bytes after response loss; changes ID when draft changes', async () => {
    await open(); await editor(); edit('이름', 'Edited');
    fail = 'loss'; save();
    await findNotice('응답 유실');
    // The failed panel stays open with the draft, so the same request can be retried.
    expect(fieldValue('이름')).toBe('Edited');
    fail = 'loss'; save();
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toBe(bodies[0]);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: '저장' }).hasAttribute('disabled')).toBe(false));
    edit('이름', 'New draft');
    save(); await waitFor(() => expect(bodies).toHaveLength(3));
    expect(JSON.parse(bodies[2]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
  });
  it('409 keeps unsaved values, guides refresh, and requires explicit fresh edit rather than auto-reapply', async () => {
    await open(); await editor();
    edit('이름', 'Unsaved name');
    edit('잔액', '95');
    fail = 'conflict'; save();
    await findNotice('새로고침');
    expect(fieldValue('이름')).toBe('Unsaved name');
    expect(fieldValue('잔액')).toBe('95');
    expect(reads).toBe(1); expect(bodies).toHaveLength(1);
    row = { ...row, balance: 100, accountVersion: 4 };
    closePanel(); await waitPanelClosed();
    refresh(); await waitFor(() => expect(reads).toBe(2));
    expect(bodies).toHaveLength(1);
    await editor();
    await waitFor(() => expect(fieldValue('잔액')).toBe('100'));
    expect(fieldValue('이름')).toBe('D05 학생');
    edit('잔액', '110');
    fail = undefined; save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
    expect(JSON.parse(bodies[1]).students[0]).toMatchObject({ balance: 110, expectedAccountVersion: 4 });
  });
  it('an explicit new snapshot resets an ambiguous attempt even if values and versions match', async () => {
    await open(); await editor(); edit('이름', 'Edited');
    fail = 'loss'; save();
    await findNotice('응답 유실');
    closePanel(); await waitPanelClosed();
    refresh(); await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '학생 명단 새로고침' }).hasAttribute('disabled')).toBe(false));
    await editor(); edit('이름', 'Edited');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).students).toEqual(JSON.parse(bodies[0]).students);
    expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
  });
  it('a committed reply advances versions together with the acknowledged row', async () => {
    await open(); await editor(); edit('이름', 'First edit'); save();
    await findNotice('학생 1명 저장 완료');
    await waitPanelClosed();
    await editor('First edit');
    edit('이름', 'Second edit');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).students[0]).toMatchObject({ name: 'Second edit', balance: 90, expectedStudentVersion: 3, expectedAccountVersion: 4 });
  });
  it('locks the panel while a save is pending and suppresses a duplicate submission', async () => {
    // Formerly: a numeric draft edited while pending kept the old versions. The panel is now inert while
    // saving, so a mid-save edit is no longer reachable; the lock itself is what protects the snapshot.
    await open(); await editor(); edit('잔액', '97');
    let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; });
    const saveButton = within(panel()).getByRole('button', { name: '저장' });
    fireEvent.click(saveButton); await waitFor(() => expect(bodies).toHaveLength(1));
    await screen.findByRole('dialog', { name: '변경 사항 저장 중' });
    const lockedPanel = document.querySelector('[role="dialog"][aria-label="S1 학생 편집"]');
    expect(lockedPanel?.getAttribute('aria-hidden')).toBe('true');
    expect(lockedPanel?.hasAttribute('inert')).toBe(true);
    fireEvent.click(saveButton);
    release(); await findNotice('학생 1명 저장 완료');
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).students[0]).toMatchObject({ balance: 97, expectedStudentVersion: 2, expectedAccountVersion: 3 });
    await waitPanelClosed();
    await editor(); edit('잔액', '98');
    save(); await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1]).students[0]).toMatchObject({ balance: 98, expectedStudentVersion: 3, expectedAccountVersion: 4 });
  });
});
