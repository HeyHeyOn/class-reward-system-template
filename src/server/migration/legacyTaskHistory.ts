import 'server-only';
import { Temporal } from '@js-temporal/polyfill';
import type { ClassTask, TaskAssignment, TaskCompletion } from '@/domain/types';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import { isCompletionForTaskInstance } from '@/domain/taskCompletionPolicy';
import { createHeaderIndex, parseTaskRow, parseTaskAssignmentRow, parseTaskCompletionRow } from '@/server/sheetsRows';
import { TASK_SCHEMA_HEADERS, TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS } from '@/server/repositories/sheets/recurringSchemaMigrator';
import { readOfflineGoogleGrid } from './offlineGoogleGrid';
import { parseLegacyBankRewardGroups } from './legacyBankRewardGroups';
import { parseLegacyFinancialHistory, type LegacyFinancialReview } from './legacyFinancialHistory';
import { canonicalJson, sha256 } from './validators';

type SourceRow = { rowNumber: number; cells: string[]; digest: string };
export type LegacyTaskEvent<T> = { originId: string; event: T; sources: SourceRow[]; transactionId: string | null;
  historicalOperation?: { id: string; hash: string } };
function fail(code: string): never { throw new Error(`LEGACY_TASK_${code}`); }
const validId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameInstant = (a: string, b: string) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

/** Original cells carry historical provenance, never modern command authority.
 * Completed BANK checkpoints become one state event, with all checkpoints kept.
 * The import does not execute rewards or manufacture authenticated operations.
 */
