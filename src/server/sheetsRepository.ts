import type { ClassTask, Product, Student, TaskAssignmentStatus, TaskCompletion, TaskCompletionEvidence, TaskRecurrence, Transaction } from '@/domain/types';
import {
  DEFAULT_CLASS_TIME_ZONE,
  normalizeLegacyTimeZone,
  serializeTaskScheduleCells,
} from '@/domain/taskSchedule';
import type { TaskCycleState } from '@/domain/taskCycleState';
import { isTaskAvailable, validateTaskAvailability } from '@/domain/taskAvailability';
import { validateTaskPrerequisiteGraph } from '@/domain/taskPrerequisite';
import {
  mutateTaskAssignmentNow,
  updateTaskAssignmentsBatch,
  type TaskBatchAssignmentOperation,
  type TaskBatchAssignmentTarget,
} from '@/server/repositories/sheets/taskAssignmentCommands';
export { updateTaskAssignmentsBatch };
export type { TaskBatchAssignmentOperation, TaskBatchAssignmentTarget };
import { mutateTaskCompletion, mutateTaskCompletionNow } from '@/server/repositories/sheets/taskCompletionCommands';
import {
  prepareImmediateTaskScheduleState,
  updateTaskSchedulesBatch,
} from '@/server/repositories/sheets/taskScheduleCommands';
export { updateTaskSchedulesBatch };
import { enqueueTaskCommand, taskCommandQueueKey } from '@/server/repositories/sheets/taskCommandQueue';
import {
  migrateRecurringTaskSchema,
  TASK_ASSIGNMENT_HEADERS,
  TASK_COMPLETION_SCHEMA_HEADERS,
  TASK_SCHEMA_HEADERS,
} from '@/server/repositories/sheets/recurringSchemaMigrator';
import {
  readTaskCycleHistory,
  readTaskCycleState,
  readTaskCompletionsFresh,
  type TaskCycleHistoryEvent,
} from '@/server/repositories/sheets/taskCycleQueries';
import {
  buildTaskAppendRow,

  buildTransactionAppendRow,
  createHeaderIndex,
  isCheckoutLineSnapshot,
  parseProductRow,
  parseStudentRow,
  parseTaskCompletionRow,
  parseTaskRow,
  parseTransactionRow,
  requireColumns,
  REQUIRED_TASK_COMPLETION_COLUMNS,
} from '@/server/sheetsRows';
import { emitOperationStage } from '@/server/operationTelemetry';
import type { StudentTaskProjectionDto } from '@/server/studentTaskProjection';
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

export type TaskScheduleEdit = {
  recurrence: TaskRecurrence;
  timeZone: string;
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
};

export type TaskUpdate = {
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds?: string[];
  availableFrom?: string;
  dueAt?: string;
  prerequisiteTaskId?: string;
  padletBoardId?: string;
  schedule?: TaskScheduleEdit;
};

export type TaskCreate = TaskUpdate & {
  taskId: string;
};

export type TaskCompletionResult = {
  task: ClassTask;
  student: Student;
  completion: TaskCompletion;
  tasks?: StudentTaskProjectionDto[];
  operation?: { operationId: string; state: 'SUCCESS' };
};

export type TaskCompletionOperation = {
  requestId: string;
  operationId: string;
  operationPayloadHash: string;
  evidence?: TaskCompletionEvidence;
  resolveEvidence?: (context: {
    task: ClassTask;
    student: Student;
    now: string;
  }) => Promise<TaskCompletionEvidence>;
  buildSafeProjection: (now: string, student: Student) => Promise<StudentTaskProjectionDto[]>;
};

export type StudentBulkBalanceMode = 'set' | 'add' | 'subtract';

