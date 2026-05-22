'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Transaction } from '@/domain/types';

type SettingsResponse = { currencyUnit?: string };
type ApiError = { error?: string };

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

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { hour12: false });
}

export function TransactionsPage() {
  return (
    <main className="min-h-screen bg-[#dbeaf6] p-3 text-slate-950 sm:p-4 md:p-6">
      <section className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
        <header className="rounded-[1.75rem] border border-slate-300/70 bg-white px-5 py-5 text-center shadow-sm md:px-7">
          <p className="text-sm font-black tracking-[0.24em] text-sky-600">Class Reward System Admin</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight md:text-5xl">거래 내역 확인</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-bold text-slate-500 md:text-base">Transactions 시트에 기록된 수입과 지출을 최신순으로 확인합니다.</p>
          <Link className="mt-5 inline-flex rounded-2xl bg-slate-950 px-5 py-3 font-black text-white" href="/admin">관리자 센터로 돌아가기</Link>
        </header>
        <TransactionsPanel />
      </section>
    </main>
  );
}

export function TransactionsPanel({ embedded = false }: { embedded?: boolean }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [message, setMessage] = useState('거래 내역을 불러오는 중입니다.');
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    async function load() {
      const [transactionsResponse, settingsResponse] = await Promise.all([
        fetch('/api/transactions', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const transactionsPayload = (await transactionsResponse.json()) as Transaction[] | ApiError;
      const settingsPayload = (await settingsResponse.json().catch(() => null)) as SettingsResponse | null;

      if (!transactionsResponse.ok || !Array.isArray(transactionsPayload)) {
        throw new Error('error' in transactionsPayload && transactionsPayload.error ? transactionsPayload.error : '거래 내역을 불러오지 못했습니다.');
      }

      if (ignore) return;
      setTransactions(transactionsPayload);
      if (settingsPayload?.currencyUnit) setCurrencyUnit(settingsPayload.currencyUnit);
      setMessage('');
    }

    load().catch((error) => {
      if (!ignore) setMessage(error instanceof Error ? error.message : '거래 내역을 불러오지 못했습니다.');
    });

    return () => {
      ignore = true;
    };
  }, []);

  const netExpense = useMemo(() => transactions.filter((transaction) => transaction.status !== 'CANCELLED').reduce((sum, transaction) => sum + transaction.totalAmount, 0), [transactions]);

  async function cancelTransaction(transaction: Transaction) {
    if (transaction.status === 'CANCELLED') return;
    if (!window.confirm(`${transaction.studentName} 학생의 ${formatSignedStudentAmount(transaction, currencyUnit)} 거래를 취소하고 이전 잔액으로 되돌릴까요?`)) return;

    setCancelingId(transaction.transactionId);
    setMessage('');
    try {
      const response = await fetch(`/api/transactions/${encodeURIComponent(transaction.transactionId)}/cancel`, { method: 'POST' });
      const payload = (await response.json()) as Transaction | ApiError;
      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload && payload.error ? payload.error : '거래를 취소하지 못했습니다.');
      }
      const cancelledTransaction = payload as Transaction;
      setTransactions((current) => current.map((item) => item.transactionId === transaction.transactionId ? cancelledTransaction : item));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '거래를 취소하지 못했습니다.');
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div className={embedded ? 'grid gap-4' : 'grid gap-4'}>
      <div className="grid gap-2 sm:grid-cols-3">
        <SummaryCard label="거래 건수" value={`${transactions.length}건`} />
        <SummaryCard label="순 지출"      value={formatCurrency(netExpense, currencyUnit)}/>
        <SummaryCard label="화폐 단위" value={currencyUnit} />
      </div>

      {message ? <p className="rounded-2xl bg-white p-4 font-bold text-slate-700 shadow-sm">{message}</p> : null}

      <section className="rounded-[1.75rem] border border-slate-300/70 bg-white/90 p-4 shadow-sm md:p-5">
        <h2 className="text-2xl font-black">최근 거래</h2>
        <div className="mt-4 grid gap-3">
          {transactions.length === 0 && !message ? <p className="rounded-2xl bg-sky-50 p-5 font-bold text-slate-600">아직 거래 내역이 없습니다.</p> : null}
          {transactions.map((transaction) => {
            const tone = getTransactionTone(transaction);
            const isCancelled = tone === 'cancelled';
            const canCancel = !isCancelled;
            const rowClass = isCancelled
              ? 'border-slate-300 bg-slate-100 opacity-80'
              : tone === 'income'
                ? 'border-rose-200 bg-rose-50'
                : 'border-sky-200 bg-sky-50';
            const amountClass = isCancelled
              ? 'text-slate-500 line-through'
              : tone === 'income'
                ? 'text-rose-700'
                : 'text-sky-700';
            return (
              <article data-testid={`transaction-row-${transaction.transactionId}`} className={`rounded-3xl border p-4 ${rowClass}`} key={transaction.transactionId}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-lg font-black">{transaction.studentName}</strong>
                      {isCancelled ? <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-black text-slate-600">취소됨</span> : null}
                    </div>
                    <p className="text-sm font-bold text-slate-500">{transaction.studentId} · {formatTimestamp(transaction.timestamp)}</p>
                    <p className="text-xs font-bold text-slate-400">{transaction.transactionId} · {transaction.status} · {transaction.operator}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <p className={`text-2xl font-black ${amountClass}`}>{formatSignedStudentAmount(transaction, currencyUnit)}</p>
                    {canCancel ? (
                      <button
                        aria-label={`${transaction.transactionId} 거래 취소`}
                        className="rounded-xl bg-slate-700 px-3 py-2 text-xs font-black text-white disabled:bg-slate-300"
                        disabled={cancelingId === transaction.transactionId}
                        onClick={() => cancelTransaction(transaction)}
                        type="button"
                      >
                        {cancelingId === transaction.transactionId ? '취소 중' : '거래 취소'}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-sm font-bold text-slate-600">
                  {transaction.items.map((item) => (
                    <span className="rounded-full bg-white px-3 py-1" key={`${transaction.transactionId}-${item.productId}`}>{item.name} × {item.quantity}</span>
                  ))}
                </div>
                <div className="mt-3 grid gap-2 text-sm font-bold text-slate-600 sm:grid-cols-2">
                  <p>거래 전 잔액: {formatCurrency(transaction.balanceBefore, currencyUnit)}</p>
                  <p>거래 후 잔액: {formatCurrency(transaction.balanceAfter, currencyUnit)}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-sky-50 px-4 py-3 text-left">
      <p className="text-xs font-black text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-sky-700">{value}</p>
    </div>
  );
}
