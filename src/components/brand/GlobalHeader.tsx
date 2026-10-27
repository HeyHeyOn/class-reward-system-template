'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { BANK_READY, BANK_URL, BOARD_URL, CLASS_HOME, HUB_READY, HUB_URL, TOOLS_READY, TOOLS_URL } from '@/lib/brand';
import type { TeacherVerification } from '@/lib/teacherVerification';
import { DdanssaemLockup } from './DdanssaemLogo';
import { VerificationReminder } from './VerificationReminder';
import styles from './GlobalHeader.module.css';

// Until the ddanssaem.com hub opens (HUB_READY), the logo goes to this app's first screen and the menu
// holds only the features that exist (클래스, 보드; with the hub also 홈 and 문제 은행). 수업 도구 stays hidden until the
// first tool exists.
const LOGO_HREF = HUB_READY ? HUB_URL : CLASS_HOME;
const MENU = [
  ...(HUB_READY ? [{ key: 'home', label: '홈', href: HUB_URL }] : []),
  { key: 'class', label: '클래스', href: CLASS_HOME },
  { key: 'board', label: '보드', href: BOARD_URL },
  ...(HUB_READY && BANK_READY ? [{ key: 'bank', label: '문제 은행', href: BANK_URL }] : []),
  ...(HUB_READY && TOOLS_READY ? [{ key: 'tools', label: '수업 도구', href: TOOLS_URL }] : []),
];

/** The signed-in teacher: the 딴쌤 account's name, e-mail and icon picture (account-protocol 9-2), and where the account
 *  is managed (the hub's '내 계정'; without the hub, the class's own profile page). */
export type HeaderAccount = Readonly<{ nickname: string; email?: string; avatarUrl?: string | null; accountUrl?: string;
  /** 교사 인증 (account-protocol 10): the hub's verification box, and the teacher's verification for the reminder. */
  verifyUrl?: string; verification?: TeacherVerification }>;

type TeacherProps = Readonly<{
  audience: 'teacher';
  /** The signed-in teacher, or null when nobody is signed in (then `loginHref` gives the 로그인 button). */
  account: HeaderAccount | null;
  loginHref?: string;
}>;
type StudentProps = Readonly<{
  audience: 'student';
  /** The class (or board) the student is in, in place of the feature name. */
  place: string;
  studentName?: string | null;
}>;

/** '[이름] 선생님', unless the shown name already ends in 쌤 or 선생님 (별빛쌤, 김 선생님). */
export function teacherLabel(nickname: string): string {
  return /(?:쌤|선생님)$/.test(nickname.trim()) ? nickname.trim() : `${nickname.trim()} 선생님`;
}

function Logo({ linked }: Readonly<{ linked: boolean }>) {
  const lockups = <>
    <span className={styles.logoWide}><DdanssaemLockup markSize={30} /></span>
    <span className={styles.logoCompact}><DdanssaemLockup markSize={26} /></span>
  </>;
  return linked
    ? <a href={LOGO_HREF} aria-label="딴쌤 홈" className={styles.home}>{lockups}</a>
    : <span role="img" aria-label="딴쌤" className={styles.home}>{lockups}</span>;
}

/** Closes a disclosure on a click outside it or on Escape (focus returns to its button). */
function useDisclosure() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, rootRef, buttonRef };
}

