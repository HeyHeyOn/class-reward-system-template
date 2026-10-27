'use client';
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { MoreMenu } from '@/components/ui/MoreMenu';
import { useRouter } from 'next/navigation';
import { themeStyles } from '@/components/uiTheme';
import type { ClassMembershipPageItem, ClassMembershipPageModel } from '@/server/classMembershipPageAccess';
import type { ClassManagementAction } from '@/server/repositories/database/classDashboard';
import { ClassManagementDialog } from './ClassManagementDialog';
import styles from './dashboard.module.css';
import { SiteFooter } from '@/components/SiteFooter';
import { publicOrigin } from '@/lib/publicOrigin';
import { GlobalHeader, type HeaderAccount } from '@/components/brand/GlobalHeader';
import { GoogleLoginButton } from '@/components/brand/GoogleLoginButton';
import { LegalAgreementGate } from '@/components/account/LegalAgreementGate';
import type { TeacherAccountView } from '@/server/teacherAccounts';
import { NEW_CLASS_BLOCKED, type NewClassNote } from '@/lib/teacherVerification';
import { PendingTutorial } from '@/components/tutorial/PendingTutorial';

const theme = themeStyles('white');
const subscribe = () => () => {};
const empty: ClassMembershipPageItem[] = [];

type Filter = 'ALL' | 'ACTIVE' | 'DRAFT' | 'TRASH';
type Sort = 'activity' | 'created' | 'name';
const SORTS: readonly (readonly [Sort, string])[] = [['activity', '최근 활동순'], ['created', '최근 만든 순'], ['name', '이름순']];
const SORT_KEY = 'class-list-sort';
const activityOf = (item: ClassMembershipPageItem) => item.dashboard?.lastActivityAt ?? item.dashboard?.createdAt ?? '';
const ORDER: Readonly<Record<Sort, (a: ClassMembershipPageItem, b: ClassMembershipPageItem) => number>> = {
  activity: (a, b) => activityOf(b).localeCompare(activityOf(a)) || a.slug.localeCompare(b.slug),
  created: (a, b) => (b.dashboard?.createdAt ?? '').localeCompare(a.dashboard?.createdAt ?? '') || a.slug.localeCompare(b.slug),
  name: (a, b) => a.displayName.localeCompare(b.displayName, 'ko') || a.slug.localeCompare(b.slug),
};

// The chosen order is remembered on this device (in memory when storage is blocked), as on the 딴쌤 board list.
let memorySort: Sort = 'activity';
const sortListeners = new Set<() => void>();
function readSort(): Sort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved && saved in ORDER) return saved as Sort;
  } catch { /* storage blocked */ }
  return memorySort;
}
function writeSort(next: Sort) {
  memorySort = next;
  try { localStorage.setItem(SORT_KEY, next); } catch { /* storage blocked */ }
  sortListeners.forEach((listener) => listener());
}
function subscribeSort(listener: () => void) {
  sortListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => { sortListeners.delete(listener); window.removeEventListener('storage', listener); };
}

type Notice = Readonly<{ text: string; ok: boolean }>;
const paths = {
  school: 'M3 10 12 3 21 10 M5 9v12h14V9 M9 21v-7h6v7 M9 9h6',
  plus: 'M12 5v14 M5 12h14', admin: 'M4 4h16v16H4z M4 10h16 M10 10v10',
  store: 'M3 9h18l-2-5H5L3 9z M4 9v11h16V9 M9 20v-7h6v7',
  bank: 'M3 8 12 3 21 8H3z M3 21h18 M5 11v7 M12 11v7 M19 11v7',
  search: 'M16 16 21 21 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  check: 'M5 12.5 10 17.5 19 7', alert: 'M12 8v5 M12 16.5v.01 M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5', trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  restore: 'M3 5v6h6 M3 11a9 9 0 1 1 2 7 M12 7v6l4 2',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
};
function Icon({ name }: { name: keyof typeof paths }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}
const dateLabel = (value: string) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));