export function parseLegacyTaskHistory(gridJson: string, financialReview?: LegacyFinancialReview) {
  const { tabs, contentSha256: sourceDigest } = readOfflineGoogleGrid(gridJson);
  const financial = parseLegacyFinancialHistory(gridJson, financialReview);
  const rows = (tab: string, headers: readonly string[]) => {
    const table = tabs[tab];
    // This extra legacy column is retained by the deployed Sheets schema
    // extension. Resolve it by its actual header without shifting source cells.
    const expected = tab === 'Tasks' && table?.[0]?.[4] === 'maxCompletionsPerStudent'
      ? [...headers.slice(0, 4), 'maxCompletionsPerStudent', ...headers.slice(4)] : headers;
    if (!table || !expected.every((h, i) => table[0]?.[i] === h) || table[0].slice(expected.length).some(Boolean)) fail('HEADERS');
    return table.slice(1).flatMap((cells, index) => {
      if (!cells.some(Boolean)) return [];
      if (cells.slice(expected.length).some(Boolean)) fail('EXTRA_CELL');
      const rowNumber = index + 2;
      return [{ rowNumber, cells, digest: sha256(canonicalJson({ tab, rowNumber, cells })) }];
    });
  };
  const definitionUpdatedAt = new Map<string, string>();
  const tasks: ClassTask[] = rows('Tasks', TASK_SCHEMA_HEADERS).map(row => {
    const task = parseTaskRow(row.cells, createHeaderIndex(tabs.Tasks[0]));
    if (!task?.taskInstanceId || !task.createdAt || !task.schedule || task.scheduleReadWarnings?.length) fail('TASK_DEFINITION');
    const updatedAt = row.cells[tabs.Tasks[0].indexOf('updatedAt')];
    if (!Number.isFinite(Date.parse(updatedAt))) fail('TASK_DEFINITION');
    definitionUpdatedAt.set(task.taskInstanceId, new Date(updatedAt).toISOString());
    return task;
  });
  const byTask = new Map(tasks.map(task => [task.taskInstanceId!, task]));
  if (byTask.size !== tasks.length || new Set(tasks.map(t => t.taskId)).size !== tasks.length) fail('DUPLICATE_TASK');
  const students = new Set(Object.keys(financial.currentBalances));
  const archivedInstances = new Map<string, { taskId: string; taskInstanceId: string; firstObservedAt: string; lastObservedAt: string }>();
  const cycleSnapshots = new Map<string, string>();
  const validateCycle = (event: TaskAssignment | TaskCompletion, at: string) => {
    const task = byTask.get(event.taskInstanceId ?? '');
    if ((task && task.taskId !== event.taskId) || !students.has(event.studentId)
      || !validId(event.taskId) || !validId(event.taskInstanceId) || !validId(event.studentId)
      || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at
      || event.schemaVersion !== 2 || event.timeZone !== 'Asia/Seoul'
      || !Number.isSafeInteger(event.ruleVersion) || event.ruleVersion! < 1) fail('CYCLE_REFERENCE');
    let start: string, end: string | null;
    try { start = Temporal.Instant.from(event.cycleStartsAt!).toString();
      end = event.cycleEndsAt === null ? null : Temporal.Instant.from(event.cycleEndsAt!).toString();
    } catch { fail('CYCLE_SNAPSHOT'); }
    if (event.cycleId !== `v1|${event.taskInstanceId}|r${event.ruleVersion}|${start}`
      || Date.parse(at) < Date.parse(start) || (end !== null && (Date.parse(end) <= Date.parse(start) || Date.parse(at) >= Date.parse(end)))
      || (task && Date.parse(at) < Date.parse(task.createdAt!))) fail('CYCLE_SNAPSHOT');
    const snapshot = canonicalJson([event.taskId, event.taskInstanceId, start, end, event.ruleVersion, event.timeZone]);
    if (cycleSnapshots.has(event.cycleId!) && cycleSnapshots.get(event.cycleId!) !== snapshot) fail('CYCLE_SNAPSHOT');
    cycleSnapshots.set(event.cycleId!, snapshot);
    // Sheets retains event snapshots, not every overwritten schedule definition.
    // Recompute only a definition known to apply at this event; never apply the
    // newest schedule retroactively to an older version or replaced instance.
    if (task && at >= definitionUpdatedAt.get(task.taskInstanceId!)! && at >= task.schedule!.effectiveFrom) {
      const schedule = resolveTaskSchedule({ currentSchedule: task.schedule!, pendingSchedule: task.pendingSchedule ?? null, now: at });
      if (event.ruleVersion === schedule.ruleVersion) {
        const cycle = getTaskCycle({ taskInstanceId: task.taskInstanceId!, schedule, taskCreatedAt: task.createdAt, now: at });
        if (cycle.cycleId !== event.cycleId || !sameInstant(cycle.startsAt, start)
          || (cycle.endsAt === null ? end !== null : !sameInstant(cycle.endsAt, end ?? ''))) fail('CYCLE_SNAPSHOT');
      }
    }
    if (!task) {
      const previous = archivedInstances.get(event.taskInstanceId!);
      if (previous && previous.taskId !== event.taskId) fail('CYCLE_REFERENCE');
      archivedInstances.set(event.taskInstanceId!, { taskId: event.taskId, taskInstanceId: event.taskInstanceId!,
        firstObservedAt: previous && previous.firstObservedAt < at ? previous.firstObservedAt : at,
        lastObservedAt: previous && previous.lastObservedAt > at ? previous.lastObservedAt : at });
    }
  };
  const origin = (table: string, id: string) => sha256(canonicalJson({ sourceDigest, table, id }));
  const assignments: LegacyTaskEvent<TaskAssignment>[] = [];
  const assignmentById = new Map<string, TaskAssignment>();
  const latestAssignment = new Map<string, TaskAssignment>();
  const key = (e: TaskAssignment | TaskCompletion) => canonicalJson([e.taskInstanceId, e.cycleId, e.studentId]);
  for (const row of rows('TaskAssignments', TASK_ASSIGNMENT_HEADERS)) {
    const event = parseTaskAssignmentRow(row.cells, createHeaderIndex([...TASK_ASSIGNMENT_HEADERS]));
    if (!event || !validId(event.assignmentId) || assignmentById.has(event.assignmentId)) fail('ASSIGNMENT');
    validateCycle(event, event.createdAt);
    const previous = latestAssignment.get(key(event));
    if (event.source === 'CARRY_FORWARD') {
      const predecessor = assignmentById.get(event.previousAssignmentId);
      if (previous || !predecessor || predecessor.taskId !== event.taskId
        || predecessor.taskInstanceId !== event.taskInstanceId || predecessor.studentId !== event.studentId
        || predecessor.status !== event.status || predecessor.cycleId === event.cycleId
        || Date.parse(predecessor.cycleStartsAt) > Date.parse(event.cycleStartsAt)
        || predecessor.ruleVersion > event.ruleVersion || predecessor.createdAt > event.createdAt
        || (sameInstant(predecessor.cycleStartsAt, event.cycleStartsAt) && predecessor.ruleVersion >= event.ruleVersion)) fail('CARRY_ASSIGNMENT');
    } else if (event.source === 'LEGACY_SEED') {
      if (previous || event.status !== 'ASSIGNED' || event.previousAssignmentId) fail('SEED');
    } else if (event.previousAssignmentId !== (previous?.assignmentId ?? '')
      || (previous ? previous.createdAt > event.createdAt : event.status !== 'ASSIGNED')) fail('ASSIGNMENT_CHAIN');
    assignmentById.set(event.assignmentId, event); latestAssignment.set(key(event), event);
    assignments.push({ originId: origin('task_assignments', event.assignmentId), event, sources: [row], transactionId: null });
  }
  const completionRows = rows('TaskCompletions', TASK_COMPLETION_SCHEMA_HEADERS);
  const events = completionRows.map(row => {
    const event = parseTaskCompletionRow(row.cells, createHeaderIndex([...TASK_COMPLETION_SCHEMA_HEADERS]));
    if (!event || !validId(event.completionId)) fail('COMPLETION');
    if (!validId(event.taskId) || !students.has(event.studentId) || !Number.isFinite(Date.parse(event.timestamp))
      || new Date(event.timestamp).toISOString() !== event.timestamp) fail('COMPLETION');
    if (event.taskInstanceId) {
      validateCycle(event, event.timestamp);
      const a = assignmentById.get(event.assignmentId ?? '');
      if (!a || a.status !== 'ASSIGNED' || key(a) !== key(event) || a.createdAt > event.timestamp) fail('COMPLETION_ASSIGNMENT');
    }
    if (![event.reward, event.balanceBefore, event.balanceAfter].every(Number.isSafeInteger) || event.reward < 0) fail('COMPLETION_AMOUNT');
    return { row, event };
  });
  if (new Set(events.map(e => e.event.completionId)).size !== events.length) fail('DUPLICATE_COMPLETION');
  const bank = parseLegacyBankRewardGroups({ events, assignments: assignmentById, financial: financial.records });
  const completions: LegacyTaskEvent<TaskCompletion>[] = [];
  const consumed = new Set<number>();
  for (const { row, event } of events) {
    if (consumed.has(row.rowNumber)) continue;
    let sources = [row], transactionId: string | null = null, final = event;
    if (!event.taskInstanceId) {
      // The first writer had no assignment/cycle/operation fields. Keep that
      // absence; a reward snapshot alone does not imply money was paid.
      if (event.status !== 'SUCCESS' || event.operationId) fail('UNVERSIONED_SHAPE');
      const matches = financial.records.filter(r => r.transaction.transactionId === `TASK-${event.completionId}`);
      if (matches.length) {
        const t = matches[0].transaction, item = t.items[0];
        if (matches.length !== 1 || !['TASK_REWARD', 'CANCELLED'].includes(t.status) || t.operator !== 'bank'
          || t.timestamp !== event.timestamp || t.studentId !== event.studentId || t.studentName !== event.studentName
          || t.balanceBefore !== event.balanceBefore || t.balanceAfter !== event.balanceAfter
          || t.totalAmount !== -event.reward || event.balanceAfter !== event.balanceBefore + event.reward
          || t.items.length !== 1 || item.productId !== event.taskId || item.quantity !== 1
          || item.price !== -event.reward || item.subtotal !== -event.reward) fail('UNVERSIONED_LEDGER');
        transactionId = t.transactionId;
      } else if (event.note !== 'admin-assignment-status' || event.balanceBefore !== event.balanceAfter) fail('UNVERSIONED_LEDGER');
    } else if (event.source === 'BANK') {
      const group = bank.find(g => g.checkpointRows.includes(row.rowNumber));
      if (!group || group.checkpointRows[0] !== row.rowNumber) fail('BANK_CHECKPOINTS');
      const members = group.checkpointRows.map(n => events.find(e => e.row.rowNumber === n) ?? fail('BANK_CHECKPOINTS'));
      sources = members.map(e => e.row); final = members[members.length - 1].event;
      transactionId = group.transactionId;
      const ledger = financial.records.find(r => r.transaction.transactionId === transactionId);
      if (!ledger || ledger.balanceDelta !== final.reward) fail('BANK_LEDGER');
    } else {
      if ((event.operationId && (!validId(event.operationId) || !/^(?:sha256:)?[a-f0-9]{64}$/.test(event.operationPayloadHash ?? '')))
        || event.reward !== 0 || event.balanceBefore !== event.balanceAfter
        || !['ADMIN', 'ADMIN_RESET', 'CARRY_FORWARD'].includes(event.source ?? '')
        || event.status !== (event.source === 'ADMIN_RESET' ? 'RESET' : 'SUCCESS')) fail('ADMIN_SHAPE');
    }
    for (const source of sources) { if (consumed.has(source.rowNumber)) fail('CHECKPOINT_REUSE'); consumed.add(source.rowNumber); }
    // Original operation strings remain in source cells, never modern receipts.
    const { operationId: _operationId, operationPayloadHash: _operationHash, ...stateEvent } = final;
    void _operationId; void _operationHash;
    completions.push({ originId: origin('task_completions', final.completionId), event: stateEvent, sources, transactionId,
      ...(final.source === 'BANK' && final.operationId
        ? { historicalOperation: { id: final.operationId, hash: final.operationPayloadHash! } } : {}) });
  }
  const latestCompletion = new Map<string, TaskCompletion>();
  const priorCompletions: TaskCompletion[] = [];
  for (const { event } of completions) {
    if (!event.taskInstanceId) { priorCompletions.push(event); continue; }
    const previous = latestCompletion.get(key(event));
    if (previous && previous.timestamp > event.timestamp) fail('COMPLETION_ORDER');
    if (event.source === 'ADMIN_RESET' && (!previous || previous.status !== 'SUCCESS')) fail('RESET_PREDECESSOR');
    if (event.source === 'CARRY_FORWARD') {
      const earlier = priorCompletions.filter(p => p.taskInstanceId === event.taskInstanceId && p.taskId === event.taskId
        && p.studentId === event.studentId && p.timestamp <= event.timestamp
        && (Date.parse(p.cycleStartsAt!) < Date.parse(event.cycleStartsAt!)
          || (sameInstant(p.cycleStartsAt!, event.cycleStartsAt!) && p.ruleVersion! < event.ruleVersion!)));
      const nearestStart = Math.max(...earlier.map(p => Date.parse(p.cycleStartsAt!)));
      const versioned = earlier.filter(p => Date.parse(p.cycleStartsAt!) === nearestStart).at(-1);
      const task = byTask.get(event.taskInstanceId);
      const legacy = task && priorCompletions.filter(p => !p.taskInstanceId && p.studentId === event.studentId
        && p.timestamp <= event.timestamp && isCompletionForTaskInstance(p, task) && p.status === 'SUCCESS').at(-1);
      if (previous || (versioned ?? legacy)?.status !== event.status) fail('CARRY_COMPLETION');
    }
    latestCompletion.set(key(event), event);
    priorCompletions.push(event);
  }
  // The Sheets mirror is the latest assignment for each student, not every
  // historical cycle (whose final assignment may legitimately differ).
  const finalAssignments = new Map<string, TaskAssignment>();
  for (const { event } of assignments) finalAssignments.set(canonicalJson([event.taskInstanceId, event.studentId]), event);
  for (const task of tasks) {
    for (const event of finalAssignments.values()) if (event.taskInstanceId === task.taskInstanceId
      && ((task.allowedStudentIds ?? []).includes(event.studentId) !== (event.status === 'ASSIGNED'))) fail('ASSIGNMENT_MIRROR');
  }
  if (consumed.size !== events.length || !same(financial.sourceDigest, sourceDigest)) fail('SOURCE_COVERAGE');
  const result = { sourceDigest, tasks, archivedTaskIdentities: [...archivedInstances.values()], assignments, completions, sourceAssignmentRows: assignments.length,
    sourceCompletionRows: completionRows.length, historicalAuthority: 'SOURCE_ARCHIVE' as const };
  return { ...result, digest: sha256(canonicalJson(result)) };
}
