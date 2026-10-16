import { classifyTaskAvailability } from '@/domain/taskAvailability';
import { lineVoucherCount } from '@/domain/checkout';
import type { TaskRecurrence, Transaction } from '@/domain/types';
import type { StudentTaskProjectionDto } from '@/server/studentTaskProjection';

/**
 * Allowlisted shapes the personal bank sends to a logged-in student. Pure functions only, so
 * both route handlers and the client (type-only) can share them.
 */

export type StudentBankProfileDto = Readonly<{
  student: Readonly<{ studentId: string; name: string; balance: number }>;
  session: Readonly<{ expiresAt: string }>;
}>;

export type StudentBankTransactionKind =
  | 'PURCHASE'
  | 'TASK_REWARD'
  | 'TEACHER_GRANT'
  | 'TEACHER_DEDUCT'
  | 'CANCELLATION'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TREE_WATER'
  | 'TREE_HARVEST'
  | 'PET_FEED'
  | 'PET_DECOR'
  | 'PET_GRADUATE';

export type StudentBankTransactionDto = Readonly<{
  transactionId: string;
  occurredAt: string;
  kind: StudentBankTransactionKind;
  /** Purchased item names for store purchases (or a legacy reward's task title). */
  detail?: string;
  /** Signed change of the balance: positive money in, negative money out. */
  amount: number;
  balanceAfter: number;
  /** This transaction was later cancelled (a separate CANCELLATION row reverses it). */
  cancelled: boolean;
  cancelledAt?: string;
}>;

export type StudentBankTaskStage = 'PENDING' | 'READY' | 'COMPLETED';

export type StudentBankTaskDto = Readonly<{
  taskId: string;
  title: string;
  description: string;
  reward: number;
  stage: StudentBankTaskStage;
  /** READY and every extra gate (prerequisite, availability window) is met now. */
  completable: boolean;
  /** Why a READY task cannot be completed yet. */
  blockedReason?: string;
  dueAt?: string;
  recurrence?: TaskRecurrence;
  prerequisiteTitle?: string;
  /** The Padlet board whose post (in the student's name) makes the task 완료 가능. */
  padlet?: StudentBankPadletDto;
  /** The 딴쌤 board whose post (or submission) makes the task 완료 가능; the bank opens it with a ticket. */
  board?: StudentBankBoardDto;
}>;

export type StudentBankPadletDto = Readonly<{ title: string; url: string; sectionTitle?: string }>;
export type StudentBankBoardDto = Readonly<{ title: string; format: 'mini' | 'group' | 'quiz' | 'survey'; groupName: string | null }>;

export function projectStudentBankTransactions(
  transactions: readonly Transaction[],
  studentId: string,
): StudentBankTransactionDto[] {
  return transactions
    .filter((transaction) => transaction.studentId === studentId)
    .map((transaction) => {
      const amount = transaction.balanceAfter - transaction.balanceBefore;
      const kind = transactionKind(transaction, amount);
      const detail = transactionDetail(transaction, kind);
      const cancelled = transaction.status === 'CANCELLED';
      return {
        transactionId: transaction.transactionId,
        occurredAt: transaction.timestamp,
        kind,
        ...(detail ? { detail } : {}),
        amount,
        balanceAfter: transaction.balanceAfter,
        cancelled,
        ...(cancelled && transaction.cancelledAt ? { cancelledAt: transaction.cancelledAt } : {}),
      };
    });
}

function transactionKind(transaction: Transaction, amount: number): StudentBankTransactionKind {
  if (transaction.status === 'CANCEL_REVERSAL') return 'CANCELLATION';
  if (transaction.status === 'TASK_REWARD' || transaction.operator === 'bank-task-completion') return 'TASK_REWARD';
  if (transaction.status === 'TREE_WATER') return 'TREE_WATER';
  if (transaction.status === 'TREE_HARVEST') return 'TREE_HARVEST';
  if (transaction.status === 'PET_FEED') return 'PET_FEED';
  if (transaction.status === 'PET_DECOR') return 'PET_DECOR';
  if (transaction.status === 'PET_GRADUATE') return 'PET_GRADUATE';
  if (transaction.items.length > 0 && amount <= 0) return 'PURCHASE';
  if (transaction.status === 'ADMIN_ADJUSTMENT' || transaction.operator === 'admin') {
    return amount >= 0 ? 'TEACHER_GRANT' : 'TEACHER_DEDUCT';
  }
  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
}

