import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskHistoryDto, TaskHistoryEntryDto } from '@/lib/taskLedgerApi';
import { LedgerHistoryDialog } from './LedgerHistoryDialog';

const row = (id: string, studentId = 'S1'): TaskHistoryEntryDto => ({
  id, studentId, studentName: studentId === 'S1' ? '가학생' : '나학생',
  at: '2026-10-07T08:00:00.000Z', stage: 'READY', previousStage: 'PENDING', cause: 'TEACHER', reward: null,
});
const page = (id: string, cursor: string | null, studentId = 'S1'): TaskHistoryDto => ({
  taskId: 'T1', title: '과제', entries: [row(id, studentId)], truncated: false,
  nextCursor: cursor, snapshotAt: '2026-10-07T10:00:00.000Z',
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const props = { taskId: 'T1', title: '과제', students: [
  { studentId: 'S1', name: '가학생', status: 'ACTIVE' as const },
  { studentId: 'S2', name: '나학생', status: 'ACTIVE' as const },
], unit: '원', now: '2026-10-07T10:00:00.000Z', opener: null, onClose: () => {} };
let requests: URL[];
let respond: (url: URL) => Response | Promise<Response>;
beforeEach(() => {
  requests = [];
  respond = () => json(page('first', 'cursor+/='));
  window.history.replaceState(null, '', '/c/fixture/admin');
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, window.location.origin); requests.push(url); return respond(url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
const next = () => screen.getByRole('button', { name: '다음 기록 페이지' });
const ready = () => screen.findByRole('navigation', { name: '과제 기록 페이지' });

describe('task history pages', () => {
  it('replaces each page, encodes its cursor, and requests the selected student on the server', async () => {
    respond = url => json(url.searchParams.has('studentId') ? page('filtered', null, 'S2')
      : url.searchParams.has('cursor') ? page('second', null, 'S2') : page('first', 'cursor+/='));
    render(<LedgerHistoryDialog {...props} />); await ready();
    fireEvent.click(next());
    await screen.findByText('2페이지');
    expect(requests.at(-1)?.searchParams.get('cursor')).toBe('cursor+/=');
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(screen.queryByText(/가학생.*완료 가능/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '이전 기록 페이지' }));
    await screen.findByText('1페이지');
    expect(requests.at(-1)?.searchParams.has('cursor')).toBe(false);
    fireEvent.change(screen.getByLabelText('기록 학생 고르기'), { target: { value: 'S2' } });
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('studentId')).toBe('S2'));
    await ready(); expect(requests.at(-1)?.searchParams.has('cursor')).toBe(false);
  });

  it('ignores a late old page after the student filter changes and prevents double paging', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    respond = url => url.searchParams.has('cursor') ? pending : json(url.searchParams.has('studentId')
      ? page('filtered', null, 'S2') : page('first', 'older'));
    render(<LedgerHistoryDialog {...props} />); await ready();
    fireEvent.click(next()); fireEvent.click(next());
    expect(requests.filter(url => url.searchParams.has('cursor'))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('기록 학생 고르기'), { target: { value: 'S2' } });
    await ready();
    await act(async () => { release(json(page('stale', 'still-older'))); });
    expect(screen.getByText('1페이지')).toBeTruthy();
    expect(screen.queryByText(/가학생.*완료 가능/)).toBeNull();
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the successful page when loading the next one fails and retries that cursor', async () => {
    let failures = 0;
    respond = url => url.searchParams.has('cursor') ? ++failures === 1
      ? json({ error: '잠시 연결 실패' }, 503) : json(page('second', null, 'S2')) : json(page('first', 'older'));
    render(<LedgerHistoryDialog {...props} />); await ready(); fireEvent.click(next());
    await screen.findByText('잠시 연결 실패');
    expect(screen.getByText('1페이지')).toBeTruthy();expect(document.querySelectorAll('li')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    await screen.findByText('2페이지');expect(requests.at(-1)?.searchParams.get('cursor')).toBe('older');
  });

  it('restarts once on a changed history snapshot instead of mixing old and new pages', async () => {
    let first = true;
    respond = url => {
      if (url.searchParams.has('cursor')) return json({ code: 'HISTORY_CHANGED', error: '기록 변경' }, 409);
      const data = first ? page('old', 'older') : page('fresh', null, 'S2');first = false;return json(data);
    };
    render(<LedgerHistoryDialog {...props} />);await ready();fireEvent.click(next());
    await screen.findByText('기록이 갱신되어 최신 기록부터 다시 보여 드려요.');
    expect(requests).toHaveLength(3);expect(screen.getByText('1페이지')).toBeTruthy();
    expect(document.querySelectorAll('li')).toHaveLength(1);expect(screen.queryByText(/가학생.*완료 가능/)).toBeNull();
  });

  it('does not silently accept a malformed page that would omit entries', async () => {
    respond = () => json({ ...page('first', null), entries: [row('valid'), { id: 'invalid' }] });
    render(<LedgerHistoryDialog {...props} />);
    await screen.findByText('기록을 불러오지 못했어요');
    expect(screen.queryByRole('navigation', { name: '과제 기록 페이지' })).toBeNull();
  });
});
