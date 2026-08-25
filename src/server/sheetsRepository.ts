import type { ClassTask, Product, Student, TaskAssignmentStatus, TaskCompletion, Transaction } from '@/domain/types';
import { normalizeLegacyTimeZone } from '@/domain/taskSchedule';
import { evaluateTaskCompletion } from '@/domain/taskCompletionPolicy';
import type { TaskCycleState } from '@/domain/taskCycleState';
import { mutateTaskAssignment } from '@/server/repositories/sheets/taskAssignmentCommands';
import {
  readTaskCycleHistory,
  readTaskCycleState,
  type TaskCycleHistoryEvent,
} from '@/server/repositories/sheets/taskCycleQueries';
import {
  buildTaskAppendRow,
  buildTaskCompletionAppendRow,
  buildTransactionAppendRow,
  createHeaderIndex,
  parseProductRow,
  parseStudentRow,
  parseTaskCompletionRow,
  parseTaskRow,
  parseTransactionRow,
  requireColumns,
  REQUIRED_TASK_COMPLETION_COLUMNS,
} from '@/server/sheetsRows';
import type {
  OperationalSheetName,
  RecurringSchemaMigrationStore,
  SheetCellUpdate,
  TabularReader,
  TabularStore,
} from '@/server/storage/tabularStore';

// Temporary compatibility aliases keep the repository's existing public type API intact.
export type SheetName = OperationalSheetName;
export type SheetsReader = TabularReader;
export type SheetsStore = TabularStore;
export type { SheetCellUpdate };

export type StudentRecord = {
  student: Student;
  rowNumber: number;
};

export type ProductRecord = {
  product: Product;
  rowNumber: number;
};

export type TransactionRecord = {
  transaction: Transaction;
  rowNumber: number;
};

export type StudentUpdate = {
  name: string;
  balance: number;
  status: Student['status'];
};

export type StudentCreate = StudentUpdate & {
  studentId: string;
};

export type ProductUpdate = {
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
};

export type ProductCreate = ProductUpdate & {
  productId: string;
};

export type TaskUpdate = {
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds?: string[];
};

export type TaskCreate = TaskUpdate & {
  taskId: string;
};

export type TaskCompletionResult = {
  task: ClassTask;
  student: Student;
  completion: TaskCompletion;
};

export type StudentBulkBalanceMode = 'set' | 'add' | 'subtract';

export type StudentBulkBalanceUpdate = {
  studentIds: string[];
  mode: StudentBulkBalanceMode;
  amount: number;
};

export type StudentBatchUpdate = StudentUpdate & {
  studentId: string;
};

export type ProductBatchUpdate = ProductUpdate & {
  productId: string;
};

export type TaskBatchUpdate = TaskUpdate & {
  taskId: string;
};

const REQUIRED_STUDENT_COLUMNS = ['studentId', 'name', 'balance', 'status'];
const REQUIRED_PRODUCT_COLUMNS = ['productId', 'name', 'price', 'stock', 'isActive'];
const REQUIRED_TRANSACTION_COLUMNS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const REQUIRED_TASK_COLUMNS = ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder'];

const TASK_HEADERS = ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'];
const VERSIONED_TASK_SCHEDULE_HEADERS = [
  'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
  'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle',
  'resetAssignmentOnCycle', 'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone',
  'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday',
  'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
] as const;
const TASK_COMPLETION_HEADERS = ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'];
const TRANSACTION_HEADERS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];

export type SheetSetting = {
  key: string;
  value: string;
};

export async function getStudentById(reader: SheetsReader, studentId: string): Promise<Student | null> {
  return (await getStudentRecordById(reader, studentId))?.student ?? null;
}

export async function getStudentRecordById(reader: SheetsReader, studentId: string): Promise<StudentRecord | null> {
  const rows = await reader.getRows('Students');
  const [headers, ...dataRows] = rows;

  if (!headers) return null;

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');

  for (let index = 0; index < dataRows.length; index += 1) {
    const student = parseStudentRow(dataRows[index], headerIndex);

    if (student?.studentId === studentId) {
      return { student, rowNumber: index + 2 };
    }
  }

  return null;
}

export async function getStudents(reader: SheetsReader): Promise<Student[]> {
  const rows = await reader.getRows('Students');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');

  return dataRows
    .map((row) => parseStudentRow(row, headerIndex))
    .filter((student): student is Student => student !== null)
    .filter((student) => student.status === 'ACTIVE')
    .sort((a, b) => a.studentId.localeCompare(b.studentId, 'ko-KR', { numeric: true }) || a.name.localeCompare(b.name));
}

export async function getActiveProducts(reader: SheetsReader): Promise<Product[]> {
  return (await getProducts(reader)).filter((product) => product.isActive);
}

export async function getProducts(reader: SheetsReader): Promise<Product[]> {
  return (await getProductRecords(reader)).map((record) => record.product);
}


export async function getTasks(reader: SheetsReader, options: { includeInactive?: boolean } = {}): Promise<ClassTask[]> {
  return (await getTaskRecords(reader))
    .map((record) => record.task)
    .filter((task) => options.includeInactive || task.isActive);
}

export async function getTaskById(reader: SheetsReader, taskId: string): Promise<ClassTask | null> {
  return (await getTaskRecordById(reader, taskId))?.task ?? null;
}

export async function getTaskRecordById(reader: SheetsReader, taskId: string): Promise<{ task: ClassTask; rowNumber: number } | null> {
  return (await getTaskRecords(reader)).find((record) => record.task.taskId === taskId) ?? null;
}

