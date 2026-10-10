'use client';
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { themeStyles } from '@/components/uiTheme';
import type { ClassMembershipPageItem, ClassMembershipPageModel } from '@/server/classMembershipPageAccess';
import type { ClassManagementAction } from '@/server/repositories/database/classDashboard';
import { ClassManagementDialog } from './ClassManagementDialog';
import styles from './dashboard.module.css';
import { SiteFooter } from '@/components/SiteFooter';
import { publicOrigin } from '@/lib/publicOrigin';
import { AccountLink } from '@/components/account/AccountLink';
import { LegalAgreementGate } from '@/components/account/LegalAgreementGate';
import type { TeacherAccountView } from '@/server/teacherAccounts';

const theme = themeStyles('white');
const subscribe = () => () => {};
const empty: ClassMembershipPageItem[] = [];
const paths = {
  school: 'M3 10 12 3 21 10 M5 9v12h14V9 M9 21v-7h6v7 M9 9h6',
  plus: 'M12 5v14 M5 12h14', admin: 'M4 4h16v16H4z M4 10h16 M10 10v10',
  store: 'M3 9h18l-2-5H5L3 9z M4 9v11h16V9 M9 20v-7h6v7',
  bank: 'M3 8 12 3 21 8H3z M3 21h18 M5 11v7 M12 11v7 M19 11v7',
  search: 'M16 16 21 21 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5', trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  restore: 'M3 5v6h6 M3 11a9 9 0 1 1 2 7 M12 7v6l4 2', logout: 'M9 3H4v18h5 M8 12h13 M16 7l5 5-5 5',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
};
function Icon({ name }: { name: keyof typeof paths }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}
const dateLabel = (value: string) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));

