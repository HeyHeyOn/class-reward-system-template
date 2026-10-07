'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { ledgerClient, type LedgerResult } from './ledgerClient';

export type TaskBoardStatus = 'loading' | 'ready' | 'error';

export type TaskBoard = {
  enabled: boolean;
  tasks: readonly AdminTaskDto[];
  /** Server time of the last read; used for "시작 전/마감됨" and day labels. */
  now: string | null;
  status: TaskBoardStatus;
  /** Message of the last failed read (the previous list stays shown). */
  error: string;
  /**
   * Reads the board. A background read is skipped while a write or another read runs and never shows
   * an error over a list that is already shown.
   */
  reload: (options?: { background?: boolean }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Shows the tasks a write returned (newer copies replace older ones). */
  applyTasks: (tasks: readonly AdminTaskDto[]) => void;
  removeTasks: (taskIds: readonly string[]) => void;
  /** Call when a write starts; call the returned function when it ends. Reads started meanwhile are dropped. */
  beginWrite: () => () => void;
};

type BoardData = { tasks: readonly AdminTaskDto[]; now: string | null; status: TaskBoardStatus; error: string };

export const BOARD_REFRESH_MS = 20_000;

/**
 * The task board of a PostgreSQL class. It is only ever the server's copy: writes replace the tasks
 * they return, and the board re-reads itself every 20 s while visible and when the page gets focus.
 * Editors keep their unsaved input themselves, so a refresh can never overwrite it.
 */
export function useTaskBoard({ enabled }: { enabled: boolean }): TaskBoard {
  const [data, setData] = useState<BoardData>({ tasks: [], now: null, status: 'loading', error: '' });
  const epoch = useRef(0);
  const writes = useRef(0);
  const backgroundRead = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(async ({ background = false }: { background?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!enabled) return { ok: false, error: '' };
    if (background && (writes.current > 0 || backgroundRead.current)) return { ok: true };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = epoch.current;
      if (background) backgroundRead.current = true;
      const result = await ledgerClient.board();
      if (background) backgroundRead.current = false;
      if (!mounted.current) return { ok: false, error: '' };
      if (epoch.current !== started || writes.current > 0) {
        // A write finished (or is running) meanwhile; this read may be older than its result.
        if (background) return { ok: true };
        continue;
      }
      if (!result.ok) {
        setData((current) => current.status === 'ready' && background ? current : { ...current, status: current.status === 'ready' ? 'ready' : 'error', error: result.error });
        return { ok: false, error: result.error };
      }
      setData({ tasks: result.data.tasks, now: result.data.now, status: 'ready', error: '' });
      return { ok: true };
    }
    return { ok: true };
  }, [enabled]);

  const applyTasks = useCallback((incoming: readonly AdminTaskDto[]) => {
    if (incoming.length === 0) return;
    setData((current) => {
      const byId = new Map(current.tasks.map((task) => [task.taskId, task]));
      for (const task of incoming) {
        const existing = byId.get(task.taskId);
        if (!existing || !(existing.version > task.version)) byId.set(task.taskId, task);
      }
      const order = [...current.tasks.map((task) => task.taskId), ...incoming.map((task) => task.taskId).filter((id) => !current.tasks.some((task) => task.taskId === id))];
      return { ...current, tasks: order.map((id) => byId.get(id)!), status: 'ready', error: '' };
    });
  }, []);

  const removeTasks = useCallback((taskIds: readonly string[]) => {
    const removed = new Set(taskIds);
    setData((current) => ({ ...current, tasks: current.tasks.filter((task) => !removed.has(task.taskId)) }));
  }, []);

  const beginWrite = useCallback(() => {
    writes.current += 1;
    epoch.current += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      writes.current -= 1;
      epoch.current += 1;
    };
  }, []);

  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    const refresh = () => { if (document.visibilityState === 'visible') void reloadRef.current({ background: true }); };
    void Promise.resolve().then(() => reloadRef.current());
    const timer = window.setInterval(refresh, BOARD_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);

  return { enabled, tasks: data.tasks, now: data.now, status: data.status, error: data.error, reload, applyTasks, removeTasks, beginWrite };
}

/**
 * Sends one write. After a failure the board is read again in the background so that what is shown
 * is the server's state; the caller keeps the teacher's input and shows the message.
 */
export async function runWrite<T>(board: Pick<TaskBoard, 'beginWrite' | 'reload'>, send: () => Promise<LedgerResult<T>>): Promise<LedgerResult<T>> {
  const end = board.beginWrite();
  let result: LedgerResult<T>;
  try {
    result = await send();
  } finally {
    end();
  }
  if (!result.ok) void board.reload();
  return result;
}
