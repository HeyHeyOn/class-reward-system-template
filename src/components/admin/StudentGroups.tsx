'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { tenantFetch } from '@/lib/tenantApiPath';
import { Button, Icon, IconButton, Input, Modal, cx } from '../ui';

// 모둠: the teacher groups the class's students (a student in at most one group). The groups live with the
// class (/api/student-groups); a rested or deleted student is in none.

export type StudentGroupView = Readonly<{ id: string; name: string; students: readonly string[] }>;
type Result = Readonly<{ ok: true } | { ok: false; error: string }>;

const FAILED = '모둠을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';

/** The class's groups, read again whenever `studentsKey` (the student list) changes. */
export function useStudentGroups(enabled: boolean, studentsKey: string) {
  const [groups, setGroups] = useState<StudentGroupView[]>([]);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await tenantFetch('/api/student-groups', { cache: 'no-store' });
      const payload = await response.json() as { groups?: StudentGroupView[] };
      if (response.ok && Array.isArray(payload.groups)) setGroups(payload.groups);
    } catch {
      // The student list stays usable without groups; the next change reads them again.
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await tenantFetch('/api/student-groups', { cache: 'no-store' });
        const payload = await response.json() as { groups?: StudentGroupView[] };
        if (!cancelled && response.ok && Array.isArray(payload.groups)) setGroups(payload.groups);
      } catch {
        // As above.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, studentsKey]);
  const change = useCallback(async (body: Record<string, unknown>): Promise<Result> => {
    try {
      const response = await tenantFetch('/api/student-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { groups?: StudentGroupView[]; error?: string };
      if (!response.ok) return { ok: false, error: payload.error || FAILED };
      if (Array.isArray(payload.groups)) setGroups(payload.groups);
      else await refresh();
      return { ok: true };
    } catch {
      return { ok: false, error: FAILED };
    }
  }, [refresh]);
  const groupOf = useMemo(() => {
    const map = new Map<string, StudentGroupView>();
    for (const group of groups) for (const studentId of group.students) map.set(studentId, group);
    return map;
  }, [groups]);
  return { groups, groupOf, refresh, change };
}

type Change = ReturnType<typeof useStudentGroups>['change'];

function GroupRow({ group, change, onError }: Readonly<{ group: StudentGroupView; change: Change; onError: (message: string) => void }>) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    const result = await change(body);
    setBusy(false);
    if (!result.ok) onError(result.error);
    else setMode('view');
  }
  if (mode === 'rename') {
    return (
      <li className="flex flex-wrap items-center gap-2 px-1 py-2">
        <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void run({ action: 'rename', groupId: group.id, name }); }}>
          <Input aria-label={`${group.name} 새 이름`} value={name} maxLength={30} autoFocus onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>저장</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setName(group.name); setMode('view'); }}>취소</Button>
        </form>
      </li>
    );
  }
  if (mode === 'delete') {
    return (
      <li className="flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--crs-danger-bg)] px-3 py-2.5">
        <p className="min-w-0 flex-1 text-[13px] font-semibold">{group.name} 모둠을 지울까요? 학생은 그대로예요.</p>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void run({ action: 'delete', groupId: group.id })}>지우기</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode('view')}>취소</Button>
      </li>
    );
  }
  return (
    <li className="relative flex items-center gap-3 px-1 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]"><Icon name="users" size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-bold">{group.name}</span>
        <span className="block text-xs text-[var(--theme-muted-text)]">학생 {group.students.length}명</span>
      </span>
      <IconButton ref={menuButton} icon="more" label={`${group.name} 메뉴`} size="sm" variant="ghost"
        aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
        onClick={() => setMenuOpen((open) => !open)} />
      {menuOpen ? (
        <div id={menuId} role="menu" aria-label={`${group.name} 메뉴`}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); menuButton.current?.focus(); } }}
          className="absolute right-1 top-11 z-10 min-w-36 overflow-hidden rounded-[12px] border border-[var(--crs-line)] bg-[var(--theme-surface)] py-1 shadow-[var(--crs-shadow-lg)]">
          <button type="button" role="menuitem" autoFocus className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold hover:bg-[var(--crs-subtle)]"
            onClick={() => { setMenuOpen(false); setName(group.name); setMode('rename'); }}><Icon name="edit" size={15} />이름 바꾸기</button>
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-[var(--crs-danger-text)] hover:bg-[var(--crs-subtle)]"
            onClick={() => { setMenuOpen(false); setMode('delete'); }}><Icon name="trash" size={15} />지우기</button>
        </div>
      ) : null}
    </li>
  );
}

