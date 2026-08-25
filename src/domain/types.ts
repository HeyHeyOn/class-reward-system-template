export type StudentStatus = 'ACTIVE' | 'INACTIVE';

export type Student = {
  studentId: string;
  name: string;
  balance: number;
  status: StudentStatus;
};

export type Product = {
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
};

export type CartItem = {
  productId: string;
  quantity: number;
};

export type CheckoutLineItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  subtotal: number;
};

export type Transaction = {
  transactionId: string;
  timestamp: string;
  studentId: string;
  studentName: string;
  items: CheckoutLineItem[];
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  operator: string;
  cancelledAt?: string;
};

export type ClassTask = {
  taskId: string;
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds: string[];
  createdAt?: string;
  /** Always populated by the sheet codec; optional for legacy API callers constructing tasks. */
  taskInstanceId?: string;
  schedule?: TaskSchedule;
  pendingSchedule?: TaskSchedule | null;
  /** Present only when persisted versioned schedule cells were malformed and a read fallback was used. */
  scheduleReadWarnings?: TaskScheduleReadWarning[];
};

export type TaskCompletion = {
  completionId: string;
  timestamp: string;
  taskId: string;
  studentId: string;
  studentName: string;
  reward: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  note: string;
};

export type TaskAssignmentStudentStatus = {
  studentId: string;
  name: string;
  assigned: boolean;
  completed: boolean;
};

export type TaskAssignmentStatus = {
  taskId: string;
  students: TaskAssignmentStudentStatus[];
};

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type DayOfMonth =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20
  | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31;

export type TaskRecurrence =
  | { type: 'NONE' }
  | { type: 'DAILY'; time: string }
  | { type: 'WEEKLY'; weekday: IsoWeekday; time: string }
  | { type: 'MONTHLY'; dayOfMonth: DayOfMonth; time: string };

export type TaskSchedule = {
  ruleVersion: number;
  effectiveFrom: string;
  timeZone: string;
  recurrence: TaskRecurrence;
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
};

export type TaskScheduleReadWarning =
  | 'INVALID_CURRENT_SCHEDULE'
  | 'INVALID_PENDING_SCHEDULE';
