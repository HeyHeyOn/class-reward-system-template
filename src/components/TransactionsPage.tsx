'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Transaction } from '@/domain/types';

type SettingsResponse = { currencyUnit?: string };

type ApiError = { error?: string };

function formatCurrency(amount: number, unit: string) {
  return `${amount.toLocaleString()}${unit}`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { hour12: false });
}

export function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [message, setMessage] = useState('결제 내역을 불러오는 중입니다.');

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
        throw new Error('error' in transactionsPayload && transactionsPayload.error ? transactionsPayload.error : '결제 내역을 불러오지 못했습니다.');
      }

      if (ignore) return;
      setTransactions(transactionsPayload);
      if (settingsPayload?.currencyUnit) setCurrencyUnit(settingsPayload.currencyUnit);
      setMessage('');
    }

    load().catch((error) => {
      if (!ignore) setMessage(error instanceof Error ? error.message : '결제 내역을 불러오지 못했습니다.');
    });

    return () => {
      ignore = true;
    };
  }, []);

  const totalSales = useMemo(() => transactions.reduce((sum, transaction) => sum + transaction.totalAmount, 0), [transactions]);

  return (
    <main className="min-h-screen bg-[#dbeaf6] p-3 text-slate-950 sm:p-4 md:p-6">
      <section className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
        <header className="rounded-[1.75rem] border border-slate-300/70 bg-white px-5 py-5 text-center shadow-sm md:px-7">
          <p className="text-sm font-black tracking-[0.24em] text-sky-600">CLASS STORE ADMIN</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight md:text-5xl">결제 내역 확인</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-bold text-slate-500 md:text-base">Transactions 시트에 기록된 결제 기록을 최신순으로 확인합니다.</p>
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            <SummaryCard label="결제 건수" value={`${transactions.length}건`} />
            <SummaryCard label="총 매출" value={formatCurrency(totalSales, currencyUnit)} />
            <SummaryCard label="화폐 단위" value={currencyUnit} />
          </div>
          <Link className="mt-5 inline-flex rounded-2xl bg-slate-950 px-5 py-3 font-black text-white" href="/admin">관리자 센터로 돌아가기</Link>
        </header>

        {message ? <p className="rounded-2xl bg-white p-4 font-bold text-slate-700 shadow-sm">{message}</p> : null}

        <section className="rounded-[1.75rem] border border-slate-300/70 bg-white/90 p-4 shadow-sm md:p-5">
          <h2 className="text-2xl font-black">최근 결제</h2>
          <div className="mt-4 grid gap-3">
            {transactions.length === 0 && !message ? <p className="rounded-2xl bg-sky-50 p-5 font-bold text-slate-600">아직 결제 내역이 없습니다.</p> : null}
            {transactions.map((transaction) => (
              <article className="rounded-3xl border border-slate-200 bg-sky-50/60 p-4" key={transaction.transactionId}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <strong className="text-lg font-black">{transaction.studentName}</strong>
                    <p className="text-sm font-bold text-slate-500">{transaction.studentId} · {formatTimestamp(transaction.timestamp)}</p>
                    <p className="text-xs font-bold text-slate-400">{transaction.transactionId} · {transaction.status} · {transaction.operator}</p>
                  </div>
                  <p className="text-2xl font-black text-sky-700">{formatCurrency(transaction.totalAmount, currencyUnit)}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-sm font-bold text-slate-600">
                  {transaction.items.map((item) => (
                    <span className="rounded-full bg-white px-3 py-1" key={`${transaction.transactionId}-${item.productId}`}>{item.name} × {item.quantity}</span>
                  ))}
                </div>
                <div className="mt-3 grid gap-2 text-sm font-bold text-slate-600 sm:grid-cols-2">
                  <p>결제 전 잔액: {formatCurrency(transaction.balanceBefore, currencyUnit)}</p>
                  <p>결제 후 잔액: {formatCurrency(transaction.balanceAfter, currencyUnit)}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
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
