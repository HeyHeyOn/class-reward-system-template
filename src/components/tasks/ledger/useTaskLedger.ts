'use client';

import { useCallback, useEffect, useState } from 'react';
import { tenantApiPath } from '@/lib/tenantApiPath';
import { useTaskBoard, type TaskBoard } from './useTaskBoard';

export type TaskSheetTab = 'basic' | 'repeat' | 'students';

/** What the task screen shows on top of the list. Only one at a time; nested dialogs live inside them. */
export type LedgerOverlay =
  | { kind: 'task'; taskId: string; tab: TaskSheetTab; opener: HTMLElement | null }
  | { kind: 'new'; opener: HTMLElement | null }
  | { kind: 'qr'; opener: HTMLElement | null }
  | { kind: 'bulk-repeat' | 'bulk-stages' | 'reset' | 'delete'; taskIds: readonly string[]; opener: HTMLElement | null };

export type TaskLedger = {
  enabled: boolean;
  board: TaskBoard;
  overlay: LedgerOverlay | null;
  overlayOpen: boolean;
  open: (overlay: LedgerOverlay) => void;
  close: () => void;
  /** Rows picked in the task list (kept while dialogs are open). */
  selection: readonly string[];
  setSelection: (next: readonly string[] | ((current: readonly string[]) => readonly string[])) => void;
};

/** True on PostgreSQL class pages (`/c/{slug}/...`), where tasks use the stage ledger. */
export function isTaskLedgerMode(): boolean {
  return tenantApiPath('/api/tasks') !== '/api/tasks';
}

const LEGACY_TASK_JOURNAL_PREFIXES = ['crs:task-', 'crs:single-task-delete:', 'crs:admin-completion:'];

/**
 * Removes this class's leftovers of the old task screen (request journals and retained drafts in
 * sessionStorage). They are never read in ledger mode; an old one used to block every task edit.
 */
export function clearLegacyTaskJournals(storage: Storage | undefined = typeof window === 'undefined' ? undefined : window.sessionStorage): number {
  if (!storage) return 0;
  const classScope = tenantApiPath('/api/tasks');
  if (classScope === '/api/tasks') return 0;
  const stale: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && LEGACY_TASK_JOURNAL_PREFIXES.some((prefix) => key.startsWith(prefix))
        && (key.includes(`${classScope}/`) || key.endsWith(classScope))) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    return 0;
  }
  return stale.length;
}

export function useTaskLedger({ enabled }: { enabled: boolean }): TaskLedger {
  const board = useTaskBoard({ enabled });
  const [overlay, setOverlay] = useState<LedgerOverlay | null>(null);
  const [selection, setSelectionState] = useState<readonly string[]>([]);

  useEffect(() => {
    if (enabled) clearLegacyTaskJournals();
  }, [enabled]);

  const open = useCallback((next: LedgerOverlay) => setOverlay(next), []);
  const close = useCallback(() => setOverlay(null), []);
  const setSelection = useCallback((next: readonly string[] | ((current: readonly string[]) => readonly string[])) => {
    setSelectionState((current) => typeof next === 'function' ? next(current) : next);
  }, []);

  return { enabled, board, overlay: enabled ? overlay : null, overlayOpen: enabled && overlay !== null, open, close, selection, setSelection };
}
