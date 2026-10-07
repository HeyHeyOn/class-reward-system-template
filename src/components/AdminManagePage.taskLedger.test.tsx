import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminManagePage } from './AdminManagePage';
import { openAdminMenu } from './testing/adminUi';
import { LedgerServer, makeTask, SLUG, STUDENTS } from './tasks/ledger/ledgerTestServer';

vi.mock('./QrScanner', () => ({ QrScanner: () => null }));

/*
 * PostgreSQL (tenant) classes use the stage-ledger task screen. None of the old task code may run
 * there: no legacy /tasks reads or writes, no request journals, and old journals are cleared.
 */

const LEGACY_JOURNALS = [
  `crs:task-completion-reset:/api/c/${SLUG}/tasks/completions/reset`,
  `crs:task-assignment-save:/api/c/${SLUG}/tasks/assignments/batch`,
  `crs:task-assignment-save:/api/c/${SLUG}/tasks/assignments/batch:drafts`,
  `crs:task-definition-save:/api/c/${SLUG}/tasks/batch`,
  `crs:task-schedule-save:/api/c/${SLUG}/tasks/schedules/batch`,
  `crs:task-qr:/api/c/${SLUG}/tasks/qr-assignment`,
  `crs:single-task-delete:/api/c/${SLUG}/tasks`,
];
const OTHER_CLASS_JOURNAL = 'crs:task-completion-reset:/api/c/another-class/tasks/completions/reset';

let ledger: LedgerServer;
let requests: Array<{ url: string; method: string }>;

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', `/c/${SLUG}/admin`);
  ledger = new LedgerServer([makeTask(), makeTask({ taskId: 'task-2', title: '독서 기록', sortOrder: 2, stages: { S1: 'COMPLETED', S2: 'READY' } })]);
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url.startsWith(`/api/c/${SLUG}/task-ledger`)) return ledger.handle(url, init);
    if (url.startsWith(`/api/c/${SLUG}/students`)) {
      return Response.json({ storage: 'postgresql', students: STUDENTS.map((student) => ({ ...student, studentVersion: 1, accountVersion: 1 })) });
    }
    if (url.startsWith(`/api/c/${SLUG}/products`)) return Response.json({ products: [], mutationPreconditions: [] });
    if (url.startsWith(`/api/c/${SLUG}/settings`)) return Response.json({ currencyUnit: '원', qrManualInputEnabled: true });
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const legacyTaskRequests = () => requests.filter((request) => /\/api\/c\/[^/]+\/tasks(\/|\?|$)/.test(request.url));

describe('tenant task screen gating', () => {
  it('loads the ledger board, clears the old journals of this class and never touches the legacy task routes', async () => {
    for (const key of [...LEGACY_JOURNALS, OTHER_CLASS_JOURNAL]) sessionStorage.setItem(key, JSON.stringify({ sent: true, rejected: false }));
    render(<AdminManagePage />);
    await openAdminMenu('과제');
    expect(await screen.findByRole('button', { name: '수학 익힘책 과제 편집' })).toBeTruthy();
    expect(Object.keys(sessionStorage)).toEqual([OTHER_CLASS_JOURNAL]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/미확정|회차|완료 기록 초기화/)).toBeNull();
    expect(requests.some((request) => request.url === `/api/c/${SLUG}/task-ledger`)).toBe(true);
    expect(legacyTaskRequests()).toEqual([]);
  });

  it('feeds the home summary and opens a task’s student stages from it', async () => {
    render(<AdminManagePage />);
    await waitFor(() => expect(screen.getByText('진행 중인 과제').closest('div')!.parentElement!.textContent).toContain('2개'));
    const card = screen.getByText('과제 진행 현황').closest('section')!;
    expect(within(card).getByText('1 / 3명')).toBeTruthy();
    expect(within(card).queryByText(/회차/)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /수학 익힘책/ }));
    const sheet = await screen.findByRole('dialog', { name: '수학 익힘책 과제 편집' });
    expect(within(sheet).getByRole('tab', { name: /^학생 현황/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('admin-background').getAttribute('aria-hidden')).toBe('true');
  });

  it('opens the new QR stage flow from the home quick action', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('button', { name: /QR로 과제 부여/ }));
    const dialog = await screen.findByRole('dialog', { name: 'QR로 단계 바꾸기' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '독서 기록 과제 선택' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'QR 찍기 시작' }));
    fireEvent.change(within(dialog).getByLabelText('학생 QR 직접 입력'), { target: { value: 'qr-S3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '적용' }));
    expect(await within(dialog).findByText('박지후: 미부여 → 미완료')).toBeTruthy();
    expect(ledger.writes('POST /qr')).toHaveLength(1);
    expect(legacyTaskRequests()).toEqual([]);
  });

  it('saves stages through the ledger without any request journal', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<AdminManagePage />);
    await openAdminMenu('과제');
    fireEvent.click(await screen.findByRole('button', { name: '수학 익힘책 과제 편집' }));
    const sheet = await screen.findByRole('dialog', { name: '수학 익힘책 과제 편집' });
    fireEvent.click(within(sheet).getByRole('tab', { name: /^학생 현황/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: '최하윤 완료' }));
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '보상 지급 확인' })).getByRole('button', { name: '보상 없이 완료' }));
    await waitFor(() => expect(ledger.writes('POST /stages')).toHaveLength(1));
    expect(ledger.writes('POST /stages')[0].body!.changes).toEqual([{ taskId: 'task-1', studentId: 'S4', stage: 'COMPLETED' }]);
    expect(await screen.findByText('학생 1명의 단계를 저장했어요.')).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(legacyTaskRequests()).toEqual([]);
  });
});
