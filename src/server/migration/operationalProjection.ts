import { sameAssignmentCompletionTuple } from './semanticValidators';

type RecordValue = Readonly<Record<string, unknown>>;

/** The intersection of the immutable history reader and configuration-boundary
 * contracts. Inputs are original canonical records in actual historical order.
 * No evidence hash, identifier, or source is promoted into command authority.
 * Unsupported variants remain canonical quarantine, never silently skipped. */
export function unsupportedOperationalRecords(
  assignments: readonly RecordValue[], completions: readonly RecordValue[],
): ReadonlySet<RecordValue> {
  const unsupported = new Set<RecordValue>();
  const byId = new Map(assignments.map((row) => [row.assignmentId, row]));
  const priorAssignment = new Map<string, RecordValue>();
  for (const row of assignments) {
    const prior = priorAssignment.get(subject(row));
    const previous = byId.get(row.previousAssignmentId);
    const seed = row.source === 'LEGACY_SEED' && row.previousAssignmentId === null;
    // Natural same-rule carry is readable but rejected by the strict boundary
    // writer. Do not bless that wider representation until both contracts agree.
    const carry = row.source === 'CARRY_FORWARD' && previous !== undefined
      && previous === prior && !unsupported.has(previous) && previous.status === 'ASSIGNED'
      && subject(previous) === subject(row) && previous.ruleVersion! < row.ruleVersion!
      && previous.cycleStartsAt! < row.cycleStartsAt! && previous.createdAt! <= row.createdAt!
      && previous.cycleEndsAt !== null && previous.cycleEndsAt! <= row.cycleStartsAt!;
    if (!cycleSnapshot(row, row.createdAt) || row.cycleEndsAt === null
      || row.status !== 'ASSIGNED' || (!seed && !carry)) {
      unsupported.add(row);
    }
    priorAssignment.set(subject(row), row);
  }
  const priorCompletion = new Map<string, RecordValue>();
  for (const row of completions) {
    const prior = priorCompletion.get(subject(row));
    const assignment = byId.get(row.assignmentId);
    const predecessor = assignment ? byId.get(assignment.previousAssignmentId) : undefined;
    const retainedFirst = prior === undefined && assignment?.source === 'CARRY_FORWARD'
      && predecessor !== undefined && predecessor.status === 'ASSIGNED'
      && subject(predecessor) === subject(row) && predecessor.cycleStartsAt! < row.cycleStartsAt!;
    const retainedNext = prior !== undefined && !unsupported.has(prior) && prior.source === 'CARRY_FORWARD'
      && prior.status === 'SUCCESS' && assignment?.previousAssignmentId === prior.assignmentId
      && prior.balanceAfter === row.balanceBefore && prior.cycleStartsAt! < row.cycleStartsAt!
      && prior.timestamp! <= row.timestamp!;
    if (row.source !== 'BANK' && (!cycleSnapshot(row, row.timestamp)
      || row.source !== 'CARRY_FORWARD' || row.status !== 'SUCCESS' || row.reward !== 0
      || row.balanceBefore !== row.balanceAfter || row.operationId !== null || row.operationPayloadHash !== null
      || (row.note !== null && (typeof row.note !== 'string' || row.note.trim() !== row.note))
      || ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest']
        .some((key) => row[key] !== undefined && row[key] !== null)
      || !assignment || unsupported.has(assignment) || assignment.status !== 'ASSIGNED'
      || !sameAssignmentCompletionTuple(assignment, row) || assignment.createdAt! > row.timestamp!
      || (!retainedFirst && !retainedNext))) unsupported.add(row);
    priorCompletion.set(subject(row), row);
  }
  return unsupported;
}

function subject(row: RecordValue): string {
  return JSON.stringify([row.taskId, row.taskInstanceId, row.studentId]);
}
function cycleSnapshot(row: RecordValue, timestamp: unknown): boolean {
  return row.schemaVersion === 2 && row.timeZone === 'Asia/Seoul'
    && typeof row.taskInstanceId === 'string' && Number.isSafeInteger(row.ruleVersion)
    && (row.ruleVersion as number) > 0 && typeof row.cycleStartsAt === 'string'
    && Number.isFinite(Date.parse(row.cycleStartsAt))
    && row.cycleId === `v1|${row.taskInstanceId}|r${row.ruleVersion}|${row.cycleStartsAt.replace('.000Z', 'Z')}`
    && typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
    && timestamp >= row.cycleStartsAt && (row.cycleEndsAt === null
      || (typeof row.cycleEndsAt === 'string' && Number.isFinite(Date.parse(row.cycleEndsAt))
        && row.cycleEndsAt > row.cycleStartsAt && timestamp < row.cycleEndsAt));
}