export type StudentBulkBalanceUpdate = {
  studentIds: string[];
  mode: StudentBulkBalanceMode;
  amount: number;
  operationId: string;
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

export async function verifyRequiredOperationalSheetHeaders(reader: SheetsReader): Promise<void> {
  const [studentRows, productRows] = await Promise.all([
    reader.getRows('Students'),
    reader.getRows('Products'),
  ]);
  assertRequiredSheetHeaders(studentRows, REQUIRED_STUDENT_COLUMNS, 'Students');
  assertRequiredSheetHeaders(productRows, REQUIRED_PRODUCT_COLUMNS, 'Products');
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
  assigned?: boolean;
  completed?: boolean;
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
    cycleId: cycleState.cycle.cycleId,
    startsAt: cycleState.cycle.startsAt,
    endsAt: cycleState.cycle.endsAt,
    transition: cycleState.transition,
    students: students.map((student) => {
      const projected = cycleState.students[student.studentId];
      return {
        studentId: student.studentId,
        name: student.name,
        assigned: projected?.assigned ?? false,
        completed: projected?.completed ?? false,
        assignmentOrigin: projected?.assignmentOrigin ?? 'DEFAULT',
        ...(projected?.assignmentEvent?.source ? { assignmentSource: projected.assignmentEvent.source } : {}),
        completionOrigin: projected?.completionOrigin ?? 'DEFAULT',
      };
    }),
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
  if (update.completed !== undefined && update.source !== 'ADMIN') {
    throw new Error('QR 요청은 완료 상태를 변경할 수 없습니다.');
  }
  const studentRecord = update.completed !== undefined
    ? await getStudentRecordById(store, student.studentId)
    : null;
  const queueKey = taskCommandQueueKey(record.task.taskId, record.task.taskInstanceId);

  return enqueueTaskCommand(queueKey, async () => {
    let legacyMirrorWarning: string | undefined;
    const mutateAssignment = async () => {
      if (update.assigned === undefined) return;
      const mutation = await mutateTaskAssignmentNow(store, {
        task: record.task,
        taskRowNumber: record.rowNumber,
        studentId: student.studentId,
        assigned: update.assigned,
        source: update.source,
      });
      legacyMirrorWarning = mutation.legacyMirrorWarning;
    };
    const mutateCompletion = async () => {
      if (update.completed === undefined || !studentRecord) return;
      await mutateTaskCompletionNow({
        store,
        task: record.task,
        taskRowNumber: record.rowNumber,
        student,
        studentRowNumber: studentRecord.rowNumber,
        completed: update.completed,
        source: 'ADMIN',
      });
    };

    // A reset needs the old assignment; a completion needs the new assignment. Keep both
    // dependency-ordered operations in this one process-global task-mutation queue command.
    if (update.assigned === false && update.completed !== undefined) {
      await mutateCompletion();
      await mutateAssignment();
    } else {
      await mutateAssignment();
      await mutateCompletion();
    }

    const status: TaskAssignmentMutationStatus = await getTaskAssignmentStatus(store, record.task.taskId);
    if (legacyMirrorWarning) status.legacyMirrorWarning = legacyMirrorWarning;
    return status;
  });
}

export async function createTask(store: SheetsStore, create: TaskCreate): Promise<ClassTask> {
  // Creation shares the process-global task command queue because both the Tasks header and
  // task IDs are shared resources. The Sheets provider still gives no cross-process CAS, so
  // uniqueness across multiple application instances remains outside this R1 guarantee.
  return enqueueTaskCommand(taskCommandQueueKey(create.taskId.trim()), () => createTaskNow(store, create));
}

async function createTaskNow(store: SheetsStore, create: TaskCreate): Promise<ClassTask> {
  const taskId = create.taskId.trim();
  validateTaskId(taskId);
  validateTaskUpdate(create);
  if (await getTaskById(store, taskId)) throw new Error('이미 존재하는 과제 ID입니다.');
  const existingTasks = await getTasks(store, { includeInactive: true });
  const availability = validateTaskAvailability(create);
  validateTaskPrerequisiteGraph([...existingTasks, { taskId, isActive: create.isActive, prerequisiteTaskId: create.prerequisiteTaskId?.trim() || undefined }]);
  await ensureTaskSheet(store);
  if (create.schedule !== undefined || ['availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId'].some((key) => Object.hasOwn(create, key))) {
    await migrateRecurringSchemaIfNeeded(requireRecurringSchemaMigrationStore(store));
  }
  const now = new Date().toISOString();
  const taskRows = await store.getRows('Tasks');
  const headers = taskRows[0] ?? TASK_HEADERS;
  const taskHeaderIndex = createHeaderIndex(headers);
  const hasVersionedScheduleColumns = assertVersionedTaskScheduleHeaders(taskHeaderIndex);
  let versionedSchedule: Pick<ClassTask, 'taskInstanceId' | 'schedule' | 'pendingSchedule'> | undefined;
  if (hasVersionedScheduleColumns) {
    versionedSchedule = {
      taskInstanceId: crypto.randomUUID(),
      schedule: {
        ruleVersion: 1,
        effectiveFrom: now,
        timeZone: DEFAULT_CLASS_TIME_ZONE,
        recurrence: create.schedule?.recurrence ?? { type: 'NONE' },
        resetCompletionOnCycle: create.schedule?.resetCompletionOnCycle ?? false,
        resetAssignmentOnCycle: create.schedule?.resetAssignmentOnCycle ?? false,
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
    ...availability,
    ...(create.prerequisiteTaskId?.trim() ? { prerequisiteTaskId: create.prerequisiteTaskId.trim() } : {}),
    ...(create.padletBoardId?.trim() ? { padletBoardId: create.padletBoardId.trim() } : {}),
    createdAt: now,
    ...versionedSchedule,
  };
  await store.appendRow('Tasks', buildTaskAppendRow(headers, task, now));
  return task;
}

export async function updateTaskDetails(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  update: TaskUpdate,
  editedAt?: string,
): Promise<ClassTask> {
  // This queue is deliberately process-local. The Sheets provider does not expose a CAS,
  // so this prevents stale schedule versions only among commands in this application process.
  return enqueueTaskCommand(taskCommandQueueKey(taskId), () =>
    updateTaskDetailsNow(store, taskId, update, editedAt ?? new Date().toISOString()));
}

export async function updateTaskSchedule(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  schedule: TaskScheduleEdit,
  editedAt?: string,
): Promise<ClassTask> {
  return enqueueTaskCommand(taskCommandQueueKey(taskId), async () => {
    const record = await getTaskRecordById(store, taskId);
    if (!record) throw new Error('과제를 찾을 수 없습니다.');
    return updateTaskDetailsNow(store, taskId, {
      title: record.task.title,
      description: record.task.description,
      reward: record.task.reward,
      isActive: record.task.isActive,
      sortOrder: record.task.sortOrder,
      allowedStudentIds: [...record.task.allowedStudentIds],
      schedule,
    }, editedAt ?? new Date().toISOString());
  });
}

export async function updateTaskScheduleSettings(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  settings: Pick<TaskUpdate, 'schedule' | 'availableFrom' | 'dueAt' | 'prerequisiteTaskId'> & { schedule: TaskScheduleEdit },
  editedAt?: string,
): Promise<ClassTask> {
  return enqueueTaskCommand(taskCommandQueueKey(taskId), async () => {
    const record = await getTaskRecordById(store, taskId);
    if (!record) throw new Error('과제를 찾을 수 없습니다.');
    return updateTaskDetailsNow(store, taskId, {
      title: record.task.title,
      description: record.task.description,
      reward: record.task.reward,
      isActive: record.task.isActive,
      sortOrder: record.task.sortOrder,
      allowedStudentIds: [...record.task.allowedStudentIds],
      ...settings,
    }, editedAt ?? new Date().toISOString());
  });
}

async function updateTaskDetailsNow(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  update: TaskUpdate,
  editedAt: string,
): Promise<ClassTask> {
  validateTaskUpdate(update);
  let record = await getTaskRecordById(store, taskId);
  if (!record) throw new Error('과제를 찾을 수 없습니다.');
  if (update.schedule !== undefined) assertPersistedScheduleIsEditable(record.task);
  const availability = validateTaskAvailability({
    availableFrom: Object.hasOwn(update, 'availableFrom') ? update.availableFrom : record.task.availableFrom,
    dueAt: Object.hasOwn(update, 'dueAt') ? update.dueAt : record.task.dueAt,
  });
  const prerequisiteTaskId = Object.hasOwn(update, 'prerequisiteTaskId')
    ? update.prerequisiteTaskId?.trim() || undefined
    : record.task.prerequisiteTaskId;
  const padletBoardId = Object.hasOwn(update, 'padletBoardId')
    ? update.padletBoardId?.trim() || undefined
    : record.task.padletBoardId;
  const allTasks = (await getTasks(store, { includeInactive: true }))
    .map((task) => task.taskId === taskId ? { ...task, isActive: update.isActive, prerequisiteTaskId } : task);
  validateTaskPrerequisiteGraph(allTasks);
  await ensureTaskSheet(store);

  const needsSchemaMigration = update.schedule !== undefined
    || ['availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId'].some((key) => Object.hasOwn(update, key));
  if (needsSchemaMigration) {
    await migrateRecurringSchemaIfNeeded(store);
    // Migration can replace the legacy projection. Re-read only after every validation that
    // can reject the command has completed without writes.
    record = await getTaskRecordById(store, taskId);
    if (!record) throw new Error('과제를 찾을 수 없습니다.');
  }
  let scheduleState = null;
  if (update.schedule !== undefined) {
    assertPersistedScheduleIsEditable(record.task);
    scheduleState = prepareImmediateScheduleState(record.task, update.schedule, editedAt);
  }
  const title = update.title.trim();
  const description = update.description.trim();
  const allowedStudentIds = normalizeUniqueIds(update.allowedStudentIds ?? []);
  const cellUpdates: SheetCellUpdate[] = [
    { rowNumber: record.rowNumber, columnName: 'title', value: title },
    { rowNumber: record.rowNumber, columnName: 'description', value: description },
    { rowNumber: record.rowNumber, columnName: 'reward', value: update.reward },
    { rowNumber: record.rowNumber, columnName: 'isActive', value: update.isActive ? 'TRUE' : 'FALSE' },
    { rowNumber: record.rowNumber, columnName: 'sortOrder', value: update.sortOrder },
  ];
  const taskRows = await store.getRows('Tasks');
  const headers = taskRows[0] ?? [];
  if (headers.includes('allowedStudentIds')) {
    cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'allowedStudentIds', value: allowedStudentIds.join(',') });
  }
  if (headers.includes('availableFrom')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'availableFrom', value: availability.availableFrom ?? '' });
  if (headers.includes('dueAt')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'dueAt', value: availability.dueAt ?? '' });
  if (headers.includes('prerequisiteTaskId')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'prerequisiteTaskId', value: prerequisiteTaskId ?? '' });
  if (headers.includes('padletBoardId') && Object.hasOwn(update, 'padletBoardId')) {
    cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'padletBoardId', value: padletBoardId ?? '' });
  }
  if (headers.includes('updatedAt')) {
    cellUpdates.push({
      rowNumber: record.rowNumber,
      columnName: 'updatedAt',
      value: scheduleState?.transitionAt ?? editedAt,
    });
  }

  if (scheduleState) {
    const cells = serializeTaskScheduleCells(scheduleState);
    for (const [columnName, value] of Object.entries(cells)) {
      cellUpdates.push({ rowNumber: record.rowNumber, columnName, value });
    }
  }
  await applyCellUpdates(store, 'Tasks', cellUpdates);
  return {
    ...(scheduleState ? record.task : withoutVersionedSchedule(record.task)),
    taskId,
    title,
    description,
    reward: update.reward,
    isActive: update.isActive,
    sortOrder: update.sortOrder,
    allowedStudentIds,
    ...availability,
    ...(prerequisiteTaskId ? { prerequisiteTaskId } : {}),
    ...(padletBoardId ? { padletBoardId } : Object.hasOwn(update, 'padletBoardId') ? { padletBoardId: undefined } : {}),
    ...(scheduleState ? {
      taskInstanceId: scheduleState.taskInstanceId,
      schedule: scheduleState.currentSchedule,
      pendingSchedule: scheduleState.pendingSchedule,
    } : {}),
  };
}