export async function getTaskRecords(reader: SheetsReader): Promise<Array<{ task: ClassTask; rowNumber: number }>> {
  const rows = await reader.getRows('Tasks');
  const [headers, ...dataRows] = rows;
  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_TASK_COLUMNS, 'Tasks');
  assertVersionedTaskScheduleHeaders(headerIndex);
  const parseRecords = (classTimeZone: string) => dataRows
    .map((row, index) => {
      const task = parseTaskRow(row, headerIndex, classTimeZone);
      return task ? { task, rowNumber: index + 2 } : null;
    })
    .filter((record): record is { task: ClassTask; rowNumber: number } => Boolean(record));

  let records = parseRecords(normalizeLegacyTimeZone(undefined));
  const needsLegacyProjection = records.some(({ task }) =>
    task.taskInstanceId?.startsWith('legacy:')
    || task.scheduleReadWarnings?.includes('INVALID_CURRENT_SCHEDULE'));
  if (needsLegacyProjection) {
    const settings = await getSheetSettings(reader);
    records = parseRecords(normalizeLegacyTimeZone(settings.classTimeZone));
  }
  return records
    .sort((a, b) => a.task.sortOrder - b.task.sortOrder || a.task.title.localeCompare(b.task.title));
}

export async function getTaskCompletions(reader: SheetsReader): Promise<TaskCompletion[]> {
  return parseTaskCompletions(await reader.getRows('TaskCompletions'));
}

function parseTaskCompletions(rows: string[][]): TaskCompletion[] {
  const [headers, ...dataRows] = rows;
  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_TASK_COMPLETION_COLUMNS, 'TaskCompletions');
  return dataRows
    .map((row) => parseTaskCompletionRow(row, headerIndex))
    .filter((completion): completion is TaskCompletion => completion !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export type TaskAssignmentStatusUpdate = {
  studentId: string;
  assigned: boolean;
  source: 'ADMIN' | 'QR';
};

export type TaskAssignmentMutationStatus = TaskAssignmentStatus & { legacyMirrorWarning?: string };

export async function getTaskAssignmentStatus(reader: SheetsReader, taskId: string): Promise<TaskAssignmentStatus> {
  const task = await getTaskById(reader, taskId.trim());
  if (!task) throw new Error('과제를 찾을 수 없습니다.');
  const [students, cycleState] = await Promise.all([
    getStudents(reader),
    readTaskCycleState(reader, task, new Date().toISOString()),
  ]);
  return {
    taskId: task.taskId,
    students: students.map((student) => ({
      studentId: student.studentId,
      name: student.name,
      assigned: cycleState.students[student.studentId]?.assigned ?? false,
      completed: cycleState.students[student.studentId]?.completed ?? false,
    })),
  };
}

/** Pure current-cycle query. It deliberately accepts only a reader, so it cannot materialize or migrate. */
export async function getTaskCycleState(
  reader: SheetsReader,
  taskId: string,
  now: string = new Date().toISOString(),
): Promise<TaskCycleState> {
  const task = await getTaskById(reader, taskId.trim());
  if (!task) throw new Error('과제를 찾을 수 없습니다.');
  return readTaskCycleState(reader, task, now);
}

/** Event-snapshot history remains readable after the Tasks definition row is deleted. */
export async function getTaskCycleHistory(
  reader: SheetsReader,
  filter: { taskId?: string; taskInstanceId?: string } = {},
): Promise<TaskCycleHistoryEvent[]> {
  return readTaskCycleHistory(reader, filter);
}

export async function updateTaskAssignmentStatus(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  update: TaskAssignmentStatusUpdate,
): Promise<TaskAssignmentMutationStatus> {
  const record = await getTaskRecordById(store, taskId.trim());
  if (!record) throw new Error('과제를 찾을 수 없습니다.');
  const student = await getStudentById(store, update.studentId.trim());
  if (!student || student.status !== 'ACTIVE') throw new Error('학생 정보를 찾을 수 없습니다.');
  const mutation = await mutateTaskAssignment(store, {
    task: record.task,
    taskRowNumber: record.rowNumber,
    studentId: student.studentId,
    assigned: update.assigned,
    source: update.source,
  });
  const status: TaskAssignmentMutationStatus = await getTaskAssignmentStatus(store, record.task.taskId);
  if (mutation.legacyMirrorWarning) status.legacyMirrorWarning = mutation.legacyMirrorWarning;
  return status;
}

export async function createTask(store: SheetsStore, create: TaskCreate): Promise<ClassTask> {
  await ensureTaskSheet(store);
  const taskId = create.taskId.trim();
  validateTaskId(taskId);
  validateTaskUpdate(create);
  if (await getTaskById(store, taskId)) throw new Error('이미 존재하는 과제 ID입니다.');
  const now = new Date().toISOString();
  const taskRows = await store.getRows('Tasks');
  const headers = taskRows[0] ?? TASK_HEADERS;
  const taskHeaderIndex = createHeaderIndex(headers);
  const hasVersionedScheduleColumns = assertVersionedTaskScheduleHeaders(taskHeaderIndex);
  let versionedSchedule: Pick<ClassTask, 'taskInstanceId' | 'schedule' | 'pendingSchedule'> | undefined;
  if (hasVersionedScheduleColumns) {
    const classTimeZone = normalizeLegacyTimeZone((await getSheetSettings(store)).classTimeZone);
    versionedSchedule = {
      taskInstanceId: crypto.randomUUID(),
      schedule: {
        ruleVersion: 1,
        effectiveFrom: now,
        timeZone: classTimeZone,
        recurrence: { type: 'NONE' },
        resetCompletionOnCycle: false,
        resetAssignmentOnCycle: false,
      },
      pendingSchedule: null,
    };
  }
  const task: ClassTask = {
    taskId,
    title: create.title.trim(),
    description: create.description.trim(),
    reward: create.reward,
    isActive: create.isActive,
    sortOrder: create.sortOrder,
    allowedStudentIds: normalizeUniqueIds(create.allowedStudentIds ?? []),
    createdAt: now,
    ...versionedSchedule,
  };
  await store.appendRow('Tasks', buildTaskAppendRow(headers, task, now));
  return task;
}

export async function updateTaskDetails(store: SheetsStore, taskId: string, update: TaskUpdate): Promise<ClassTask> {
  await ensureTaskSheet(store);
  const record = await getTaskRecordById(store, taskId);
  if (!record) throw new Error('과제를 찾을 수 없습니다.');
  validateTaskUpdate(update);
  const title = update.title.trim();
  const description = update.description.trim();
  await store.updateCell('Tasks', record.rowNumber, 'title', title);
  await store.updateCell('Tasks', record.rowNumber, 'description', description);
  await store.updateCell('Tasks', record.rowNumber, 'reward', update.reward);
  await store.updateCell('Tasks', record.rowNumber, 'isActive', update.isActive ? 'TRUE' : 'FALSE');
  await store.updateCell('Tasks', record.rowNumber, 'sortOrder', update.sortOrder);
  const taskRows = await store.getRows('Tasks');
  const allowedStudentIds = normalizeUniqueIds(update.allowedStudentIds ?? []);
  if (taskRows[0]?.includes('allowedStudentIds')) await store.updateCell('Tasks', record.rowNumber, 'allowedStudentIds', allowedStudentIds.join(','));
  if (taskRows[0]?.includes('updatedAt')) await store.updateCell('Tasks', record.rowNumber, 'updatedAt', new Date().toISOString());
  return { taskId, title, description, reward: update.reward, isActive: update.isActive, sortOrder: update.sortOrder, allowedStudentIds };
}


export async function updateTaskDetailsBatch(store: SheetsStore, updates: TaskBatchUpdate[]): Promise<ClassTask[]> {
  await ensureTaskSheet(store);
  if (!Array.isArray(updates) || updates.length === 0) throw new Error('저장할 과제가 없습니다.');

  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const normalized = updates.map((update) => ({ ...update, taskId: update.taskId.trim() }));
  const duplicateIds = findDuplicates(normalized.map((update) => update.taskId));
  if (duplicateIds.length > 0) throw new Error(`중복된 과제 ID가 있습니다: ${duplicateIds.join(', ')}`);

  const taskRows = await store.getRows('Tasks');
  const hasUpdatedAt = taskRows[0]?.includes('updatedAt') ?? false;
  const now = new Date().toISOString();
  const cellUpdates: SheetCellUpdate[] = [];
  const tasks: ClassTask[] = [];

  for (const update of normalized) {
    validateTaskId(update.taskId);
    validateTaskUpdate(update);
    const record = recordsById.get(update.taskId);
    if (!record) throw new Error(`과제를 찾을 수 없습니다: ${update.taskId}`);

    const title = update.title.trim();
    const description = update.description.trim();
    cellUpdates.push(
      { rowNumber: record.rowNumber, columnName: 'title', value: title },
      { rowNumber: record.rowNumber, columnName: 'description', value: description },
      { rowNumber: record.rowNumber, columnName: 'reward', value: update.reward },
      { rowNumber: record.rowNumber, columnName: 'isActive', value: update.isActive ? 'TRUE' : 'FALSE' },
      { rowNumber: record.rowNumber, columnName: 'sortOrder', value: update.sortOrder },
    );
    const allowedStudentIds = normalizeUniqueIds(update.allowedStudentIds ?? []);
    const hasAllowedStudentIds = taskRows[0]?.includes('allowedStudentIds') ?? false;
    if (hasAllowedStudentIds) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'allowedStudentIds', value: allowedStudentIds.join(',') });
    if (hasUpdatedAt) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'updatedAt', value: now });
    tasks.push({ taskId: update.taskId, title, description, reward: update.reward, isActive: update.isActive, sortOrder: update.sortOrder, allowedStudentIds });
  }

  await applyCellUpdates(store, 'Tasks', cellUpdates);
  return tasks.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