export function ClassesSelectionView({ model, account, withdrawn = false }: Readonly<{
  model: ClassMembershipPageModel;
  /** The signed-in teacher's profile and legal notice (PostgreSQL classes). */
  account?: TeacherAccountView;
  withdrawn?: boolean;
}>) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('recent');
  const [notice, setNotice] = useState('');
  const [logoutPending, setLogoutPending] = useState(false);
  const [dialog, setDialog] = useState<{ item: ClassMembershipPageItem; action: ClassManagementAction } | null>(null);
  const memberships = model.kind === 'MEMBERSHIPS' ? model.memberships : empty;
  const current = memberships.filter(m => !m.dashboard?.deletedAt);
  const trashed = memberships.filter(m => m.dashboard?.deletedAt);
  const active = current.filter(m => m.selectable);
  const draft = current.filter(m => m.setupHref);
  const visible = useMemo(() => memberships.filter(m => {
    if (filter === 'TRASH' ? !m.dashboard?.deletedAt : Boolean(m.dashboard?.deletedAt)) return false;
    if (filter === 'ACTIVE' && !m.selectable || filter === 'DRAFT' && !m.setupHref) return false;
    return m.displayName.toLocaleLowerCase('ko-KR').includes(query.trim().toLocaleLowerCase('ko-KR'));
  }).sort((a, b) => sort === 'name' ? a.displayName.localeCompare(b.displayName, 'ko')
    : (b.dashboard?.createdAt ?? '').localeCompare(a.dashboard?.createdAt ?? '') || a.slug.localeCompare(b.slug)), [memberships, query, filter, sort]);

  async function logout() {
    if (logoutPending || !ready) return;
    setLogoutPending(true); setNotice('');
    try {
      const response = await fetch('/api/google/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error();
      window.location.replace('/classes');
    } catch { setNotice('로그아웃하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.'); setLogoutPending(false); }
  }
  async function copyAddress(item: ClassMembershipPageItem) {
    try { await navigator.clipboard.writeText(`${publicOrigin()}/c/${item.slug}`); setNotice(`${item.displayName}의 매점 주소를 복사했습니다.`); }
    catch { setNotice('주소를 복사하지 못했습니다. 매점을 연 뒤 주소창의 주소를 복사해 주세요.'); }
  }
  return <main style={theme.variables} className={styles.shell}>
    <div className={styles.container}>
      <header className={styles.header}>
        <Link href="/classes" aria-label="학급 보상 시스템 내 학급" className={styles.brand}>
          <span aria-hidden="true" className={styles.logo}/><span>학급 보상 시스템</span>
        </Link>
        {model.kind === 'MEMBERSHIPS' && <div className={styles.account}>
          {account
            ? <AccountLink nickname={account.profile.nickname} avatar={account.profile.avatar} />
            : <><span className={styles.avatar} aria-hidden="true">{Array.from(model.accountLabel)[0]}</span><span className={styles.accountName}>{model.accountLabel}</span></>}
          <button onClick={logout} disabled={!ready || logoutPending} className={styles.outline}><Icon name="logout"/>{logoutPending ? '로그아웃 중…' : '로그아웃'}</button>
        </div>}
      </header>
      {model.kind === 'LOGIN_REQUIRED' && withdrawn ? <p role="status" className={styles.notice}>회원 탈퇴가 끝났어요. 그동안 학급 보상 시스템을 이용해 주셔서 고마워요.</p> : null}
      {model.kind === 'LOGIN_REQUIRED' ? <section className={styles.welcome}>
        <div><h1>우리 반의 성장과<br/>보상을 함께 관리해요.</h1><p className={styles.intro}>학급마다 매점과 은행을 운영하고,<br/>학생들의 작은 도전을 보상으로 연결하세요.</p><div className={styles.features}>{['여러 학급 관리','학급 매점 · 은행','과제와 보상'].map(s => <span key={s}>{s}</span>)}</div></div>
        <div className={styles.loginCard}><span className={styles.classIcon}><Icon name="school"/></span><h2>내 학급으로 시작하기</h2><p>Google 계정으로 로그인하면 내 학급을 확인하거나 새로운 학급을 만들 수 있습니다.</p><a href={model.loginHref} className={styles.primary}>Google 계정으로 로그인<Icon name="arrow"/></a><small>이미 만든 학급이 있다면<br/>그 학급을 만든 Google 계정으로 로그인해 주세요.</small></div>
      </section> : <>
        <section className={styles.hero}><div><h1>내 학급</h1><p>학급을 선택하고 오늘의 활동을 시작하세요.</p></div><Link href="/classes/new" aria-label="새 학급" className={styles.primary}><Icon name="plus"/>새 학급 만들기</Link></section>
        <section aria-label="학급 현황" className={styles.stats}>
          {[
            ['전체 학급', current.length, '내가 소속된 학급'], ['사용 중', active.length, '지금 운영 중인 학급'],
            ['등록된 학생', current.reduce((n, m) => n + (m.dashboard?.studentCount ?? 0), 0), '학급별 학생 수 합계'],
          ].map(([label, count, description]) => <div key={label}><span>{label}</span><strong>{count}</strong><small>{description}</small></div>)}
        </section>
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        <section aria-label="학급 목록">
          <div className={styles.toolbar}>
            <div aria-label="학급 분류" className={styles.filters}>
              {([['ALL','전체',current.length],['ACTIVE','사용 중',active.length],['DRAFT','준비 중',draft.length],['TRASH','휴지통',trashed.length]] as const).map(([value, label, count]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}
            </div>
            <div className={styles.searchRow}><label className={styles.search}><Icon name="search"/><span className="sr-only">학급 이름 검색</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="학급 이름으로 검색"/></label><select aria-label="학급 정렬" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">최근 생성순</option><option value="name">이름순</option></select></div>
          </div>
          {filter === 'TRASH' && <p className={styles.trashInfo}>삭제한 학급은 접속이 중지됩니다. 소유자가 복원하면 기존 기록과 함께 다시 사용할 수 있습니다.</p>}
          {visible.length === 0 ? <div className={styles.empty}><span className={styles.classIcon}><Icon name={filter === 'TRASH' ? 'trash' : 'school'}/></span>
            <h2>{query ? '검색 결과가 없습니다.' : filter === 'TRASH' ? '휴지통이 비어 있습니다.' : current.length ? '이 분류에 해당하는 학급이 없습니다.' : '아직 등록된 학급이 없습니다.'}</h2>
            <p>{query ? '다른 학급 이름으로 검색해 보세요.' : filter === 'TRASH' ? '삭제한 학급은 이곳에서 복원할 수 있습니다.' : '새 학급을 만들거나 다른 분류를 선택해 주세요.'}</p>
            {!current.length && filter !== 'TRASH' && !query && <Link href="/classes/new" className={styles.primary}><Icon name="plus"/>첫 학급 만들기</Link>}
          </div> : <ul className={styles.grid}>{visible.map(item => {
            const deleted = Boolean(item.dashboard?.deletedAt);
            const owner = item.dashboard?.role === 'OWNER';
            const manageable = owner && (item.selectable || Boolean(item.setupHref));
            return <li key={item.slug} className={styles.card}><div className={styles.cardBody}>
              <div className={styles.cardTop}><span className={styles.classIcon}><span aria-hidden="true" className={styles.crsMark}/></span><span className={`${styles.badge} ${item.selectable ? styles.activeBadge : ''}`}><i aria-hidden="true"/>{deleted ? '삭제됨' : item.lifecycleLabel}</span></div>
              <h2>{item.displayName}</h2><p className={styles.cardMeta}>{item.roleLabel}{item.dashboard && <> · {dateLabel(item.dashboard.deletedAt ?? item.dashboard.createdAt)} {deleted ? '삭제' : '생성'}</>}</p>
              <dl className={styles.cardStats}>{([['학생',item.dashboard?.studentCount,'명'],['상품',item.dashboard?.productCount,'개'],['과제',item.dashboard?.taskCount,'개']] as const).map(([label, count, unit]) => <div key={label}><dt>{label}</dt><dd>{count ?? '—'}<small>{unit}</small></dd></div>)}</dl>
              {item.selectable && item.href ? <div className={styles.destinations}><Link href={`${item.href}/admin`} aria-label={`${item.displayName} 관리자 페이지`} className={styles.primary}><Icon name="admin"/>관리자 페이지<Icon name="arrow"/></Link><Link href={item.href} aria-label={`${item.displayName} 학급으로 이동`} className={styles.outline}><Icon name="store"/>매점</Link><Link href={`${item.href}/bank`} aria-label={`${item.displayName} 은행 페이지`} className={styles.outline}><Icon name="bank"/>은행</Link></div>
                : deleted && owner ? <button disabled={!ready} onClick={() => setDialog({ item, action: 'RESTORE' })} className={`${styles.outline} ${styles.full}`}><Icon name="restore"/>학급 복원</button>
                  : item.setupHref ? <Link href={item.setupHref} className={`${styles.primary} ${styles.full}`}>학급 준비 계속<Icon name="arrow"/></Link>
                    : <p className={styles.unavailable}>현재 선택할 수 없습니다.</p>}
              {item.selectable && <div className={styles.secondaryLinks}><Link href={`${item.href}/admin/student-qrs`}>학생 QR 출력</Link><button disabled={!ready} onClick={() => copyAddress(item)}>매점 주소 복사</button></div>}
            </div>{manageable && <div className={styles.cardActions}><button disabled={!ready} aria-label={`${item.displayName} 이름 변경`} onClick={() => setDialog({ item, action: 'RENAME' })}>이름 변경</button>{item.selectable && <button disabled={!ready} aria-label={`${item.displayName} 복제`} onClick={() => setDialog({ item, action: 'DUPLICATE' })}><Icon name="copy"/>복제</button>}<button disabled={!ready} aria-label={`${item.displayName} 삭제`} onClick={() => setDialog({ item, action: 'DELETE' })} className={styles.danger}><Icon name="trash"/>삭제</button></div>}</li>;
          })}</ul>}
        </section>
        <aside className={styles.help}><details><summary>학급 복제와 삭제, 어떻게 동작하나요?</summary><p>복제하면 설정·학생 명단·상품과 재고·과제·할인 행사를 새 학급에 가져옵니다. 학생 잔액은 0으로 시작하고 거래·과제 완료·부여 내역은 가져오지 않습니다. 과제와 할인 행사는 확인 후 켤 수 있도록 비활성 상태로 복제합니다.</p><p>삭제한 학급은 휴지통에 보관되며, 기존 기록을 유지한 채 소유자가 복원할 수 있습니다. 이름 변경·복제·삭제·복원은 학급 소유자만 사용할 수 있습니다.</p></details></aside>
      </>}
      <SiteFooter className={styles.footer}/>
    </div>
    {dialog && <ClassManagementDialog key={`${dialog.item.slug}-${dialog.action}`} item={dialog.item} action={dialog.action} onClose={() => setDialog(null)} onSuccess={message => { setDialog(null); setNotice(message); router.refresh(); }}/> }
    {account ? <LegalAgreementGate notice={account.notice} classNames={memberships.filter((item) => item.roleLabel === '소유자').map((item) => item.displayName)} /> : null}
  </main>;
}
