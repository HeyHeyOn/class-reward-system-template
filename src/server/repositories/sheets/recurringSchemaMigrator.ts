import {
  MigrationConflictError,
  SheetProviderError,
  type RecurringSchemaMigrationStore,
  type SheetInfo,
  type SheetLookupResult,
} from '@/server/storage/tabularStore';

export { MigrationConflictError } from '@/server/storage/tabularStore';

export const TASK_SCHEMA_HEADERS = [
  'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
  'allowedStudentIds', 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone',
  'recurrenceType', 'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'pendingRuleVersion', 'pendingEffectiveFrom',
  'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday',
  'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
  'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays',
] as const;

export const TASK_COMPLETION_SCHEMA_HEADERS = [
  'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
  'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt',
  'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion',
] as const;

export const TASK_ASSIGNMENT_HEADERS = [
  'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
  'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
] as const;

type ExtensionPlan = {
  name: 'Tasks' | 'TaskCompletions';
  info: SheetInfo;
  expectedHeader: string[];
  missing: string[];
};

/** Explicit command. Ordinary reads never invoke schema migration. */
export async function migrateRecurringTaskSchema(store: RecurringSchemaMigrationStore): Promise<void> {
  const plans = await Promise.all([
    planExtension(store, 'Tasks', TASK_SCHEMA_HEADERS),
    planExtension(store, 'TaskCompletions', TASK_COMPLETION_SCHEMA_HEADERS),
  ]);
  const assignments = await store.lookupSheet('TaskAssignments');
  if (assignments.found) await assertAssignmentState(store, assignments.info);
  for (const plan of plans) await applyExtension(store, plan);
  await ensureAssignments(store, assignments);
}

async function planExtension(
  store: RecurringSchemaMigrationStore,
  name: ExtensionPlan['name'],
  canonical: readonly string[],
): Promise<ExtensionPlan> {
  const firstLookup = await store.lookupSheet(name);
  if (!firstLookup.found) throw new MigrationConflictError(name, 'required sheet is missing');
  const firstHeader = (await store.getRows(name))[0] ?? [];
  if (name === 'Tasks') {
    assertKnownTasksHeader(firstHeader);
  } else {
    const requiredLegacyPrefix = canonical.slice(0, 10);
    if (!hasCanonicalPrefix(firstHeader, requiredLegacyPrefix)) {
      throw new MigrationConflictError(name, 'existing legacy header prefix is not canonical');
    }
  }
  const normalized = firstHeader.map(normalize);
  const missing = canonical.filter((header) => !normalized.includes(header));
  if (missing.length === 0) return { name, info: firstLookup.info, expectedHeader: firstHeader, missing: [] };

  const secondLookup = await store.lookupSheet(name);
  const secondHeader = (await store.getRows(name))[0] ?? [];
  if (!secondLookup.found || secondLookup.info.sheetId !== firstLookup.info.sheetId
    || secondLookup.info.columnCount !== firstLookup.info.columnCount || !sameHeader(firstHeader, secondHeader)) {
    throw new MigrationConflictError(name, 'header prefix or grid width changed during preflight');
  }
  if (firstHeader.length > firstLookup.info.columnCount) {
    throw new MigrationConflictError(name, 'header exceeds grid width');
  }
  return { name, info: firstLookup.info, expectedHeader: firstHeader, missing: [...missing] };
}

async function applyExtension(store: RecurringSchemaMigrationStore, plan: ExtensionPlan): Promise<void> {
  if (plan.missing.length === 0) return;
  const required = plan.expectedHeader.length + plan.missing.length;
  if (required > plan.info.columnCount) {
    await store.verifyHeaderCells(plan.name, {
      sheetId: plan.info.sheetId,
      columnCount: plan.info.columnCount,
      header: plan.expectedHeader,
    });
    await store.ensureColumnCount(plan.name, plan.info.columnCount, required);
  }
  await store.verifyAndWriteHeaderCells(plan.name, {
    sheetId: plan.info.sheetId,
    columnCount: Math.max(plan.info.columnCount, required),
    header: plan.expectedHeader,
  }, plan.missing);
}

async function assertAssignmentState(store: RecurringSchemaMigrationStore, info: SheetInfo): Promise<void> {
  const header = (await store.getRows('TaskAssignments'))[0] ?? [];
  if (header.length === 0) {
    throw new MigrationConflictError('TaskAssignments', 'existing sheet has no canonical header');
  }
  if (!hasCanonicalPrefix(header, TASK_ASSIGNMENT_HEADERS)) {
    throw new MigrationConflictError('TaskAssignments', 'existing header does not begin with canonical A1:O1');
  }
  if (info.columnCount < TASK_ASSIGNMENT_HEADERS.length) {
    throw new MigrationConflictError('TaskAssignments', 'canonical header exceeds grid width');
  }
}

async function ensureAssignments(store: RecurringSchemaMigrationStore, initial: SheetLookupResult): Promise<void> {
  let lookup = initial;
  let racedCreate = false;
  if (!lookup.found) {
    try {
      await store.createSheetWithHeader('TaskAssignments', TASK_ASSIGNMENT_HEADERS);
    } catch (error) {
      if (!(error instanceof SheetProviderError) || error.reason !== 'SHEET_ALREADY_EXISTS') throw error;
      racedCreate = true;
    }
    lookup = await store.lookupSheet('TaskAssignments');
    if (!lookup.found) throw new MigrationConflictError('TaskAssignments', 'sheet absent after create');
  }
  const header = (await store.getRows('TaskAssignments'))[0] ?? [];
  if (hasCanonicalPrefix(header, TASK_ASSIGNMENT_HEADERS)) return;
  if (racedCreate) {
    throw new MigrationConflictError('TaskAssignments', 'concurrent create was not already canonical');
  }
  if (header.length !== 0) throw new MigrationConflictError('TaskAssignments', 'header changed before initialization');
  if (lookup.info.columnCount < TASK_ASSIGNMENT_HEADERS.length) {
    await store.ensureColumnCount('TaskAssignments', lookup.info.columnCount, TASK_ASSIGNMENT_HEADERS.length);
  }
  await store.writeHeaderCells('TaskAssignments', 0, [...TASK_ASSIGNMENT_HEADERS]);
}

const KNOWN_TASK_HEADER_PREFIXES = [
  TASK_SCHEMA_HEADERS.slice(0, 9),
  ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'],
  ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds', 'createdAt', 'updatedAt'],
  ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'],
] as const;

function assertKnownTasksHeader(header: readonly string[]): void {
  const signatureLength = KNOWN_TASK_HEADER_PREFIXES.find((prefix) => hasCanonicalPrefix(header, prefix))?.length;
  if (signatureLength === undefined) {
    throw new MigrationConflictError('Tasks', 'existing legacy header does not match a deployed signature');
  }
  const normalized = header.map(normalize);
  const seen = new Set(normalized.slice(0, signatureLength));
  for (const trailingHeader of normalized.slice(signatureLength)) {
    if (trailingHeader.length === 0 || seen.has(trailingHeader)) {
      throw new MigrationConflictError('Tasks', 'trailing header names must be non-blank and unique');
    }
    seen.add(trailingHeader);
  }
}

function normalize(value: string): string { return value.trim(); }
function sameHeader(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => normalize(value) === normalize(right[index] ?? ''));
}

function hasCanonicalPrefix(header: readonly string[], prefix: readonly string[]): boolean {
  return header.length >= prefix.length
    && prefix.every((value, index) => normalize(header[index] ?? '') === normalize(value));
}