export async function updateTaskDetailsBatch(
  store: RecurringSchemaMigrationStore,
  updates: TaskBatchUpdate[],
  editedAt?: string,
): Promise<ClassTask[]> {
  // Batch and single edits use the same conservative process-global task-mutation key.
  return enqueueTaskCommand(taskCommandQueueKey(''), () =>
    updateTaskDetailsBatchNow(store, updates, editedAt ?? new Date().toISOString()));
}

async function updateTaskDetailsBatchNow(
  store: RecurringSchemaMigrationStore,
  updates: TaskBatchUpdate[],
  editedAt: string,
): Promise<ClassTask[]> {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error('저장할 과제가 없습니다.');
  const normalized = updates.map((update) => ({ ...update, taskId: update.taskId.trim() }));
  const duplicateIds = findDuplicates(normalized.map((update) => update.taskId));
  if (duplicateIds.length > 0) throw new Error(`중복된 과제 ID가 있습니다: ${duplicateIds.join(', ')}`);

  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  for (const update of normalized) {
    validateTaskId(update.taskId);
    validateTaskUpdate(update);
    const record = recordsById.get(update.taskId);
    if (!record) throw new Error(`과제를 찾을 수 없습니다: ${update.taskId}`);
    if (update.schedule !== undefined) assertPersistedScheduleIsEditable(record.task);
  }
  validateTaskPrerequisiteGraph(Array.from(recordsById.values(), ({ task }) => {
    const update = normalized.find((candidate) => candidate.taskId === task.taskId);
    return update ? {
      ...task,
      isActive: update.isActive,
      prerequisiteTaskId: Object.hasOwn(update, 'prerequisiteTaskId')
        ? update.prerequisiteTaskId?.trim() || undefined
        : task.prerequisiteTaskId,
    } : task;
  }));
  await ensureTaskSheet(store);
  const needsSchemaMigration = normalized.some((update) => update.schedule !== undefined
    || ['availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId'].some((key) => Object.hasOwn(update, key)));
  if (needsSchemaMigration) await migrateRecurringSchemaIfNeeded(store);

  // Re-read after any migration while still holding the process-local queue lock.
  const currentRecordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const scheduleStates = new Map<string, ReturnType<typeof prepareImmediateScheduleState>>();
  for (const update of normalized) {
    if (update.schedule === undefined) continue;
    const record = currentRecordsById.get(update.taskId);
    if (!record) throw new Error(`과제를 찾을 수 없습니다: ${update.taskId}`);
    assertPersistedScheduleIsEditable(record.task);
    scheduleStates.set(update.taskId, prepareImmediateScheduleState(record.task, update.schedule, editedAt));
  }

  const taskRows = await store.getRows('Tasks');
  const hasUpdatedAt = taskRows[0]?.includes('updatedAt') ?? false;
  const now = editedAt;
  const cellUpdates: SheetCellUpdate[] = [];
  const tasks: ClassTask[] = [];

  for (const update of normalized) {
    const record = currentRecordsById.get(update.taskId);
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
    const availability = validateTaskAvailability({
      availableFrom: Object.hasOwn(update, 'availableFrom') ? update.availableFrom : record.task.availableFrom,
      dueAt: Object.hasOwn(update, 'dueAt') ? update.dueAt : record.task.dueAt,
    });
    const prerequisiteTaskId = Object.hasOwn(update, 'prerequisiteTaskId')
      ? update.prerequisiteTaskId?.trim() || undefined
      : record.task.prerequisiteTaskId;
    const padletBoardId = Object.hasOwn(update, 'padletBoardId')
      ? update.padletBoardId?.trim() || undefined
      : record.task.padletBoardId;
    const hasAllowedStudentIds = taskRows[0]?.includes('allowedStudentIds') ?? false;
    if (hasAllowedStudentIds) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'allowedStudentIds', value: allowedStudentIds.join(',') });
    if (taskRows[0]?.includes('availableFrom')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'availableFrom', value: availability.availableFrom ?? '' });
    if (taskRows[0]?.includes('dueAt')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'dueAt', value: availability.dueAt ?? '' });
    if (taskRows[0]?.includes('prerequisiteTaskId')) cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'prerequisiteTaskId', value: prerequisiteTaskId ?? '' });
    if (taskRows[0]?.includes('padletBoardId') && Object.hasOwn(update, 'padletBoardId')) {
      cellUpdates.push({ rowNumber: record.rowNumber, columnName: 'padletBoardId', value: padletBoardId ?? '' });
    }
    const scheduleState = scheduleStates.get(update.taskId) ?? null;
    if (hasUpdatedAt) {
      cellUpdates.push({
        rowNumber: record.rowNumber,
        columnName: 'updatedAt',
        value: scheduleState?.transitionAt ?? now,
      });
    }
    if (scheduleState) {
      const cells = serializeTaskScheduleCells(scheduleState);
      for (const [columnName, value] of Object.entries(cells)) {
        cellUpdates.push({ rowNumber: record.rowNumber, columnName, value });
      }
    }
    tasks.push({
      ...(scheduleState ? record.task : withoutVersionedSchedule(record.task)),
      taskId: update.taskId,
      title,
      description,
      reward: update.reward,
      isActive: update.isActive,
      sortOrder: update.sortOrder,
      allowedStudentIds,
      ...availability,
      ...(prerequisiteTaskId ? { prerequisiteTaskId } : {}),
      ...(padletBoardId ? { padletBoardId } : Object.hasOwn(update, 'padletBoardId') ? { padletBoardId: undefined } : {}),
      ...(scheduleState ? {
        taskInstanceId: scheduleState.taskInstanceId,
        schedule: scheduleState.currentSchedule,
        pendingSchedule: scheduleState.pendingSchedule,
      } : {}),
    });
  }

  await applyCellUpdates(store, 'Tasks', cellUpdates);
  return tasks.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