export function ClassesSelectionView({ model, account, header, newClass, withdrawn = false, loginFailed = false }: Readonly<{
  model: ClassMembershipPageModel;
  /** The signed-in teacher's legal notice (PostgreSQL classes). */
  account?: TeacherAccountView;
  /** The header's account button; without it the header shows the membership label. */
  header?: HeaderAccount;
  /** 교사 인증 (account-protocol 10-4): new classes blocked, or a grace running out, and where to verify. */
  newClass?: Readonly<{ note: NewClassNote; verifyUrl?: string }>;
  withdrawn?: boolean;
  /** Back from the 딴쌤 hub without signing in: offer to try again instead of sending the browser round. */
  loginFailed?: boolean;
}>) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const sort = useSyncExternalStore(subscribeSort, readSort, () => 'activity' as Sort);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<{ item: ClassMembershipPageItem; action: ClassManagementAction } | null>(null);
  const memberships = model.kind === 'MEMBERSHIPS' ? model.memberships : empty;
  const groups = useMemo(() => {
    const current = memberships.filter(m => !m.dashboard?.deletedAt);
    return { ALL: current, ACTIVE: current.filter(m => m.selectable), DRAFT: current.filter(m => m.setupHref), TRASH: memberships.filter(m => m.dashboard?.deletedAt) };
  }, [memberships]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => groups[filter]
    .filter(m => m.displayName.toLocaleLowerCase('ko-KR').includes(query.trim().toLocaleLowerCase('ko-KR')))
    .sort(ORDER[sort]), [groups, filter, query, sort]);

  function say(text: string, ok: boolean) {
    setNotice({ text, ok });
    if (ok) window.setTimeout(() => setNotice(current => current?.text === text ? null : current), 4000);
  }
  async function copyAddress(item: ClassMembershipPageItem) {
    try { await navigator.clipboard.writeText(`${publicOrigin()}/c/${item.slug}`); say(`${item.displayName}의 매점 주소를 복사했어요.`, true); }
    catch { say('주소를 복사하지 못했어요. 매점을 연 뒤 주소창의 주소를 복사해 주세요.', false); }
  }
  const emptyText = searching ? '찾는 학급이 없어요.'
    : filter === 'TRASH' ? '휴지통이 비어 있어요.' : filter === 'ACTIVE' ? '사용 중인 학급이 없어요.'
      : filter === 'DRAFT' ? '준비 중인 학급이 없어요.' : '아직 학급이 없어요.';
  return <>
  <GlobalHeader audience="teacher"
    account={model.kind === 'MEMBERSHIPS' ? header ?? { nickname: model.accountLabel } : null}
    loginHref={model.kind === 'LOGIN_REQUIRED' ? model.loginHref : undefined} />
  <main style={theme.variables} className={styles.shell}>
    {notice ? <div role={notice.ok ? 'status' : 'alert'} className={`${styles.toast} ${notice.ok ? styles.toastOk : styles.toastFail}`}>
      <Icon name={notice.ok ? 'check' : 'alert'}/><span>{notice.text}</span>
      <button type="button" aria-label="알림 닫기" onClick={() => setNotice(null)}>×</button>
    </div> : null}
    <div className={styles.container}>
      {model.kind === 'LOGIN_REQUIRED' && withdrawn ? <p role="status" className={styles.notice}>회원 탈퇴가 끝났어요. 그동안 딴쌤 클래스를 이용해 주셔서 고마워요.</p> : null}
      {model.kind === 'LOGIN_REQUIRED' ? <section className={styles.welcome}>
        <div><h1>우리 반의 성장과<br/>보상을 함께 관리해요.</h1><p className={styles.intro}>학급마다 매점과 은행을 운영하고,<br/>학생들의 작은 도전을 보상으로 연결하세요.</p><div className={styles.features}>{['여러 학급 관리','학급 매점과 은행','과제와 보상'].map(s => <span key={s}>{s}</span>)}</div></div>
        {loginFailed
          ? <div className={styles.loginCard}><span className={styles.classIcon}><Icon name="school"/></span><h2>로그인하지 못했어요</h2><p>잠시 뒤 다시 시도해 주세요.</p><a href={model.loginHref} className={styles.primary}>다시 로그인</a></div>
          : <div className={styles.loginCard}><span className={styles.classIcon}><Icon name="school"/></span><h2>내 학급으로 시작하기</h2><p>Google 계정으로 로그인하면 내 학급을 확인하거나 새 학급을 만들 수 있어요.</p><GoogleLoginButton href={model.loginHref} block className={styles.googleLogin} /><small>이미 만든 학급이 있다면<br/>그 학급을 만든 Google 계정으로 로그인해 주세요.</small></div>}
      </section> : <>
        <section aria-label="내 학급" className={styles.titleRow}>
          <h1>내 학급</h1>
          <div className={styles.titleTools}>
            <label className={styles.search}><Icon name="search"/><span className="sr-only">학급 검색</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="학급 검색"/></label>
            <select aria-label="정렬" value={sort} onChange={e => writeSort(e.target.value as Sort)} className={styles.sort}>
              {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <Link href="/classes/new" aria-label="새 학급" className={styles.primary}><Icon name="plus"/>새 학급</Link>
          </div>
        </section>
        {newClass?.note ? (
          <p role="status" data-testid="new-class-note" className={styles.verifyNote}>
            <span>{newClass.note.kind === 'blocked' ? NEW_CLASS_BLOCKED : `교사 인증 전까지 ${newClass.note.days}일`}</span>
            {newClass.verifyUrl ? <a href={newClass.verifyUrl}>인증하기</a> : null}
          </p>
        ) : null}
        <div role="tablist" aria-label="학급 나누어 보기" className={styles.tabs}>
          {([['ALL','전체'],['ACTIVE','사용 중'],['DRAFT','준비 중'],['TRASH','휴지통']] as const).map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{label} {groups[value].length}</button>
          ))}
        </div>
        {visible.length === 0 ? <div className={styles.empty}>
          <p>{emptyText}</p>
          {filter === 'ALL' && !searching && groups.ALL.length === 0 ? <Link href="/classes/new" className={styles.primary}><Icon name="plus"/>새 학급</Link> : null}
        </div> : <ul aria-label="학급 목록" className={styles.grid}>{visible.map(item => (
          <ClassCard key={item.slug} item={item} ready={ready} onAction={action => setDialog({ item, action })} onCopy={() => void copyAddress(item)} />
        ))}</ul>}
      </>}
    </div>
    <SiteFooter className={styles.footer}/>
    {model.kind === 'MEMBERSHIPS' ? <PendingTutorial/> : null}
    {dialog && <ClassManagementDialog key={`${dialog.item.slug}-${dialog.action}`} item={dialog.item} action={dialog.action}
      verifyFirst={dialog.action === 'DUPLICATE' && newClass?.note?.kind === 'blocked' ? { verifyUrl: newClass.verifyUrl } : undefined}
      onClose={() => setDialog(null)} onSuccess={message => { setDialog(null); say(message, true); router.refresh(); }}/> }
    {account ? <LegalAgreementGate notice={account.notice} classNames={memberships.filter((item) => item.roleLabel === '소유자').map((item) => item.displayName)} /> : null}
  </main>
  </>;
}

