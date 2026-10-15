import { normalizeFontFamily, type FontFamily } from '@/lib/fontSettings';
import { tenantFetch } from '@/lib/tenantApiPath';
import type {
  StudentBankProfileDto,
  StudentBankTaskDto,
  StudentBankTransactionDto,
  StudentBankTransactionKind,
} from '@/server/studentBankViews';

import type { ClassTreeStudentViewDto, ClassTreeWaterResultDto } from '@/lib/classTreeApi';
import type { StudentBagDto } from '@/lib/studentBagApi';
import { isStudentBag } from '../bag/bagClient';

export type { StudentBankProfileDto, StudentBankTaskDto, StudentBankTransactionDto, StudentBankTransactionKind };
export type { ClassTreeStudentViewDto, ClassTreeWaterResultDto, StudentBagDto };

export type BankSettings = {
  currencyUnit: string;
  /** Display title: the class bank title, or "{store title} 은행". */
  bankTitle: string;
  /** The class name shown in the header ('' when the class has none). */
  className: string;
  themeColor: string;
  fontFamily: FontFamily;
  qrManualInputEnabled: boolean;
};

export const DEFAULT_BANK_SETTINGS: BankSettings = {
  currencyUnit: '원', bankTitle: '학급 은행', className: '', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false,
};

export type BankFailure = Readonly<{
  ok: false;
  /** 0 when the request never got an HTTP response. */
  status: number;
  code?: string;
  error?: string;
  retryable?: boolean;
}>;
export type BankResult<T> = Readonly<{ ok: true; data: T }> | BankFailure;

export const SESSION_REQUIRED_CODE = 'BANK_SESSION_REQUIRED';

const NETWORK_ERROR = '연결이 잠시 불안정해요. 다시 시도해 주세요.';

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

function failureFrom(status: number, payload: unknown): BankFailure {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    ok: false,
    status,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
  };
}

/** A student bank request: the data when it has the expected shape, else a failure. Shared by the pet screen. */
export async function bankRequest<T>(path: string, init: RequestInit, isData: (value: unknown) => value is T): Promise<BankResult<T>> {
  let response: Response;
  try {
    response = await tenantFetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, status: 0, error: NETWORK_ERROR, retryable: true };
  }
  const payload = await readJson(response);
  if (response.ok && isData(payload)) return { ok: true, data: payload };
  if (response.ok) return { ok: false, status: 0, error: NETWORK_ERROR, retryable: true };
  return failureFrom(response.status, payload);
}

export function isSessionRequired(result: BankFailure): boolean {
  return result.status === 401 || result.code === SESSION_REQUIRED_CODE;
}

/* ------------------------------------------------------------------ */
/* Shape checks (the client trusts nothing it did not validate)        */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isProfile(value: unknown): value is StudentBankProfileDto {
  return isRecord(value) && isRecord(value.student) && isRecord(value.session)
    && typeof value.student.studentId === 'string' && value.student.studentId.length > 0
    && typeof value.student.name === 'string' && isSafeInteger(value.student.balance)
    && typeof value.session.expiresAt === 'string';
}

const TASK_STAGES = new Set(['PENDING', 'READY', 'COMPLETED']);

export function isTask(value: unknown): value is StudentBankTaskDto {
  return isRecord(value) && typeof value.taskId === 'string' && typeof value.title === 'string'
    && typeof value.description === 'string' && isSafeInteger(value.reward)
    && typeof value.stage === 'string' && TASK_STAGES.has(value.stage) && typeof value.completable === 'boolean'
    && (value.blockedReason === undefined || typeof value.blockedReason === 'string')
    && (value.dueAt === undefined || typeof value.dueAt === 'string')
    && (value.prerequisiteTitle === undefined || typeof value.prerequisiteTitle === 'string');
}