export async function deleteTasksBatch(store: SheetsStore, taskIds: string[]): Promise<{ taskIds: string[]; deletedCompletionCount: number }> {
  const uniqueIds = normalizeUniqueIds(taskIds);
  if (uniqueIds.length === 0) throw new Error('선택된 과제가 없습니다.');
  if (!store.deleteRows) throw new Error('현재 Sheets 저장소가 여러 행 삭제를 지원하지 않습니다.');

  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const missingIds = uniqueIds.filter((taskId) => !recordsById.has(taskId));
  if (missingIds.length > 0) throw new Error(`과제를 찾을 수 없습니다: ${missingIds.join(', ')}`);

  const deletedCompletionCount = await deleteTaskCompletionRowsForTaskIds(store, uniqueIds);
  await store.deleteRows('Tasks', uniqueIds.map((taskId) => recordsById.get(taskId)!.rowNumber));
  return { taskIds: uniqueIds, deletedCompletionCount };
}

export async function resetTaskCompletionsBatch(store: SheetsStore, taskIds: string[]): Promise<{ taskIds: string[]; deletedCount: number }> {
  const uniqueIds = normalizeUniqueIds(taskIds);
  if (uniqueIds.length === 0) throw new Error('선택된 과제가 없습니다.');
  if (!store.deleteRows) throw new Error('현재 Sheets 저장소가 여러 행 삭제를 지원하지 않습니다.');
  await ensureTaskSheet(store);
  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const missingIds = uniqueIds.filter((taskId) => !recordsById.has(taskId));
  if (missingIds.length > 0) throw new Error(`과제를 찾을 수 없습니다: ${missingIds.join(', ')}`);
  const deletedCount = await deleteTaskCompletionRowsForTaskIds(store, uniqueIds);
  const taskRows = await store.getRows('Tasks');
  if (taskRows[0]?.includes('allowedStudentIds')) {
    await applyCellUpdates(store, 'Tasks', uniqueIds.map((taskId) => ({
      rowNumber: recordsById.get(taskId)!.rowNumber,
      columnName: 'allowedStudentIds',
      value: '',
    })));
  }
  return { taskIds: uniqueIds, deletedCount };
}

