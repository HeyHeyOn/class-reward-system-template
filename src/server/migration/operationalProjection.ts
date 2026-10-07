import { sameAssignmentCompletionTuple } from './semanticValidators';
import { type BudgetContext, BudgetExceededError, BudgetUnavailableError, equalBudgetValue, utf8ByteLength } from '@/lib/boundedWork';
import { registeredBoundedKeys, serializeBoundedOperationalKey, stringBoundedJson } from '@/lib/boundedJson';

type RecordValue = Readonly<Record<string, unknown>>;
const EVIDENCE_KEYS = ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest'] as const;

/** The intersection of the immutable history reader and configuration-boundary
 * contracts. Inputs are original canonical records in actual historical order.
 * No evidence hash, identifier, or source is promoted into command authority.
 * Unsupported variants remain canonical quarantine, never silently skipped. */
export function unsupportedOperationalRecords(
  assignments: readonly RecordValue[], completions: readonly RecordValue[], budget?: BudgetContext,
): ReadonlySet<RecordValue> {
  return native(() => {
    if (budget) { registeredBoundedKeys(assignments, budget); registeredBoundedKeys(completions, budget); }
    const eq = <T>(left: unknown, right: T): left is T => equalBudgetValue(left, right, budget);
    budget?.reserve({ nodes: 1, structuralBytes: 16 }); budget?.spend();
    const unsupported = native(() => new Set<RecordValue>(), budget);
    const byId = assignmentIndex(assignments, budget);
    const priorAssignment = emptyMap<string>(budget);
    for (const row of assignments) {
      budget?.spend(16); // Visit and fixed scalar/type comparisons, before the row.
      const prior = get(priorAssignment, subject(row, budget), budget);
      const previous = get(byId, row.previousAssignmentId, budget);
      const seed = eq(row.source, 'LEGACY_SEED') && eq(row.previousAssignmentId, null);
      // Natural same-rule carry is readable but rejected by the strict boundary
      // writer. Do not bless that wider representation until both contracts agree.
      const carry = eq(row.source, 'CARRY_FORWARD') && previous !== undefined
        && previous === prior && !has(unsupported, previous, budget) && eq(previous.status, 'ASSIGNED')
        && eq(subject(previous, budget), subject(row, budget)) && relation(previous.ruleVersion, row.ruleVersion, '<', budget)
        && relation(previous.cycleStartsAt, row.cycleStartsAt, '<', budget) && relation(previous.createdAt, row.createdAt, '<=', budget)
        && !eq(previous.cycleEndsAt, null) && relation(previous.cycleEndsAt, row.cycleStartsAt, '<=', budget);
      if (!cycleSnapshot(row, row.createdAt, budget) || eq(row.cycleEndsAt, null)
        || !eq(row.status, 'ASSIGNED') || (!seed && !carry)) {
        add(unsupported, row, budget);
      }
      set(priorAssignment, subject(row, budget), row, budget);
    }
    const priorCompletion = emptyMap<string>(budget);
    for (const row of completions) {
      budget?.spend(20);
      const prior = get(priorCompletion, subject(row, budget), budget);
      const assignment = get(byId, row.assignmentId, budget);
      const predecessor = assignment ? get(byId, assignment.previousAssignmentId, budget) : undefined;
      const retainedFirst = prior === undefined && eq(assignment?.source, 'CARRY_FORWARD')
        && predecessor !== undefined && eq(predecessor.status, 'ASSIGNED')
        && eq(subject(predecessor, budget), subject(row, budget)) && relation(predecessor.cycleStartsAt, row.cycleStartsAt, '<', budget);
      const retainedNext = prior !== undefined && !has(unsupported, prior, budget) && eq(prior.source, 'CARRY_FORWARD')
        && eq(prior.status, 'SUCCESS') && eq(assignment?.previousAssignmentId, prior.assignmentId)
        && eq(prior.balanceAfter, row.balanceBefore) && relation(prior.cycleStartsAt, row.cycleStartsAt, '<', budget)
        && relation(prior.timestamp, row.timestamp, '<=', budget);
      if (!eq(row.source, 'BANK') && (!cycleSnapshot(row, row.timestamp, budget)
        || !eq(row.source, 'CARRY_FORWARD') || !eq(row.status, 'SUCCESS') || !eq(row.reward, 0)
        || !eq(row.balanceBefore, row.balanceAfter) || !eq(row.operationId, null) || !eq(row.operationPayloadHash, null)
        || (!eq(row.note, null) && (typeof row.note !== 'string' || !eq(trimNote(row.note, budget), row.note)))
        || EVIDENCE_KEYS.some((key) => { budget?.spend(); return !eq(row[key], undefined) && !eq(row[key], null); })
        || !assignment || has(unsupported, assignment, budget) || !eq(assignment.status, 'ASSIGNED')
        || !sameAssignmentCompletionTuple(assignment, row, budget) || relation(assignment.createdAt, row.timestamp, '>', budget)
        || (!retainedFirst && !retainedNext))) add(unsupported, row, budget);
      set(priorCompletion, subject(row, budget), row, budget);
    }
    budget?.check(); return unsupported;
  }, budget);
}