const TRANSACTION_KINDS = new Set<StudentBankTransactionKind>([
  'PURCHASE', 'TASK_REWARD', 'TEACHER_GRANT', 'TEACHER_DEDUCT', 'CANCELLATION', 'DEPOSIT', 'WITHDRAWAL',
  'TREE_WATER', 'TREE_HARVEST', 'PET_FEED', 'PET_DECOR', 'PET_GRADUATE',
]);

function isTransaction(value: unknown): value is StudentBankTransactionDto {
  return isRecord(value) && typeof value.transactionId === 'string' && typeof value.occurredAt === 'string'
    && typeof value.kind === 'string' && TRANSACTION_KINDS.has(value.kind as StudentBankTransactionKind)
    && isSafeInteger(value.amount) && isSafeInteger(value.balanceAfter) && typeof value.cancelled === 'boolean'
    && (value.detail === undefined || typeof value.detail === 'string')
    && (value.cancelledAt === undefined || typeof value.cancelledAt === 'string');
}

export type TasksPayload = { tasks: StudentBankTaskDto[] };
function isTasksPayload(value: unknown): value is TasksPayload {
  return isRecord(value) && Array.isArray(value.tasks) && value.tasks.every(isTask);
}

export type TransactionsPayload = { balance: number; transactions: StudentBankTransactionDto[]; limit: number };
function isTransactionsPayload(value: unknown): value is TransactionsPayload {
  return isRecord(value) && isSafeInteger(value.balance) && isSafeInteger(value.limit)
    && Array.isArray(value.transactions) && value.transactions.every(isTransaction);
}

function isOk(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

export async function fetchBankSettings(): Promise<BankSettings> {
  const response = await tenantFetch('/api/settings', { cache: 'no-store' });
  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload)) throw new Error('설정을 불러오지 못했어요.');
  const text = (key: string, fallback: string) => typeof payload[key] === 'string' ? payload[key] as string : fallback;
  return {
    currencyUnit: text('currencyUnit', DEFAULT_BANK_SETTINGS.currencyUnit) || DEFAULT_BANK_SETTINGS.currencyUnit,
    bankTitle: text('bankTitle', '').trim() || `${text('appTitle', '').trim() || '학급 매점'} 은행`,
    className: text('className', '').trim(),
    themeColor: text('themeColor', DEFAULT_BANK_SETTINGS.themeColor),
    fontFamily: normalizeFontFamily(payload.fontFamily),
    qrManualInputEnabled: payload.qrManualInputEnabled === true,
  };
}

export function fetchSession(): Promise<BankResult<StudentBankProfileDto>> {
  return bankRequest('/api/bank/session', { method: 'GET' }, isProfile);
}

/** The only request that carries the student's QR value; it goes in the POST body, never the URL. */
export function login(studentQr: string): Promise<BankResult<StudentBankProfileDto>> {
  return bankRequest('/api/bank/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentQr }),
  }, isProfile);
}

export function logout(): Promise<BankResult<{ ok: true }>> {
  return bankRequest('/api/bank/session', { method: 'DELETE' }, isOk);
}

export function fetchTasks(): Promise<BankResult<TasksPayload>> {
  return bankRequest('/api/bank/me/tasks', { method: 'GET' }, isTasksPayload);
}

export function fetchTransactions(): Promise<BankResult<TransactionsPayload>> {
  return bankRequest('/api/bank/me/transactions', { method: 'GET' }, isTransactionsPayload);
}

function isTreeView(value: unknown): value is ClassTreeStudentViewDto {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.treeName !== 'string' || !isSafeInteger(value.apples) || !isSafeInteger(value.waterPrice)
    || !isSafeInteger(value.waterDailyLimit) || !isSafeInteger(value.myWaterToday) || !isSafeInteger(value.waterersToday)
    || !isSafeInteger(value.harvestedTrees)) return false;
  const tree = value.tree;
  if (tree !== null && !(isRecord(tree) && isSafeInteger(tree.treeNo) && isSafeInteger(tree.goal) && isSafeInteger(tree.drops)
    && typeof tree.startedAt === 'string')) return false;
  return true;
}

