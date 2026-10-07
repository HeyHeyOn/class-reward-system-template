import 'server-only';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { createHeaderIndex, parseTaskRow } from '@/server/sheetsRows';
import { TASK_SCHEMA_HEADERS, TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS } from '@/server/repositories/sheets/recurringSchemaMigrator';
import { importSchema4BankHistory, normalizeSchema4BankHistory, readSchema4BankHistory, type BankHistoryPlan } from './schema4BankHistory';

// Pinned-coordinate development observation, never authenticated operation
// recovery. Matching bytes can be manually fabricated and do not identify a
// unique writer invocation. No raw identifiers are returned in this assessment.
type Intent = { intent: 'OFFLINE_INSPECTION' | 'OPERATIONAL_READER' | 'OPERATIONAL_IMPORT' };
type ReadInput = Parameters<typeof readSchema4BankHistory>[0] & Intent;
type Row = { rowNumber: number; cells: string[]; values: Record<string, string> };
const tuple = ['taskId', 'taskInstanceId', 'studentId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone'];
const id = (value: string | undefined) => Boolean(value && value.trim() === value && value.length <= 4096);
const integer = (value: string | undefined) => value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const iso = (value: string | undefined) => Boolean(value && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const same = (a: Record<string, string>, b: Record<string, string>, keys = tuple) => keys.every(key => a[key] === b[key]);

export function inspectSchema4CompletionHistory(gridJson: string) {
  return inspectPlan(normalizeSchema4BankHistory(gridJson));
}
function inspectPlan(plan: BankHistoryPlan) {
  const headers = (tab: string) => plan.sources.find(r => r.tab === tab && r.rowNumber === 1)?.cells ?? [];
  const table = (tab: string): Row[] => plan.sources.filter(r => r.tab === tab && r.rowNumber > 1 && r.cells.some(Boolean))
    .map(r => ({ rowNumber: r.rowNumber, cells: r.cells,
      values: Object.fromEntries(headers(tab).filter(Boolean).map(key => [key, r.cells[headers(tab).indexOf(key)] ?? ''])) }));
  const canonical = (tab: string, expected: readonly string[]) => expected.every((key, i) => headers(tab)[i] === key)
    && headers(tab).slice(expected.length).every(v => !v)
    && table(tab).every(r => r.cells.slice(expected.length).every(v => !v));
  const completions = table('TaskCompletions'), assignments = table('TaskAssignments'), tasks = table('Tasks');
  const first = completions.find(r => r.rowNumber === 6), last = completions.find(r => r.rowNumber === 7);
  const a = first?.values ?? {}, b = last?.values ?? {};
  const sameLogical = (r: Row) => ['taskId', 'taskInstanceId'].some(key => r.values[key]?.trim() === a[key])
    && r.values.studentId?.trim() === a.studentId;
  const relatedAssignments = assignments.filter(sameLogical), relatedCompletions = completions.filter(sameLogical);
  const assigned = relatedAssignments.find(r => r.rowNumber === 3), unassigned = relatedAssignments.find(r => r.rowNumber === 4);
  const ar = assigned?.values ?? {}, ur = unassigned?.values ?? {};
  const relatedTasks = tasks.filter(r => r.values.taskId?.trim() === a.taskId || r.values.taskInstanceId?.trim() === a.taskInstanceId);
  const taskRow = relatedTasks.length === 1 ? relatedTasks[0] : undefined;
  const tr = taskRow?.values ?? {};
  const unique = (rows: Row[], key: string, value: string) => id(value) && rows.filter(r => r.values[key]?.trim() === value).length === 1;
  let cycleMatches = false;
  try {
    if (taskRow) {
      const task = parseTaskRow(taskRow.cells, createHeaderIndex(headers('Tasks')));
      if (task?.taskInstanceId && task.schedule && task.schedule.recurrence.type === 'NONE' && !task.pendingSchedule) {
        cycleMatches = [a, b].every(r => {
          const cycle = getTaskCycle({ taskInstanceId: task.taskInstanceId!, schedule: task.schedule!, taskCreatedAt: task.createdAt, now: r.timestamp });
          return cycle.cycleId === r.cycleId && cycle.startsAt === r.cycleStartsAt && (cycle.endsAt ?? '') === r.cycleEndsAt
            && String(task.schedule!.ruleVersion) === r.ruleVersion && task.schedule!.timeZone === r.timeZone
            && Date.parse(task.schedule!.effectiveFrom) <= Date.parse(r.timestamp);
        });
      }
    }
  } catch { /* Fixed diagnostic only; parser input can contain private values. */ }
  // Raw Transactions are checked before any permissive reader can discard a
  // malformed candidate. Absence here is not absence of an external claim.
  let noTransactionLink = true;
  for (const transaction of table('Transactions')) {
    const r = transaction.values;
    try {
      const items: unknown = JSON.parse(r.items);
      if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object'
        || typeof item.productId !== 'string' || [a.taskId, b.taskId].includes(item.productId.trim()))) noTransactionLink = false;
      if ([a, b].some(c => [c.completionId, `TASK-${c.completionId}`, `TASK-LOGICAL-${encodeURIComponent(c.completionId ?? '')}`]
        .includes(r.transactionId?.trim()) || r.operator?.trim() === `cancel:${c.completionId}`)) noTransactionLink = false;
    } catch { noTransactionLink = false; }
  }
  const pairFacts = {
    canonicalHeaders: canonical('TaskCompletions', TASK_COMPLETION_SCHEMA_HEADERS)
      && canonical('TaskAssignments', TASK_ASSIGNMENT_HEADERS) && canonical('Tasks', TASK_SCHEMA_HEADERS)
      && ['transactionId', 'items', 'operator'].every(key => headers('Transactions').includes(key)),
    exactPhysicalPair: Boolean(first && last && relatedCompletions.length === 2 && relatedCompletions[0] === first && relatedCompletions[1] === last),
    sameSnapshot: same(a, b) && a.assignmentId === b.assignmentId && a.balanceAfter === b.balanceBefore,
    orderedEvents: iso(a.timestamp) && iso(b.timestamp) && Date.parse(a.timestamp) < Date.parse(b.timestamp),
    assignedAnchor: relatedAssignments.length === 2 && ar.status === 'ASSIGNED' && ar.source === 'ADMIN'
      && same(ar, a) && ar.assignmentId === a.assignmentId && ar.schemaVersion === '2' && ar.previousAssignmentId === ''
      && ar.note === '' && ar.createdAt === a.timestamp && new RegExp(`^A-${uuid}$`).test(ar.assignmentId ?? '')
      && unique(assignments, 'assignmentId', ar.assignmentId),
    unassignedAnchor: ur.status === 'UNASSIGNED' && ur.source === 'ADMIN' && same(ur, b)
      && ur.previousAssignmentId === ar.assignmentId && ur.schemaVersion === '2' && ur.note === '' && ur.createdAt === b.timestamp
      && ur.assignmentId !== ar.assignmentId && new RegExp(`^A-${uuid}$`).test(ur.assignmentId ?? '')
      && unique(assignments, 'assignmentId', ur.assignmentId),
    taskAnchor: taskRow?.rowNumber === 3 && tr.taskId === a.taskId && tr.taskInstanceId === a.taskInstanceId
      && tr.recurrenceType === 'NONE' && tr.ruleVersion === a.ruleVersion && tr.recurrenceTimeZone === a.timeZone
      && id(tr.createdAt) && Date.parse(tr.createdAt) <= Date.parse(a.timestamp)
      && !Object.keys(tr).some(key => key.startsWith('pending') && tr[key]) && cycleMatches,
    noTransactionLink,
  };
  const rows = [6, 7].map(rowNumber => {
    const r = (rowNumber === 6 ? a : b), isSuccess = rowNumber === 6;
    const facts = { ...pairFacts,
      rowShape: r.source === (isSuccess ? 'ADMIN' : 'ADMIN_RESET') && r.status === (isSuccess ? 'SUCCESS' : 'RESET')
        && r.note === (isSuccess ? 'admin-completion' : 'admin-reset') && r.schemaVersion === '2'
        && ['taskId', 'taskInstanceId', 'studentId', 'studentName', 'cycleId', 'cycleStartsAt', 'timeZone', 'assignmentId'].every(key => id(r[key])),
      uniqueCompletionId: new RegExp(`^TC-${uuid}$`).test(r.completionId ?? '') && unique(completions, 'completionId', r.completionId),
      operationUnbound: !r.operationId && !r.operationPayloadHash,
      zeroEffect: r.reward === '0' && integer(r.balanceBefore) && r.balanceBefore === r.balanceAfter,
    };
    return { rowNumber, event: Object.values(facts).every(Boolean)
      ? (isSuccess ? 'ADMIN_SUCCESS' as const : 'ADMIN_RESET' as const) : 'UNPROVEN' as const,
      consistency: Object.values(facts).every(Boolean) ? 'ADMIN_TOGGLE_WRITER_COMPATIBLE' as const : 'UNPROVEN' as const,
      adminAuthority: 'UNVERIFIED' as const, claimAuthority: 'UNVERIFIED' as const, writerAttribution: 'UNVERIFIED' as const,
      authority: 'UNPROVEN_ADMIN_OPERATION' as const, facts,
      diagnosticCodes: [...Object.entries(facts).filter(([, value]) => !value).map(([key]) => `COMPLETION_${key.toUpperCase()}_UNPROVEN`),
        'HISTORICAL_ADMIN_AUTH_UNVERIFIED', 'HISTORICAL_REDIS_CLAIM_UNVERIFIED', 'WRITER_INVOCATION_UNPROVEN', 'CROSS_TAB_WRITE_ORDER_UNPROVEN'],
      assignmentRows: assignments.filter(other => other.values.assignmentId === r.assignmentId).map(other => other.rowNumber),
      taskRows: relatedTasks.map(other => other.rowNumber), logicalRows: relatedCompletions.map(other => other.rowNumber),
      unassignmentRows: relatedAssignments.filter(other => other.values.status === 'UNASSIGNED').map(other => other.rowNumber) };
  });
  return { authority: 'OFFLINE_NONAUTHORITY' as const, sourceDigest: plan.sourceDigest, rows,
    legacyDiagnostics: plan.diagnostics.map(row => ({ ...row })),
    operationalBridge: { status: 'BLOCKED' as const, readerConnected: false as const, importerConnected: false as const },
    historicalAdminAuthentication: 'UNVERIFIED' as const, historicalRedisClaim: 'UNVERIFIED' as const };
}
const complete = (history: ReturnType<typeof inspectPlan>) => history.rows.every(r => r.consistency === 'ADMIN_TOGGLE_WRITER_COMPATIBLE');
function offline(input: Intent) { if (input.intent !== 'OFFLINE_INSPECTION') throw new Error('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED'); }
export async function importSchema4CompletionHistory(input: Parameters<typeof importSchema4BankHistory>[0] & Intent) {
  offline(input);
  if (!complete(inspectSchema4CompletionHistory(input.gridJson))) throw new Error('COMPLETION_HISTORY_SLICE_BLOCKED');
  // Reuse A04's raw-row transaction/readback without new SQL tables, events,
  // balances, reward groups or importer admission. A04–A07 are not reclassified.
  return importSchema4BankHistory(input);
}
export async function readSchema4CompletionHistory(input: ReadInput) {
  offline(input);
  const observation = await readSchema4BankHistory(input);
  return { observation, completionHistory: inspectPlan(observation.plan), currentStateAuthority: 'BLOCKED' as const };
}
export async function replaySchema4CompletionHistory(input: ReadInput & { rowNumber: number }) {
  offline(input);
  if (![6, 7].includes(input.rowNumber)) throw new Error('COMPLETION_REPLAY_UNPROVEN');
  const { completionHistory } = await readSchema4CompletionHistory(input);
  if (!complete(completionHistory)) throw new Error('COMPLETION_REPLAY_UNPROVEN');
  return { kind: 'HISTORICAL_COMPLETION_ALREADY_RECORDED' as const, authority: 'OFFLINE_NONAUTHORITY' as const,
    rowNumber: input.rowNumber, changed: false as const, balanceToApply: 0, stockToApply: 0, rewardToApply: 0,
    completionToApply: false as const, claimPublished: false as const, currentStateAuthority: 'BLOCKED' as const };
}