export async function deleteTasksBatch(store: RecurringSchemaMigrationStore, taskIds: string[]): Promise<{ taskIds: string[]; deletedTaskCount: number; deletedCompletionCount: number }> {
  return enqueueTaskCommand(taskCommandQueueKey(''), () => deleteTasksBatchNow(store, taskIds));
}

async function deleteTasksBatchNow(store: RecurringSchemaMigrationStore, taskIds: string[]): Promise<{ taskIds: string[]; deletedTaskCount: number; deletedCompletionCount: number }> {
  const uniqueIds = normalizeUniqueIds(taskIds);
  if (uniqueIds.length === 0) throw new Error('선택된 과제가 없습니다.');
  if (!store.deleteRows) throw new Error('현재 Sheets 저장소가 여러 행 삭제를 지원하지 않습니다.');

  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const missingIds = uniqueIds.filter((taskId) => !recordsById.has(taskId));
  if (missingIds.length > 0) throw new Error(`과제를 찾을 수 없습니다: ${missingIds.join(', ')}`);
  assertNoRemainingTaskReferences(recordsById, new Set(uniqueIds));

  await store.deleteRows('Tasks', uniqueIds.map((taskId) => recordsById.get(taskId)!.rowNumber));
  // Assignment and completion rows are append-only audit ledgers and outlive the definition row.
  return { taskIds: uniqueIds, deletedTaskCount: uniqueIds.length, deletedCompletionCount: 0 };
}

export async function resetTaskCompletionsBatch(store: RecurringSchemaMigrationStore, taskIds: string[]): Promise<{ taskIds: string[]; resetEventsAppended: number; deletedCount: number }> {
  const uniqueIds = normalizeUniqueIds(taskIds);
  if (uniqueIds.length === 0) throw new Error('선택된 과제가 없습니다.');
  const recordsById = new Map((await getTaskRecords(store)).map((record) => [record.task.taskId, record]));
  const missingIds = uniqueIds.filter((taskId) => !recordsById.has(taskId));
  if (missingIds.length > 0) throw new Error(`과제를 찾을 수 없습니다: ${missingIds.join(', ')}`);

  await migrateRecurringSchemaIfNeeded(store);
  const studentsById = new Map((await getStudents(store)).map((student) => [student.studentId, student]));
  let resetCount = 0;
  for (const taskId of uniqueIds) {
    const record = recordsById.get(taskId)!;
    const cycleState = await readTaskCycleState(store, record.task, new Date().toISOString());
    for (const studentId of cycleState.completedStudentIds) {
      const student = studentsById.get(studentId);
      if (!student) continue;
      const studentRecord = await getStudentRecordById(store, studentId);
      if (!studentRecord) continue;
      const result = await mutateTaskCompletion({
        store,
        task: record.task,
        taskRowNumber: record.rowNumber,
        student,
        studentRowNumber: studentRecord.rowNumber,
        completed: false,
        source: 'ADMIN',
      });
      if (result.changed) resetCount += 1;
    }
  }
  // Keep the legacy property name while reporting appended reset events, never deletions.
  return { taskIds: uniqueIds, resetEventsAppended: resetCount, deletedCount: resetCount };
}

export async function deleteTask(store: RecurringSchemaMigrationStore, taskId: string): Promise<{ taskId: string; taskDefinitionDeleted: true; deletedCompletionCount: number }> {
  return enqueueTaskCommand(taskCommandQueueKey(''), () => deleteTaskNow(store, taskId));
}

async function deleteTaskNow(store: RecurringSchemaMigrationStore, taskId: string): Promise<{ taskId: string; taskDefinitionDeleted: true; deletedCompletionCount: number }> {
  const records = await getTaskRecords(store);
  const recordsById = new Map(records.map((candidate) => [candidate.task.taskId, candidate]));
  const record = recordsById.get(taskId);
  if (!record) throw new Error('과제를 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');
  assertNoRemainingTaskReferences(recordsById, new Set([taskId]));
  await store.deleteRow('Tasks', record.rowNumber);
  return { taskId, taskDefinitionDeleted: true, deletedCompletionCount: 0 };
}

function assertNoRemainingTaskReferences(
  recordsById: Map<string, { task: ClassTask; rowNumber: number }>,
  deletingTaskIds: Set<string>,
): void {
  const dependent = Array.from(recordsById.values()).find(({ task }) =>
    !deletingTaskIds.has(task.taskId)
      && Boolean(task.prerequisiteTaskId && deletingTaskIds.has(task.prerequisiteTaskId)));
  if (dependent) throw new Error(`선행 과제로 참조 중인 과제는 삭제할 수 없습니다: ${dependent.task.title}`);
}