function subject(row: RecordValue, budget?: BudgetContext): string {
  return budget ? serializeBoundedOperationalKey('subject', row, budget)
    : JSON.stringify([row.taskId, row.taskInstanceId, row.studentId]);
}
function cycleSnapshot(row: RecordValue, timestamp: unknown, budget?: BudgetContext): boolean {
  budget?.spend(14);
  return equalBudgetValue(row.schemaVersion, 2, budget) && equalBudgetValue(row.timeZone, 'Asia/Seoul', budget)
    && typeof row.taskInstanceId === 'string' && Number.isSafeInteger(row.ruleVersion)
    && (row.ruleVersion as number) > 0 && typeof row.cycleStartsAt === 'string'
    && Number.isFinite(parseInstant(row.cycleStartsAt, budget))
    && equalBudgetValue(row.cycleId, cycleId(row.taskInstanceId, row.ruleVersion as number, row.cycleStartsAt, budget), budget)
    && typeof timestamp === 'string' && Number.isFinite(parseInstant(timestamp, budget))
    && relation(timestamp, row.cycleStartsAt, '>=', budget) && (equalBudgetValue(row.cycleEndsAt, null, budget)
      || (typeof row.cycleEndsAt === 'string' && Number.isFinite(parseInstant(row.cycleEndsAt, budget))
        && relation(row.cycleEndsAt, row.cycleStartsAt, '>', budget) && relation(timestamp, row.cycleEndsAt, '<', budget)));
}
function native<T>(call: () => T, budget?: BudgetContext): T {
  try { const result = call(); budget?.check(); return result; }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check(); throw error;
  }
}
function emptyMap<K>(budget?: BudgetContext): Map<K, RecordValue> {
  budget?.reserve({ nodes: 1, structuralBytes: 16 }); budget?.spend();
  return native(() => new Map<K, RecordValue>(), budget);
}
function assignmentIndex(assignments: readonly RecordValue[], budget?: BudgetContext): Map<unknown, RecordValue> {
  if (!budget) return new Map(assignments.map((row) => [row.assignmentId, row]));
  // Build the same last-ID-wins index directly; no unreserved map result list or
  // entry tuples, and replacing an ID does not allocate a new Map entry.
  const result = emptyMap<unknown>(budget);
  for (const row of assignments) { budget.spend(); set(result, row.assignmentId, row, budget); }
  return result;
}
function keyWork(key: unknown, budget?: BudgetContext): void { budget?.spend(1 + (typeof key === 'string' ? Math.ceil(key.length / 256) : 0)); }
function get<K>(map: Map<K, RecordValue>, key: K, budget?: BudgetContext): RecordValue | undefined {
  keyWork(key, budget); return native(() => map.get(key), budget);
}
function set<K>(map: Map<K, RecordValue>, key: K, row: RecordValue, budget?: BudgetContext): void {
  if (budget) {
    keyWork(key, budget);
    if (!native(() => map.has(key), budget)) budget.reserve({ slots: 2, structuralBytes: 8 });
  }
  keyWork(key, budget); native(() => map.set(key, row), budget);
}
function has(set: Set<RecordValue>, row: RecordValue, budget?: BudgetContext): boolean {
  budget?.spend(); return native(() => set.has(row), budget);
}
function add(set: Set<RecordValue>, row: RecordValue, budget?: BudgetContext): void {
  if (budget && !has(set, row, budget)) budget.reserve({ slots: 1, structuralBytes: 4 });
  budget?.spend(); native(() => set.add(row), budget);
}
function parseInstant(value: string, budget?: BudgetContext): number {
  if (budget) { budget.reserve({ nodes: 1, structuralBytes: 4 }); budget.spend(1 + Math.ceil(value.length / 256)); }
  return native(() => Date.parse(value), budget);
}
function trimNote(value: string, budget?: BudgetContext): string {
  if (budget) { budget.reserveString(utf8ByteLength(value, budget)); budget.spend(1 + Math.ceil(value.length / 256)); }
  return native(() => value.trim(), budget);
}
function cycleId(instance: string, version: number, starts: string, budget?: BudgetContext): string {
  if (!budget) return `v1|${instance}|r${version}|${starts.replace('.000Z', 'Z')}`;
  const startBytes = utf8ByteLength(starts, budget);
  budget.reserveString(startBytes); budget.spend(1 + Math.ceil(starts.length / 256));
  const replaced = native(() => starts.replace('.000Z', 'Z'), budget);
  budget.reserveString(32); budget.spend(); // Native finite integer formatting.
  const number = native(() => String(version), budget);
  budget.reserveString(6 + utf8ByteLength(instance, budget) + number.length + startBytes);
  budget.spend(1 + Math.ceil((instance.length + number.length + replaced.length + 6) / 256));
  return native(() => `v1|${instance}|r${number}|${replaced}`, budget);
}
function relation(left: unknown, right: unknown, operator: '<' | '<=' | '>' | '>=', budget?: BudgetContext): boolean {
  if (budget) {
    // Rare malformed canonical operands can be arrays/records. Reserve native
    // coercion scratch too, without certifying or mutating them. Their immutable
    // primitive-only graphs cannot dispatch caller-defined coercion callbacks.
    budget.spend(2);
    if (left && typeof left === 'object') left = stringBoundedJson(left, budget);
    if (right && typeof right === 'object') right = stringBoundedJson(right, budget);
    budget.spend(1 + (typeof left === 'string' ? Math.ceil(left.length / 256) : 0)
      + (typeof right === 'string' ? Math.ceil(right.length / 256) : 0));
  }
  // Type assertions do not alter the original JS relational-coercion semantics.
  return native(() => operator === '<' ? (left as string) < (right as string)
    : operator === '<=' ? (left as string) <= (right as string)
      : operator === '>' ? (left as string) > (right as string) : (left as string) >= (right as string), budget);
}
