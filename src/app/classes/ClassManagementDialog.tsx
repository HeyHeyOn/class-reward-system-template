'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClassMembershipPageItem } from '@/server/classMembershipPageAccess';
import type { ClassManagementAction } from '@/server/repositories/database/classDashboard';
const titles = { RENAME: '학급 이름 바꾸기', DUPLICATE: '학급 복제', DELETE: '휴지통으로 옮기기', RESTORE: '학급 복원', PURGE: '학급 완전히 삭제' };
const labels = { RENAME: '저장', DUPLICATE: '새 학급으로 복제', DELETE: '휴지통으로', RESTORE: '학급 복원', PURGE: '완전히 삭제' };
const completed = { RENAME: '학급 이름을 바꿨어요.', DUPLICATE: '새 학급으로 복제했어요. 관리자 페이지에서 복제된 내용을 확인해 주세요.', DELETE: '휴지통으로 옮겼어요. 휴지통에서 복원할 수 있어요.', RESTORE: '학급을 복원했어요.', PURGE: '학급을 완전히 삭제했어요. 이 학급의 자료는 복원할 수 없어요.' };
/** Typing the class name again confirms these. */
const confirmByName = (action: ClassManagementAction) => action === 'DELETE' || action === 'PURGE';
export function ClassManagementDialog({ item, action, onClose, onSuccess }: {
  item: ClassMembershipPageItem; action: ClassManagementAction; onClose(): void; onSuccess(message: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const attempt = useRef<{ operationId: string; action: ClassManagementAction; name: string; expectedVersion: string } | null>(null);
  const inFlight = useRef(false);
  const [name, setName] = useState(action === 'DUPLICATE' ? `${item.displayName.slice(0, 75).replace(/[\uD800-\uDBFF]$/, '')} 복사본` : confirmByName(action) ? '' : item.displayName);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const canSubmit = confirmByName(action) ? name === item.displayName : name.trim().length > 0 && name.trim().length <= 80;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !canSubmit || !item.dashboard) return;
    inFlight.current = true; setBusy(true); setMessage('');
    attempt.current ??= { operationId: crypto.randomUUID(), action, name: name.trim(), expectedVersion: item.dashboard.managementVersion };
    try {
      const response = await fetch(`/api/classes/${item.slug}/manage`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt.current) });
      const result: unknown = await response.json();
      if (response.ok) {
        if (!result || typeof result !== 'object' || !('action' in result) || result.action !== action
          || !('slug' in result) || typeof result.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)
          || !('managementVersion' in result) || typeof result.managementVersion !== 'string'
          || !/^[1-9][0-9]*$/.test(result.managementVersion)) throw new Error('Unconfirmed result');
        onSuccess(completed[action]); return;
      }
      setMessage(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : '요청 결과를 확인하지 못했어요.');
      if (response.status === 400 || response.status === 413) { attempt.current = null; setUncertain(false); }
      else setUncertain(true);
    } catch { setUncertain(true); setMessage('연결이 끊겨 처리 결과를 확인하지 못했어요. 같은 요청으로 다시 확인하거나 목록을 새로고침해 주세요.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="class-management-title" aria-describedby="class-management-description"
    onCancel={event => { if (busy || uncertain) event.preventDefault(); else onClose(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-3xl border border-[var(--theme-divider)] bg-[var(--theme-surface)] p-0 text-[var(--theme-text)] shadow-2xl backdrop:bg-black/35">
    <form onSubmit={submit} className="relative p-6 sm:p-8">
      {/* 창 닫기 (ddanssaem-brand README '공통 부품'): the X on the top right. */}
      <button type="button" aria-label="닫기" disabled={busy || uncertain} onClick={onClose}
        className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-xl text-[var(--theme-muted-text)] hover:bg-[var(--theme-surface-raised)] hover:text-[var(--theme-text)] disabled:opacity-40">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
      <p className="mb-2 break-words pr-10 text-sm font-medium text-[var(--theme-muted-text)]">{item.displayName}</p><h2 id="class-management-title" className="text-2xl font-black tracking-tight">{titles[action]}</h2>
      <div id="class-management-description" className="mt-4 text-sm leading-6 text-[var(--theme-muted-text)]">
        {action === 'RENAME' && <p>학급 목록에 보이는 이름을 바꿔요. 학급 주소와 기존 기록은 그대로예요.</p>}
        {action === 'DUPLICATE' && <><p>지금 학급의 구성을 새 학급으로 가져와요.</p><ul className="mt-3 list-disc space-y-1 rounded-2xl bg-[var(--theme-surface-raised)] py-4 pl-8 pr-4"><li>설정, 학생 명단, 상품과 재고를 복사해요.</li><li>과제와 할인 행사는 꺼진 채로 복사해요.</li><li>학생 잔액은 0에서 시작해요.</li><li>거래, 완료, 부여 내역과 공동 관리자, 외부 연동, 예약 변경은 복사하지 않아요.</li></ul><p className="mt-3">관리자 페이지에서 내용을 확인하고 학생 QR을 새로 출력해 주세요.</p></>}
        {action === 'DELETE' && <><p>휴지통으로 옮기면 관리자, 매점, 은행 접속이 중지돼요. 학생과 거래 기록은 보관되고 나중에 복원할 수 있어요. 자료를 완전히 지우려면 휴지통에서 [완전히 삭제]를 누르세요.</p><p className="mt-3 font-semibold text-[var(--theme-text)]">확인을 위해 학급 이름을 그대로 입력해 주세요.</p></>}
        {action === 'PURGE' && <><p>학생 명단과 잔액, 상품, 과제, 거래 기록, 펫과 나무 기록, 보관함, 연결해 둔 패들렛 정보까지 이 학급의 모든 자료를 지워요.</p><p className="mt-3 rounded-2xl bg-rose-50 p-4 font-semibold text-rose-800">지운 뒤에는 되돌릴 수 없어요. 함께 관리하던 선생님도 더 이상 이 학급을 볼 수 없어요.</p><p className="mt-3 font-semibold text-[var(--theme-text)]">확인을 위해 학급 이름을 그대로 입력해 주세요.</p></>}
        {action === 'RESTORE' && <p>삭제 전 상태로 학급을 복원해요. 기존 학생, 잔액, 상품, 거래 기록을 그대로 다시 쓸 수 있어요.</p>}
      </div>
      {action !== 'RESTORE' && <label className="mt-5 block text-sm font-bold">{action === 'DUPLICATE' ? '새 학급 이름' : '학급 이름'}<input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy || uncertain} autoComplete="off" className="mt-2 w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 py-3 font-normal outline-offset-2 disabled:bg-[var(--theme-surface-raised)]"/></label>}
      {message && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm leading-6 text-rose-800">{message}</p>}
      <div className="mt-7 flex flex-wrap justify-end gap-2">
        {uncertain ? <button type="button" disabled={busy} onClick={() => window.location.reload()} className="rounded-xl border border-[var(--theme-divider)] px-4 py-3 text-sm font-bold">목록 새로고침</button> : <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-[var(--theme-divider)] px-4 py-3 text-sm font-bold hover:bg-[var(--theme-surface-raised)] disabled:opacity-50">취소</button>}
        <button type="submit" disabled={busy || !canSubmit} className={`rounded-xl px-5 py-3 text-sm font-bold disabled:opacity-40 ${confirmByName(action) ? 'bg-rose-700 text-white hover:bg-rose-800' : 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)] hover:bg-[var(--theme-hover)] hover:text-[var(--theme-hover-text)]'}`}>{busy ? '처리 중…' : uncertain ? '같은 요청으로 다시 확인' : labels[action]}</button>
      </div>
    </form>
  </dialog>;
}