export async function deleteTask(store: SheetsStore, taskId: string): Promise<{ taskId: string; deletedCompletionCount: number }> {
  const record = await getTaskRecordById(store, taskId);
  if (!record) throw new Error('과제를 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');
  const deletedCompletionCount = await deleteTaskCompletionRowsForTaskIds(store, [taskId]);
  await store.deleteRow('Tasks', record.rowNumber);
  return { taskId, deletedCompletionCount };
}

async function deleteTaskCompletionRowsForTaskIds(store: SheetsStore, taskIds: string[]): Promise<number> {
  await ensureTaskCompletionSheet(store);

  const rows = await store.getRows('TaskCompletions');
  const [headers, ...dataRows] = rows;
  if (!headers) return 0;

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_TASK_COMPLETION_COLUMNS, 'TaskCompletions');
  const taskIdIndex = headerIndex.get('taskId')!;
  const rowNumbers = dataRows
    .map((row, index) => taskIds.includes(String(row[taskIdIndex] ?? '').trim()) ? index + 2 : null)
    .filter((rowNumber): rowNumber is number => rowNumber !== null);

  return deleteTaskCompletionRowNumbers(store, rowNumbers);
}


async function deleteTaskCompletionRowNumbers(store: SheetsStore, rowNumbers: number[]): Promise<number> {
  if (rowNumbers.length === 0) return 0;
  if (store.deleteRows) {
    await store.deleteRows('TaskCompletions', rowNumbers);
  } else if (store.deleteRow) {
    for (const rowNumber of [...rowNumbers].sort((a, b) => b - a)) await store.deleteRow('TaskCompletions', rowNumber);
  } else {
    throw new Error('현재 Sheets 저장소가 완료 기록 삭제를 지원하지 않습니다.');
  }
  return rowNumbers.length;
}