/** 모둠 만들기, and each group's ⋯ menu (이름 바꾸기, 지우기). */
export function StudentGroupManagerDialog({ groups, change, onClose, opener }: Readonly<{
  groups: readonly StudentGroupView[]; change: Change; onClose: () => void; opener: HTMLElement | null;
}>) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await change({ action: 'create', name });
    setBusy(false);
    if (result.ok) setName('');
    else setError(result.error);
  }
  return (
    <Modal title="모둠" ariaLabel="모둠" description="학생을 모둠으로 묶어요. 학생은 모둠 하나에만 들어가요." onClose={onClose} opener={opener}>
      <form onSubmit={create} className="flex gap-2" data-tour="student-group-create">
        <Input aria-label="새 모둠 이름" placeholder="예: 1모둠" value={name} maxLength={30} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1" />
        <Button type="submit" variant="primary" icon="plus" disabled={busy || !name.trim()}>만들기</Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
      {groups.length === 0
        ? <p className="mt-4 rounded-[12px] bg-[var(--crs-subtle)] px-4 py-6 text-center text-[13px] text-[var(--theme-muted-text)]">아직 모둠이 없어요.</p>
        : <ul aria-label="모둠 목록" className="mt-3 divide-y divide-[var(--crs-line)]">
          {groups.map((group) => <GroupRow key={`${group.id}:${group.name}`} group={group} change={change} onError={setError} />)}
        </ul>}
    </Modal>
  );
}

/** Put the selected students in a group, or in none. */
export function StudentGroupAssignDialog({ groups, studentIds, change, onClose, onDone, onManage, opener }: Readonly<{
  groups: readonly StudentGroupView[]; studentIds: readonly string[]; change: Change; onClose: () => void;
  onDone: (message: string) => void; onManage: (opener: HTMLElement) => void; opener: HTMLElement | null;
}>) {
  const [choice, setChoice] = useState<string>(groups[0]?.id ?? 'none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = useId();
  async function assign() {
    setBusy(true);
    setError('');
    const groupId = choice === 'none' ? null : choice;
    const result = await change({ action: 'assign', groupId, studentIds: [...studentIds] });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    const group = groups.find((item) => item.id === groupId);
    onDone(group ? `학생 ${studentIds.length}명을 ${group.name}에 넣었어요.` : `학생 ${studentIds.length}명을 모둠에서 뺐어요.`);
  }
  return (
    <Modal title="모둠 지정" ariaLabel="모둠 지정" description={`선택한 학생 ${studentIds.length}명을 넣을 모둠을 골라요.`} onClose={onClose} opener={opener} busy={busy}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
        <Button variant="primary" icon="check" disabled={busy} onClick={() => void assign()} data-tour="student-group-assign-apply">지정</Button>
      </>}>
      {groups.length === 0 ? (
        <div className="rounded-[12px] bg-[var(--crs-subtle)] px-4 py-5 text-center">
          <p className="text-[13px] text-[var(--theme-muted-text)]">아직 모둠이 없어요.</p>
          <Button size="sm" variant="secondary" icon="plus" className="mt-3" onClick={(event) => onManage(event.currentTarget)}>모둠 만들기</Button>
        </div>
      ) : null}
      <div role="radiogroup" aria-label="넣을 모둠" className="mt-1 grid gap-2">
        {[...groups.map((group) => ({ id: group.id, label: group.name, hint: `학생 ${group.students.length}명` })), { id: 'none', label: '모둠 없음', hint: '모둠에서 빼요' }].map((option) => (
          <label key={option.id} className={cx('flex cursor-pointer items-center gap-3 rounded-[12px] border px-3.5 py-2.5',
            choice === option.id ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)]' : 'border-[var(--crs-line)] hover:border-[var(--crs-line-strong)]')}>
            <input type="radio" name={name} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} className="accent-[var(--theme-accent-solid)]" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-bold">{option.label}</span>
            <span className="text-xs text-[var(--theme-muted-text)]">{option.hint}</span>
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="mt-3 text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
    </Modal>
  );
}
