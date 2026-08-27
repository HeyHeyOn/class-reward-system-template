'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassTask, Transaction } from '@/domain/types';
import { getFontFamilyCss, type FontFamily } from '@/lib/fontSettings';
import { QrScanner } from './QrScanner';
import { formatStudentTaskDue, formatStudentTaskRecurrence } from '@/domain/taskStudentDisplay';
import { buildStudentTaskChains, type StudentTaskChain } from '@/domain/studentTaskChains';
import type { TaskRecurrence } from '@/domain/types';

type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';
type Settings = { currencyUnit?: string; appTitle?: string; bankTitle?: string; themeColor?: string; fontFamily?: FontFamily; qrManualInputEnabled?: boolean };
type BankView = 'home' | 'balance-scan' | 'balance-result' | 'tasks-scan' | 'tasks-list' | 'task-detail' | 'task-success' | 'task-failure';
type BalanceResult = { studentId: string; name: string; balance: number; transactions?: Transaction[] } | null;
type TaskResult = { message: string; balanceAfter?: number; reward?: number; studentName?: string } | null;
type TaskStudentStatus = { studentId: string; assigned: boolean; completed?: boolean };
type BankTask = Omit<ClassTask, 'allowedStudentIds'> & {
  allowedStudentIds?: string[];
  currentCycle?: {
    cycleId?: string;
    startsAt?: string;
    endsAt?: string | null;
    assignedStudentIds?: string[];
    completedStudentIds?: string[];
    students?: TaskStudentStatus[];
  };
  studentStatus?: TaskStudentStatus;
  recurrence?: TaskRecurrence;
  prerequisiteTitle?: string;
  prerequisiteStatus?: 'SATISFIED' | 'REQUIRED' | 'UNAVAILABLE';
  prerequisiteMessage?: string;
};

function getTaskStudentStatus(task: BankTask, studentId: string) {
  const direct = task.studentStatus?.studentId === studentId ? task.studentStatus : undefined;
  const cycleStudent = task.currentCycle?.students?.find((student) => student.studentId === studentId);
  const status = direct ?? cycleStudent;
  const assigned = typeof status?.assigned === 'boolean'
    ? status.assigned
    : Array.isArray(task.currentCycle?.assignedStudentIds)
      ? task.currentCycle.assignedStudentIds.includes(studentId)
      : (task.allowedStudentIds ?? []).includes(studentId);
  const completed = typeof status?.completed === 'boolean'
    ? status.completed
    : Array.isArray(task.currentCycle?.completedStudentIds)
      ? task.currentCycle.completedStudentIds.includes(studentId)
      : undefined;
  return { assigned, completed };
}


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

