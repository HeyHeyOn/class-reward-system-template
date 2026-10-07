// Synthetic values only. This fixture never reads a private source capture.
import { createHash } from 'node:crypto';
import { getTaskCycle } from '@/domain/taskRecurrence';
import type { ClassTask } from '@/domain/types';
import { TASK_SCHEMA_HEADERS, TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS } from '@/server/repositories/sheets/recurringSchemaMigrator';

export const syntheticResetOperation = '20202020-2020-4020-8020-202020202020';
export const syntheticTask: ClassTask = {
  taskId: 'synthetic-task', taskInstanceId: 'synthetic-instance', title: 'Synthetic Task', description: '',
  reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: ['synthetic-student'],
  createdAt: '2026-01-01T00:00:00.000Z',
  schedule: { ruleVersion: 1, effectiveFrom: '2026-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
    recurrence: { type: 'NONE' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
};
export function syntheticAdminGrid(): Record<string, string[][]> {
  const task = syntheticTask;
  const cycle = getTaskCycle({ taskInstanceId: task.taskInstanceId!, schedule: task.schedule!,
    taskCreatedAt: task.createdAt, now: '2026-01-01T01:00:00.000Z' });
  const tuple = { taskId: task.taskId, taskInstanceId: task.taskInstanceId!, studentId: 'synthetic-student',
    cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt ?? '', ruleVersion: '1', timeZone: 'Asia/Seoul' };
  const bank = { ...tuple, timestamp: '2026-01-01T01:00:00.000Z', studentName: 'Synthetic Person', reward: '5',
    balanceBefore: '10', balanceAfter: '15', source: 'BANK', assignmentId: 'synthetic-assignment', schemaVersion: '2',
    operationId: 'synthetic-legacy-bank', operationPayloadHash: `sha256:${'a'.repeat(64)}` };
  const table = (records: Record<string, string>[]) => {
    const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
    return [headers, ...records.map(row => headers.map(key => row[key] ?? ''))];
  };
  const taskRecord: Record<string, string> = { taskId: task.taskId, taskInstanceId: task.taskInstanceId!, title: task.title,
    description: '', reward: '5', isActive: 'TRUE', sortOrder: '1', allowedStudentIds: tuple.studentId,
    createdAt: task.createdAt!, updatedAt: task.createdAt!, ruleVersion: '1', scheduleEffectiveFrom: task.createdAt!,
    recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'NONE', resetAssignmentOnCycle: 'FALSE', resetCompletionOnCycle: 'FALSE' };
  const tables: Record<string, string[][]> = {
    Settings: [['key', 'value'], ['schemaVersion', '4']],
    Tasks: [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map(key => taskRecord[key] ?? '')],
    Students: [['studentId', 'name', 'balance', 'status'], [tuple.studentId, bank.studentName, '15', 'ACTIVE']],
    TaskAssignments: table([{ ...tuple, assignmentId: bank.assignmentId, status: 'ASSIGNED', source: 'LEGACY_SEED',
      previousAssignmentId: '', createdAt: task.createdAt!, schemaVersion: '2', note: '' }]),
    TaskCompletions: table([
      ...['PENDING', 'BALANCE_APPLIED', 'SUCCESS'].map(status => ({ ...bank,
        completionId: `synthetic-logical-${status}`, status, note: `bank-self-completion:${status.toLowerCase()}` })),
      { ...bank, completionId: `TC-RESET-${hash(syntheticResetOperation)}-1-1`, status: 'RESET', source: 'ADMIN_RESET',
        reward: '0', balanceBefore: '15', note: 'admin-reset', operationId: syntheticResetOperation,
        operationPayloadHash: `sha256:${hash(JSON.stringify([task.taskId]))}` },
    ]),
    Transactions: table([{ transactionId: 'TASK-LOGICAL-synthetic-logical', timestamp: bank.timestamp,
      studentId: tuple.studentId, studentName: bank.studentName,
      items: JSON.stringify([{ productId: task.taskId, name: task.title, price: -5, quantity: 1, subtotal: -5 }]),
      totalAmount: '-5', balanceBefore: '10', balanceAfter: '15', status: 'TASK_REWARD', operator: 'bank' }]),
  };
  for (const [tab, headers] of [['TaskAssignments', TASK_ASSIGNMENT_HEADERS], ['TaskCompletions', TASK_COMPLETION_SCHEMA_HEADERS]] as const) {
    const [old, ...rows] = tables[tab];
    tables[tab] = [[...headers], ...rows.map(row => headers.map(key => row[old.indexOf(key)] ?? ''))];
  }
  return tables;
}
export function adminGridWire(tables: Record<string, string[][]>) {
  return JSON.stringify({ spreadsheetId: 'synthetic-sheet', sheets: Object.entries(tables).map(([title, rows]) => ({
    properties: { title }, data: [{ rowData: rows.map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })) }],
  })) });
}
export function setAdminCell(tables: Record<string, string[][]>, tab: string, row: number, key: string, value: string) {
  let col = tables[tab][0].indexOf(key);
  if (col < 0) { col = tables[tab][0].length; tables[tab].forEach(r => r.push('')); tables[tab][0][col] = key; }
  tables[tab][row - 1][col] = value;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
