'use client';

import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import { formatAdminHistoryDate, formatAdminTaskHistoryEvent, groupAdminTaskHistory } from '../adminTaskHistory';

export type TaskHistoryDialogState = {
  taskId: string;
  title: string;
  loading: boolean;
  error: string;
  detail: TaskHistoryDetailDto | null;
};

export function TaskHistoryDialog({ history, onClose }: { history: TaskHistoryDialogState; onClose: () => void }) {
  const groups = history.detail ? groupAdminTaskHistory(history.detail) : [];
  const currentCycleId = history.detail?.currentLifecycle.currentCycleStatus?.cycleId;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section role="dialog" aria-modal="true" aria-label="과제 기록" className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-4 text-slate-950 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <div><h2 className="text-xl font-black">과제 기록</h2><p className="text-sm font-bold text-slate-500">{history.title} ({history.taskId})</p></div>
          <button type="button" onClick={onClose} className="rounded-xl bg-slate-200 px-4 py-2 font-black">닫기</button>
        </div>
        {history.loading ? <p role="status" aria-label="과제 기록 불러오는 중" className="mt-4 rounded-xl bg-slate-50 p-6 text-center font-bold">기록을 불러오는 중입니다.</p> : null}
        {history.error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 font-bold text-rose-700">{history.error}</p> : null}
        {history.detail && history.detail.cumulativeHistory.eventCount === 0 ? <p className="mt-4 rounded-xl bg-slate-50 p-6 text-center font-bold text-slate-500">기록이 없습니다.</p> : null}
        {history.detail ? <div className="mt-4 space-y-4 overflow-y-auto">{groups.map((lifecycle, lifecycleIndex) => (
          <section key={`${lifecycle.taskInstanceId}-${lifecycleIndex}`} className="rounded-xl border border-slate-200 p-3">
            <h3 className="font-black">{lifecycle.isCurrentLifecycle ? '현재 과제 생애' : '이전 과제 생애'}</h3>
            {lifecycle.cycles.map((cycle) => <div key={cycle.cycleId} className="mt-3 rounded-xl bg-slate-50 p-3"><h4 className="text-sm font-black">{cycle.cycleId === currentCycleId ? '현재 회차' : '회차'} · {cycle.cycleId}{cycle.scheduleChanged ? ' · 반복 규칙 변경' : ''}</h4><ul className="mt-2 space-y-1">{cycle.events.map((event) => <li key={event.eventId} className="text-xs font-bold text-slate-600"><time>{formatAdminHistoryDate(event.occurredAt, event.timeZone)}</time> · {formatAdminTaskHistoryEvent(event)}</li>)}</ul></div>)}
          </section>
        ))}</div> : null}
      </section>
    </div>
  );
}