const BANK_THEME: Record<ThemeColor, { shell: string; accentText: string; accentBg: string; accentBgAlt: string; accentBorder: string; accentBorderAlt: string; softBg: string; softText: string; focusBorder: string }> = {
  blue: { shell: 'bg-[#EDF5FA]', accentText: 'text-[#365F78]', accentBg: 'bg-[#B8D0E0] text-[#1F1F1F]', accentBgAlt: 'bg-[#D8E9F2] text-[#1F1F1F]', accentBorder: 'border-[#B8D0E0]', accentBorderAlt: 'border-[#B8D0E0]', softBg: 'bg-[#EDF5FA]', softText: 'text-slate-800', focusBorder: 'focus:border-[#B8D0E0]' },
  pink: { shell: 'bg-[#FAEDED]', accentText: 'text-[#8F5555]', accentBg: 'bg-[#F0C7C7] text-[#1F1F1F]', accentBgAlt: 'bg-[#F4DADA] text-[#1F1F1F]', accentBorder: 'border-[#F0C7C7]', accentBorderAlt: 'border-[#F0C7C7]', softBg: 'bg-[#FAEDED]', softText: 'text-slate-800', focusBorder: 'focus:border-[#F0C7C7]' },
  yellow: { shell: 'bg-[#FCFAE6]', accentText: 'text-[#766D1E]', accentBg: 'bg-[#F5EDA6] text-[#1F1F1F]', accentBgAlt: 'bg-[#F8F2BF] text-[#1F1F1F]', accentBorder: 'border-[#F5EDA6]', accentBorderAlt: 'border-[#F5EDA6]', softBg: 'bg-[#FCFAE6]', softText: 'text-slate-800', focusBorder: 'focus:border-[#F5EDA6]' },
  green: { shell: 'bg-[#DCF5C9]', accentText: 'text-[#505999]', accentBg: 'bg-[#A5C78B] text-[#1F1F1F]', accentBgAlt: 'bg-[#DCF5C9] text-[#1F1F1F]', accentBorder: 'border-[#A5C78B]', accentBorderAlt: 'border-[#A5C78B]', softBg: 'bg-[#DCF5C9]', softText: 'text-slate-800', focusBorder: 'focus:border-[#A5C78B]' },
  purple: { shell: 'bg-[#F7EDFC]', accentText: 'text-[#76518A]', accentBg: 'bg-[#BB99CC] text-[#1F1F1F]', accentBgAlt: 'bg-[#E8D6F0] text-[#1F1F1F]', accentBorder: 'border-[#BB99CC]', accentBorderAlt: 'border-[#BB99CC]', softBg: 'bg-[#F7EDFC]', softText: 'text-slate-800', focusBorder: 'focus:border-[#BB99CC]' },
  white: { shell: 'bg-[#FCFCFC]', accentText: 'text-[#1F1F1F]', accentBg: 'bg-[#1F1F1F] text-[#FCFCFC]', accentBgAlt: 'bg-white text-[#1F1F1F]', accentBorder: 'border-[#1F1F1F]', accentBorderAlt: 'border-[#1F1F1F]', softBg: 'bg-white', softText: 'text-[#1F1F1F]', focusBorder: 'focus:border-[#1F1F1F]' },
  black: { shell: 'bg-[#1F1F1F]', accentText: 'text-[#FCFCFC]', accentBg: 'bg-[#FCFCFC] text-[#1F1F1F]', accentBgAlt: 'bg-[#2B2B2B] text-[#FCFCFC]', accentBorder: 'border-[#FCFCFC]', accentBorderAlt: 'border-[#FCFCFC]', softBg: 'bg-[#2B2B2B]', softText: 'text-[#FCFCFC]', focusBorder: 'focus:border-[#FCFCFC]' },
  navy: { shell: 'bg-[#DCE8F4]', accentText: 'text-[#2F5D82]', accentBg: 'bg-[#7FA6C7] text-[#1F1F1F]', accentBgAlt: 'bg-[#EEF5FA] text-[#1F1F1F]', accentBorder: 'border-[#7FA6C7]', accentBorderAlt: 'border-[#7FA6C7]', softBg: 'bg-[#EEF5FA]', softText: 'text-slate-800', focusBorder: 'focus:border-[#7FA6C7]' },
};

function normalizeThemeColor(value: unknown): ThemeColor {
  return value === 'blue' || value === 'pink' || value === 'yellow' || value === 'green' || value === 'purple' || value === 'black' || value === 'navy' ? value : 'white';
}

