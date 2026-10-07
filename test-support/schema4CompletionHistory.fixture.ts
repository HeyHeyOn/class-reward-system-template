// Synthetic values only; no private capture values are persisted by this fixture.
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { syntheticAdjustmentGrid, adjustmentGridWire, setAdjustmentCell } from './schema4AdjustmentHistory.fixture';
export { adjustmentGridWire as completionGridWire, setAdjustmentCell as setCompletionCell };
export const completionTimes = ['2026-01-01T08:00:00.000Z', '2026-01-01T09:00:00.000Z'];
export const completionUuids = ['80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002'];
export const assignmentUuids = ['81000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002'];
export function syntheticCompletionGrid(): Record<string, string[][]> {
  const t = syntheticAdjustmentGrid();
  const clone = (tab: string, row: number) => Object.fromEntries(t[tab][0].map((key, i) => [key, t[tab][row - 1][i]]));
  const task = { ...clone('Tasks', 2), taskId: 'synthetic-admin-task', taskInstanceId: 'synthetic-admin-instance',
    title: 'Synthetic Admin Task', allowedStudentIds: '' };
  t.Tasks.push(t.Tasks[0].map(key => task[key as keyof typeof task] ?? ''));
  const base = clone('TaskAssignments', 2);
  const tuple = { ...base, taskId: task.taskId, taskInstanceId: task.taskInstanceId,
    cycleId: base.cycleId.replace('synthetic-instance', task.taskInstanceId) };
  for (const i of [0, 1]) {
    const assignment = { ...tuple, assignmentId: `A-${assignmentUuids[i]}`, source: 'ADMIN',
      status: i === 0 ? 'ASSIGNED' : 'UNASSIGNED', previousAssignmentId: i === 0 ? '' : `A-${assignmentUuids[0]}`,
      createdAt: completionTimes[i], note: '' };
    t.TaskAssignments.push(t.TaskAssignments[0].map(key => assignment[key as keyof typeof assignment] ?? ''));
    const completion = { ...tuple, completionId: `TC-${completionUuids[i]}`, timestamp: completionTimes[i],
      studentName: 'Synthetic Person', reward: '0', balanceBefore: '36', balanceAfter: '36', schemaVersion: '2',
      source: i === 0 ? 'ADMIN' : 'ADMIN_RESET', status: i === 0 ? 'SUCCESS' : 'RESET',
      note: i === 0 ? 'admin-completion' : 'admin-reset', assignmentId: `A-${assignmentUuids[0]}`,
      operationId: '', operationPayloadHash: '' };
    t.TaskCompletions.push(t.TaskCompletions[0].map(key => completion[key as keyof typeof completion] ?? ''));
  }
  return t;
}
/** Local memory only. This helper neither records cell values nor offers a remote writer. */
export function completionMemoryStore(tables: Record<string, string[][]>) {
  const writes: Array<{ tab: string; kind: string }> = [];
  const append = async (tab: string, rows: string[][]) => {
    writes.push({ tab, kind: 'append' }); tables[tab].push(...rows.map(r => [...r]));
  };
  const update = async (tab: string, row: number, key: string, value: string | number) => {
    writes.push({ tab, kind: 'mirror' }); tables[tab][row - 1][tables[tab][0].indexOf(key)] = String(value);
  };
  const noSchemaChange = async () => { throw new Error('A08_UNEXPECTED_SCHEMA_WRITE'); };
  const store: RecurringSchemaMigrationStore = {
    getRows: async name => (tables[name] ?? []).map(r => [...r]),
    getRowsFresh: async name => (tables[name] ?? []).map(r => [...r]),
    appendRow: async (tab, values) => append(tab, [values]), appendRows: append,
    updateCell: update,
    updateCells: async (tab, values) => { for (const v of values) await update(tab, v.rowNumber, v.columnName, v.value); },
    lookupSheet: async name => ({ found: true, info: { sheetId: 1, title: name, columnCount: tables[name][0].length } }),
    createSheetWithHeader: noSchemaChange, ensureColumnCount: noSchemaChange,
    writeHeaderCells: noSchemaChange, verifyHeaderCells: noSchemaChange, verifyAndWriteHeaderCells: noSchemaChange,
    updateHeaderRow: noSchemaChange, deleteRow: noSchemaChange, deleteRows: noSchemaChange,
  };
  return { store, writes };
}