export async function completeTaskForStudent(store: SheetsStore, taskId: string, studentId: string): Promise<TaskCompletionResult> {
  await ensureTaskSheet(store);
  await ensureTaskCompletionSheet(store);
  const task = await getTaskById(store, taskId.trim());
  if (!task || !task.isActive) throw new Error('완료할 수 있는 과제가 아닙니다.');
  const studentRecord = await getStudentRecordById(store, studentId.trim());
  if (!studentRecord || studentRecord.student.status !== 'ACTIVE') throw new Error('학생 정보를 찾을 수 없습니다.');
  if (task.allowedStudentIds.length === 0) throw new Error('부여된 학생이 없습니다.');
  if (!task.allowedStudentIds.includes(studentRecord.student.studentId)) throw new Error('허가되지 않은 과제입니다.');

  const completionRows = await store.getRows('TaskCompletions');
  const completions = parseTaskCompletions(completionRows);
  const policyResult = evaluateTaskCompletion({ task, student: studentRecord.student, completions });
  if (!policyResult.ok) throw new Error(policyResult.message);

  const balanceBefore = studentRecord.student.balance;
  const balanceAfter = policyResult.balanceAfter;
  const timestamp = new Date().toISOString();
  const completion: TaskCompletion = {
    completionId: `TC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    taskId: task.taskId,
    studentId: studentRecord.student.studentId,
    studentName: studentRecord.student.name,
    reward: task.reward,
    balanceBefore,
    balanceAfter,
    status: 'SUCCESS',
    note: 'bank-self-completion',
  };
  const completionHeaders = completionRows[0] ?? TASK_COMPLETION_HEADERS;
  let transactionHeaders = TRANSACTION_HEADERS;
  try {
    transactionHeaders = (await store.getRows('Transactions'))[0] ?? TRANSACTION_HEADERS;
  } catch {
    // Transaction logging is best effort; still try the canonical schema below.
  }

  await store.updateCell('Students', studentRecord.rowNumber, 'balance', balanceAfter);
  await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(completionHeaders, completion));
  const rewardTransaction: Transaction = {
    transactionId: `TASK-${completion.completionId}`,
    timestamp,
    studentId: completion.studentId,
    studentName: completion.studentName,
    items: [{ productId: task.taskId, name: task.title, price: -task.reward, quantity: 1, subtotal: -task.reward }],
    totalAmount: -task.reward,
    balanceBefore,
    balanceAfter,
    status: 'TASK_REWARD',
    operator: 'bank',
  };
  await store.appendRow('Transactions', buildTransactionAppendRow(transactionHeaders, rewardTransaction)).catch(() => undefined);

  return {
    task,
    student: { ...studentRecord.student, balance: balanceAfter },
    completion,
  };
}

export async function getTransactions(reader: SheetsReader): Promise<Transaction[]> {
  return (await getTransactionRecords(reader)).map((record) => record.transaction);
}

export async function getTransactionRecords(reader: SheetsReader): Promise<TransactionRecord[]> {
  return parseTransactionRecords(await reader.getRows('Transactions'));
}

function parseTransactionRecords(rows: string[][]): TransactionRecord[] {
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_TRANSACTION_COLUMNS, 'Transactions');

  const records = dataRows
    .map((row, index) => {
      const transaction = parseTransactionRow(row, headerIndex);
      return transaction ? { transaction, rowNumber: index + 2 } : null;
    })
    .filter((record): record is TransactionRecord => record !== null);

  const cancelledAtByOriginalId = new Map<string, string>();
  for (const record of records) {
    const originalId = record.transaction.operator.startsWith('cancel:') ? record.transaction.operator.slice('cancel:'.length) : '';
    if (originalId) cancelledAtByOriginalId.set(originalId, record.transaction.timestamp);
  }

  return records
    .map((record) => ({
      ...record,
      transaction: record.transaction.status === 'CANCELLED' && cancelledAtByOriginalId.has(record.transaction.transactionId)
        ? { ...record.transaction, cancelledAt: cancelledAtByOriginalId.get(record.transaction.transactionId) }
        : record.transaction,
    }))
    .sort((a, b) => b.transaction.timestamp.localeCompare(a.transaction.timestamp));
}

export async function cancelTransaction(store: SheetsStore, transactionId: string): Promise<{ cancelledTransaction: Transaction; reversalTransaction: Transaction }> {
  const normalizedId = transactionId.trim();
  if (!normalizedId) throw new Error('거래 ID를 입력해 주세요.');

  const transactionRows = await store.getRows('Transactions');
  const transactionRecord = parseTransactionRecords(transactionRows).find((record) => record.transaction.transactionId === normalizedId);
  if (!transactionRecord) throw new Error('거래 내역을 찾을 수 없습니다.');

  const transaction = transactionRecord.transaction;
  if (transaction.status === 'CANCELLED') throw new Error('이미 취소된 거래입니다.');

  const studentRecord = await getStudentRecordById(store, transaction.studentId);
  if (!studentRecord) throw new Error('학생 정보를 찾을 수 없습니다.');

  const productsById = new Map((await getProductRecords(store)).map((record) => [record.product.productId, record]));
  const productUpdates: SheetCellUpdate[] = [];
  if (transaction.totalAmount > 0) {
    for (const item of transaction.items) {
      const productRecord = productsById.get(item.productId);
      if (productRecord) {
        productUpdates.push({ rowNumber: productRecord.rowNumber, columnName: 'stock', value: productRecord.product.stock + item.quantity });
      }
    }
  }

  const cancelledAt = new Date().toISOString();
  const reversalDelta = transaction.balanceBefore - transaction.balanceAfter;
  const reversalBalanceAfter = studentRecord.student.balance + reversalDelta;
  if (reversalBalanceAfter < 0) throw new Error('거래 취소 후 잔액은 0보다 작아질 수 없습니다.');
  const reversalTotalAmount = -reversalDelta;
  const reversalTransaction: Transaction = {
    transactionId: `CANCEL-${transaction.transactionId}-${Date.now().toString(36)}`,
    timestamp: cancelledAt,
    studentId: transaction.studentId,
    studentName: transaction.studentName,
    items: [{
      productId: `CANCEL-${transaction.transactionId}`,
      name: '거래 취소',
      price: reversalTotalAmount,
      quantity: 1,
      subtotal: reversalTotalAmount,
    }],
    totalAmount: reversalTotalAmount,
    balanceBefore: studentRecord.student.balance,
    balanceAfter: reversalBalanceAfter,
    status: 'CANCEL_REVERSAL',
    operator: `cancel:${transaction.transactionId}`,
  };

  await store.updateCell('Students', studentRecord.rowNumber, 'balance', reversalBalanceAfter);
  await applyCellUpdates(store, 'Products', productUpdates);
  await store.updateCell('Transactions', transactionRecord.rowNumber, 'status', 'CANCELLED');
  const transactionHeaders = transactionRows[0] ?? TRANSACTION_HEADERS;
  await store.appendRow('Transactions', buildTransactionAppendRow(transactionHeaders, reversalTransaction));

  return { cancelledTransaction: { ...transaction, status: 'CANCELLED', cancelledAt }, reversalTransaction };
}

export async function getSheetSettings(reader: SheetsReader): Promise<Record<string, string>> {
  const rows = await reader.getRows('Settings');
  const [headers, ...dataRows] = rows;

  if (!headers) return {};

  const headerIndex = createHeaderIndex(headers);
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || valueIndex === undefined) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  return Object.fromEntries(
    dataRows
      .map((row) => [String(row[keyIndex] ?? '').trim(), String(row[valueIndex] ?? '').trim()] as const)
      .filter(([key]) => Boolean(key)),
  );
}

export async function saveSheetSetting(store: SheetsStore, setting: SheetSetting): Promise<void> {
  const key = setting.key.trim();
  if (!key) throw new Error('설정 키를 입력해 주세요.');

  const rows = await store.getRows('Settings');
  const [headers, ...dataRows] = rows;

  if (!headers) {
    await store.appendRow('Settings', ['key', 'value']);
    await store.appendRow('Settings', [key, setting.value]);
    return;
  }

  const headerIndex = createHeaderIndex(headers);
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || valueIndex === undefined) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  const existingIndex = dataRows.findIndex((row) => String(row[keyIndex] ?? '').trim() === key);
  if (existingIndex >= 0) {
    await store.updateCell('Settings', existingIndex + 2, headers[valueIndex], setting.value);
    return;
  }

  await store.appendRow('Settings', headers.map((header) => {
    const normalizedHeader = header.trim();
    if (normalizedHeader === 'key') return key;
    if (normalizedHeader === 'value') return setting.value;
    return '';
  }));
}

export async function getProductRecords(reader: SheetsReader): Promise<ProductRecord[]> {
  const rows = await reader.getRows('Products');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_PRODUCT_COLUMNS, 'Products');

  return dataRows
    .map((row, index) => {
      const product = parseProductRow(row, headerIndex);
      return product ? { product, rowNumber: index + 2 } : null;
    })
    .filter((record): record is ProductRecord => Boolean(record))
    .sort((a, b) => a.product.sortOrder - b.product.sortOrder || a.product.name.localeCompare(b.product.name));
}

export async function createStudent(store: SheetsStore, create: StudentCreate): Promise<Student> {
  const studentId = create.studentId.trim();
  validateStudentId(studentId);
  validateStudentUpdate(create);

  if (await getStudentById(store, studentId)) {
    throw new Error('이미 존재하는 학생 ID입니다.');
  }

  const student: Student = {
    studentId,
    name: create.name.trim(),
    balance: create.balance,
    status: create.status,
  };

  const studentRow = buildStudentAppendRow((await store.getRows('Students'))[0], student);
  await store.appendRow('Students', studentRow);

  return student;
}

export async function updateStudentDetails(store: SheetsStore, studentId: string, update: StudentUpdate): Promise<Student> {
  const record = await getStudentRecordById(store, studentId);

  if (!record) {
    throw new Error('학생을 찾을 수 없습니다.');
  }

  validateStudentUpdate(update);

  const name = update.name.trim();
  await store.updateCell('Students', record.rowNumber, 'name', name);
  await store.updateCell('Students', record.rowNumber, 'balance', update.balance);
  await store.updateCell('Students', record.rowNumber, 'status', update.status);

  return { studentId, name, balance: update.balance, status: update.status };
}

export async function updateStudentDetailsBatch(store: SheetsStore, updates: StudentBatchUpdate[]): Promise<Student[]> {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error('저장할 학생이 없습니다.');

  const rows = await store.getRows('Students');
  const recordsById = getStudentRecordsFromRows(rows);
  const normalized = updates.map((update) => ({ ...update, studentId: update.studentId.trim() }));
  const duplicateIds = findDuplicates(normalized.map((update) => update.studentId));
  if (duplicateIds.length > 0) throw new Error(`중복된 학생 ID가 있습니다: ${duplicateIds.join(', ')}`);

  const cellUpdates: SheetCellUpdate[] = [];
  const students: Student[] = [];
  for (const update of normalized) {
    validateStudentId(update.studentId);
    validateStudentUpdate(update);
    const record = recordsById.get(update.studentId);
    if (!record) throw new Error(`학생을 찾을 수 없습니다: ${update.studentId}`);

    const name = update.name.trim();
    cellUpdates.push(
      { rowNumber: record.rowNumber, columnName: 'name', value: name },
      { rowNumber: record.rowNumber, columnName: 'balance', value: update.balance },
      { rowNumber: record.rowNumber, columnName: 'status', value: update.status },
    );
    students.push({ studentId: update.studentId, name, balance: update.balance, status: update.status });
  }

  await applyCellUpdates(store, 'Students', cellUpdates);
  return students;
}

export async function deleteStudent(store: SheetsStore, studentId: string): Promise<{ studentId: string }> {
  const record = await getStudentRecordById(store, studentId);
  if (!record) throw new Error('학생을 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');

  await store.deleteRow('Students', record.rowNumber);
  return { studentId };
}

export async function deleteStudentsBatch(store: SheetsStore, studentIds: string[]): Promise<{ studentIds: string[] }> {
  const uniqueIds = normalizeUniqueIds(studentIds);
  if (uniqueIds.length === 0) throw new Error('선택된 학생이 없습니다.');
  if (!store.deleteRows) throw new Error('현재 Sheets 저장소가 여러 행 삭제를 지원하지 않습니다.');

  const rows = await store.getRows('Students');
  const recordsById = getStudentRecordsFromRows(rows);
  const missingIds = uniqueIds.filter((studentId) => !recordsById.has(studentId));
  if (missingIds.length > 0) throw new Error(`학생을 찾을 수 없습니다: ${missingIds.join(', ')}`);

  await store.deleteRows('Students', uniqueIds.map((studentId) => recordsById.get(studentId)!.rowNumber));
  return { studentIds: uniqueIds };
}

export async function bulkAdjustStudentBalances(
  store: SheetsStore,
  update: StudentBulkBalanceUpdate,
): Promise<Array<{ studentId: string; balance: number }>> {
  validateStudentBulkBalanceUpdate(update);

  const uniqueIds = Array.from(new Set(update.studentIds.map((id) => id.trim()).filter(Boolean)));
  const records = await Promise.all(uniqueIds.map((studentId) => getStudentRecordById(store, studentId)));
  const missingIds = uniqueIds.filter((_, index) => !records[index]);
  if (missingIds.length > 0) throw new Error(`학생을 찾을 수 없습니다: ${missingIds.join(', ')}`);

  const results: Array<{ studentId: string; balance: number }> = [];
  const cellUpdates: SheetCellUpdate[] = [];
  for (const record of records) {
    if (!record) continue;
    const balance =
      update.mode === 'set'
        ? update.amount
        : update.mode === 'add'
          ? record.student.balance + update.amount
          : record.student.balance - update.amount;

    cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'balance', value: balance });
    results.push({ studentId: record.student.studentId, balance });
  }

  let transactionHeaders = TRANSACTION_HEADERS;
  try {
    transactionHeaders = (await store.getRows('Transactions'))[0] ?? TRANSACTION_HEADERS;
  } catch {
    // Preserve bulk-adjustment availability by appending with the canonical schema.
  }
  await applyCellUpdates(store, 'Students', cellUpdates);
  for (const record of records) {
    if (!record) continue;
    const result = results.find((item) => item.studentId === record.student.studentId);
    if (!result) continue;
    await appendBalanceAdjustmentTransaction(store, transactionHeaders, record.student, record.student.balance, result.balance, update.mode);
  }
  return results;
}

export async function createProduct(store: SheetsStore, create: ProductCreate): Promise<Product> {
  const productId = create.productId.trim();
  validateProductId(productId);
  validateProductUpdate(create);

  if ((await getProductRecords(store)).some(({ product }) => product.productId === productId)) {
    throw new Error('이미 존재하는 상품 ID입니다.');
  }

  const imageUrl = create.imageUrl?.trim() || undefined;
  const category = create.category?.trim() || undefined;
  const product: Product = {
    productId,
    name: create.name.trim(),
    price: create.price,
    stock: create.stock,
    isActive: create.isActive,
    imageUrl,
    category,
    sortOrder: create.sortOrder,
  };

  await store.appendRow('Products', [
    product.productId,
    product.name,
    String(product.price),
    String(product.stock),
    product.isActive ? 'TRUE' : 'FALSE',
    product.imageUrl ?? '',
    product.category ?? '',
    String(product.sortOrder),
  ]);

  return product;
}

export async function updateProductDetails(store: SheetsStore, productId: string, update: ProductUpdate): Promise<Product> {
  const record = (await getProductRecords(store)).find(({ product }) => product.productId === productId);

  if (!record) {
    throw new Error('상품을 찾을 수 없습니다.');
  }

  validateProductUpdate(update);

  const name = update.name.trim();
  const imageUrl = update.imageUrl?.trim() || undefined;
  const category = update.category?.trim() || undefined;
  await store.updateCell('Products', record.rowNumber, 'name', name);
  await store.updateCell('Products', record.rowNumber, 'price', update.price);
  await store.updateCell('Products', record.rowNumber, 'stock', update.stock);
  await store.updateCell('Products', record.rowNumber, 'isActive', update.isActive ? 'TRUE' : 'FALSE');
  await store.updateCell('Products', record.rowNumber, 'imageUrl', imageUrl ?? '');
  await store.updateCell('Products', record.rowNumber, 'category', category ?? '');
  await store.updateCell('Products', record.rowNumber, 'sortOrder', update.sortOrder);

  return {
    ...record.product,
    name,
    price: update.price,
    stock: update.stock,
    isActive: update.isActive,
    imageUrl,
    category,
    sortOrder: update.sortOrder,
  };
}

export async function updateProductDetailsBatch(store: SheetsStore, updates: ProductBatchUpdate[]): Promise<Product[]> {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error('저장할 상품이 없습니다.');

  const recordsById = new Map((await getProductRecords(store)).map((record) => [record.product.productId, record]));
  const normalized = updates.map((update) => ({ ...update, productId: update.productId.trim() }));
  const duplicateIds = findDuplicates(normalized.map((update) => update.productId));
  if (duplicateIds.length > 0) throw new Error(`중복된 상품 ID가 있습니다: ${duplicateIds.join(', ')}`);

  const cellUpdates: SheetCellUpdate[] = [];
  const products: Product[] = [];
  for (const update of normalized) {
    validateProductId(update.productId);
    validateProductUpdate(update);
    const record = recordsById.get(update.productId);
    if (!record) throw new Error(`상품을 찾을 수 없습니다: ${update.productId}`);

    const name = update.name.trim();
    const imageUrl = update.imageUrl?.trim() || undefined;
    const category = update.category?.trim() || undefined;
    cellUpdates.push(
      { rowNumber: record.rowNumber, columnName: 'name', value: name },
      { rowNumber: record.rowNumber, columnName: 'price', value: update.price },
      { rowNumber: record.rowNumber, columnName: 'stock', value: update.stock },
      { rowNumber: record.rowNumber, columnName: 'isActive', value: update.isActive ? 'TRUE' : 'FALSE' },
      { rowNumber: record.rowNumber, columnName: 'imageUrl', value: imageUrl ?? '' },
      { rowNumber: record.rowNumber, columnName: 'category', value: category ?? '' },
      { rowNumber: record.rowNumber, columnName: 'sortOrder', value: update.sortOrder },
    );
    products.push({
      ...record.product,
      productId: update.productId,
      name,
      price: update.price,
      stock: update.stock,
      isActive: update.isActive,
      imageUrl,
      category,
      sortOrder: update.sortOrder,
    });
  }

  await applyCellUpdates(store, 'Products', cellUpdates);
  return products.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function deleteProduct(store: SheetsStore, productId: string): Promise<{ productId: string }> {
  const record = (await getProductRecords(store)).find(({ product }) => product.productId === productId);
  if (!record) throw new Error('상품을 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');

  await store.deleteRow('Products', record.rowNumber);
  return { productId };
}

export async function deleteProductsBatch(store: SheetsStore, productIds: string[]): Promise<{ productIds: string[] }> {
  const uniqueIds = normalizeUniqueIds(productIds);
  if (uniqueIds.length === 0) throw new Error('선택된 상품이 없습니다.');
  if (!store.deleteRows) throw new Error('현재 Sheets 저장소가 여러 행 삭제를 지원하지 않습니다.');

  const recordsById = new Map((await getProductRecords(store)).map((record) => [record.product.productId, record]));
  const missingIds = uniqueIds.filter((productId) => !recordsById.has(productId));
  if (missingIds.length > 0) throw new Error(`상품을 찾을 수 없습니다: ${missingIds.join(', ')}`);

  await store.deleteRows('Products', uniqueIds.map((productId) => recordsById.get(productId)!.rowNumber));
  return { productIds: uniqueIds };
}

async function appendBalanceAdjustmentTransaction(
  store: SheetsStore,
  transactionHeaders: string[],
  student: Student,
  balanceBefore: number,
  balanceAfter: number,
  mode: StudentBulkBalanceMode,
): Promise<void> {
  const delta = balanceAfter - balanceBefore;
  if (delta === 0 && mode !== 'set') return;
  const timestamp = new Date().toISOString();
  const label = mode === 'add' ? '관리자 지급' : mode === 'subtract' ? '관리자 회수' : '관리자 잔액 지정';
  const transactionAmount = -delta;
  const item = {
    productId: `ADMIN-${mode.toUpperCase()}`,
    name: label,
    price: transactionAmount,
    quantity: 1,
    subtotal: transactionAmount,
  };
  const transaction: Transaction = {
    transactionId: `ADMIN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    studentId: student.studentId,
    studentName: student.name,
    items: [item],
    totalAmount: transactionAmount,
    balanceBefore,
    balanceAfter,
    status: 'ADMIN_ADJUSTMENT',
    operator: 'admin',
  };
  await store.appendRow('Transactions', buildTransactionAppendRow(transactionHeaders, transaction));
}