/** One class: the card opens it (the admin page, or 학급 준비), 매점 and 은행 stay on the card, the rest is in ⋯. */
function ClassCard({ item, ready, onAction, onCopy }: Readonly<{
  item: ClassMembershipPageItem; ready: boolean; onAction(action: ClassManagementAction): void; onCopy(): void;
}>) {
  const deleted = Boolean(item.dashboard?.deletedAt);
  const owner = item.dashboard?.role === 'OWNER';
  const manageable = owner && (item.selectable || Boolean(item.setupHref));
  const content = <>
    <div className={styles.cardTop}><span className={styles.classIcon}><Icon name="school"/></span>
      <div className={styles.cardTitle}><h2>{item.displayName}</h2><p className={styles.cardMeta}>{item.roleLabel}{item.dashboard && <>, {dateLabel(item.dashboard.deletedAt ?? item.dashboard.createdAt)} {deleted ? '삭제' : '생성'}</>}</p></div></div>
    <div className={styles.cardState}><span className={`${styles.badge} ${item.selectable ? styles.activeBadge : ''}`}><i aria-hidden="true"/>{deleted ? '삭제됨' : item.lifecycleLabel}</span>
      {item.setupHref && !deleted ? <span className={styles.continue}>학급 준비 계속<Icon name="arrow"/></span> : null}</div>
    {item.dashboard ? <dl className={styles.cardStats}>{([['학생',item.dashboard.studentCount,'명'],['상품',item.dashboard.productCount,'개'],['과제',item.dashboard.taskCount,'개']] as const).map(([label, count, unit]) => <div key={label}><dt>{label}</dt><dd>{count}<small>{unit}</small></dd></div>)}</dl> : null}
  </>;
  const opens = !deleted && item.selectable && item.href ? { href: `${item.href}/admin`, label: `${item.displayName} 관리자 페이지` }
    : !deleted && item.setupHref ? { href: item.setupHref, label: `${item.displayName} 학급 준비 계속` } : null;
  return <li className={styles.card}>
    {opens ? <Link href={opens.href} aria-label={opens.label} className={styles.cardMain}>{content}</Link> : <div className={styles.cardMain}>{content}</div>}
    {deleted ? (owner ? <div className={styles.cardFoot}>
        <button type="button" disabled={!ready} onClick={() => onAction('RESTORE')} className={styles.outline}><Icon name="restore"/>학급 복원</button>
        <button type="button" disabled={!ready} aria-label={`${item.displayName} 완전히 삭제`} onClick={() => onAction('PURGE')} className={`${styles.outline} ${styles.dangerOutline}`}><Icon name="trash"/>완전히 삭제</button>
      </div> : null)
      : item.selectable && item.href ? <div className={styles.cardFoot}>
        <Link href={item.href} aria-label={`${item.displayName} 학급으로 이동`} className={styles.outline}><Icon name="store"/>매점</Link>
        <Link href={`${item.href}/bank`} aria-label={`${item.displayName} 은행 페이지`} className={styles.outline}><Icon name="bank"/>은행</Link>
      </div>
      : !item.setupHref ? <p className={styles.unavailable}>지금은 선택할 수 없어요.</p> : null}
    {!deleted && (manageable || item.selectable) ? <MoreMenu label={`${item.displayName} 학급 관리`} className={styles.cardMore} items={[
      manageable ? { label: '이름 바꾸기', icon: 'edit', disabled: !ready, onSelect: () => onAction('RENAME') } : null,
      owner && item.selectable ? { label: '복제', icon: 'copy', disabled: !ready, onSelect: () => onAction('DUPLICATE') } : null,
      item.selectable && item.href ? { label: '학생 QR 인쇄', icon: 'printer', href: `${item.href}/admin/student-qrs` } : null,
      item.selectable ? { label: '매점 주소 복사', icon: 'link', disabled: !ready, onSelect: onCopy } : null,
      manageable ? { label: '휴지통으로', icon: 'trash', danger: true, disabled: !ready, onSelect: () => onAction('DELETE') } : null,
    ]} /> : null}
  </li>;
}