function AccountMenu({ account }: Readonly<{ account: HeaderAccount }>) {
  const { open, setOpen, rootRef, buttonRef } = useDisclosure();
  const id = useId();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = teacherLabel(account.nickname);
  const initial = Array.from(account.nickname.trim())[0] ?? '선';

  async function logout() {
    if (leaving) return;
    setLeaving(true); setFailed(false);
    try {
      const response = await fetch('/api/google/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error();
      // With the 딴쌤 hub the reply names the hub's logout, which comes back to the class list.
      const reply: unknown = await response.json().catch(() => null);
      window.location.replace(reply && typeof reply === 'object' && 'next' in reply && typeof reply.next === 'string' ? reply.next : CLASS_HOME);
    } catch {
      setLeaving(false); setFailed(true);
    }
  }

  return (
    <div ref={rootRef} className={styles.account}>
      <button ref={buttonRef} type="button" aria-label="계정 메뉴" aria-expanded={open} aria-controls={id}
        className={styles.accountButton} onClick={() => setOpen(!open)}>
        <span aria-hidden="true" className={styles.avatar}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the hub's fixed SVG, drawn as given (9-2) */}
          {account.avatarUrl ? <img src={account.avatarUrl} alt="" width={34} height={34} className={styles.avatarImage} /> : initial}
        </span>
        <span className={`${styles.accountName} ${styles.wideOnly}`}>{label}</span>
        <svg className={styles.wideOnly} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open ? (
        <div id={id} className={styles.popover}>
          <div className={styles.popoverWho}>
            <p className={styles.popoverName}>{label}</p>
            {account.email ? <p className={styles.popoverEmail}>{account.email}</p> : null}
          </div>
          {account.accountUrl
            ? <a href={account.accountUrl} className={styles.popoverItem}>딴쌤 계정</a>
            : <a href="/profile" className={styles.popoverItem}>내 프로필</a>}
          <button type="button" className={styles.popoverItem} disabled={leaving} onClick={() => void logout()}>
            {leaving ? '로그아웃 중…' : '로그아웃'}
          </button>
          {failed ? <p role="alert" className={styles.popoverNote}>로그아웃하지 못했어요. 다시 눌러 주세요.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PhoneMenu() {
  const { open, setOpen, rootRef, buttonRef } = useDisclosure();
  const id = useId();
  return (
    <div ref={rootRef} className={styles.account}>
      <button ref={buttonRef} type="button" aria-label="메뉴" aria-expanded={open} aria-controls={id}
        className={styles.menuButton} onClick={() => setOpen(!open)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      {open ? (
        <nav id={id} aria-label="딴쌤 메뉴" className={styles.popover}>
          {MENU.map((item) => (
            <a key={item.key} href={item.href} aria-current={item.key === 'class' ? 'page' : undefined} className={styles.popoverItem}>{item.label}</a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

/** The header on top of every 딴쌤 screen: `딴쌤 / 클래스` with the menu and the account for teachers,
 *  `딴쌤 / [학급 이름]` with the student's name for students. */
export function GlobalHeader(props: TeacherProps | StudentProps) {
  if (props.audience === 'student') {
    return (
      <header className={styles.header} data-global-header="student">
        <div className={styles.bar}>
          <div className={styles.left}>
            <Logo linked={false} />
            {props.place ? <><span aria-hidden="true" className={styles.slash}>/</span><span className={styles.section}>{props.place}</span></> : null}
          </div>
          {props.studentName ? (
            <span className={styles.student}>
              <span aria-hidden="true" className={styles.studentIcon}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>
              </span>
              <span className={styles.studentName}>{props.studentName}</span>
            </span>
          ) : null}
        </div>
      </header>
    );
  }

  return (
    <header className={styles.header} data-global-header="teacher">
      <div className={styles.bar}>
        <div className={styles.left}>
          <Logo linked />
          <span aria-hidden="true" className={styles.slash}>/</span>
          <a href={CLASS_HOME} data-tour="header-class" className={styles.section}>클래스</a>
        </div>
        <nav aria-label="딴쌤 메뉴" className={styles.nav}>
          {MENU.map((item) => (
            <a key={item.key} href={item.href} aria-current={item.key === 'class' ? 'page' : undefined} className={styles.navLink}>{item.label}</a>
          ))}
        </nav>
        <div className={styles.right}>
          {props.account ? <AccountMenu account={props.account} />
            : props.loginHref ? <a href={props.loginHref} className={styles.login}>로그인</a> : null}
          {props.account?.verification && props.account.verifyUrl
            ? <VerificationReminder verification={props.account.verification} verifyUrl={props.account.verifyUrl} /> : null}
          <PhoneMenu />
        </div>
      </div>
    </header>
  );
}

