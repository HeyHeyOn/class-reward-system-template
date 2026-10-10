'use client';

import { useCallback, useRef, useState } from 'react';
import {
  clearPendingCompletion,
  isTask,
  postTaskCompletion,
  readPendingCompletion,
  SESSION_REQUIRED_CODE,
  writePendingCompletion,
  type PendingCompletion,
  type StudentBankTaskDto,
} from './bankClient';

export type CompletionSuccess = Readonly<{
  operation: Readonly<{ operationId: string; state: 'SUCCESS' }>;
  task: Readonly<{ taskId: string; title: string; reward: number }>;
  tasks: StudentBankTaskDto[];
  student?: Readonly<{ name: string; balance: number }>;
  /** What the task added to the class tree (drops) and the student's pet (growth), when anything. */
  growth?: Readonly<{ tree: number; pet: number }>;
}>;

export type CompletionOutcome =
  | Readonly<{ kind: 'success'; taskTitle: string; reward: number; balance?: number; growth?: Readonly<{ tree: number; pet: number }> }>
  | Readonly<{ kind: 'policy'; message: string }>
  | Readonly<{ kind: 'unknown'; message: string }>
  | Readonly<{ kind: 'conflict'; message: string }>
  | Readonly<{ kind: 'manual'; message: string }>;

type Options = Readonly<{
  onSuccess: (payload: CompletionSuccess) => void;
  onPolicyFailure: () => void;
  onSessionExpired: () => void;
  /** Every final outcome, e.g. for an aria-live announcement. */
  onOutcome?: (outcome: CompletionOutcome) => void;
}>;

const CHECKING = '처리 상태를 확인하고 있어요.';

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

/** RFC 4122 v4; falls back to getRandomValues where randomUUID needs a secure context. */
export function createOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isCompletionSuccess(payload: unknown, operation: PendingCompletion): payload is CompletionSuccess {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<CompletionSuccess>;
  return candidate.operation?.operationId === operation.operationId
    && candidate.operation?.state === 'SUCCESS'
    && candidate.task?.taskId === operation.taskId
    && typeof candidate.task?.title === 'string'
    && typeof candidate.task?.reward === 'number' && Number.isSafeInteger(candidate.task.reward)
    && Array.isArray(candidate.tasks) && candidate.tasks.every(isTask)
    && (candidate.student === undefined || (typeof candidate.student?.name === 'string'
      && typeof candidate.student?.balance === 'number' && Number.isSafeInteger(candidate.student.balance)));
}

/** The growth a completion reports, when it is well formed. */
function growthOf(value: unknown): CompletionSuccess['growth'] {
  if (!value || typeof value !== 'object') return undefined;
  const { tree, pet } = value as { tree?: unknown; pet?: unknown };
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return ok(tree) && ok(pet) ? { tree, pet } : undefined;
}

/**
 * Bank task completion: one idempotent operation ID per attempt, bounded automatic retries of that
 * same ID, and an "unknown" state that can be re-checked later with the same ID (journaled across
 * reloads). The server pays a task only from 완료 가능 under a lock, so an unknown result on one task
 * never holds the student's other tasks back, and the task list itself settles it once it shows the
 * task is no longer waiting at 완료 가능.
 */