export async function completeTaskForStudent(
  store: RecurringSchemaMigrationStore,
  taskId: string,
  studentId: string,
  operation?: TaskCompletionOperation,
): Promise<TaskCompletionResult> {
  return enqueueTaskCommand(taskCommandQueueKey(''), async () => {
    let schemaReady = false;
    if (store.primeRows) {
      await store.primeRows(['Tasks', 'Students', 'TaskAssignments', 'TaskCompletions']);
      const [taskRows, assignmentRows, completionRows] = await Promise.all([
        store.getRows('Tasks'), store.getRows('TaskAssignments'), store.getRows('TaskCompletions'),
      ]);
      schemaReady = TASK_SCHEMA_HEADERS.every((header) => taskRows[0]?.includes(header))
        && TASK_ASSIGNMENT_HEADERS.every((header) => assignmentRows[0]?.includes(header))
        && TASK_COMPLETION_SCHEMA_HEADERS.every((header) => completionRows[0]?.includes(header));
    }
    // Every decision that authorizes a reward is based on state re-read inside the same
    // process-global critical section immediately before the completion mutation.
    const existingOperation = operation
      ? (await readTaskCompletionsFresh(store)).some((event) => event.operationId === operation.operationId)
      : false;
    const record = await getTaskRecordById(store, taskId.trim());
    if (!record || (!existingOperation && !record.task.isActive)) throw new Error('완료할 수 있는 과제가 아닙니다.');
    const now = new Date().toISOString();
    if (!existingOperation && !isTaskAvailable(record.task, now)) throw new Error('현재 완료할 수 있는 과제가 아닙니다.');
    const studentRecord = await getStudentRecordById(store, studentId.trim());
    if (!studentRecord || (!existingOperation && studentRecord.student.status !== 'ACTIVE')) throw new Error('학생 정보를 찾을 수 없습니다.');
    if (!existingOperation && record.task.padletBoardId && !operation?.resolveEvidence) {
      throw new Error('PADLET_EVIDENCE_REQUIRED');
    }
    if (!existingOperation && record.task.prerequisiteTaskId) {
      const prerequisite = await getTaskById(store, record.task.prerequisiteTaskId);
      if (!prerequisite) throw new Error('선행 과제를 찾을 수 없습니다.');
      if (!prerequisite.isActive || !isTaskAvailable(prerequisite, now)) {
        throw new Error(`선행 과제 '${prerequisite.title}'은(는) 현재 완료할 수 없습니다.`);
      }
      const prerequisiteState = await readTaskCycleState(store, prerequisite, now);
      if (!(prerequisiteState.students[studentRecord.student.studentId]?.completed ?? false)) {
        throw new Error(`선행 과제 '${prerequisite.title}'을(를) 먼저 완료해 주세요.`);
      }
    }
    const mutation = await mutateTaskCompletionNow({
      store,
      task: record.task,
      taskRowNumber: record.rowNumber,
      student: studentRecord.student,
      studentRowNumber: studentRecord.rowNumber,
      completed: true,
      source: 'BANK',
      schemaReady,
      ...(operation ? {
        operationId: operation.operationId,
        operationPayloadHash: operation.operationPayloadHash,
        evidence: operation.evidence,
        ...(!existingOperation && operation.resolveEvidence ? {
          resolveEvidence: () => operation.resolveEvidence!({
            task: record.task,
            student: studentRecord.student,
            now,
          }),
        } : {}),
      } : {}),
      now,
    });
    if (!mutation.completion) throw new Error('과제 완료 처리에 실패했습니다.');
    const baseResult = {
      task: operation ? { ...record.task, reward: mutation.completion.reward } : record.task,
      student: { ...studentRecord.student, balance: mutation.balanceAfter },
      completion: mutation.completion,
    };
    if (!operation) return baseResult;
    const projectionStartedAt = Date.now();
    const tasks = await operation.buildSafeProjection(now, studentRecord.student);
    if (!Array.isArray(tasks)) throw new Error('과제 projection을 확인할 수 없습니다.');
    emitOperationStage({
      requestId: operation.requestId,
      operationId: operation.operationId,
      stage: 'safe_projection',
      durationMs: Date.now() - projectionStartedAt,
      resultCode: 'SUCCESS',
      retryCount: 0,
    });
    return {
      ...baseResult,
      tasks,
      operation: { operationId: operation.operationId, state: 'SUCCESS' },
    };
  }, operation ? {
    onStart: ({ queueWaitMs }) => emitOperationStage({
      requestId: operation.requestId,
      operationId: operation.operationId,
      stage: 'queue_wait',
      durationMs: queueWaitMs,
      resultCode: queueWaitMs >= 1_000 ? 'SLOW' : 'OK',
      retryCount: 0,
    }),
  } : undefined);
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

export async function cancelTransaction(
  store: SheetsStore,
  transactionId: string,
  operationId?: string,
): Promise<{ cancelledTransaction: Transaction; reversalTransaction: Transaction }> {
  const normalizedId = transactionId.trim();
  if (!normalizedId) throw new Error('거래 ID를 입력해 주세요.');

  const transactionRows = await store.getRows('Transactions');
  const records = parseTransactionRecords(transactionRows);
  const rawTransactionHeaders = transactionRows[0] ?? [];
  const transactionHeaderIndex = createHeaderIndex(rawTransactionHeaders);
  const transactionIdColumn = transactionHeaderIndex.get('transactionId') ?? -1;
  const operatorColumn = transactionHeaderIndex.get('operator') ?? -1;
  const rawRecords = transactionRows.slice(1).map((row, index) => ({ row, rowNumber: index + 2 }));
  const parsedByRowNumber = new Map(records.map((record) => [record.rowNumber, record.transaction]));
  const transactionRecord = records.find((record) => record.transaction.transactionId === normalizedId);
  if (!transactionRecord) throw new Error('거래 내역을 찾을 수 없습니다.');

  const transaction = transactionRecord.transaction;
  const deterministicReversalId = operationId ? `CANCEL-${operationId}` : null;
  const rawLinkedCandidates = rawRecords.filter(({ row }) => row[operatorColumn]?.trim() === `cancel:${normalizedId}`);
  if (rawLinkedCandidates.length > 1) {
    throw new Error('거래 취소 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.');
  }
  const rawLinkedCandidate = rawLinkedCandidates[0];
  const existingReversal = rawLinkedCandidate
    ? parsedByRowNumber.get(rawLinkedCandidate.rowNumber)
    : undefined;
  if (rawLinkedCandidate && !existingReversal) {
    throw new Error('거래 취소 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.');
  }
  if (deterministicReversalId) {
    const rawIdCollisions = rawRecords
      .filter(({ row }) => row[transactionIdColumn]?.trim() === deterministicReversalId);
    if (rawIdCollisions.length > 1) {
      throw new Error('취소 작업 ID 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.');
    }
    const rawIdCollision = rawIdCollisions[0];
    const idCollision = rawIdCollision
      ? parsedByRowNumber.get(rawIdCollision.rowNumber)
      : undefined;
    if (rawIdCollision && !idCollision) {
      throw new Error('취소 작업 ID 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.');
    }
    if (idCollision && idCollision.operator !== `cancel:${normalizedId}`) {
      throw new Error('취소 작업 ID가 다른 거래에 사용되었습니다.');
    }
    if (existingReversal) {
      validateSheetsCancellationReplay(transaction, existingReversal, deterministicReversalId);
      return {
        cancelledTransaction: { ...transaction, cancelledAt: existingReversal.timestamp },
        reversalTransaction: existingReversal,
      };
    }
  }
  if (existingReversal) {
    throw new Error('이미 취소된 거래이거나 취소 기록의 무결성을 확인할 수 없습니다.');
  }
  if (transaction.status === 'CANCELLED') throw new Error('이미 취소된 거래입니다.');
  if (transaction.status !== 'COMPLETED'
      && transaction.status !== 'TASK_REWARD'
      && transaction.status !== 'ADMIN_ADJUSTMENT') {
    throw new Error('취소할 수 없는 거래입니다.');
  }
  if (transaction.itemsMalformed) throw new Error('거래 상품 스냅샷이 올바르지 않습니다.');

  const studentRecord = await getStudentRecordById(store, transaction.studentId);
  if (!studentRecord) throw new Error('학생 정보를 찾을 수 없습니다.');

  const productsById = new Map((await getProductRecords(store)).map((record) => [record.product.productId, record]));
  if (transaction.status === 'COMPLETED') {
    const missingProductIds = transaction.items
      .map((item) => item.productId)
      .filter((productId) => !productsById.has(productId));
    if (missingProductIds.length > 0) {
      throw new Error(`거래 상품을 찾을 수 없어 수동 조정이 필요합니다: ${missingProductIds.join(', ')}`);
    }
  }
  const restoreQuantityByProductId = new Map<string, number>();
  for (const item of transaction.items) {
    if (!productsById.has(item.productId)) continue;
    const restoreQuantity = isCheckoutLineSnapshot(item) ? item.totalQuantity : item.quantity;
    restoreQuantityByProductId.set(
      item.productId,
      checkedSafeIntegerAddition(restoreQuantityByProductId.get(item.productId) ?? 0, restoreQuantity),
    );
  }
  const productUpdates: SheetCellUpdate[] = [];
  for (const [productId, restoreQuantity] of restoreQuantityByProductId) {
    const productRecord = productsById.get(productId)!;
    productUpdates.push({
      rowNumber: productRecord.rowNumber,
      columnName: 'stock',
      value: checkedSafeIntegerAddition(productRecord.product.stock, restoreQuantity),
    });
  }

  const cancelledAt = new Date().toISOString();
  const reversalDelta = transaction.balanceBefore - transaction.balanceAfter;
  if (!Number.isSafeInteger(reversalDelta)) throw new Error('Cancellation balance delta exceeds the safe integer range');
  const reversalBalanceAfter = checkedSafeIntegerAddition(studentRecord.student.balance, reversalDelta);
  if (reversalBalanceAfter < 0) throw new Error('거래 취소 후 잔액은 0보다 작아질 수 없습니다.');
  const reversalTotalAmount = -reversalDelta;
  const reversalTransaction: Transaction = {
    transactionId: deterministicReversalId ?? `CANCEL-${transaction.transactionId}-${Date.now().toString(36)}`,
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

  // Sequential provider writes are non-atomic and not exactly-once: each later failure can
  // leave balance, inventory, or status writes applied. R2 deliberately adds no outbox.
  await store.updateCell('Students', studentRecord.rowNumber, 'balance', reversalBalanceAfter);
  await applyCellUpdates(store, 'Products', productUpdates);
  await store.updateCell('Transactions', transactionRecord.rowNumber, 'status', 'CANCELLED');
  const transactionHeaders = transactionRows[0] ?? TRANSACTION_HEADERS;
  await store.appendRow('Transactions', buildTransactionAppendRow(transactionHeaders, reversalTransaction));

  return { cancelledTransaction: { ...transaction, status: 'CANCELLED', cancelledAt }, reversalTransaction };
}

function validateSheetsCancellationReplay(
  original: Transaction,
  reversal: Transaction,
  expectedReversalId: string,
): void {
  const reversalDelta = original.balanceBefore - original.balanceAfter;
  const expectedTotal = -reversalDelta;
  const item = reversal.items[0];
  const valid = Number.isSafeInteger(reversalDelta)
    && Number.isSafeInteger(expectedTotal)
    && original.status === 'CANCELLED'
    && reversal.transactionId === expectedReversalId
    && reversal.status === 'CANCEL_REVERSAL'
    && reversal.operator === `cancel:${original.transactionId}`
    && reversal.studentId === original.studentId
    && reversal.studentName === original.studentName
    && reversal.totalAmount === expectedTotal
    && Number.isSafeInteger(reversal.balanceBefore)
    && Number.isSafeInteger(reversal.balanceAfter)
    && checkedSafeIntegerAddition(reversal.balanceBefore, reversalDelta) === reversal.balanceAfter
    && reversal.items.length === 1
    && item !== undefined
    && !isCheckoutLineSnapshot(item)
    && item.productId === `CANCEL-${original.transactionId}`
    && item.name === '거래 취소'
    && item.price === expectedTotal
    && item.quantity === 1
    && item.subtotal === expectedTotal;
  if (!valid) throw new Error('거래 취소 기록의 무결성이 일치하지 않아 수동 조정이 필요합니다.');
}

function checkedSafeIntegerAddition(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Error('Cancellation restoration requires safe integer values');
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('Safe integer overflow: 안전한 정수 범위를 벗어났습니다.');
  return result;
}

export async function getSheetSettings(reader: SheetsReader): Promise<Record<string, string>> {
  const rows = await reader.getRows('Settings');
  return parseSheetSettingsRows(rows);
}

export function parseSheetSettingsRows(rows: string[][]): Record<string, string> {
  const [headers, ...dataRows] = rows;

  if (!headers) return {};

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, ['key', 'value'], 'Settings');
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || keyIndex < 0 || valueIndex === undefined || valueIndex < 0) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  return Object.fromEntries(
    dataRows
      .map((row) => [String(row[keyIndex] ?? '').trim(), String(row[valueIndex] ?? '').trim()] as const)
      .filter(([key]) => Boolean(key)),
  );
}