function buildStudentAppendRow(headers: string[] | undefined, student: Student): string[] {
  if (!headers || headers.length === 0) {
    return [student.studentId, student.name, String(student.balance), student.status];
  }

  const valuesByColumn: Record<string, string> = {
    studentId: student.studentId,
    name: student.name,
    balance: String(student.balance),
    qrValue: student.studentId,
    status: student.status,
    note: '',
  };

  return headers.map((header) => valuesByColumn[header.trim()] ?? '');
}

function getStudentRecordsFromRows(rows: string[][]): Map<string, StudentRecord> {
  const [headers, ...dataRows] = rows;
  const records = new Map<string, StudentRecord>();
  if (!headers) return records;

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');
  dataRows.forEach((row, index) => {
    const student = parseStudentRow(row, headerIndex);
    if (student) records.set(student.studentId, { student, rowNumber: index + 2 });
  });
  return records;
}

async function applyCellUpdates(store: SheetsStore, sheetName: SheetName, updates: SheetCellUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  if (store.updateCells) {
    await store.updateCells(sheetName, updates);
    return;
  }

  for (const update of updates) {
    await store.updateCell(sheetName, update.rowNumber, update.columnName, update.value);
  }
}

function normalizeUniqueIds(ids: string[]): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean)));
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return Array.from(duplicates);
}

