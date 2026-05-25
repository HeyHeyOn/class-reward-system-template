'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassTask, Transaction } from '@/domain/types';
import { QrScanner } from './QrScanner';

type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';
type Settings = { currencyUnit?: string; appTitle?: string; bankTitle?: string; themeColor?: string };
type BankView = 'home' | 'balance-scan' | 'balance-result' | 'tasks-list' | 'task-detail' | 'task-scan' | 'task-success' | 'task-failure';
type BalanceResult = { studentId: string; name: string; balance: number; transactions?: Transaction[] } | null;
type TaskResult = { message: string; balanceAfter?: number; reward?: number; studentName?: string } | null;

function LoadingScreen({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-black">{title}</h1>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-600">{message}</p>
      </section>
    </main>
  );
}

function formatTransactionAmount(transaction: Transaction, unit: string) {
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${Math.abs(delta).toLocaleString()}${unit}`;
}

type TransactionFilter = 'all' | 'income' | 'expense';

function getTransactionTone(transaction: Transaction) {
  if (transaction.status === 'CANCELLED') return 'cancelled';
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  return delta > 0 ? 'income' : 'expense';
}

function getTransactionAmountTone(transaction: Transaction) {
  const delta = transaction.balanceAfter - transaction.balanceBefore;
  return delta > 0 ? 'income' : 'expense';
}

function formatTransactionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

const BANK_THEME: Record<ThemeColor, { shell: string; accentText: string; accentBg: string; accentBgAlt: string; softBg: string; focusBorder: string }> = {
  blue: { shell: 'bg-[#EDF5FA]', accentText: 'text-[#365F78]', accentBg: 'bg-[#B8D0E0]', accentBgAlt: 'bg-[#D8E9F2]', softBg: 'bg-[#EDF5FA]', focusBorder: 'focus:border-[#B8D0E0]' },
  pink: { shell: 'bg-[#FAEDED]', accentText: 'text-[#8F5555]', accentBg: 'bg-[#F0C7C7]', accentBgAlt: 'bg-[#F4DADA]', softBg: 'bg-[#FAEDED]', focusBorder: 'focus:border-[#F0C7C7]' },
  yellow: { shell: 'bg-[#FCFAE6]', accentText: 'text-[#766D1E]', accentBg: 'bg-[#F5EDA6]', accentBgAlt: 'bg-[#F8F2BF]', softBg: 'bg-[#FCFAE6]', focusBorder: 'focus:border-[#F5EDA6]' },
  green: { shell: 'bg-[#DCF5C9]', accentText: 'text-[#505999]', accentBg: 'bg-[#A5C78B]', accentBgAlt: 'bg-[#DCF5C9]', softBg: 'bg-[#DCF5C9]', focusBorder: 'focus:border-[#A5C78B]' },
  purple: { shell: 'bg-[#F7EDFC]', accentText: 'text-[#76518A]', accentBg: 'bg-[#BB99CC]', accentBgAlt: 'bg-[#E8D6F0]', softBg: 'bg-[#F7EDFC]', focusBorder: 'focus:border-[#BB99CC]' },
  white: { shell: 'bg-[#FCFCFC]', accentText: 'text-[#1F1F1F]', accentBg: 'bg-[#1F1F1F] text-[#FCFCFC]', accentBgAlt: 'bg-white text-[#1F1F1F]', softBg: 'bg-white', focusBorder: 'focus:border-[#1F1F1F]' },
  black: { shell: 'bg-[#1F1F1F]', accentText: 'text-[#FCFCFC]', accentBg: 'bg-[#FCFCFC] text-[#1F1F1F]', accentBgAlt: 'bg-[#2B2B2B] text-[#FCFCFC]', softBg: 'bg-[#2B2B2B]', focusBorder: 'focus:border-[#FCFCFC]' },
  navy: { shell: 'bg-[#8F97CF]', accentText: 'text-[#30376F]', accentBg: 'bg-[#505999] text-[#FCFCFC]', accentBgAlt: 'bg-[#D5D9F2]', softBg: 'bg-[#D5D9F2]', focusBorder: 'focus:border-[#505999]' },
};

function normalizeThemeColor(value: unknown): ThemeColor {
  return value === 'blue' || value === 'pink' || value === 'yellow' || value === 'green' || value === 'purple' || value === 'black' || value === 'navy' ? value : 'white';
}

export function BankApp() {
  const [settings, setSettings] = useState<Settings>({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white' });
  const [tasks, setTasks] = useState<ClassTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<ClassTask | null>(null);
  const [view, setView] = useState<BankView>('home');
  const [manualQr, setManualQr] = useState('');
  const [balanceResult, setBalanceResult] = useState<BalanceResult>(null);
  const [taskResult, setTaskResult] = useState<TaskResult>(null);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>('all');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingDialog, setLoadingDialog] = useState<{ title: string; message: string } | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);

  const currencyUnit = settings.currencyUnit || '원';
  const theme = BANK_THEME[normalizeThemeColor(settings.themeColor)];
  const title = useMemo(() => settings.bankTitle || `${settings.appTitle || '학급 매점'} 은행`, [settings.appTitle, settings.bankTitle]);
  const filteredBalanceTransactions = useMemo(() => {
    const transactions = balanceResult?.transactions ?? [];
    if (transactionFilter === 'all') return transactions;
    return transactions.filter((transaction) => getTransactionAmountTone(transaction) === transactionFilter);
  }, [balanceResult?.transactions, transactionFilter]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const payload = await response.json();
      if (response.ok) setSettings(payload);
    } catch {
      setSettings({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white' });
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setLoadingDialog({ title: '과제 목록 불러오는 중', message: '과제 목록을 불러오는 중입니다.' });
    setErrorMessage('');
    try {
      const response = await fetch('/api/tasks', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 목록을 불러오지 못했습니다.');
      setTasks(payload);
      setView('tasks-list');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.');
      setView('tasks-list');
    } finally {
      setLoading(false);
      setLoadingDialog(null);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => loadSettings()); }, [loadSettings]);

  async function checkBalance(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId) return;
    setLoading(true);
    setLoadingDialog({ title: '내 계좌 확인 중', message: 'QR을 인식했습니다. 내 계좌를 불러오는 중입니다.' });
    setErrorMessage('');
    try {
      const response = await fetch(`/api/bank/balance?studentId=${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '잔액을 불러오지 못했습니다.');
      setBalanceResult(payload);
      setTransactionFilter('all');
      setView('balance-result');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '잔액을 불러오지 못했습니다.');
      setView('balance-result');
    } finally {
      setLoading(false);
      setLoadingDialog(null);
      setManualQr('');
    }
  }

  async function completeSelectedTask(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId || !selectedTask) return;
    setLoading(true);
    setLoadingDialog({ title: '과제 완료 처리 중', message: 'QR을 인식했습니다. 보상을 지급하는 중입니다.' });
    setErrorMessage('');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(selectedTask.taskId)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 완료 처리에 실패했습니다.');
      setTaskResult({
        message: `${payload.student.name} 학생에게 ${payload.task.reward}${currencyUnit} 지급 완료`,
        balanceAfter: payload.student.balance,
        reward: payload.task.reward,
        studentName: payload.student.name,
      });
      setView('task-success');
    } catch (error) {
      setTaskResult({ message: error instanceof Error ? error.message : '과제 완료 처리에 실패했습니다.' });
      setView('task-failure');
    } finally {
      setLoading(false);
      setLoadingDialog(null);
      setManualQr('');
    }
  }

  function openBalanceScan() {
    setManualQr(''); setBalanceResult(null); setErrorMessage(''); setView('balance-scan');
  }

  function openTaskDetail(task: ClassTask) {
    setSelectedTask(task); setTaskResult(null); setErrorMessage(''); setView('task-detail');
  }

  function openTaskScan() {
    setManualQr(''); setTaskResult(null); setErrorMessage(''); setView('task-scan');
  }

  if (isSettingsLoading) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="은행 제목과 테마 설정을 불러오는 중입니다." />;
  }

  return (
    <main data-testid="bank-shell" className={`min-h-screen ${theme.shell} p-4 text-slate-950`}>
      <section className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col justify-center gap-5">
        <header className="rounded-[2rem] border border-white/50 bg-white/90 p-5 text-center text-slate-950 shadow-lg">
          <p className={`text-xs font-black tracking-[0.25em] ${theme.accentText}`}>CLASS BANK</p>
          <h1 className="mt-2 text-4xl font-black sm:text-5xl">{title}</h1>
          <p className="mt-2 text-sm font-bold text-slate-500">QR로 잔액을 확인하고 과제 보상을 받을 수 있어요.</p>
        </header>

        <section className="grid gap-4 rounded-[2rem] bg-white/90 p-5 shadow-lg sm:grid-cols-2">
          <button type="button" onClick={openBalanceScan} className={`rounded-[1.5rem] border border-sky-200 ${theme.accentBg} px-5 py-12 text-3xl font-black text-sky-950 shadow-sm`}>내 계좌</button>
          <button type="button" onClick={loadTasks} className={`rounded-[1.5rem] border border-indigo-300 ${theme.accentBgAlt} px-5 py-12 text-3xl font-black text-indigo-950 shadow-sm`}>과제 확인</button>
        </section>
      </section>

      {loadingDialog ? <LoadingDialog title={loadingDialog.title} message={loadingDialog.message} /> : null}

      {view === 'balance-scan' ? (
        <ScanDialog title="내 계좌 QR 인식" description="학생 개인 QR 코드를 카메라에 보여 주세요." manualValue={manualQr} onManualChange={setManualQr} onClose={() => setView('home')} onSubmit={() => checkBalance(manualQr)} onScan={checkBalance} submitLabel="QR 값으로 내 계좌 확인" />
      ) : null}

      {view === 'balance-result' ? (
        <ResultDialog title={errorMessage ? '내 계좌 확인 실패' : '내 계좌'} tone={errorMessage ? 'failure' : 'success'} onClose={() => setView('home')}>
          {errorMessage ? (
            <p>{errorMessage}</p>
          ) : (
            <div className="text-left">
              <p data-testid="bank-balance-sentence" className="text-center text-xl font-black leading-snug text-slate-800 sm:text-2xl">{balanceResult?.name} 학생의 현재 잔액은 <strong className={theme.accentText}>{balanceResult?.balance.toLocaleString()}{currencyUnit}</strong>입니다.</p>
              <section data-testid="bank-recent-transactions" className="mx-auto mt-4 max-h-72 w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-3 text-left">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-black text-slate-800">거래 내역 ({filteredBalanceTransactions.length})</h3>
                  <TransactionFilterTabs value={transactionFilter} onChange={setTransactionFilter} />
                </div>
                {filteredBalanceTransactions.length ? (
                  <div className="mt-2 space-y-2">
                    {filteredBalanceTransactions.map((transaction) => {
                      const tone = getTransactionTone(transaction);
                      const amountTone = getTransactionAmountTone(transaction);
                      const rowClass = tone === 'cancelled'
                        ? 'bg-slate-100 text-slate-500'
                        : tone === 'income'
                          ? 'bg-rose-50 text-rose-700'
                          : 'bg-sky-50 text-sky-700';
                      const amountClass = amountTone === 'income' ? 'text-rose-700' : 'text-sky-700';
                      const itemLabel = transaction.items.length > 0
                        ? transaction.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')
                        : '거래';
                      return (
                        <div key={transaction.transactionId} className={`rounded-xl px-3 py-2 text-sm font-black ${rowClass}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-slate-700">{itemLabel}</span>
                            <span data-testid={`bank-transaction-amount-${transaction.transactionId}`} className={`shrink-0 ${amountClass}`}>{formatTransactionAmount(transaction, currencyUnit)}</span>
                          </div>
                          <p className="mt-1 text-xs font-bold text-slate-500">{formatTransactionDate(transaction.timestamp)} · 잔액 {transaction.balanceAfter.toLocaleString()}{currencyUnit}{tone === 'cancelled' ? ' · 취소됨' : ''}{transaction.cancelledAt ? ` · 취소 ${formatTransactionDate(transaction.cancelledAt)}` : ''}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="mt-2 rounded-xl bg-slate-50 p-3 text-sm font-bold text-slate-500">아직 거래 내역이 없습니다.</p>}
              </section>
            </div>
          )}
        </ResultDialog>
      ) : null}

      {view === 'tasks-list' ? (
        <Modal title="과제 목록" onClose={() => setView('home')} closeLabel="닫기">
          {loading ? <p className="rounded-2xl bg-slate-50 p-4 font-bold">과제 목록을 불러오는 중입니다.</p> : null}
          {errorMessage ? <p className="rounded-2xl bg-rose-50 p-4 font-bold text-rose-700">{errorMessage}</p> : null}
          {!loading && !errorMessage && tasks.length === 0 ? <p className="rounded-2xl bg-slate-50 p-4 font-bold text-slate-600">현재 받을 수 있는 과제가 없습니다.</p> : null}
          <div className="space-y-2">
            {tasks.map((task) => (
              <button key={task.taskId} type="button" onClick={() => openTaskDetail(task)} className={`w-full rounded-2xl border border-slate-200 ${theme.softBg} p-4 text-left font-black text-slate-800`}>
                <span className="block text-lg">{task.title}</span>
                <span className="mt-1 block text-sm text-slate-500">보상 {task.reward.toLocaleString()}{currencyUnit} · {task.maxCompletionsPerStudent}회까지</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {view === 'task-detail' && selectedTask ? (
        <Modal title={selectedTask.title} onClose={() => setView('tasks-list')} closeLabel="닫기">
          <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-700">{selectedTask.description || '과제 설명이 없습니다.'}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <p className="rounded-2xl bg-amber-50 p-4 font-black text-amber-800">보상<br />{selectedTask.reward.toLocaleString()}{currencyUnit}</p>
            <p className="rounded-2xl bg-sky-50 p-4 font-black text-sky-800">가능 횟수<br />{selectedTask.maxCompletionsPerStudent}회</p>
          </div>
          <button type="button" onClick={openTaskScan} className={`mt-4 w-full rounded-2xl ${theme.accentBg} py-4 text-xl font-black text-slate-950`}>완료하기</button>
        </Modal>
      ) : null}

      {view === 'task-scan' && selectedTask ? (
        <ScanDialog title="과제 완료 QR 인식" description={`${selectedTask.title} 완료 보상을 받을 학생 QR을 인식합니다.`} manualValue={manualQr} onManualChange={setManualQr} onClose={() => setView('task-detail')} onSubmit={() => completeSelectedTask(manualQr)} onScan={completeSelectedTask} submitLabel="QR 값으로 완료하기" />
      ) : null}

      {view === 'task-success' ? (
        <ResultDialog title="과제 완료 성공" tone="success" onClose={() => setView('task-detail')}>
          <p>{taskResult?.message}</p>
          {typeof taskResult?.balanceAfter === 'number' ? <p className="mt-2">현재 잔액: <strong>{taskResult.balanceAfter.toLocaleString()}{currencyUnit}</strong></p> : null}
        </ResultDialog>
      ) : null}

      {view === 'task-failure' ? (
        <ResultDialog title="과제 완료 실패" tone="failure" onClose={() => setView('task-detail')} retryLabel="다시 시도" onRetry={openTaskScan} closeLabel="취소">
          <p>{taskResult?.message ?? '과제 완료 처리에 실패했습니다.'}</p>
        </ResultDialog>
      ) : null}
    </main>
  );
}

function TransactionFilterTabs({ value, onChange }: { value: TransactionFilter; onChange: (value: TransactionFilter) => void }) {
  return (
    <div className="flex rounded-full bg-slate-100 p-1 text-xs font-black text-slate-600" role="group" aria-label="거래 필터">
      {([
        ['all', '전체'],
        ['income', '수입'],
        ['expense', '지출'],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`rounded-full px-2 py-1 ${value === id ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LoadingDialog({ title, message }: { title: string; message: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-[2rem] bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-emerald-500" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-black">{title}</h2>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-600">{message}</p>
      </section>
    </div>
  );
}

function Modal({ title, children, onClose, closeLabel }: { title: string; children: ReactNode; onClose: () => void; closeLabel: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[2rem] bg-white p-5 shadow-2xl">
        <h2 className="text-2xl font-black">{title}</h2>
        <div className="mt-4">{children}</div>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl bg-slate-200 py-3 font-black text-slate-700">{closeLabel}</button>
      </section>
    </div>
  );
}

function ScanDialog({ title, description, manualValue, onManualChange, onClose, onSubmit, onScan, submitLabel }: { title: string; description: string; manualValue: string; onManualChange: (value: string) => void; onClose: () => void; onSubmit: () => void; onScan: (value: string) => void; submitLabel: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-xl rounded-[2rem] bg-white p-5 shadow-2xl">
        <h2 className="text-2xl font-black">{title}</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">{description}</p>
        <div className="mt-4 flex justify-center"><QrScanner onScan={onScan} /></div>
        <label className="mt-4 block text-sm font-bold text-slate-700">
          <span>QR 값 직접 입력</span>
          <input aria-label="QR 값 직접 입력" value={manualValue} onChange={(event) => onManualChange(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white p-3 outline-none focus:border-sky-400" placeholder="S001" />
        </label>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700">취소</button>
          <button type="button" onClick={onSubmit} className="flex-1 rounded-xl bg-sky-500 py-3 font-black text-white">{submitLabel}</button>
        </div>
      </section>
    </div>
  );
}

function ResultDialog({ title, tone, children, onClose, onRetry, retryLabel, closeLabel = '닫기' }: { title: string; tone: 'success' | 'failure'; children: ReactNode; onClose: () => void; onRetry?: () => void; retryLabel?: string; closeLabel?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-[2rem] bg-white p-5 text-center shadow-2xl">
        <h2 className={`text-2xl font-black ${tone === 'success' ? 'text-sky-700' : 'text-rose-700'}`}>{title}</h2>
        <div className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-700">{children}</div>
        <div className="mt-4 flex gap-2">
          {onRetry ? <button type="button" onClick={onRetry} className="flex-1 rounded-xl bg-slate-950 py-3 font-black text-white">{retryLabel}</button> : null}
          <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700">{closeLabel}</button>
        </div>
      </section>
    </div>
  );
}
