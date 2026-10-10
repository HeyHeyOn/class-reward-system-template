import type { ReactNode } from 'react';
import type { Product, Student, TaskAssignmentStudentStatus } from '@/domain/types';
import type { FontFamily } from '@/lib/fontSettings';
import type { VersionedAdminStudent } from '@/lib/studentAdminSnapshot';
import type { NormalizedAdminTask } from '../taskRecurrenceEditor';
import type { TaskDialogTarget } from '../tasks/taskTargetSummary';
import type { ThemeColor } from '../uiTheme';

// Local edit revisions are never serialized. They distinguish edits made while a save is pending.

export type StudentDraft = Student & Partial<Pick<VersionedAdminStudent, 'studentVersion' | 'accountVersion'>> & { balanceEditRevision?: number };

export type ProductDraft = Product & { stockEditRevision?: number };

export type TaskDraft = NormalizedAdminTask & { taskVersion?: number };

export type TaskDeleteConfirmation = { taskId: string; title: string; opener: HTMLElement; deleting: boolean; error: string };

export type TaskAssignmentDraft = {
  taskId: string | null; target: TaskDialogTarget; opener: HTMLElement | null;
  operations: Record<string, { assigned?: boolean; completed?: boolean }>;
  retryTargets?: Array<{ taskId: string; operations: Array<{ studentId: string; assigned?: boolean; completed?: boolean; source: 'ADMIN' }> }>;
  selectedIds: string[]; assignedIds: string[]; completedIds: string[];
  initialAssignedIds: string[]; initialCompletedIds: string[]; statusRows: TaskAssignmentStudentStatus[]; isLoading?: boolean;
  /** Assigned students that are 완료 가능, as the assignment status reports them. */
  readyIds?: string[]; initialReadyIds?: string[];
};

export type AdminTab = 'home' | 'settings' | 'students' | 'products' | 'tasks' | 'tree' | 'transactions' | 'currency';

export type TaskSheetTab = 'basic' | 'schedule' | 'students';

export type TaskSheetState =
  | { mode: 'edit'; taskId: string; tab: TaskSheetTab; snapshot: TaskDraft; opener: HTMLElement | null; resync?: TaskDraft }
  | { mode: 'new'; tab: TaskSheetTab; opener: HTMLElement | null };

export type EntitySheetState<T> = { mode: 'edit'; id: string; snapshot: T; opener: HTMLElement | null } | { mode: 'new'; opener: HTMLElement | null };

export type ConfirmState = { title: string; description: ReactNode; confirmLabel: string; tone?: 'danger' | 'warning'; onConfirm: () => unknown; busy?: boolean };

export type AssignmentFilter = 'all' | 'completed' | 'pending' | 'unassigned';

export type StoreTab = 'inventory' | 'promotions';

export type BulkMode = 'set' | 'add' | 'subtract';

export type CurrencyMode = 'add' | 'subtract';

export type Settings = { className?: string; currencyUnit?: string; appTitle?: string; bankTitle?: string; themeColor?: ThemeColor; fontFamily?: FontFamily; qrManualInputEnabled?: boolean };

export type CurrencyResult = {
  status: 'success' | 'failure';
  mode: CurrencyMode;
  studentId: string;
  amount: number;
  message: string;
};

export type QrTaskAssignmentResult = {
  status: 'success' | 'failure';
  taskId: string;
  message: string;
};

export type NewStudentDraft = {
  studentId: string;
  name: string;
  balance: number;
  status: Student['status'];
};

export type NewProductDraft = {
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string;
  category: string;
  sortOrder: number;
};

export type ProductDeleteAttempt = {
  productId: string;
  expectedProductVersion: number;
  operationId: string;
};

export type ProductDeleteConfirmation = {
  productId: string;
  name: string;
  opener: HTMLElement;
  deleting: boolean;
  error: string;
};
