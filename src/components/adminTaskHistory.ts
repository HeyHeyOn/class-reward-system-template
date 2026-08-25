import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import type { TaskCycleHistoryEvent } from '@/server/repositories/sheets/taskCycleQueries';

export type AdminTaskHistoryCycle = {
  cycleId: string;
  ruleVersion: number | null;
  scheduleChanged: boolean;
  events: TaskCycleHistoryEvent[];
};

export type AdminTaskHistoryLifecycle = {
  taskInstanceId: string | null;
  isCurrentLifecycle: boolean;
  cycles: AdminTaskHistoryCycle[];
};

export function groupAdminTaskHistory(detail: TaskHistoryDetailDto): AdminTaskHistoryLifecycle[] {
  return (detail.cumulativeHistory?.lifecycles ?? []).map((lifecycle) => {
    const sorted = [...(lifecycle.events ?? [])].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const cycleMap = new Map<string, TaskCycleHistoryEvent[]>();
    sorted.forEach((event) => {
      const cycleId = event.cycleId ?? 'legacy';
      cycleMap.set(cycleId, [...(cycleMap.get(cycleId) ?? []), { ...event }]);
    });
    let priorRule: number | null = null;
    const cycles = Array.from(cycleMap, ([cycleId, events]) => {
      const ruleVersion = events.find((event) => event.ruleVersion !== undefined)?.ruleVersion ?? null;
      const scheduleChanged = priorRule !== null && ruleVersion !== null && priorRule !== ruleVersion;
      if (ruleVersion !== null) priorRule = ruleVersion;
      return { cycleId, ruleVersion, scheduleChanged, events };
    });
    return {
      taskInstanceId: lifecycle.taskInstanceId ?? null,
      isCurrentLifecycle: Boolean(lifecycle.isCurrentLifecycle),
      cycles,
    };
  }).sort((left, right) => Number(right.isCurrentLifecycle) - Number(left.isCurrentLifecycle));
}

const SOURCE_LABEL: Record<string, string> = {
  ADMIN: '관리자', QR: 'QR', LEGACY_SEED: '기존 설정', CARRY_FORWARD: '이월',
  CARRY: '이월', BANK: '은행', ADMIN_RESET: '관리자 초기화',
};

export function formatAdminTaskHistoryEvent(event: TaskCycleHistoryEvent): string {
  if (event.eventType === 'ASSIGNMENT') {
    const action = event.assignmentStatus === 'ASSIGNED' ? '부여' : '부여 해제';
    return `${event.studentId} · ${action} · ${SOURCE_LABEL[event.assignmentSource] ?? event.assignmentSource}`;
  }
  const source = SOURCE_LABEL[event.completionSource ?? ''] ?? event.completionSource ?? '기록';
  const action = event.completionSource === 'ADMIN_RESET' || event.completionStatus === 'RESET'
    ? '완료 초기화'
    : event.completionStatus === 'SUCCESS' ? '완료' : event.completionStatus;
  return `${event.studentName || event.studentId} · ${action} · ${source}${event.reward !== undefined ? ` · 보상 ${event.reward}` : ''}`;
}

export function formatAdminHistoryDate(instant: string, timeZone = 'Asia/Seoul'): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'short', timeStyle: 'short', timeZone,
    }).format(new Date(instant));
  } catch {
    return instant;
  }
}
