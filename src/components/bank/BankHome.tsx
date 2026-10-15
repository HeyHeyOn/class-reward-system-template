'use client';

import { forwardRef, type ReactNode } from 'react';
import styles from '../classroom.module.css';
import { Button, Icon, IconButton } from '../ui';
import { formatMoney } from './format';

type BankHomeProps = Readonly<{
  title: string;
  name: string;
  balance: number;
  currencyUnit: string;
  refreshing: boolean;
  loggingOut: boolean;
  onOpenHistory: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  children: ReactNode;
}>;

/** Personal banking home: who is logged in, the balance (opens the history) and '내 과제' below. */
export const BankHome = forwardRef<HTMLHeadingElement, BankHomeProps>(function BankHome(
  { title, name, balance, currencyUnit, refreshing, loggingOut, onOpenHistory, onRefresh, onLogout, children }, headingRef,
) {
  return (
    <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className={`${styles.bankHeader} flex items-center gap-2.5`}>
        <h1 className="min-w-0 flex-1 truncate text-[clamp(1.2rem,4.8vw,1.5rem)] font-black tracking-[-0.035em]">{title}</h1>
        <IconButton icon="refresh" label="잔액과 과제 새로고침" onClick={onRefresh} disabled={refreshing} />
        <Button variant="secondary" size="sm" icon="logout" onClick={onLogout} disabled={loggingOut} loading={loggingOut}>로그아웃</Button>
      </header>

      <p ref={headingRef} tabIndex={-1} className="mt-5 text-[17px] font-extrabold tracking-[-0.02em] outline-none">
        {name}님, 안녕하세요!
      </p>

      <button type="button" onClick={onOpenHistory} aria-label={`내 잔액 ${formatMoney(balance, currencyUnit)}, 거래 내역 보기`}
        className="mt-3 block w-full rounded-[26px] bg-[var(--theme-accent-solid)] p-5 text-left text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow)] transition-[transform,background-color] duration-150 hover:bg-[var(--theme-hover)] hover:text-[var(--theme-hover-text)] active:scale-[0.99] sm:p-6">
        <span className="flex items-center justify-between gap-3 text-[14px] font-bold opacity-85">
          <span className="flex items-center gap-1.5"><Icon name="wallet" size={18} />내 잔액</span>
          <span className="flex items-center gap-0.5 text-[13px]">거래 내역<Icon name="chevronRight" size={16} /></span>
        </span>
        <span data-testid="bank-balance" className="mt-3 block break-all text-[clamp(2.4rem,12vw,3.5rem)] font-black leading-none tabular-nums tracking-[-0.045em]">
          {balance.toLocaleString('ko-KR')}<span className="ml-1 text-[0.5em] tracking-normal">{currencyUnit}</span>
        </span>
        <span className="mt-3 block text-[13px] font-semibold opacity-80">눌러서 들어오고 나간 돈을 확인해요</span>
      </button>

      {children}
    </div>
  );
});

/** The '내 과제' menu on the home screen: a short summary that opens the task list. */
export function BankTasksMenu({ completable, waiting, completed, loading, attention, onOpen }: Readonly<{
  completable: number; waiting: number; completed: number; loading: boolean; attention: boolean; onOpen: () => void;
}>) {
  const summary = loading ? '과제를 불러오는 중이에요' : `완료 가능 ${completable}개, 미완료 ${waiting}개, 완료 ${completed}개`;
  return (
    <button type="button" onClick={onOpen} aria-label={`내 과제, ${summary}`}
      className="mt-4 flex w-full items-center gap-4 rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-5 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,background-color] duration-150 hover:bg-[var(--crs-subtle-hover)] active:scale-[0.99]">
      <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]">
        <Icon name="task" size={24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] font-black tracking-[-0.02em]">내 과제</span>
        <span className="mt-0.5 block text-[13px] font-semibold text-[var(--theme-muted-text)]">{summary}</span>
        {attention ? <span className="mt-1.5 block text-[13px] font-bold text-[var(--crs-warning-text)]">확인 중인 과제 완료가 있어요. 눌러서 확인해 주세요.</span>
          : !loading && completable > 0 ? <span className="mt-1.5 block text-[13px] font-bold text-[var(--theme-accent-text)]">지금 완료하고 보상을 받을 수 있는 과제가 {completable}개 있어요!</span> : null}
      </span>
      <Icon name="chevronRight" size={20} className="shrink-0 text-[var(--theme-muted-text)]" />
    </button>
  );
}
