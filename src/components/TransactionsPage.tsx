'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Transaction } from '@/domain/types';
import { tenantFetch } from '@/lib/tenantApiPath';
import { themeStyles } from './uiTheme';
import {
  Badge, Button, Callout, Card, EmptyState, Icon, IconButton, LoadingOverlay, Modal, SearchInput, SegmentedControl, StatCard,
  buttonClass, cx, type IconName,
} from './ui';

type SettingsResponse = { currencyUnit?: string };
type ApiError = { error?: string };
type CancelTransactionResponse = { cancelledTransaction: Transaction; reversalTransaction: Transaction };
type TransactionFilter = 'all' | 'income' | 'expense';

function formatCurrency(amount: number, unit: string) {
  return `${amount.toLocaleString()}${unit}`;
}

function formatSignedStudentAmount(transaction: Transaction, unit: string) {
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${Math.abs(delta).toLocaleString()}${unit}`;
}

function getTransactionTone(transaction: Transaction) {
  if (transaction.status === 'CANCELLED') return 'cancelled';
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  return delta > 0 ? 'income' : 'expense';
}

function getTransactionAmountTone(transaction: Transaction) {
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  return delta > 0 ? 'income' : 'expense';
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { hour12: false }).replace(/(오전|오후) /, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransaction(value: unknown): value is Transaction {
  if (!isRecord(value)) return false;
  const hasString = (key: string) => typeof value[key] === 'string';
  const hasFiniteNumber = (key: string) => typeof value[key] === 'number'
    && Number.isFinite(value[key]);
  const items = value.items;
  return hasString('transactionId')
    && hasString('timestamp')
    && hasString('studentId')
    && hasString('studentName')
    && Array.isArray(items)
    && items.every((item) => isRecord(item)
      && typeof item.productId === 'string'
      && typeof item.name === 'string'
      && typeof item.price === 'number' && Number.isFinite(item.price)
      && typeof item.quantity === 'number' && Number.isFinite(item.quantity)
      && typeof item.subtotal === 'number' && Number.isFinite(item.subtotal))
    && hasFiniteNumber('totalAmount')
    && hasFiniteNumber('balanceBefore')
    && hasFiniteNumber('balanceAfter')
    && hasString('status')
    && hasString('operator')
    && (!Object.hasOwn(value, 'cancelledAt') || typeof value.cancelledAt === 'string')
    && (!Object.hasOwn(value, 'itemsMalformed') || value.itemsMalformed === true);
}

function isCancelTransactionResponse(
  value: unknown,
  expectedTransactionId: string,
): value is CancelTransactionResponse {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'cancelledTransaction')
    || !Object.hasOwn(value, 'reversalTransaction')
    || !isTransaction(value.cancelledTransaction)
    || !isTransaction(value.reversalTransaction)) return false;
  const { cancelledTransaction, reversalTransaction } = value;
  return cancelledTransaction.transactionId === expectedTransactionId
    && cancelledTransaction.status === 'CANCELLED'
    && reversalTransaction.transactionId !== expectedTransactionId
    && reversalTransaction.status === 'CANCEL_REVERSAL'
    && reversalTransaction.studentId === cancelledTransaction.studentId;
}

export function TransactionsPage({ adminHref = '/admin' }: { adminHref?: string }) {
  return (
    <main style={themeStyles('white').variables} className="min-h-screen bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 lg:py-10">
      <section className="mx-auto flex w-full max-w-[1000px] flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[13px] font-semibold text-[var(--theme-muted-text)]">학급 보상 시스템 · 관리자</p>
            <h1 className="mt-1 text-[28px] font-black tracking-[-0.035em]">거래 내역</h1>
            <p className="mt-1.5 text-sm text-[var(--theme-muted-text)]">학급에 기록된 수입과 지출을 최신순으로 확인합니다.</p>
          </div>
          <Link className={buttonClass({ variant: 'secondary' })} href={adminHref}><Icon name="chevronLeft" size={17} />관리자 화면으로</Link>
        </div>
        <TransactionsPanel />
      </section>
    </main>
  );
}

type TransactionKind = { label: string; icon: IconName; tone: 'income' | 'expense' | 'neutral' };

function describeTransaction(transaction: Transaction): TransactionKind {
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  if (transaction.status === 'CANCEL_REVERSAL') return { label: '취소 반영', icon: 'restore', tone: 'neutral' };
  if (transaction.status === 'TASK_REWARD') return { label: '과제 보상', icon: 'task', tone: 'income' };
  if (transaction.items.length > 0 && delta <= 0) return { label: '매점 구매', icon: 'cart', tone: 'expense' };
  if (delta > 0) return { label: '지급', icon: 'plus', tone: 'income' };
  if (delta < 0) return { label: '회수', icon: 'minus', tone: 'expense' };
  return { label: '기록', icon: 'receipt', tone: 'neutral' };
}

function dayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '날짜 없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function TransactionsPanel({ embedded = false }: { embedded?: boolean; summaryToneClass?: string; summaryAccentClass?: string }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [message, setMessage] = useState('거래 내역을 불러오는 중입니다.');
  const [loading, setLoading] = useState(true);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ transaction: Transaction; opener: HTMLButtonElement } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>('all');
  const [query, setQuery] = useState('');
  const cancellationInFlightRef = useRef(new Set<string>());
  const cancellationOperationIdsRef = useRef(new Map<string, string>());

  const loadTransactions = useCallback(async (options: { shouldApply?: () => boolean } = {}) => {
    const shouldApply = options.shouldApply ?? (() => true);
    const [transactionsResponse, settingsResponse] = await Promise.all([
      tenantFetch('/api/transactions', { cache: 'no-store' }),
      tenantFetch('/api/settings', { cache: 'no-store' }),
    ]);
    const transactionsPayload = (await transactionsResponse.json()) as Transaction[] | ApiError;
    const settingsPayload = (await settingsResponse.json().catch(() => null)) as SettingsResponse | null;

    if (!transactionsResponse.ok || !Array.isArray(transactionsPayload)) {
      throw new Error('error' in transactionsPayload && transactionsPayload.error ? transactionsPayload.error : '거래 내역을 불러오지 못했습니다.');
    }

    if (!shouldApply()) return;
    setTransactions(transactionsPayload);
    if (settingsPayload?.currencyUnit) setCurrencyUnit(settingsPayload.currencyUnit);
    setMessage('');
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;

    void Promise.resolve()
      .then(() => loadTransactions({ shouldApply: () => !ignore }))
      .catch((error) => {
        if (!ignore) { setMessage(error instanceof Error ? error.message : '거래 내역을 불러오지 못했습니다.'); setLoading(false); }
      });

    return () => {
      ignore = true;
    };
  }, [loadTransactions]);

  const filteredTransactions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return transactions.filter((transaction) => (transactionFilter === 'all' || getTransactionAmountTone(transaction) === transactionFilter)
      && (!needle || `${transaction.studentName} ${transaction.studentId} ${transaction.items.map((item) => item.name).join(' ')}`.toLowerCase().includes(needle)));
  }, [transactions, transactionFilter, query]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const transaction of transactions) {
      if (transaction.status === 'CANCELLED' || transaction.status === 'CANCEL_REVERSAL') continue;
      const delta = transaction.balanceAfter - transaction.balanceBefore;
      if (delta > 0) income += delta; else expense -= delta;
    }
    return { income, expense };
  }, [transactions]);

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const transaction of filteredTransactions) {
      const key = dayKey(transaction.timestamp);
      map.set(key, [...(map.get(key) ?? []), transaction]);
    }
    return Array.from(map.entries());
  }, [filteredTransactions]);

  async function refreshTransactions() {
    setIsRefreshing(true);
    setMessage('');
    try {
      await loadTransactions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '거래 내역을 불러오지 못했습니다.');
    } finally {
      setIsRefreshing(false);
    }
  }

  async function cancelTransaction(transaction: Transaction) {
    if (transaction.status === 'CANCELLED'
      || cancellationInFlightRef.current.size > 0) return;
    setConfirmation(null);
    cancellationInFlightRef.current.add(transaction.transactionId);
    const operationId = cancellationOperationIdsRef.current.get(transaction.transactionId)
      ?? crypto.randomUUID();
    cancellationOperationIdsRef.current.set(transaction.transactionId, operationId);
    setCancelingId(transaction.transactionId);
    setMessage('');
    try {
      const response = await tenantFetch(`/api/transactions/${encodeURIComponent(transaction.transactionId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId }),
      });
      const payload = (await response.json()) as CancelTransactionResponse | ApiError;
      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload && payload.error ? payload.error : '거래를 취소하지 못했습니다.');
      }
      if (!isCancelTransactionResponse(payload, transaction.transactionId)) {
        throw new Error('거래를 취소하지 못했습니다.');
      }
      const { cancelledTransaction, reversalTransaction } = payload;
      setTransactions((current) => {
        const updated = current.map((item) => item.transactionId === transaction.transactionId ? cancelledTransaction : item);
        return [reversalTransaction, ...updated];
      });
      cancellationOperationIdsRef.current.delete(transaction.transactionId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '거래를 취소하지 못했습니다.');
    } finally {
      cancellationInFlightRef.current.delete(transaction.transactionId);
      setCancelingId(null);
    }
  }

  return (
    <div className={cx('grid gap-5', embedded && 'pb-6')}>
      <section inert={confirmation !== null} aria-hidden={confirmation ? true : undefined} aria-label="거래 내역 목록" className="grid gap-5">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="수입" value={<span className="text-[var(--crs-success-text)]">+{formatCurrency(totals.income, currencyUnit)}</span>} hint="취소된 거래 제외" />
          <StatCard label="지출" value={<span className="text-[var(--crs-danger-text)]">-{formatCurrency(totals.expense, currencyUnit)}</span>} hint="취소된 거래 제외" />
          <StatCard label="거래 수" value={`${transactions.length.toLocaleString('ko-KR')}건`} hint={filteredTransactions.length !== transactions.length ? `표시 ${filteredTransactions.length}건` : '전체'} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={query} onChange={setQuery} placeholder="학생 이름 또는 상품 검색" ariaLabel="거래 검색" className="w-full sm:w-72" />
          <TransactionFilterTabs value={transactionFilter} onChange={setTransactionFilter} />
          <IconButton icon="refresh" label="거래 내역 새로고침" variant="secondary" onClick={refreshTransactions} className="ml-auto" />
        </div>

        {message ? <Callout tone={loading ? 'neutral' : 'warning'}>{message}</Callout> : null}

        {filteredTransactions.length === 0 && !message ? (
          <EmptyState icon="receipt" title={transactions.length ? '조건에 맞는 거래가 없습니다' : '아직 거래가 없습니다'}
            description={transactions.length ? '검색어나 필터를 바꿔 보세요.' : '학생이 매점에서 사거나 과제 보상을 받으면 여기에 기록됩니다.'} />
        ) : null}

        {groups.map(([day, rows]) => (
          <div key={day}>
            <h3 className="mb-2 px-1 text-[13px] font-bold text-[var(--theme-muted-text)]">{day}</h3>
            <Card padded={false} className="divide-y divide-[var(--crs-line)] overflow-hidden">
              {rows.map((transaction) => {
                const tone = getTransactionTone(transaction);
                const amountTone = getTransactionAmountTone(transaction);
                const isCancelled = tone === 'cancelled';
                const canCancel = !isCancelled && transaction.status !== 'CANCEL_REVERSAL';
                const kind = describeTransaction(transaction);
                const itemsText = transaction.items.map((item) => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`).join(', ');
                return (
                  <article data-testid={`transaction-row-${transaction.transactionId}`} key={transaction.transactionId}
                    className={cx('flex items-center gap-3.5 px-4 py-3.5 sm:px-5', isCancelled && 'opacity-60')}>
                    <span aria-hidden="true" className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]',
                      kind.tone === 'income' ? 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]' : kind.tone === 'expense' ? 'bg-[var(--crs-subtle-hover)] text-[var(--theme-text)]' : 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]')}>
                      <Icon name={kind.icon} size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <strong className="text-[15px] font-bold">{transaction.studentName}</strong>
                        <span className="text-xs font-semibold text-[var(--theme-muted-text)]">{kind.label}</span>
                        {isCancelled ? <span data-testid={`transaction-cancelled-label-${transaction.transactionId}`}><Badge>취소됨</Badge></span> : null}
                      </p>
                      <p className="mt-0.5 truncate text-[13px] text-[var(--theme-muted-text)]">
                        {timeLabel(transaction.timestamp)}{itemsText ? ` · ${itemsText}` : ''}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[color-mix(in_srgb,var(--theme-muted-text)_75%,transparent)]" title={`${transaction.transactionId} · ${transaction.status} · ${transaction.operator}`}>
                        잔액 {formatCurrency(transaction.balanceBefore, currencyUnit)} → {formatCurrency(transaction.balanceAfter, currencyUnit)}
                        {transaction.cancelledAt ? ` · 취소 일시: ${formatTimestamp(transaction.cancelledAt)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <p data-testid={`transaction-amount-${transaction.transactionId}`}
                        className={cx('text-[17px] font-black tabular-nums', amountTone === 'income' ? 'text-[var(--crs-success-text)]' : 'text-[var(--theme-text)]', isCancelled && 'line-through')}>
                        {formatSignedStudentAmount(transaction, currencyUnit)}
                      </p>
                      {canCancel ? (
                        <Button size="sm" variant="ghost"
                          aria-label={`${transaction.transactionId} 거래 취소`}
                          disabled={cancelingId !== null || confirmation !== null}
                          onClick={(event) => {
                            if (!confirmation && cancellationInFlightRef.current.size === 0) {
                              setConfirmation({ transaction, opener: event.currentTarget });
                            }
                          }}
                        >
                          {cancelingId === transaction.transactionId ? '취소 중' : '거래 취소'}
                        </Button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </Card>
          </div>
        ))}
      </section>
      {confirmation ? <TransactionCancelDialog transaction={confirmation.transaction} currencyUnit={currencyUnit}
        opener={confirmation.opener} onClose={() => setConfirmation(null)}
        onConfirm={() => void cancelTransaction(confirmation.transaction)} /> : null}
      {cancelingId ? <LoadingOverlay title="거래 취소 중" message="거래를 취소하는 중입니다." /> : null}
      {isRefreshing ? <LoadingOverlay title="새로고침 중" message="최신 거래 내역을 불러오는 중입니다." /> : null}
    </div>
  );
}

function TransactionCancelDialog({ transaction, currencyUnit, opener, onClose, onConfirm }: {
  transaction: Transaction; currencyUnit: string; opener: HTMLButtonElement;
  onClose: () => void; onConfirm: () => void;
}) {
  const detail = transaction.status === 'TASK_REWARD'
    ? '지급한 보상만큼 현재 잔액에서 회수하고, 이 과제 완료도 취소합니다. 초기화 후 새로 완료한 기록은 그대로 둡니다.'
    : '이 거래를 되돌리는 반대 거래를 현재 잔액에 적용합니다.';
  return (
    <Modal size="sm" tone="danger" title="거래를 취소할까요?" ariaLabel="거래 취소 확인" opener={opener} onClose={onClose}
      footer={<>
        <Button variant="ghost" data-autofocus onClick={onClose}>돌아가기</Button>
        <Button variant="danger" onClick={onConfirm}>거래 취소 확정</Button>
      </>}>
      <div className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-3">
        <p className="text-sm font-bold">{transaction.studentName} · {formatSignedStudentAmount(transaction, currencyUnit)}</p>
        <p className="mt-0.5 break-all text-[11px] text-[var(--theme-muted-text)]">{transaction.transactionId}</p>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{detail}</p>
      {transaction.balanceAfter > transaction.balanceBefore ? (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--crs-warning-text)]">회수할 금액이 현재 잔액보다 크면 잔액이 음수가 될 수 있습니다.</p>
      ) : null}
    </Modal>
  );
}

function TransactionFilterTabs({ value, onChange }: { value: TransactionFilter; onChange: (value: TransactionFilter) => void }) {
  return (
    <SegmentedControl ariaLabel="거래 필터" value={value} onChange={onChange}
      options={[{ value: 'all', label: '전체' }, { value: 'income', label: '수입' }, { value: 'expense', label: '지출' }]} />
  );
}
