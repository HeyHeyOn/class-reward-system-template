'use client';

import { forwardRef, useMemo, useState } from 'react';
import { Badge, Button, Callout, EmptyState, Icon, IconButton, SegmentedControl, Spinner, cx, type IconName } from '../ui';
import type { StudentBankTransactionDto, StudentBankTransactionKind } from './bankClient';
import { formatMoney, formatSeoulDay, formatSeoulDateTime, formatSeoulTime, formatSignedMoney, seoulDayKey } from './format';

type Filter = 'all' | 'in' | 'out';

const KIND_LABELS: Record<StudentBankTransactionKind, { label: string; icon: IconName }> = {
  PURCHASE: { label: '매점 구매', icon: 'cart' },
  TASK_REWARD: { label: '과제 보상', icon: 'task' },
  TEACHER_GRANT: { label: '선생님 지급', icon: 'gift' },
  TEACHER_DEDUCT: { label: '선생님 회수', icon: 'minus' },
  CANCELLATION: { label: '거래 취소', icon: 'restore' },
  DEPOSIT: { label: '입금', icon: 'plus' },
  WITHDRAWAL: { label: '출금', icon: 'minus' },
  TREE_WATER: { label: '학급 나무 양분 주기', icon: 'sprout' },
  TREE_HARVEST: { label: '학급 나무 수확 보상', icon: 'sprout' },
  PET_FEED: { label: '펫 먹이 주기', icon: 'paw' },
  PET_DECOR: { label: '펫 꾸미기 구매', icon: 'paw' },
  PET_GRADUATE: { label: '펫 졸업 보상', icon: 'paw' },
};

export function transactionLabel(kind: StudentBankTransactionKind): string {
  return KIND_LABELS[kind].label;
}

type BankHistoryProps = Readonly<{
  name: string;
  balance: number;
  currencyUnit: string;
  transactions: StudentBankTransactionDto[] | null;
  limit: number;
  loading: boolean;
  error: string;
  onBack: () => void;
  onRetry: () => void;
}>;

/** Detailed personal transaction history, newest first, grouped by day (Asia/Seoul). */
export const BankHistory = forwardRef<HTMLHeadingElement, BankHistoryProps>(function BankHistory(
  { name, balance, currencyUnit, transactions, limit, loading, error, onBack, onRetry }, headingRef,
) {
  const [filter, setFilter] = useState<Filter>('all');
  const visible = useMemo(() => (transactions ?? []).filter((transaction) => filter === 'all'
    || (filter === 'in' ? transaction.amount > 0 : transaction.amount < 0)), [filter, transactions]);
  const groups = useMemo(() => {
    const byDay: Array<{ key: string; label: string; items: StudentBankTransactionDto[] }> = [];
    for (const transaction of visible) {
      const key = seoulDayKey(transaction.occurredAt);
      const last = byDay.at(-1);
      if (last?.key === key) last.items.push(transaction);
      else byDay.push({ key, label: formatSeoulDay(transaction.occurredAt), items: [transaction] });
    }
    return byDay;
  }, [visible]);

  return (
    <div className="pb-[max(2rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2">
        <IconButton icon="chevronLeft" label="홈으로 돌아가기" onClick={onBack} className="-ml-2" size="lg" />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[22px] font-black tracking-[-0.03em] outline-none">거래 내역</h2>
      </header>

      <div className="mt-3 rounded-[20px] bg-[var(--theme-accent-solid)] px-5 py-4 text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow-sm)]">
        <p className="text-[13px] font-bold opacity-80">{name}님의 지금 잔액</p>
        <p data-testid="bank-history-balance" className="mt-0.5 text-[30px] font-black leading-tight tabular-nums tracking-[-0.035em]">{formatMoney(balance, currencyUnit)}</p>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl ariaLabel="거래 필터" value={filter} onChange={setFilter} options={[
          { value: 'all', label: '전체' }, { value: 'in', label: '들어온 돈' }, { value: 'out', label: '나간 돈' },
        ]} />
        {loading && transactions ? <span role="status" className="flex items-center gap-1.5 text-xs font-semibold text-[var(--theme-muted-text)]"><Spinner size={14} />새로 불러오는 중</span> : null}
      </div>

      {transactions === null && loading ? (
        <p role="status" className="mt-4 flex items-center gap-2 rounded-[var(--crs-radius)] bg-[var(--theme-surface)] px-4 py-5 text-sm font-semibold text-[var(--theme-muted-text)]">
          <Spinner size={18} />거래 내역을 불러오는 중이에요.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4">
          <Callout tone="danger" title="거래 내역을 불러오지 못했어요">
            <p>{error}</p>
            <Button variant="secondary" size="sm" icon="refresh" className="mt-2" onClick={onRetry} disabled={loading}>다시 불러오기</Button>
          </Callout>
        </div>
      ) : null}

      {transactions && !visible.length ? (
        <div className="mt-4">
          <EmptyState icon="receipt" title={transactions.length ? '이 조건에 맞는 거래가 없어요' : '아직 거래 내역이 없어요'}
            description={transactions.length ? '다른 필터를 눌러 보세요.' : '매점에서 사거나 과제 보상을 받으면 여기에 보여요.'} />
        </div>
      ) : null}

      {groups.length ? (
        <ol aria-label="거래 목록" className="mt-4 space-y-5">
          {groups.map((group) => (
            <li key={group.key}>
              <h3 className="px-1 text-[13px] font-extrabold text-[var(--theme-muted-text)]">{group.label}</h3>
              <ul className="mt-2 divide-y divide-[var(--crs-line)] overflow-hidden rounded-[18px] border border-[var(--crs-line)] bg-[var(--theme-surface)] shadow-[var(--crs-shadow-sm)]">
                {group.items.map((transaction) => <TransactionRow key={transaction.transactionId} transaction={transaction} currencyUnit={currencyUnit} />)}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}

      {transactions && transactions.length >= limit ? (
        <p className="mt-4 text-center text-xs font-semibold text-[var(--theme-muted-text)]">최근 {limit}건까지 보여 줘요.</p>
      ) : null}
    </div>
  );
});

function TransactionRow({ transaction, currencyUnit }: { transaction: StudentBankTransactionDto; currencyUnit: string }) {
  const { label, icon } = KIND_LABELS[transaction.kind];
  const income = transaction.amount > 0;
  return (
    <li data-testid={`bank-transaction-${transaction.transactionId}`} className={cx('flex items-center gap-3 px-4 py-3.5', transaction.cancelled && 'opacity-70')}>
      <span aria-hidden="true" className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
        income ? 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]' : 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]')}>
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[15px] font-bold">
          <span>{label}</span>
          {transaction.cancelled ? <Badge tone="neutral">취소됨</Badge> : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-[var(--theme-muted-text)]">
          <time dateTime={transaction.occurredAt}>{formatSeoulTime(transaction.occurredAt)}</time>
          {transaction.detail ? ` · ${transaction.detail}` : ''}
          {transaction.cancelled && transaction.cancelledAt ? ` · ${formatSeoulDateTime(transaction.cancelledAt)} 취소` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p data-testid={`bank-transaction-amount-${transaction.transactionId}`}
          className={cx('text-[16px] font-black tabular-nums', income ? 'text-[var(--crs-success-text)]' : 'text-[var(--theme-text)]', transaction.cancelled && 'line-through')}>
          {formatSignedMoney(transaction.amount, currencyUnit)}
        </p>
        <p className="mt-0.5 text-[11.5px] font-semibold tabular-nums text-[var(--theme-muted-text)]">잔액 {formatMoney(transaction.balanceAfter, currencyUnit)}</p>
      </div>
    </li>
  );
}