export function useTaskCompletion({ onSuccess, onPolicyFailure, onSessionExpired, onOutcome }: Options) {
  const [pending, setPending] = useState<PendingCompletion | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [outcome, setOutcomeState] = useState<CompletionOutcome | null>(null);
  const inFlight = useRef(false);
  const pendingRef = useRef<PendingCompletion | null>(null);

  const setOutcome = useCallback((next: CompletionOutcome | null) => {
    setOutcomeState(next);
    if (next) onOutcome?.(next);
  }, [onOutcome]);

  const settle = useCallback((operation: PendingCompletion) => {
    clearPendingCompletion(operation.operationId);
    if (pendingRef.current?.operationId === operation.operationId) {
      pendingRef.current = null;
      setPending(null);
    }
  }, []);

  const run = useCallback(async (operation: PendingCompletion, manualCheck: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOutcome(null);
    setBusyMessage(manualCheck ? CHECKING : '과제를 완료하고 보상을 받는 중이에요.');
    const slowCopy = window.setTimeout(() => setBusyMessage(CHECKING), 1000);
    try {
      const maxAttempts = manualCheck ? 1 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const response = await postTaskCompletion(operation.taskId, operation.operationId);
        const payload = response?.payload;
        if (response && response.status >= 200 && response.status < 300 && isCompletionSuccess(payload, operation)) {
          settle(operation);
          onSuccess(payload);
          setOutcome({ kind: 'success', taskTitle: payload.task.title, reward: payload.task.reward, balance: payload.student?.balance, growth: growthOf(payload.growth) });
          return;
        }
        const error = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown; retryable?: unknown } : {};
        const message = typeof error.error === 'string' ? error.error : '';
        if (response && (response.status === 401 || error.code === SESSION_REQUIRED_CODE)) {
          // Not processed for this attempt; keep the journal so the same ID is re-checked after login.
          onSessionExpired();
          return;
        }
        // Definite refusals: nothing was written, so the operation is settled (NOT_READY = 미완료).
        if (response && response.status >= 400 && response.status < 500
          && (error.code === 'POLICY_FAILURE' || error.code === 'NOT_READY' || error.code === 'INVALID_REQUEST')) {
          settle(operation);
          setOutcome({ kind: 'policy', message: message || '지금은 이 과제를 완료할 수 없어요.' });
          onPolicyFailure();
          return;
        }
        if (error.code === 'COMPLETION_OPERATION_CONFLICT') {
          settle(operation);
          setOutcome({ kind: 'conflict', message: message || '같은 완료 요청의 내용이 맞지 않아요. 선생님께 알려 주세요.' });
          onPolicyFailure();
          return;
        }
        if (error.code === 'COMPLETION_RECONCILIATION_REQUIRED' && error.retryable === false) {
          settle(operation);
          setOutcome({ kind: 'manual', message: message || '완료 결과를 자동으로 확인할 수 없어요. 선생님께 알려 주세요.' });
          onPolicyFailure();
          return;
        }
        setBusyMessage(CHECKING);
        if (attempt < maxAttempts - 1) await waitForRetry(250 * (2 ** attempt));
      }
      setOutcome({ kind: 'unknown', message: '완료됐는지 아직 확인하지 못했어요. 잠시 뒤 [다시 확인]을 눌러 주세요.' });
    } finally {
      window.clearTimeout(slowCopy);
      inFlight.current = false;
      setBusyMessage(null);
    }
  }, [onPolicyFailure, onSessionExpired, onSuccess, setOutcome, settle]);

  const complete = useCallback((task: StudentBankTaskDto, studentId: string) => {
    if (inFlight.current || !task.completable) return;
    const existing = pendingRef.current;
    // The uncertain task continues with its own ID, so it is never paid twice.
    if (existing?.taskId === task.taskId) {
      void run(existing, true);
      return;
    }
    const operation: PendingCompletion = {
      operationId: createOperationId(), taskId: task.taskId, taskTitle: task.title,
      studentId, startedAt: new Date().toISOString(),
    };
    pendingRef.current = operation;
    setPending(operation);
    writePendingCompletion(operation);
    void run(operation, false);
  }, [run]);

  const recheck = useCallback(() => {
    const existing = pendingRef.current;
    if (existing) void run(existing, true);
  }, [run]);

  /** Picks up an uncertain completion journaled for this student (e.g. before a reload). */
  const restore = useCallback((studentId: string) => {
    const restored = readPendingCompletion(studentId);
    pendingRef.current = restored;
    setPending(restored);
    setOutcomeState(null);
  }, []);

  /**
   * The student's current task list answers an uncertain completion: once that task no longer
   * waits at 완료 가능 (completed, or changed by the teacher), there is nothing left to re-check.
   */
  const reconcile = useCallback((tasks: readonly StudentBankTaskDto[]) => {
    const existing = pendingRef.current;
    if (!existing || inFlight.current) return;
    if (tasks.find((task) => task.taskId === existing.taskId)?.stage === 'READY') return;
    settle(existing);
  }, [settle]);

  /** Forget in-memory state on logout; a journaled uncertain operation stays for the next login. */
  const reset = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
    setOutcomeState(null);
  }, []);
  const dismissOutcome = useCallback(() => setOutcomeState(null), []);

  return {
    pending,
    busyMessage,
    outcome,
    inFlight: busyMessage !== null,
    complete,
    recheck,
    restore,
    reconcile,
    reset,
    dismissOutcome,
  };
}