function transactionDetail(transaction: Transaction, kind: StudentBankTransactionKind): string | undefined {
  if (kind !== 'PURCHASE' && kind !== 'TASK_REWARD') return undefined;
  const names = transaction.items
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return '';
      const vouchers = lineVoucherCount(item);
      return `${Number.isSafeInteger(item.quantity) && item.quantity > 1 ? `${name} ×${item.quantity}` : name}${vouchers > 0 ? ` (교환권 ${vouchers}장)` : ''}`;
    })
    .filter(Boolean);
  if (names.length === 0) return undefined;
  const detail = names.join(', ');
  return detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
}

const STAGE_ORDER: Record<StudentBankTaskStage, number> = { READY: 0, PENDING: 1, COMPLETED: 2 };

/**
 * The student's own tasks from 미완료 upward. 미부여 (UNASSIGNED) tasks are dropped: the student
 * must not see them at all. Order: 완료 가능 (completable first) → 미완료 → 완료.
 */
export function projectStudentBankTasks(
  projection: readonly StudentTaskProjectionDto[],
  now: string,
  padletBoards: ReadonlyMap<string, StudentBankPadletDto> = new Map(),
  boards: ReadonlyMap<string, StudentBankBoardDto> = new Map(),
): StudentBankTaskDto[] {
  return projection
    .flatMap((task) => {
      const stage = task.studentStatus.stage;
      if (stage !== 'PENDING' && stage !== 'READY' && stage !== 'COMPLETED') return [];
      const blockedReason = stage === 'READY' ? readyGateReason(task, now) : undefined;
      const dto: StudentBankTaskDto = {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        reward: task.reward,
        stage,
        completable: stage === 'READY' && !blockedReason,
        ...(blockedReason ? { blockedReason } : {}),
        ...(task.dueAt ? { dueAt: task.dueAt } : {}),
        ...(task.recurrence ? { recurrence: task.recurrence } : {}),
        ...(task.prerequisiteTitle ? { prerequisiteTitle: task.prerequisiteTitle } : {}),
        ...(padletBoards.has(task.taskId) ? { padlet: padletBoards.get(task.taskId) } : {}),
        ...(boards.has(task.taskId) ? { board: boards.get(task.taskId) } : {}),
      };
      return [{ dto, sortOrder: task.sortOrder }];
    })
    .sort((left, right) => {
      const stage = STAGE_ORDER[left.dto.stage] - STAGE_ORDER[right.dto.stage];
      if (stage !== 0) return stage;
      if (left.dto.completable !== right.dto.completable) return left.dto.completable ? -1 : 1;
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.dto.taskId < right.dto.taskId ? -1 : left.dto.taskId > right.dto.taskId ? 1 : 0;
    })
    .map(({ dto }) => dto);
}

function readyGateReason(task: StudentTaskProjectionDto, now: string): string | undefined {
  if (task.prerequisiteStatus === 'REQUIRED') {
    return task.prerequisiteTitle
      ? `먼저 '${task.prerequisiteTitle}' 과제를 완료해야 해요.`
      : '먼저 해야 하는 과제가 있어요.';
  }
  if (task.prerequisiteStatus === 'UNAVAILABLE') return '먼저 해야 하는 과제를 지금은 할 수 없어요. 선생님께 물어봐 주세요.';
  let availability: ReturnType<typeof classifyTaskAvailability>;
  try {
    availability = classifyTaskAvailability({ availableFrom: task.availableFrom, dueAt: task.dueAt }, now);
  } catch {
    return '지금은 완료할 수 없어요.';
  }
  if (availability === 'UPCOMING') return '아직 시작 전이에요.';
  if (availability === 'EXPIRED') return '기한이 지났어요.';
  return undefined;
}