export function BankApp() {
  const [settings, setSettings] = useState<Settings>({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false });
  const [tasks, setTasks] = useState<BankTask[]>([]);
  const [publicTasks, setPublicTasks] = useState<BankTask[]>([]);
  const [publicTask, setPublicTask] = useState<BankTask | null>(null);
  const [publicTasksLoading, setPublicTasksLoading] = useState(true);
  const [publicTasksError, setPublicTasksError] = useState('');
  const [selectedTask, setSelectedTask] = useState<BankTask | null>(null);
  const [taskStudentId, setTaskStudentId] = useState('');
  const [view, setView] = useState<BankView>('home');
  const [manualQr, setManualQr] = useState('');
  const [balanceResult, setBalanceResult] = useState<BalanceResult>(null);
  const [taskResult, setTaskResult] = useState<TaskResult>(null);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>('all');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingDialog, setLoadingDialog] = useState<{ title: string; message: string } | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const taskRequestId = useRef(0);
  const taskAbortController = useRef<AbortController | null>(null);

  const currencyUnit = settings.currencyUnit || '원';
  const theme = BANK_THEME[normalizeThemeColor(settings.themeColor)];
  const fontFamilyCss = getFontFamilyCss(settings.fontFamily);
  const fontFamilyStyle = fontFamilyCss ? { fontFamily: fontFamilyCss } : undefined;
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
      setSettings({ currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false });
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  const loadPublicTasks = useCallback(async () => {
    setPublicTasksLoading(true);
    setPublicTasksError('');
    try {
      const response = await fetch('/api/bank/tasks', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '공개 과제 목록을 불러오지 못했습니다.');
      setPublicTasks(Array.isArray(payload) ? payload : []);
    } catch (error) {
      setPublicTasksError(error instanceof Error ? error.message : '공개 과제 목록을 불러오지 못했습니다.');
    } finally {
      setPublicTasksLoading(false);
    }
  }, []);

  const assignedTasks = useMemo(
    () => tasks.filter((task) => taskStudentId && getTaskStudentStatus(task, taskStudentId).assigned),
    [taskStudentId, tasks],
  );
  const assignedTaskChains = useMemo(
    () => buildStudentTaskChains(assignedTasks, (task) => getTaskStudentStatus(task, taskStudentId).completed),
    [assignedTasks, taskStudentId],
  );

  const identifyTaskStudent = useCallback(async (decodedText: string) => {
    const studentId = decodedText.trim();
    if (!studentId) return;
    const requestId = ++taskRequestId.current;
    taskAbortController.current?.abort();
    const controller = new AbortController();
    taskAbortController.current = controller;
    setLoading(true);
    setLoadingDialog({ title: '과제 목록 불러오는 중', message: '과제 목록을 불러오는 중입니다.' });
    setErrorMessage('');
    try {
      const response = await fetch(`/api/tasks?studentId=${encodeURIComponent(studentId)}`, { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '과제 목록을 불러오지 못했습니다.');
      if (requestId !== taskRequestId.current) return;
      setTaskStudentId(studentId);
      setTasks(payload);
      setSelectedTask(null);
      setManualQr('');
      setView('tasks-list');
    } catch (error) {
      if (requestId !== taskRequestId.current || controller.signal.aborted) return;
      setErrorMessage(error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.');
      setTaskStudentId(studentId);
      setTasks([]);
      setView('tasks-list');
    } finally {
      if (requestId === taskRequestId.current) {
        setLoading(false);
        setLoadingDialog(null);
      }
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => { void loadSettings(); void loadPublicTasks(); }); }, [loadPublicTasks, loadSettings]);
  useEffect(() => () => taskAbortController.current?.abort(), []);

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

  async function completeSelectedTask() {
    const studentId = taskStudentId;
    if (!studentId || !selectedTask) return;
    const status = getTaskStudentStatus(selectedTask, studentId);
    if (!status.assigned || status.completed === true) return;
    const activeRequestId = taskRequestId.current;
    setLoading(true);
    setLoadingDialog({ title: '과제 완료 처리 중', message: '과제 완료를 기록하고 보상을 지급하는 중입니다.' });
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
      void refreshCompletedTask(studentId, activeRequestId);
    } catch (error) {
      setTaskResult({ message: error instanceof Error ? error.message : '과제 완료 처리에 실패했습니다.' });
      setView('task-failure');
    } finally {
      setLoading(false);
      setLoadingDialog(null);
    }
  }

  async function refreshCompletedTask(studentId: string, requestId: number) {
    try {
      const response = await fetch(`/api/tasks?studentId=${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const payload: BankTask[] = await response.json();
      if (!response.ok || requestId !== taskRequestId.current) return;
      setTasks(payload);
      setSelectedTask((current) => current ? payload.find((task) => task.taskId === current.taskId) ?? null : null);
    } catch {
      // Completion already succeeded; a refresh failure must not discard that result.
    }
  }

  function openBalanceScan() {
    setManualQr(''); setBalanceResult(null); setErrorMessage(''); setView('balance-scan');
  }

  function openTaskScan() {
    ++taskRequestId.current;
    taskAbortController.current?.abort();
    setManualQr(''); setTasks([]); setSelectedTask(null); setTaskStudentId(''); setTaskResult(null); setErrorMessage(''); setView('tasks-scan');
  }

  function openTaskDetail(task: BankTask) {
    setSelectedTask(task); setTaskResult(null); setErrorMessage(''); setView('task-detail');
  }

  if (isSettingsLoading) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="은행 제목과 테마 설정을 불러오는 중입니다." />;
  }

  return (
    <main data-testid="bank-shell" style={fontFamilyStyle} className={`h-[100dvh] overflow-hidden ${theme.shell} pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] text-slate-950 sm:p-4`}>
      <section data-testid="bank-home-layout" className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-2 sm:gap-5">
        <header data-testid="bank-home-header" className="shrink-0 rounded-[1.5rem] border border-white/50 bg-white/90 p-3 text-center text-slate-950 shadow-lg sm:rounded-[2rem] sm:p-5">
          <h1 className="text-2xl font-black sm:text-5xl">{title}</h1>
          <div className="mt-2 space-y-0.5 text-xs font-bold text-slate-500 sm:mt-3 sm:space-y-1 sm:text-sm">
            <p>- 내 계좌 버튼을 눌러 잔액과 거래 내역을 확인할 수 있어요.</p>
            <p>- 과제 완료 버튼을 눌러 과제를 확인하고 완료할 수 있어요.</p>
            <p>(※ 일부 과제는 허용된 학생만 완료할 수 있습니다.)</p>
          </div>
        </header>

        <section role="region" aria-label="공개 과제 목록" className="flex min-h-0 flex-1 flex-col rounded-[1.5rem] bg-white/90 p-3 shadow-lg sm:rounded-[2rem] sm:p-5">
          <h2 className="shrink-0 text-xl font-black sm:text-2xl">공개 과제 목록</h2>
          <div data-testid="public-task-list-body" className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain sm:mt-3">
            {publicTasksLoading ? <p role="status" className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600 sm:p-4">공개 과제를 불러오는 중입니다.</p> : null}
            {publicTasksError ? <div className="rounded-xl bg-rose-50 p-3 font-bold text-rose-700 sm:p-4"><p>{publicTasksError}</p><button type="button" aria-label="공개 과제 다시 시도" onClick={() => void loadPublicTasks()} className="mt-2 rounded-lg bg-rose-700 px-3 py-2 text-white">다시 시도</button></div> : null}
            {!publicTasksLoading && !publicTasksError && publicTasks.length === 0 ? <p className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600 sm:p-4">현재 공개된 과제가 없습니다.</p> : null}
            <div className="grid gap-2 sm:grid-cols-2">{publicTasks.map((task) => <button key={task.taskId} type="button" onClick={() => setPublicTask(task)} className={`rounded-2xl border ${theme.accentBorderAlt} ${theme.softBg} p-3 text-left ${theme.softText} sm:p-4`}><span className="block text-base font-black sm:text-lg">{task.title}</span><span className="mt-1 block text-xs font-bold sm:text-sm">보상 {task.reward.toLocaleString()}{currencyUnit}</span><TaskStudentSummary task={task} compact /></button>)}</div>
          </div>
        </section>

        <section data-testid="bank-home-actions" className="grid shrink-0 grid-cols-2 gap-2 rounded-[1.5rem] bg-white/90 p-2 shadow-lg sm:gap-4 sm:rounded-[2rem] sm:p-5">
          <button type="button" onClick={openBalanceScan} className={`rounded-[1rem] border ${theme.accentBorder} ${theme.accentBg} px-2 py-4 text-lg font-black shadow-sm sm:rounded-[1.5rem] sm:px-5 sm:py-8 sm:text-3xl`}>내 계좌</button>
          <button type="button" onClick={openTaskScan} className={`rounded-[1rem] border ${theme.accentBorderAlt} ${theme.accentBgAlt} px-2 py-4 text-lg font-black shadow-sm sm:rounded-[1.5rem] sm:px-5 sm:py-8 sm:text-3xl`}>과제 완료</button>
        </section>
      </section>

      {loadingDialog ? <LoadingDialog title={loadingDialog.title} message={loadingDialog.message} /> : null}

      {view === 'balance-scan' ? (
        <ScanDialog title="내 계좌 QR 인식" description="학생 개인 QR 코드를 카메라에 보여 주세요." manualValue={manualQr} onManualChange={setManualQr} onClose={() => setView('home')} onSubmit={() => checkBalance(manualQr)} onScan={checkBalance} submitLabel="QR 값으로 내 계좌 확인" manualInputEnabled={Boolean(settings.qrManualInputEnabled)} />
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

      {view === 'tasks-scan' ? (
        <ScanDialog title="과제 완료 QR 인식" description="과제를 완료할 학생 QR을 인식합니다." manualValue={manualQr} onManualChange={setManualQr} onClose={() => setView('home')} onSubmit={() => identifyTaskStudent(manualQr)} onScan={identifyTaskStudent} submitLabel="QR 값으로 과제 완료" manualInputEnabled={Boolean(settings.qrManualInputEnabled)} />
      ) : null}

      {view === 'tasks-list' ? (
        <Modal title="과제 목록" onClose={() => setView('home')} closeLabel="닫기">
          <p className="mb-3 rounded-xl bg-slate-100 p-3 text-sm font-black text-slate-600">학생 QR: {taskStudentId}</p>
          {loading ? <p className="rounded-2xl bg-slate-50 p-4 font-bold">과제 목록을 불러오는 중입니다.</p> : null}
          {errorMessage ? <p className="rounded-2xl bg-rose-50 p-4 font-bold text-rose-700">{errorMessage}</p> : null}
          {!loading && !errorMessage && assignedTasks.length === 0 ? <p className="rounded-2xl bg-slate-50 p-4 font-bold text-slate-600">배정된 과제가 없습니다.</p> : null}
          <div className="space-y-2">
            {assignedTaskChains.map((chain) => chain.tasks.length === 1 ? (
              <TaskCard key={chain.tasks[0].taskId} task={chain.tasks[0]} studentId={taskStudentId} currencyUnit={currencyUnit} theme={theme} isBlackTheme={normalizeThemeColor(settings.themeColor) === 'black'} onOpen={openTaskDetail} />
            ) : (
              <TaskCarousel key={chain.tasks.map((task) => `${task.taskId}:${getTaskStudentStatus(task, taskStudentId).completed === true ? '1' : '0'}:${task.prerequisiteStatus ?? ''}`).join('|')} chain={chain} studentId={taskStudentId} currencyUnit={currencyUnit} theme={theme} isBlackTheme={normalizeThemeColor(settings.themeColor) === 'black'} onOpen={openTaskDetail} />
            ))}
          </div>
          <button type="button" onClick={openTaskScan} className="mt-3 w-full rounded-xl border border-slate-300 py-2 text-sm font-black text-slate-600">다른 학생 QR 인식</button>
        </Modal>
      ) : null}

      {view === 'task-detail' && selectedTask ? (
        <Modal title={selectedTask.title} onClose={() => setView('tasks-list')} closeLabel="닫기">
          <p data-testid="bank-task-description" className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 text-lg font-bold leading-relaxed text-slate-700">{selectedTask.description || '과제 설명이 없습니다.'}</p>
          <p className="mt-3 rounded-2xl bg-amber-50 p-4 text-center font-black text-amber-800">보상<br />{selectedTask.reward.toLocaleString()}{currencyUnit}</p>
          <TaskStudentSummary task={selectedTask} />
          {getTaskStudentStatus(selectedTask, taskStudentId).completed === true ? <p className="sr-only">완료됨</p> : null}
          {selectedTask.prerequisiteTitle ? <p className="mt-3 rounded-xl bg-slate-100 p-3 font-bold">선행 과제: {selectedTask.prerequisiteTitle}</p> : null}
          {selectedTask.prerequisiteMessage ? <p className="mt-3 rounded-xl bg-amber-100 p-3 font-bold text-amber-900">{selectedTask.prerequisiteMessage}</p> : null}
          {getTaskStudentStatus(selectedTask, taskStudentId).completed !== true ? (
            <button type="button" disabled={selectedTask.prerequisiteStatus === 'REQUIRED' || selectedTask.prerequisiteStatus === 'UNAVAILABLE'} onClick={() => void completeSelectedTask()} className={`mt-4 w-full rounded-2xl ${theme.accentBg} py-4 text-xl font-black disabled:cursor-not-allowed disabled:opacity-50`}>완료하기</button>
          ) : null}
        </Modal>
      ) : null}

      {view === 'task-success' ? (
        <ResultDialog title="과제 완료 성공" tone="success" onClose={() => setView('task-detail')}>
          <p>{taskResult?.message}</p>
          {typeof taskResult?.balanceAfter === 'number' ? <p className="mt-2">현재 잔액: <strong>{taskResult.balanceAfter.toLocaleString()}{currencyUnit}</strong></p> : null}
        </ResultDialog>
      ) : null}

      {view === 'task-failure' ? (
        <ResultDialog title="과제 완료 실패" tone="failure" onClose={() => setView('task-detail')} retryLabel="다시 시도" onRetry={() => void completeSelectedTask()} closeLabel="취소">
          <p>{taskResult?.message ?? '과제 완료 처리에 실패했습니다.'}</p>
        </ResultDialog>
      ) : null}
      {publicTask ? (
        <Modal title={publicTask.title} onClose={() => setPublicTask(null)} closeLabel="닫기">
          <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 text-lg font-bold text-slate-700">{publicTask.description || '과제 설명이 없습니다.'}</p>
          <p className="mt-3 rounded-2xl bg-amber-50 p-4 text-center font-black text-amber-800">보상 {publicTask.reward.toLocaleString()}{currencyUnit}</p>
          <TaskStudentSummary task={publicTask} />
          {publicTask.prerequisiteTitle ? <p className="mt-3 rounded-xl bg-slate-100 p-3 font-bold">선행 과제: {publicTask.prerequisiteTitle}</p> : null}
        </Modal>
      ) : null}
    </main>
  );
}

type TaskCardProps = {
  task: BankTask;
  studentId: string;
  currencyUnit: string;
  theme: (typeof BANK_THEME)[ThemeColor];
  isBlackTheme: boolean;
  onOpen: (task: BankTask) => void;
  reserveCarouselFooter?: boolean;
};

function TaskCard({ task, studentId, currencyUnit, theme, isBlackTheme, onOpen, reserveCarouselFooter = false }: TaskCardProps) {
  const completed = getTaskStudentStatus(task, studentId).completed === true;
  const locked = task.prerequisiteStatus === 'REQUIRED' || task.prerequisiteStatus === 'UNAVAILABLE';
  const accessibleStatus = completed ? ', 완료됨' : locked ? ', 완료 불가' : '';
  return (
    <button
      type="button"
      aria-label={`${task.title}${accessibleStatus}`}
      onClick={() => onOpen(task)}
      className={`relative w-full overflow-hidden rounded-2xl border border-slate-200 ${theme.softBg} p-4 ${reserveCarouselFooter ? 'pb-11' : ''} text-left font-black ${theme.softText} ${completed || locked ? 'brightness-75 opacity-70' : ''}`}
    >
      <span className="block text-lg">{task.title}</span>
      <span className={`mt-1 block text-sm ${isBlackTheme ? 'text-slate-300' : 'text-slate-500'}`}>보상 {task.reward.toLocaleString()}{currencyUnit}</span>
      <TaskStudentSummary task={task} compact />
      {task.prerequisiteMessage ? <span className="mt-2 block rounded-xl bg-amber-100 p-2 text-xs text-amber-900">{task.prerequisiteMessage}</span> : null}
      {completed ? <span aria-hidden="true" className={`absolute right-4 top-1/2 -translate-y-1/2 rotate-[-12deg] rounded border-4 px-3 py-1 text-xl font-black ${isBlackTheme ? 'border-white text-white' : 'border-emerald-800 text-emerald-900'}`}>완료됨</span> : null}
    </button>
  );
}

function TaskCarousel({ chain, studentId, currencyUnit, theme, isBlackTheme, onOpen }: Omit<TaskCardProps, 'task' | 'reserveCarouselFooter'> & { chain: StudentTaskChain<BankTask> }) {
  const [activeIndex, setActiveIndex] = useState(chain.initialIndex);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const showSlide = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(chain.tasks.length - 1, index));
    setActiveIndex(nextIndex);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const left = nextIndex * scroller.clientWidth;
    scrollTaskCarousel(scroller, left, 'smooth');
  }, [chain.tasks.length]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const left = chain.initialIndex * scroller.clientWidth;
    scrollTaskCarousel(scroller, left);
  }, [chain.initialIndex]);

  return (
    <section role="region" aria-label={`${chain.tasks[0].title} 연결 과제 묶음`} className="relative rounded-2xl border border-slate-200 bg-white/60 p-2">
      <div
        ref={scrollerRef}
        className="flex touch-pan-x snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
        onScroll={(event) => {
          const width = event.currentTarget.clientWidth;
          if (width > 0) setActiveIndex(Math.max(0, Math.min(chain.tasks.length - 1, Math.round(event.currentTarget.scrollLeft / width))));
        }}
      >
        {chain.tasks.map((task, index) => (
          <div
            key={task.taskId}
            role="group"
            aria-label={`${index + 1} / ${chain.tasks.length}: ${task.title}`}
            aria-hidden={index === activeIndex ? undefined : true}
            inert={index === activeIndex ? undefined : true}
            className="min-w-full snap-center"
          >
            <TaskCard task={task} studentId={studentId} currencyUnit={currencyUnit} theme={theme} isBlackTheme={isBlackTheme} onOpen={onOpen} reserveCarouselFooter />
          </div>
        ))}
      </div>
      <button type="button" aria-label="이전 과제" disabled={activeIndex === 0} onClick={() => showSlide(activeIndex - 1)} className="absolute bottom-3 left-4 z-10 rounded-lg bg-white/90 px-3 py-1 font-black shadow-sm disabled:opacity-40">‹</button>
      <div data-testid="task-carousel-indicator" className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-xl font-black tracking-widest text-slate-600">
          <span aria-hidden="true">{chain.tasks.map((_, index) => index === activeIndex ? '○' : '•').join('')}</span>
          {chain.tasks.map((task, index) => (
            <button
              key={task.taskId}
              type="button"
              aria-label={`${index + 1}번째 과제 보기`}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => showSlide(index)}
              className="absolute inset-y-0 opacity-0 focus-visible:z-20 focus-visible:opacity-100 focus-visible:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
              style={{ left: `${index * (100 / chain.tasks.length)}%`, width: `${100 / chain.tasks.length}%` }}
            />
          ))}
      </div>
      <button type="button" aria-label="다음 과제" disabled={activeIndex === chain.tasks.length - 1} onClick={() => showSlide(activeIndex + 1)} className="absolute bottom-3 right-4 z-10 rounded-lg bg-white/90 px-3 py-1 font-black shadow-sm disabled:opacity-40">›</button>
    </section>
  );
}

function scrollTaskCarousel(scroller: HTMLDivElement, left: number, behavior?: ScrollBehavior) {
  try {
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ left, behavior });
      return;
    }
  } catch {
    // Older browsers and some test DOMs expose scrollTo without implementing it.
  }
  scroller.scrollLeft = left;
}

function TaskStudentSummary({ task, compact = false }: { task: BankTask; compact?: boolean }) {
  const recurrence = task.recurrence ?? task.schedule?.recurrence;
  return (
    <div className={`${compact ? 'mt-1 text-xs' : 'mt-3 rounded-2xl bg-slate-50 p-4 text-sm'} font-bold text-slate-500`}>
      <p>{formatStudentTaskDue(task.dueAt)}</p>
      <p>{formatStudentTaskRecurrence(recurrence)}</p>
    </div>
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

function ScanDialog({ title, description, manualValue, onManualChange, onClose, onSubmit, onScan, submitLabel, manualInputEnabled }: { title: string; description: string; manualValue: string; onManualChange: (value: string) => void; onClose: () => void; onSubmit: () => void; onScan: (value: string) => void; submitLabel: string; manualInputEnabled: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-xl rounded-[2rem] bg-white p-5 shadow-2xl">
        <h2 className="text-2xl font-black">{title}</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">{description}</p>
        <div className="mt-4 flex justify-center"><QrScanner onScan={onScan} /></div>
        {manualInputEnabled ? (
          <>
            <label className="mt-4 block text-sm font-bold text-slate-700">
              <span>QR 값 직접 입력</span>
              <input aria-label="QR 값 직접 입력" value={manualValue} onChange={(event) => onManualChange(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white p-3 text-slate-950 outline-none focus:border-sky-400" placeholder="S001" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-slate-200 py-3 font-black text-slate-700">취소</button>
              <button type="button" onClick={onSubmit} className="flex-1 rounded-xl bg-sky-500 py-3 font-black text-white">{submitLabel}</button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-4 rounded-xl bg-slate-100 p-3 text-center text-sm font-black text-slate-600">QR 직접 입력은 시스템 설정에서 차단되어 있습니다. 카메라로 학생 QR을 인식해 주세요.</p>
            <button type="button" onClick={onClose} className="mt-4 w-full rounded-xl bg-slate-200 py-3 font-black text-slate-700">취소</button>
          </>
        )}
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
