'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskHistoryDto, TaskHistoryEntryDto } from '@/lib/taskLedgerApi';
import { Button, Callout, EmptyState, Icon, Modal, Select, cx, type IconName } from '../../ui';
import { ledgerClient } from './ledgerClient';
import { CAUSE_LABELS, formatDayHeading, formatTimeOfDay, historySentence, seoulDayKey } from './ledgerFormat';
import { studentLabels, type LedgerStudent } from './LedgerParts';

const CAUSE_STYLE: Record<TaskHistoryEntryDto['cause'], { icon: IconName; tone: string }> = {
  TEACHER: { icon: 'user', tone: 'bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]' },
  QR: { icon: 'qr', tone: 'bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]' },
  BANK: { icon: 'bank', tone: 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]' },
  RESET: { icon: 'restore', tone: 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]' },
  AUTO_RESET: { icon: 'repeat', tone: 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]' },
  CANCELLED: { icon: 'close', tone: 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]' },
  IMPORTED: { icon: 'migrate', tone: 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]' },
};

type Loaded = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; history: TaskHistoryDto };

/** 기록: readable sentences, newest first, grouped by day, filterable by student. */
export function LedgerHistoryDialog({ taskId, title, students, unit, now, opener, onClose }: {
  taskId: string; title: string; students: readonly LedgerStudent[]; unit: string;
  /** Server time from the board, for "오늘/어제" headings. */
  now: string | null;
  opener: HTMLElement | null; onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [student, setStudent] = useState('');
  const [openedAt] = useState(() => new Date().toISOString());
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoaded({ status: 'loading' });
    const result = await ledgerClient.history(taskId);
    if (request.current !== id) return;
    setLoaded(result.ok ? { status: 'ready', history: result.data } : { status: 'error', error: result.error });
  }, [taskId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const names = useMemo(() => studentLabels(students), [students]);
  const entries = useMemo(() => loaded.status === 'ready' ? loaded.history.entries : [], [loaded]);
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) if (!seen.has(entry.studentId)) seen.set(entry.studentId, names.get(entry.studentId) ?? entry.studentName ?? entry.studentId);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko-KR'));
  }, [entries, names]);
  const shown = student ? entries.filter((entry) => entry.studentId === student) : entries;
  const days: Array<{ key: string; heading: string; entries: TaskHistoryEntryDto[] }> = [];
  for (const entry of shown) {
    const key = seoulDayKey(entry.at);
    const last = days.at(-1);
    if (last && last.key === key) last.entries.push(entry);
    else days.push({ key, heading: formatDayHeading(entry.at, now ?? openedAt), entries: [entry] });
  }

  return (
    <Modal title="과제 기록" ariaLabel="과제 기록" description={title} size="lg" opener={opener} onClose={onClose}
      footer={<Button variant="ghost" onClick={onClose}>닫기</Button>}>
      {loaded.status === 'loading' ? (
        <p role="status" aria-label="과제 기록 불러오는 중" className="rounded-[14px] bg-[var(--crs-subtle)] p-6 text-center text-sm font-semibold text-[var(--theme-muted-text)]">기록을 불러오는 중이에요.</p>
      ) : loaded.status === 'error' ? (
        <div className="space-y-3">
          <Callout tone="danger" title="기록을 불러오지 못했어요"><p>{loaded.error}</p></Callout>
          <Button size="sm" icon="refresh" onClick={() => void load()}>다시 불러오기</Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon="history" title="아직 기록이 없어요" description="학생의 단계가 바뀌면 여기에 남아요." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ledger-history-student" className="text-[13px] font-bold">학생</label>
            <Select id="ledger-history-student" aria-label="기록 학생 고르기" value={student} onChange={(event) => setStudent(event.target.value)} className="h-9 text-sm">
              <option value="">모든 학생</option>
              {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </div>
          {days.length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">이 학생의 기록이 없어요.</p> : null}
          {days.map((day) => (
            <section key={day.key} aria-label={day.heading}>
              <h3 className="mb-2 text-xs font-bold text-[var(--theme-muted-text)]">{day.heading}</h3>
              <ol className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)]">
                {day.entries.map((entry) => {
                  const style = CAUSE_STYLE[entry.cause] ?? CAUSE_STYLE.IMPORTED;
                  const named = { ...entry, studentName: names.get(entry.studentId) ?? entry.studentName };
                  return (
                    <li key={entry.id} className="flex items-start gap-3 px-3.5 py-2.5">
                      <span title={CAUSE_LABELS[entry.cause]} className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', style.tone)}><Icon name={style.icon} size={14} /></span>
                      <span className="min-w-0 flex-1 text-[13px] font-semibold leading-relaxed">{historySentence(named, unit)}</span>
                      <time dateTime={entry.at} className="shrink-0 text-xs tabular-nums text-[var(--theme-muted-text)]">{formatTimeOfDay(entry.at)}</time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {loaded.history.truncated ? <p className="text-center text-xs text-[var(--theme-muted-text)]">오래된 기록은 일부만 보여요.</p> : null}
        </div>
      )}
    </Modal>
  );
}
