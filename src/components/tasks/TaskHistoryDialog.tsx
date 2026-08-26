'use client';

import { useEffect, useRef } from 'react';
import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import { formatAdminHistoryDate, formatAdminTaskHistoryEvent, groupAdminTaskHistory } from '../adminTaskHistory';
import { themeStyles, type ThemeColor } from '../uiTheme';

export type TaskHistoryDialogState = {
  taskId: string;
  title: string;
  loading: boolean;
  error: string;
  detail: TaskHistoryDetailDto | null;
};

export function TaskHistoryDialog({ history, onClose, opener = null, themeColor = 'white' }: { history: TaskHistoryDialogState; onClose: () => void; opener?: HTMLElement | null; themeColor?: ThemeColor }) {
  const groups = history.detail ? groupAdminTaskHistory(history.detail) : [];
  const currentCycleId = history.detail?.currentLifecycle.currentCycleStatus?.cycleId;
  const semantic = themeStyles(themeColor);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    return () => opener?.focus();
  }, [opener]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (controls.length === 1 || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="과제 기록" onKeyDown={handleKeyDown} style={semantic.variables} className={`flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border ${semantic.border} ${semantic.surface} p-4 ${semantic.text} shadow-2xl`}>
        <div className="flex items-center justify-between gap-2">
          <div><h2 className="text-xl font-black">과제 기록</h2><p className={`text-sm font-bold ${semantic.mutedText}`}>{history.title} ({history.taskId})</p></div>
          <button ref={closeRef} type="button" onClick={onClose} className={`rounded-xl border ${semantic.border} ${semantic.surfaceRaised} px-4 py-2 font-black ${semantic.text} focus:outline-none focus:ring-2 ${semantic.ring}`}>닫기</button>
        </div>
        {history.loading ? <p role="status" aria-label="과제 기록 불러오는 중" className={`mt-4 rounded-xl border ${semantic.border} ${semantic.surfaceRaised} p-6 text-center font-bold ${semantic.mutedText}`}>기록을 불러오는 중입니다.</p> : null}
        {history.error ? <p role="alert" className={`mt-4 rounded-xl border ${semantic.border} ${semantic.surfaceRaised} p-4 font-bold ${semantic.text}`}>{history.error}</p> : null}
        {history.detail && history.detail.cumulativeHistory.eventCount === 0 ? <p className={`mt-4 rounded-xl border ${semantic.border} ${semantic.surfaceRaised} p-6 text-center font-bold ${semantic.mutedText}`}>기록이 없습니다.</p> : null}
        {history.detail ? <div className="mt-4 space-y-4 overflow-y-auto">{groups.map((lifecycle, lifecycleIndex) => (
          <section key={`${lifecycle.taskInstanceId}-${lifecycleIndex}`} className={`rounded-xl border ${semantic.border} p-3`}>
            <h3 className="font-black">{lifecycle.isCurrentLifecycle ? '현재 과제 생애' : '이전 과제 생애'}</h3>
            {lifecycle.cycles.map((cycle) => <div key={cycle.cycleId} className={`mt-3 rounded-xl border ${semantic.border} ${semantic.surfaceRaised} p-3`}><h4 className="text-sm font-black">{cycle.cycleId === currentCycleId ? '현재 회차' : '회차'} · {cycle.cycleId}{cycle.scheduleChanged ? ' · 반복 규칙 변경' : ''}</h4><ul className="mt-2 space-y-1">{cycle.events.map((event) => <li key={event.eventId} className={`text-xs font-bold ${semantic.mutedText}`}><time>{formatAdminHistoryDate(event.occurredAt, event.timeZone)}</time> · {formatAdminTaskHistoryEvent(event)}</li>)}</ul></div>)}
          </section>
        ))}</div> : null}
      </section>
    </div>
  );
}