function validateStudentId(studentId: string) {
  if (!studentId) throw new Error('학생 ID를 입력해 주세요.');
}

function validateStudentUpdate(update: StudentUpdate) {
  if (!update.name.trim()) throw new Error('학생 이름을 입력해 주세요.');
  if (!Number.isInteger(update.balance)) throw new Error('잔액은 정수여야 합니다.');
  if (update.status !== 'ACTIVE' && update.status !== 'INACTIVE') throw new Error('학생 상태가 올바르지 않습니다.');
}

function validateStudentBulkBalanceUpdate(update: StudentBulkBalanceUpdate) {
  if (!Array.isArray(update.studentIds) || update.studentIds.length === 0) throw new Error('선택된 학생이 없습니다.');
  if (update.mode !== 'set' && update.mode !== 'add' && update.mode !== 'subtract') throw new Error('일괄 작업 방식이 올바르지 않습니다.');
  if (!Number.isInteger(update.amount) || update.amount < 0) throw new Error('금액은 0 이상의 정수여야 합니다.');
}

function validateProductId(productId: string) {
  if (!productId) throw new Error('상품 ID를 입력해 주세요.');
}

function validateProductUpdate(update: ProductUpdate) {
  if (!update.name.trim()) throw new Error('상품명을 입력해 주세요.');
  if (!Number.isInteger(update.price) || update.price < 0) throw new Error('가격은 0 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.stock) || update.stock < 0) throw new Error('재고는 0 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.sortOrder)) throw new Error('정렬 순서는 정수여야 합니다.');
}