export type TreePayload = { balance: number; tree: ClassTreeStudentViewDto };
function isTreePayload(value: unknown): value is TreePayload {
  return isRecord(value) && isSafeInteger(value.balance) && isTreeView(value.tree);
}

export type WaterPayload = { result: ClassTreeWaterResultDto; tree: ClassTreeStudentViewDto };
function isWaterPayload(value: unknown): value is WaterPayload {
  return isRecord(value) && isRecord(value.result) && value.result.ok === true && isSafeInteger(value.result.balanceAfter)
    && isSafeInteger(value.result.drops) && isTreeView(value.tree);
}

/** The class tree and the student's coupons. 404 UNSUPPORTED means a Sheets class without a tree. */
export function fetchTree(): Promise<BankResult<TreePayload>> {
  return bankRequest('/api/bank/me/tree', { method: 'GET' }, isTreePayload);
}

export type BagPayload = { bag: StudentBagDto };
function isBagPayload(value: unknown): value is BagPayload {
  return isRecord(value) && isStudentBag(value.bag);
}

/** The student's own bag. 404 UNSUPPORTED means a Sheets class without bags. */
export function fetchBag(): Promise<BankResult<BagPayload>> {
  return bankRequest('/api/bank/me/bag', { method: 'GET' }, isBagPayload);
}

/** Waters the tree once. Resend the same operation ID after a lost response; it is charged only once. */
export function waterTree(operationId: string): Promise<BankResult<WaterPayload>> {
  return bankRequest('/api/bank/me/tree/water', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId }),
  }, isWaterPayload);
}

export type CompletionResponse = Readonly<{ status: number; payload: unknown }> | null;

/** Raw completion POST; the caller owns retries with the same operation ID. */
export async function postTaskCompletion(taskId: string, operationId: string): Promise<CompletionResponse> {
  try {
    const response = await tenantFetch(`/api/bank/me/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId }),
      cache: 'no-store', credentials: 'same-origin',
    });
    return { status: response.status, payload: await readJson(response) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Uncertain completion journal                                        */
/* ------------------------------------------------------------------ */

/**
 * A completion whose outcome is not yet known. It survives reloads (sessionStorage) so the
 * student can re-check with the SAME operation ID instead of paying twice.
 */
export type PendingCompletion = Readonly<{
  operationId: string;
  taskId: string;
  taskTitle: string;
  studentId: string;
  startedAt: string;
}>;

function journalKey(): string {
  return `crs:bank-completion:v1:${typeof window === 'undefined' ? '' : window.location.pathname}`;
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readPendingCompletion(studentId: string): PendingCompletion | null {
  try {
    const raw = window.sessionStorage.getItem(journalKey());
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.operationId !== 'string' || !OPERATION_ID.test(value.operationId)
      || typeof value.taskId !== 'string' || !value.taskId || typeof value.taskTitle !== 'string'
      || typeof value.studentId !== 'string' || typeof value.startedAt !== 'string') return null;
    if (value.studentId !== studentId) return null;
    return {
      operationId: value.operationId, taskId: value.taskId, taskTitle: value.taskTitle,
      studentId: value.studentId, startedAt: value.startedAt,
    };
  } catch {
    return null;
  }
}

export function writePendingCompletion(pending: PendingCompletion): void {
  try {
    window.sessionStorage.setItem(journalKey(), JSON.stringify(pending));
  } catch {
    // Storage can be unavailable (private mode); the in-memory operation still protects this page.
  }
}

export function clearPendingCompletion(operationId: string): void {
  try {
    const raw = window.sessionStorage.getItem(journalKey());
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.operationId === operationId) window.sessionStorage.removeItem(journalKey());
  } catch {
    // Nothing to clear.
  }
}
