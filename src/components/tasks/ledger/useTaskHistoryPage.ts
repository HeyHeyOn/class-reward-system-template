'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskHistoryDto } from '@/lib/taskLedgerApi';
import { ledgerClient } from './ledgerClient';

type View = {
  key: string; history: TaskHistoryDto | null; loading: boolean; error: string | null;
  notice: string | null; cursors: string[];
};

/** One page in memory. A filter/task change invalidates every pending page response. */
export function useTaskHistoryPage(taskId: string, studentId: string) {
  const key = JSON.stringify([taskId, studentId]);
  const [state, setState] = useState<View>({ key, history: null, loading: true, error: null, notice: null, cursors: [] });
  const request = useRef(0);
  const busy = useRef(false);
  const retryPage = useRef<{ key: string; cursors: string[] }>({ key, cursors: [] });
  const current = state.key === key ? state : { key, history: null, loading: true, error: null, notice: null, cursors: [] };

  const load = useCallback(async (cursors: string[]) => {
    const id = ++request.current;
    busy.current = true;
    retryPage.current = { key, cursors };
    setState(previous => ({ key, history: previous.key === key ? previous.history : null,
      cursors: previous.key === key ? previous.cursors : [], loading: true, error: null, notice: null }));
    const options = { ...(studentId ? { studentId } : {}), ...(cursors.length ? { cursor: cursors.at(-1)! } : {}) };
    let result = await ledgerClient.history(taskId, options);
    if (request.current !== id) return;
    let notice: string | null = null;
    if (!result.ok && result.code === 'HISTORY_CHANGED' && cursors.length) {
      // Backdated entries or changed reset rules invalidate the old ordering.
      // Restart once; never combine entries from two snapshots.
      cursors = [];
      retryPage.current = { key, cursors };
      result = await ledgerClient.history(taskId, studentId ? { studentId } : {});
      notice = '기록이 갱신되어 최신 기록부터 다시 보여 드려요.';
      if (request.current !== id) return;
    }
    busy.current = false;
    if (result.ok) setState({ key, history: result.data, cursors, loading: false, error: null, notice });
    else setState(previous => ({ ...previous, key, loading: false, error: result.error, notice: null }));
  }, [key, taskId, studentId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void load([]); });
    return () => { active = false; request.current += 1; busy.current = false; };
  }, [load]);

  return {
    ...current,
    page: current.cursors.length + 1,
    next: () => {
      if (!busy.current && current.history?.nextCursor) void load([...current.cursors, current.history.nextCursor]);
    },
    previous: () => { if (!busy.current && current.cursors.length) void load(current.cursors.slice(0, -1)); },
    retry: () => { if (!busy.current) void load(retryPage.current.key === key ? retryPage.current.cursors : []); },
  };
}
