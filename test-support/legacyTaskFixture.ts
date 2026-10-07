import { getTaskCycle } from '@/domain/taskRecurrence';
import { TASK_SCHEMA_HEADERS, TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS } from '@/server/repositories/sheets/recurringSchemaMigrator';
const start = '2026-09-01T00:00:00.000Z', done = '2026-09-01T00:01:00.000Z';
const reset = '2026-09-01T00:02:00.000Z';
const row = (headers: readonly string[], values: Record<string, unknown>) => headers.map(h => String(values[h] ?? ''));
export function taskHistoryFixture() {
  const schedule = { ruleVersion: 1, effectiveFrom: start, timeZone: 'Asia/Seoul' as const,
    recurrence: { type: 'NONE' as const }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false };
  const cycle = getTaskCycle({ taskInstanceId: 'I1', taskCreatedAt: start, schedule, now: done });
  const tuple = { taskId: 'T1', taskInstanceId: 'I1', studentId: 'S1', cycleId: cycle.cycleId,
    cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt, ruleVersion: 1, timeZone: 'Asia/Seoul', schemaVersion: 2 };
  return {
    Settings: [['key', 'value'], ['schemaVersion', '4']],
    Students: [['studentId', 'name', 'balance', 'status'], ['S1', 'Test student', '120', 'ACTIVE']],
    Tasks: [[...TASK_SCHEMA_HEADERS], row(TASK_SCHEMA_HEADERS, { taskId: 'T1', taskInstanceId: 'I1', title: 'Test task', description: '', reward: 20,
      isActive: 'TRUE', sortOrder: 1, createdAt: start, updatedAt: start, allowedStudentIds: 'S1', ruleVersion: 1,
      scheduleEffectiveFrom: start, recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'NONE',
      resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE' })],
    TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS], row(TASK_ASSIGNMENT_HEADERS, { ...tuple, assignmentId: 'A1',
      createdAt: start, source: 'LEGACY_SEED', status: 'ASSIGNED' })],
    TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS], ...['PENDING', 'BALANCE_APPLIED', 'SUCCESS'].map(status =>
      row(TASK_COMPLETION_SCHEMA_HEADERS, { ...tuple, completionId: `C1-${status}`, timestamp: done, assignmentId: 'A1',
        studentName: 'Test student', reward: 20, balanceBefore: 100, balanceAfter: 120, status, source: 'BANK',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', operationPayloadHash: `sha256:${'a'.repeat(64)}` })),
      row(TASK_COMPLETION_SCHEMA_HEADERS, { ...tuple, completionId: 'R1', timestamp: reset, assignmentId: 'A1',
        studentName: 'Test student', reward: 0, balanceBefore: 120, balanceAfter: 120, status: 'RESET', source: 'ADMIN_RESET' })],
    Transactions: [['transactionId','timestamp','studentId','studentName','items','totalAmount','balanceBefore','balanceAfter','status','operator'],
      ['TASK-LOGICAL-C1', done, 'S1', 'Test student', JSON.stringify([{productId:'T1',name:'Test task',price:-20,quantity:1,subtotal:-20}]),'-20','100','120','TASK_REWARD','bank']],
  };
}
export function taskHistoryGrid(tabs = taskHistoryFixture()) {
  return JSON.stringify({ spreadsheetId: 'synthetic-history', sheets: Object.entries(tabs).map(([title, rows]) => ({
    properties: { title }, data: [{ rowData: rows.map(cells => ({ values: cells.map(formattedValue => ({ formattedValue })) })) }],
  })) });
}

export function taskHistoryCarryFixture(assigned: boolean) {
  const tabs = taskHistoryFixture();
  const set = (header: string[], cells: string[], key: string, value: string) => { cells[header.indexOf(key)] = value; };
  const at = '2026-09-02T00:00:00.000Z';
  for (const [key, value] of Object.entries({ pendingRuleVersion: '2', pendingEffectiveFrom: at,
    pendingTimeZone: 'Asia/Seoul', pendingRecurrenceType: 'NONE',
    pendingResetCompletionOnCycle: 'FALSE', pendingResetAssignmentOnCycle: 'FALSE' })) {
    set(tabs.Tasks[0], tabs.Tasks[1], key, value);
  }
  if (!assigned) {
    const previous = [...tabs.TaskAssignments[1]];
    for (const [key, value] of Object.entries({ assignmentId: 'A2', previousAssignmentId: 'A1',
      source: 'ADMIN', status: 'UNASSIGNED', createdAt: '2026-09-01T00:03:00.000Z' })) set(tabs.TaskAssignments[0], previous, key, value);
    tabs.TaskAssignments.push(previous); set(tabs.Tasks[0], tabs.Tasks[1], 'allowedStudentIds', '');
  }
  const cycle = getTaskCycle({ taskInstanceId: 'I1', taskCreatedAt: '2026-09-01T00:00:00.000Z', now: at,
    schedule: { ruleVersion: 2, effectiveFrom: at, timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' },
      resetCompletionOnCycle: false, resetAssignmentOnCycle: false } });
  const carried = [...tabs.TaskAssignments[1]];
  for (const [key, value] of Object.entries({ assignmentId: 'CARRY1', previousAssignmentId: assigned ? 'A1' : 'A2',
    source: 'CARRY_FORWARD', status: assigned ? 'ASSIGNED' : 'UNASSIGNED', createdAt: at,
    ruleVersion: '2', cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: '' })) set(tabs.TaskAssignments[0], carried, key, value);
  tabs.TaskAssignments.push(carried);
  return tabs;
}