async function ensureTaskSheet(store: SheetsStore): Promise<void> {
  const rows = await store.getRows('Tasks');
  const headers = rows[0];
  if (!headers) {
    await store.appendRow('Tasks', TASK_HEADERS);
    return;
  }

  await ensureSheetHeaders(store, 'Tasks', TASK_HEADERS, headers);
}

async function ensureTaskCompletionSheet(store: SheetsStore): Promise<void> {
  const rows = await store.getRows('TaskCompletions');
  const headers = rows[0];
  if (!headers) {
    await store.appendRow('TaskCompletions', TASK_COMPLETION_HEADERS);
    return;
  }

  await ensureSheetHeaders(store, 'TaskCompletions', TASK_COMPLETION_HEADERS, headers);
}

async function ensureSheetHeaders(store: SheetsStore, sheetName: SheetName, requiredHeaders: string[], currentHeaders: string[]): Promise<void> {
  const normalizedCurrent = currentHeaders.map((header) => header.trim()).filter(Boolean);
  const missingHeaders = requiredHeaders.filter((header) => !normalizedCurrent.includes(header));
  if (missingHeaders.length === 0) return;
  if (!store.updateHeaderRow) {
    throw new Error(`${sheetName} 시트에 새 기능용 컬럼이 없습니다: ${missingHeaders.join(', ')}`);
  }
  await store.updateHeaderRow(sheetName, [...normalizedCurrent, ...missingHeaders]);
}

function validateTaskId(taskId: string) {
  if (!taskId) throw new Error('과제 ID를 입력해 주세요.');
}

function validateTaskUpdate(update: TaskUpdate) {
  if (!update.title.trim()) throw new Error('과제명을 입력해 주세요.');
  if (!Number.isInteger(update.reward) || update.reward < 0) throw new Error('보상은 0 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.sortOrder)) throw new Error('정렬 순서는 정수여야 합니다.');
}

function assertVersionedTaskScheduleHeaders(headerIndex: ReadonlyMap<string, number>): boolean {
  const presentCount = VERSIONED_TASK_SCHEDULE_HEADERS
    .filter((header) => headerIndex.has(header))
    .length;
  if (presentCount > 0 && presentCount < VERSIONED_TASK_SCHEDULE_HEADERS.length) {
    throw new Error('Tasks 시트의 versioned schedule 헤더가 불완전합니다.');
  }
  return presentCount === VERSIONED_TASK_SCHEDULE_HEADERS.length;
}

function assertRequiredColumns(
  headerIndex: Map<string, number>,
  requiredColumns: readonly string[],
  sheetName: SheetName,
) {
  const result = requireColumns(headerIndex, requiredColumns);

  if (result.ok === false) {
    throw new Error(`${sheetName} 시트에 필수 컬럼이 없습니다: ${result.missingColumns.join(', ')}`);
  }
}