export async function upsertSheetSettings(
  store: SheetsStore,
  rows: string[][],
  settings: SheetSetting[],
): Promise<void> {
  const normalized = settings.map(({ key, value }) => ({ key: key.trim(), value }));
  if (normalized.some(({ key }) => !key)) throw new Error('설정 키를 입력해 주세요.');
  const [headers, ...dataRows] = rows;
  if (!headers) {
    const appendedRows = [['key', 'value'], ...normalized.map(({ key, value }) => [key, value])];
    if (store.appendRows) await store.appendRows('Settings', appendedRows);
    else for (const row of appendedRows) await store.appendRow('Settings', row);
    return;
  }

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, ['key', 'value'], 'Settings');
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');
  if (keyIndex === undefined || valueIndex === undefined) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  const updates: SheetCellUpdate[] = [];
  const missing: string[][] = [];
  for (const setting of normalized) {
    let existingIndex = -1;
    for (let index = dataRows.length - 1; index >= 0; index -= 1) {
      if (String(dataRows[index][keyIndex] ?? '').trim() === setting.key) {
        existingIndex = index;
        break;
      }
    }
    if (existingIndex < 0) {
      missing.push(headers.map((header) => {
        const normalizedHeader = header.trim();
        if (normalizedHeader === 'key') return setting.key;
        if (normalizedHeader === 'value') return setting.value;
        return '';
      }));
    } else if (String(dataRows[existingIndex][valueIndex] ?? '').trim() !== setting.value) {
      updates.push({ rowNumber: existingIndex + 2, columnName: headers[valueIndex], value: setting.value });
    }
  }

  if (updates.length > 0) {
    if (store.updateCells) await store.updateCells('Settings', updates);
    else for (const update of updates) {
      await store.updateCell('Settings', update.rowNumber, update.columnName, update.value);
    }
  }
  if (missing.length > 0) {
    if (store.appendRows) await store.appendRows('Settings', missing);
    else for (const row of missing) await store.appendRow('Settings', row);
  }
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
  assertRequiredColumns(headerIndex, ['key', 'value'], 'Settings');
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || keyIndex < 0 || valueIndex === undefined || valueIndex < 0) {
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

  const studentIds = update.studentIds.map((id) => id.trim()).sort();
  const payloadHash = await sha256Hex(JSON.stringify({ studentIds, mode: update.mode, amount: update.amount }));
  const operationPrefix = `ADMIN-${update.operationId}-`;
  const expectedTransactionIds = new Map<string, string>();
  const writesLedger = update.mode === 'set' || update.amount !== 0;
  if (writesLedger) {
    for (const studentId of studentIds) {
      expectedTransactionIds.set(studentId, `${operationPrefix}${payloadHash}-${(await sha256Hex(studentId)).slice(0, 12)}`);
    }
  }

  const [studentRows, transactionRows] = await Promise.all([
    store.getRows('Students'),
    store.getRows('Transactions'),
  ]);
  const transactionHeaderIndex = createHeaderIndex(transactionRows[0] ?? []);
  if (!requireColumns(transactionHeaderIndex, [...REQUIRED_TRANSACTION_COLUMNS, 'items']).ok) {
    throw bulkReconciliationError();
  }
  const recordsById = getStudentRecordsFromRows(studentRows);
  const missingIds = studentIds.filter((studentId) => !recordsById.has(studentId));
  if (missingIds.length > 0) throw new Error(`학생을 찾을 수 없습니다: ${missingIds.join(', ')}`);

  const operationRows = getRawBulkOperationRows(transactionRows, operationPrefix);
  if (operationRows.length > 0) {
    return validateBulkBalanceReplay(
      transactionRows,
      operationRows,
      studentIds.map((studentId) => recordsById.get(studentId)!),
      update,
      expectedTransactionIds,
    );
  }

  const timestamp = new Date().toISOString();
  const transactionHeaders = transactionRows[0] ?? TRANSACTION_HEADERS;
  const changes = studentIds.map((studentId) => {
    const record = recordsById.get(studentId)!;
    const balance = update.mode === 'set'
      ? update.amount
      : checkedSafeIntegerAddition(record.student.balance, update.mode === 'add' ? update.amount : -update.amount);
    if (!Number.isSafeInteger(record.student.balance) || !Number.isSafeInteger(balance)) {
      throw new Error('학생 잔액은 안전한 정수 범위여야 합니다.');
    }
    const transactionAmount = checkedSafeIntegerAddition(record.student.balance, -balance);
    return { record, balance, transactionAmount };
  });
  const results = changes.map(({ record, balance }) => ({ studentId: record.student.studentId, balance }));

  // add/subtract zero has no ledger row in the legacy schema. Returning current balances is
  // deterministic and write-free, but this operation ID cannot be remembered across requests.
  if (!writesLedger) return results;

  const cellUpdates = changes.map(({ record, balance }) => ({
    rowNumber: record.rowNumber, columnName: 'balance', value: balance,
  }));
  await applyCellUpdates(store, 'Students', cellUpdates);
  for (const { record, balance, transactionAmount } of changes) {
    await appendBalanceAdjustmentTransaction(
      store,
      transactionHeaders,
      record.student,
      record.student.balance,
      balance,
      update.mode,
      transactionAmount,
      expectedTransactionIds.get(record.student.studentId)!,
      timestamp,
    );
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

type RawBulkOperationRow = { row: string[]; rowNumber: number };

function getRawBulkOperationRows(rows: string[][], operationPrefix: string): RawBulkOperationRow[] {
  const headers = rows[0] ?? [];
  const transactionIdColumn = createHeaderIndex(headers).get('transactionId') ?? -1;
  if (transactionIdColumn < 0) throw new Error('거래 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.');
  return rows.slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => row[transactionIdColumn]?.trim().startsWith(operationPrefix));
}

function validateBulkBalanceReplay(
  transactionRows: string[][],
  operationRows: RawBulkOperationRow[],
  records: StudentRecord[],
  update: StudentBulkBalanceUpdate,
  expectedIds: ReadonlyMap<string, string>,
): Array<{ studentId: string; balance: number }> {
  if (operationRows.length !== expectedIds.size) throw bulkReconciliationError();
  const headerIndex = createHeaderIndex(transactionRows[0] ?? []);
  if (!requireColumns(headerIndex, [...REQUIRED_TRANSACTION_COLUMNS, 'items']).ok) throw bulkReconciliationError();
  const transactionIdColumn = headerIndex.get('transactionId')!;
  const rowsById = new Map<string, RawBulkOperationRow[]>();
  for (const raw of operationRows) {
    const id = raw.row[transactionIdColumn]?.trim() ?? '';
    rowsById.set(id, [...(rowsById.get(id) ?? []), raw]);
  }

  const cell = (row: string[], column: string) => row[headerIndex.get(column)!]?.trim() ?? '';
  const safeInteger = (value: string): number | null => {
    if (!/^-?(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  let timestamp: string | undefined;
  const results: Array<{ studentId: string; balance: number }> = [];
  for (const record of records) {
    const expectedId = expectedIds.get(record.student.studentId);
    const candidates = expectedId ? rowsById.get(expectedId) ?? [] : [];
    if (candidates.length !== 1) throw bulkReconciliationError();
    const row = candidates[0].row;
    const balanceBefore = safeInteger(cell(row, 'balanceBefore'));
    const balanceAfter = safeInteger(cell(row, 'balanceAfter'));
    const totalAmount = safeInteger(cell(row, 'totalAmount'));
    let items: unknown;
    try { items = JSON.parse(cell(row, 'items')); } catch { throw bulkReconciliationError(); }
    if (balanceBefore === null || balanceAfter === null || totalAmount === null
      || !Array.isArray(items) || items.length !== 1
      || typeof items[0] !== 'object' || items[0] === null || Array.isArray(items[0])) {
      throw bulkReconciliationError();
    }
    const item = items[0] as Record<string, unknown>;
    const expectedAfter = update.mode === 'set'
      ? update.amount
      : checkedSafeIntegerAddition(balanceBefore, update.mode === 'add' ? update.amount : -update.amount);
    const expectedTotal = balanceBefore - expectedAfter;
    const label = update.mode === 'add' ? '관리자 지급' : update.mode === 'subtract' ? '관리자 회수' : '관리자 잔액 지정';
    const rowTimestamp = cell(row, 'timestamp');
    const validTimestamp = (() => {
      try { return new Date(rowTimestamp).toISOString() === rowTimestamp; } catch { return false; }
    })();
    const valid = cell(row, 'transactionId') === expectedId
      && cell(row, 'studentId') === record.student.studentId
      && cell(row, 'studentName') === record.student.name
      && cell(row, 'status') === 'ADMIN_ADJUSTMENT'
      && cell(row, 'operator') === 'admin'
      && balanceAfter === expectedAfter
      && totalAmount === expectedTotal
      && record.student.balance === balanceAfter
      && Object.keys(item).sort().join('|') === 'name|price|productId|quantity|subtotal'
      && item.productId === `ADMIN-${update.mode.toUpperCase()}`
      && item.name === label
      && item.price === expectedTotal
      && item.quantity === 1
      && item.subtotal === expectedTotal
      && validTimestamp
      && (timestamp === undefined || timestamp === rowTimestamp);
    if (!valid) throw bulkReconciliationError();
    timestamp = rowTimestamp;
    results.push({ studentId: record.student.studentId, balance: balanceAfter });
  }
  return results;
}

function bulkReconciliationError(): Error {
  return new Error('학생 재화 조정 기록의 무결성이 일치하지 않아 수동 조정이 필요합니다.');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function appendBalanceAdjustmentTransaction(
  store: SheetsStore,
  transactionHeaders: string[],
  student: Student,
  balanceBefore: number,
  balanceAfter: number,
  mode: StudentBulkBalanceMode,
  transactionAmount: number,
  transactionId: string,
  timestamp: string,
): Promise<void> {
  const label = mode === 'add' ? '관리자 지급' : mode === 'subtract' ? '관리자 회수' : '관리자 잔액 지정';
  const item = {
    productId: `ADMIN-${mode.toUpperCase()}`,
    name: label,
    price: transactionAmount,
    quantity: 1,
    subtotal: transactionAmount,
  };
  const transaction: Transaction = {
    transactionId,
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

function requireRecurringSchemaMigrationStore(store: SheetsStore): RecurringSchemaMigrationStore {
  const candidate = store as Partial<RecurringSchemaMigrationStore>;
  const requiredCapabilities: Array<keyof RecurringSchemaMigrationStore> = [
    'lookupSheet',
    'createSheetWithHeader',
    'ensureColumnCount',
    'writeHeaderCells',
    'verifyHeaderCells',
    'verifyAndWriteHeaderCells',
  ];
  if (requiredCapabilities.some((capability) => typeof candidate[capability] !== 'function')) {
    throw new Error('현재 Sheets 저장소가 반복 과제 스키마 준비를 지원하지 않습니다.');
  }
  return candidate as RecurringSchemaMigrationStore;
}

async function migrateRecurringSchemaIfNeeded(store: RecurringSchemaMigrationStore): Promise<void> {
  const [taskRows, completionRows, assignmentLookup] = await Promise.all([
    store.getRows('Tasks'),
    store.getRows('TaskCompletions'),
    store.lookupSheet('TaskAssignments'),
  ]);
  const hasHeaderSet = (headers: readonly string[] | undefined, required: readonly string[]) => {
    const present = new Set((headers ?? []).map((header) => header.trim()));
    return required.every((header) => present.has(header));
  };
  let needsMigration = !hasHeaderSet(taskRows[0], TASK_SCHEMA_HEADERS)
    || !hasHeaderSet(completionRows[0], TASK_COMPLETION_SCHEMA_HEADERS)
    || !assignmentLookup.found;
  if (!needsMigration && assignmentLookup.found) {
    const assignmentRows = await store.getRows('TaskAssignments');
    const header = assignmentRows[0];
    needsMigration = !header
      || header.length < TASK_ASSIGNMENT_HEADERS.length
      || !TASK_ASSIGNMENT_HEADERS.every((value, index) => header[index]?.trim() === value);
  }
  if (needsMigration) await migrateRecurringTaskSchema(store);
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

function withoutVersionedSchedule(task: ClassTask): ClassTask {
  return {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    reward: task.reward,
    isActive: task.isActive,
    sortOrder: task.sortOrder,
    allowedStudentIds: task.allowedStudentIds,
    ...(task.availableFrom ? { availableFrom: task.availableFrom } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.prerequisiteTaskId ? { prerequisiteTaskId: task.prerequisiteTaskId } : {}),
    ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
  };
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
  const studentIds = update.studentIds.map((id) => typeof id === 'string' ? id.trim() : '');
  if (studentIds.some((id) => !id)) throw new Error('학생 ID를 입력해 주세요.');
  const duplicateIds = findDuplicates(studentIds);
  if (duplicateIds.length > 0) throw new Error(`중복된 학생 ID가 있습니다: ${duplicateIds.join(', ')}`);
  if (update.mode !== 'set' && update.mode !== 'add' && update.mode !== 'subtract') throw new Error('일괄 작업 방식이 올바르지 않습니다.');
  if (!Number.isSafeInteger(update.amount) || update.amount < 0) throw new Error('금액은 0 이상의 안전한 정수여야 합니다.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(update.operationId)) {
    throw new Error('작업 ID 형식이 올바르지 않습니다.');
  }
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


async function ensureSheetHeaders(store: SheetsStore, sheetName: SheetName, requiredHeaders: string[], currentHeaders: string[]): Promise<void> {
  const normalizedCurrent = currentHeaders.map((header) => header.trim());
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
  if (update.padletBoardId !== undefined && update.padletBoardId.trim()
    && !/^[A-Za-z0-9]{16,22}$/.test(update.padletBoardId.trim())) {
    throw new Error('Padlet 게시판 ID 형식이 올바르지 않습니다.');
  }
  validateTaskAvailability(update);
}

function assertPersistedScheduleIsEditable(task: ClassTask): void {
  const warning = task.scheduleReadWarnings?.[0];
  if (warning) {
    throw new Error(`과제 일정 데이터가 손상되었습니다 (${warning}). 일정을 먼저 복구해 주세요.`);
  }
}

function prepareImmediateScheduleState(task: ClassTask, edit: TaskScheduleEdit, editedAt: string) {
  return prepareImmediateTaskScheduleState(task, edit, editedAt);
}

function assertVersionedTaskScheduleHeaders(headerIndex: ReadonlyMap<string, number>): boolean {
  const observedCount = VERSIONED_TASK_SCHEDULE_HEADERS
    .filter((header) => headerIndex.get(header) !== undefined)
    .length;
  const validCount = VERSIONED_TASK_SCHEDULE_HEADERS
    .filter((header) => (headerIndex.get(header) ?? -1) >= 0)
    .length;
  if (observedCount > 0 && validCount < VERSIONED_TASK_SCHEDULE_HEADERS.length) {
    throw new Error('Tasks 시트의 versioned schedule 헤더가 불완전합니다.');
  }
  return validCount === VERSIONED_TASK_SCHEDULE_HEADERS.length;
}

function assertRequiredSheetHeaders(
  rows: string[][],
  requiredColumns: readonly string[],
  sheetName: SheetName,
): void {
  const headerIndex = createHeaderIndex(rows[0] ?? []);
  assertRequiredColumns(headerIndex, requiredColumns, sheetName);
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
