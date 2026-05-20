'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassTask } from '@/domain/types';
import { QrScanner } from './QrScanner';

type Settings = { currencyUnit?: string; appTitle?: string; themeColor?: string };
type BankView = 'home' | 'balance-scan' | 'balance-result' | 'tasks-list' | 'task-detail' | 'task-scan' | 'task-success' | 'task-failure';
type BalanceResult = { studentId: string; name: string; balance: number } | null;
type TaskResult = { message: string; balanceAfter?: number; reward?: number; studentName?: string } | null;

const themeClass: Record<string, string> = {
  blue: 'bg-sky-100', pink: 'bg-pink-100', yellow: 'bg-amber-100', green: 'bg-emerald-100', purple: 'bg-purple-100', white: 'bg-white', black: 'bg-slate-950', navy: 'bg-blue-950',
};

export function BankApp() {
  const [settings, setSettings] = useState<Settings>({ currencyUnit: '원', appTitle: '학급 매점', themeColor: 'blue' });
  const [tasks, setTasks] = useState<ClassTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<ClassTask | null>(null);
  const [view, setView] = useState<BankView>('home');
  const [manualQr, setManualQr] = useState('');
  const [balanceResult, setBalanceResult] = useState<BalanceResult>(null);
  const [taskResult, setTaskResult] = useState<TaskResult>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const currencyUnit = settings.currencyUnit || '원';
  const background = themeClass[settings.themeColor || 'blue'] ?? themeClass.blue;
  const title = useMemo(() => `${settings.appTitle || '학급 매점'} 은행`, [settings.appTitle]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const payload = await response.json();
      if (response.ok) setSettings(payload);
    } catch {
      setSettings({ currencyUnit: '원', appTitle: '학급 매점', themeColor: 'blue' });
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
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
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => loadSettings()); }, [loadSettings]);

  async function checkBalance(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId) return;
    setLoading(true);
    setErrorMessage('');
    try {
      const response = await fetch(`/api/bank/balance?studentId=${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '잔액을 불러오지 못했습니다.');
      setBalanceResult(payload);
      setView('balance-result');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '잔액을 불러오지 못했습니다.');
      setView('balance-result');
    } finally {
      setLoading(false);
      setManualQr('');
    }
  }

  async function completeSelectedTask(decodedText: string) {
    const studentId = decodedText.trim();
    if (!studentId || !selectedTask) return;
    setLoading(true);
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

  return (
    <main data-testid="bank-shell" className={`min-h-screen ${background} p-4 text-slate-950 ${settings.themeColor === 'black' || settings.themeColor === 'navy' ? 'text-white' : ''}`}>
      <section className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col justify-center gap-5">
        <header className="rounded-[2rem] border border-white/50 bg-white/90 p-5 text-center text-slate-950 shadow-lg">
          <p className="text-xs font-black tracking-[0.25em] text-sky-600">CLASS BANK</p>
          <h1 className="mt-2 text-4xl font-black sm:text-5xl">{title}</h1>
          <p className="mt-2 text-sm font-bold text-slate-500">QR로 잔액을 확인하고 과제 보상을 받을 수 있어요.</p>
        </header>

        <section className="grid gap-4 rounded-[2rem] bg-white/90 p-5 shadow-lg sm:grid-cols-2">
          <button type="button" onClick={openBalanceScan} className="rounded-[1.5rem] bg-sky-500 px-5 py-12 text-3xl font-black text-white shadow-sm">잔액 확인</button>
          <button type="button" onClick={loadTasks} className="rounded-[1.5rem] bg-emerald-500 px-5 py-12 text-3xl font-black text-white shadow-sm">과제 확인</button>
        </section>
      </section>

      {view === 'balance-scan' ? (
        <ScanDialog title="잔액 확인 QR 인식" description="학생 개인 QR 코드를 카메라에 보여 주세요." manualValue={manualQr} onManualChange={setManualQr} onClose={() => setView('home')} onSubmit={() => checkBalance(manualQr)} onScan={checkBalance} submitLabel="QR 값으로 잔액 확인" />
      ) : null}

      {view === 'balance-result' ? (
        <ResultDialog title={errorMessage ? '잔액 확인 실패' : '잔액 확인'} tone={errorMessage ? 'failure' : 'success'} onClose={() => setView('home')}>
          {errorMessage ? <p>{errorMessage}</p> : <p>{balanceResult?.name} 학생의 현재 잔액은 <strong>{balanceResult?.balance.toLocaleString()}{currencyUnit}</strong>입니다.</p>}
        </ResultDialog>
      ) : null}

      {view === 'tasks-list' ? (
        <Modal title="과제 목록" onClose={() => setView('home')} closeLabel="닫기">
          {loading ? <p className="rounded-2xl bg-slate-50 p-4 font-bold">과제 목록을 불러오는 중입니다.</p> : null}
          {errorMessage ? <p className="rounded-2xl bg-rose-50 p-4 font-bold text-rose-700">{errorMessage}</p> : null}
          {!loading && !errorMessage && tasks.length === 0 ? <p className="rounded-2xl bg-slate-50 p-4 font-bold text-slate-600">현재 받을 수 있는 과제가 없습니다.</p> : null}
          <div className="space-y-2">
            {tasks.map((task) => (
              <button key={task.taskId} type="button" onClick={() => openTaskDetail(task)} className="w-full rounded-2xl border border-slate-200 bg-sky-50 p-4 text-left font-black text-slate-800">
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
          <button type="button" onClick={openTaskScan} className="mt-4 w-full rounded-2xl bg-emerald-500 py-4 text-xl font-black text-white">완료하기</button>
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
