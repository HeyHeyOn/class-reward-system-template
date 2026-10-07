import { unsupportedOperationalRecords } from './operationalProjection';
import { createNormalizationOutput, type NormalizationOutput } from './normalizationOutput';
import { parsePromotionRow, parseTaskRow, createHeaderIndex } from '@/server/sheetsRows';
import { canonicalTransactionItem, isSheetsBankRewardLedger, parseTransactionItemsJson, adjustmentKey, adjustmentTransactionKey, sameAssignmentCompletionTuple, cancellationOriginalId } from './semanticValidators';
import { createBoundedCorrelationInput, assertRegisteredBoundedJson, registeredBoundedKeys, stringBoundedJsonExact as stringBoundedJson, createBoundedHistoryAssignment, createBoundedHistoryCompletion, createBoundedHistoryInvalidCompletion, boundedOperationalHistoryView, createBoundedOperationalHistoryList } from '@/lib/boundedJson';
import { BudgetExceededError, BudgetUnavailableError, allocate, addBudgetSet, equalBudgetValue, mapBudgetList, stableBudgetSort, trimBudgetString, uniqueBudgetStrings, utf8ByteLength, type BudgetContext } from '@/lib/boundedWork';
import type { SheetsSnapshot, SheetSnapshotRow } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import {
  canonicalId, canonicalInstant, canonicalJson, compareCodeUnits, deterministicId, deterministicIdWithBudget,
  isHexDigest, safeInteger, sha256, strictBoolean,
} from './validators';

export type Diagnostic = Readonly<{ code: string; path: string; sourceDigest: string }>;
export type SourcePointer =
  | Readonly<{ kind: 'SHEET'; artifactDigest: string; tab: string; rowNumber: number; rowHash: string }>
  | Readonly<{ kind: 'REDIS'; artifactDigest: string; provenance: string; sourceDigest: string }>;
export type NormalizedSourceRecord = Readonly<{
  source: SourcePointer;
  redactedSourceRecord: Readonly<{ identityDigest: string; recognizedFieldCount: number; omittedFieldCount: number }>;
  canonicalRecord: Readonly<Record<string, unknown>> | null;
  mappingStatus: 'STAGED' | 'QUARANTINED';
  targetTable?: string;
  targetId?: string;
  warningCodes: readonly string[];
  errorCodes: readonly string[];
}>;
export type SourceMapping = Readonly<{ sourceDigest: string; targetTable: string; targetId: string; status: 'STAGED' }>;

type Target = { table: string; id: string; record: Record<string, unknown> };
type Ref = { code: string; table: string; id: string };
type Entry = {
  source: SourcePointer; tab: string; identity: string; sourcePrimaryIdentity: string | null;
  redacted: NormalizedSourceRecord['redactedSourceRecord'];
  canonical: Record<string, unknown> | null; targets: Target[]; refs: Ref[]; warnings: string[]; errors: string[];
};

const REQUIRED: Record<number, Record<string, readonly string[]>> = {
  1: {
    Students: ['studentId', 'name', 'balance', 'status'], Products: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
    Transactions: ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
    Adjustments: ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'], Settings: ['key', 'value'],
    Tasks: ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'],
    TaskCompletions: ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'],
  },
  2: {}, 3: {},
};
const TASK_V2 = [
  ...REQUIRED[1].Tasks, 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
  'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
  'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
  'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
] as const;
const COMPLETION_SNAPSHOT_HEADERS = ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId', 'operationPayloadHash'];
REQUIRED[2] = { ...REQUIRED[1], Tasks: TASK_V2,
  TaskAssignments: ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'],
  TaskCompletions: [...REQUIRED[1].TaskCompletions, ...COMPLETION_SNAPSHOT_HEADERS],
};
REQUIRED[3] = { ...REQUIRED[2], Tasks: [...TASK_V2, 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays'],
  Promotions: ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
  PromotionProducts: ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
};
// The v4 generator and captured business tabs keep the v3 business headers.
// Keep the declared source version; completion/assignment and promotion row versions stay 2/3.
REQUIRED[4] = { ...REQUIRED[3] };
const EVIDENCE_HEADERS = ['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'];
const OPERATIONAL_SETTINGS = new Set(['schemaVersion', 'systemVersion', 'systemName', 'appTitle', 'bankTitle', 'currencyUnit', 'classTimeZone', 'themeColor', 'qrManualInputEnabled']);
const FINANCIAL_TABS = new Set(['Transactions', 'Adjustments', 'TaskAssignments', 'TaskCompletions']);
const TAB_COLLECTIONS: Record<string, readonly string[]> = {
  Students: ['students', 'accounts'], Products: ['products'], Transactions: ['transactions', 'transaction_items'],
  Adjustments: ['adjustments'], Tasks: ['tasks', 'task_allowed_students'], TaskAssignments: ['task_assignments'],
  TaskCompletions: ['task_completions'], Promotions: ['promotions'], PromotionProducts: ['promotion_products'],
};
const MAX_DIAGNOSTICS = 4_096;

function knownHeaders(schemaVersion: number, tab: string, budget?: BudgetContext): ReadonlySet<string> {
  if (budget) {
    const required = REQUIRED[schemaVersion]?.[tab];
    const evidence = tab === 'TaskCompletions' ? EVIDENCE_HEADERS : undefined;
    budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
    const known = new Set<string>();
    for (let i = 0; i < (required?.length ?? 0); i++) { budget.spend(); addBudgetSet(known, required![i], budget); budget.check(); }
    for (let i = 0; i < (evidence?.length ?? 0); i++) { budget.spend(); addBudgetSet(known, evidence![i], budget); budget.check(); }
    return known;
  }
  return new Set([
    ...(REQUIRED[schemaVersion]?.[tab] ?? []),
    ...(tab === 'TaskCompletions' ? EVIDENCE_HEADERS : []),
  ]);
}

/** Partial P0 propagation: admitted headers, shared cells, task/promotion row
 * callers, nested transaction items, accepted item-loop/ref/ID construction and
 * the SHEET Entry/source/redacted shell. Final output categories/array destinations
 * are capped separately per call. Other canonical/Target/ref payload expansion,
 * derived claims and joins are NOT bounded. Do not expose this as a bounded
 * manifest/report API. */
export function normalizeLegacySnapshots(input: { tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot }, budget?: BudgetContext) {
  try {
    if (budget) {
      preflightNormalizationRows(input, budget);
      // The three initial lists and two native indexes; no payload or entries yet.
      budget.reserve({ nodes: 5, structuralBytes: 80 });
    }
    const output = budget ? createNormalizationOutput(budget) : undefined;
    const entries: Entry[] = [];
    const warnings: Diagnostic[] = [];
    const conflicts: Diagnostic[] = [];
    let diagnosticCount = 0;
    const pushDiagnostics = (target: Diagnostic[], ...items: Diagnostic[]) => {
      if (diagnosticCount + items.length > MAX_DIAGNOSTICS) {
        throw new Error('Legacy migration output exceeds normalization bounds.');
      }
      diagnosticCount += items.length;
      target.push(...items);
    };
    function headerDiagnostic(list: Diagnostic[], code: string, tab: string, field: string | number): void {
      if (budget) {
        // Diagnostic object, rest list and destination slot BEFORE path operands.
        budget.reserve({ nodes: 5, slots: 5, structuralBytes: 128 });
        if (typeof field === 'number') { budget.reserveString(32); budget.spend(); }
        budget.reserveString(utf8ByteLength(tab, budget) + (typeof field === 'string' ? utf8ByteLength(field, budget) : 32) + 16);
        budget.spend(4);
      }
      const path = typeof field === 'number' ? `${tab}.headers[${field}]` : `${tab}.${field}`;
      budget?.check();
      const sourceDigest = sha256(input.sheets.digest, budget);
      pushDiagnostics(list, { code, path, sourceDigest }); budget?.check();
    }
    const collections = new Set<string>();
    const headerIndexes = new Map<string, Map<string, number>>();

    if (budget) {
      const count = registeredBoundedKeys(input.sheets.tabs, budget).length;
      budget.reserve({ nodes: 1, slots: count, structuralBytes: 16 + 4 * count });
      budget.spend(1 + count);
    }
    const tabNames = Object.keys(input.sheets.tabs); budget?.check();
    for (const tab of budget ? stableBudgetSort(tabNames, (a, b) => compareCodeUnits(a, b, budget), budget) : tabNames.sort(compareCodeUnits)) {
      budget?.spend();
      const snapshot = input.sheets.tabs[tab];
      for (const collection of TAB_COLLECTIONS[tab] ?? []) { budget?.spend(); addBudgetSet(collections, collection, budget); budget?.check(); }
      const normalized = budget ? mapBudgetList(snapshot.headers, (header) => typeof header === 'string' ? trimBudgetString(header, budget) : (header as string).trim(), budget) : snapshot.headers.map((header) => header.trim());
      budget?.reserve({ nodes: 1, structuralBytes: 16 }); budget?.spend();
      const counts = new Map<string, number>();
      budget?.spend();
      normalized.forEach((header) => {
        budget?.spend(3 + 2 * Math.ceil(header.length / 256));
        const count = counts.get(header) ?? 0; budget?.check();
        budget?.reserve({ nodes: 1, slots: count === 0 ? 2 : 0, structuralBytes: count === 0 ? 12 : 4 });
        counts.set(header, count + 1); budget?.check();
      });
      const required = REQUIRED[input.sheets.schemaVersion][tab] ?? [];
      const known = knownHeaders(input.sheets.schemaVersion, tab, budget);
      budget?.spend();
      normalized.forEach((header, index) => {
        budget?.spend(3 + 2 * Math.ceil(header.length / 256));
        if (!header) headerDiagnostic(warnings, 'BLANK_HEADER', tab, index);
        else if (!known.has(header)) headerDiagnostic(warnings, 'UNKNOWN_HEADER', tab, index);
        if (header && counts.get(header)! > 1 && firstHeaderPosition(normalized, header, budget) === index) headerDiagnostic(conflicts, 'DUPLICATE_HEADER', tab, header);
      });
      for (const column of required) {
        budget?.spend(2 + Math.ceil(column.length / 256));
        if ((counts.get(column) ?? 0) !== 1) headerDiagnostic(conflicts, 'MISSING_REQUIRED_COLUMN', tab, column);
      }
      // Budgeted parsers require the decoder-owned immutable arrays, not a spread
      // that loses private ownership. Their contracts only read these operands.
      const index = budget ? createHeaderIndex(snapshot.headers as string[], budget) : createHeaderIndex([...snapshot.headers]);
      budget?.reserve({ slots: 2, structuralBytes: 8 }); budget?.spend(1 + Math.ceil(tab.length / 256));
      headerIndexes.set(tab, index); budget?.check();
      budget?.spend();
      const badHeader = required.some((column) => { budget?.spend(2 + Math.ceil(column.length / 256)); const missing = (index.get(column) ?? -1) < 0; budget?.check(); return missing; });
      for (const row of snapshot.rows) {
        budget?.spend();
        // Reserve the destination before evaluating the Entry constructor.
        budget?.reserve({ slots: 1, structuralBytes: 4 });
        const entry = makeEntry(input.sheets, tab, row, snapshot.headers, index, input.tenantId, input.migrationJobId, badHeader, budget);
        // Adjustment construction creates no Target: correlation owns that
        // later expansion. The destination slot above already admits this Entry;
        // charge its native append and empty target visit without reserving twice.
        if (budget && tab === 'Settings') {
          // Reuse the existing Entry destination reservation, not a second slot.
          budget.spend(); entries.push(entry); budget.check();
          budget.spend();
          entry.targets.forEach((target) => {
            // One visit and the two short-string native Set operations. Check
            // has before add even when the collection was already present.
            budget.spend(5);
            const present = collections.has(target.table); budget.check();
            if (!present) budget.reserve({ slots: 1, structuralBytes: 4 });
            collections.add(target.table); budget.check();
          });
          budget.check();
        } else if (budget) {
          budget.spend();
          referenceNative(budget, () => entries.push(entry));
          budget.spend();
          const rowTargets = referenceNative(budget, () => entry.targets);
          const rowForEach = referenceNative(budget, () => rowTargets.forEach);
          referenceNative(budget, () => rowForEach.call(rowTargets, (target) => {
            budget.spend();
            const table = referenceNative(budget, () => target.table);
            claimCollection(collections, table, budget);
          }));
        } else {
          entries.push(entry);
          entry.targets.forEach((target) => collections.add(target.table));
        }
      }
    }

    const claimOutput = normalizeClaims(input, entries, budget);
    if (!budget) {
      entries.push(...claimOutput.entries);
      pushDiagnostics(conflicts, ...claimOutput.conflicts);
      claimOutput.collections.forEach((name) => collections.add(name));
    } else {
      // The private claim list paid for its slots, not these outer references.
      // Visit/append work is independent of destination allocation admission.
      budget.spend();
      for (let i = 0; i < claimOutput.entries.length; i++) {
        budget.spend(2);
        budget.reserve({ slots: 1, structuralBytes: 4 });
        const entry = referenceNative(budget, () => claimOutput.entries[i]);
        referenceNative(budget, () => entries.push(entry));
      }
      const claimConflicts = claimOutput.conflicts;
      budget.spend(1 + claimConflicts.length);
      if (claimConflicts.length === 0) {
        // Naturally empty today: preserve the legacy rest-list/native push.
        budget.reserve({ nodes: 1, structuralBytes: 16 });
        referenceNative(budget, () => pushDiagnostics(conflicts));
      } else {
        // Synthetic/future nonempty path: rest/argument and receiving slots,
        // plus iterator scratch, before reads. Keep the whole-batch 4096 guard.
        budget.reserve({ nodes: 3, slots: 3 * claimConflicts.length, structuralBytes: 48 + 12 * claimConflicts.length });
        referenceNative(budget, () => pushDiagnostics(conflicts, ...claimConflicts));
      }
      const claimCollections = claimOutput.collections;
      budget.spend();
      referenceNative(budget, () => claimCollections.forEach((name) => {
        budget.spend();
        claimCollection(collections, name, budget);
      }));
    }
    markDuplicates(entries, budget);
    validateRequiredSettings(entries, input.sheets.schemaVersion, (code, path) => {
      if (!budget) { pushDiagnostics(conflicts, diag(code, path, input.sheets.digest)); return; }
      // Diagnostic + its three fixed keys, variadic argument list and destination.
      // Reserve before evaluating the digest getter, hash or object literal.
      budget.spend(4); budget.reserve({ nodes: 5, slots: 5, structuralBytes: 64, contentBytes: 20 });
      referenceNative(budget, () => {
        const sourceDigest = sha256(input.sheets.digest, budget);
        budget.check();
        pushDiagnostics(conflicts, { code, path, sourceDigest });
      });
    }, budget);
    validateTransactionCancellations(entries, budget);
    correlateAdjustments(entries, input.tenantId, budget);
    validateReferences(entries, budget);
    validateOperationalHistory(entries, budget);
    validateReferences(entries, budget);
    quarantineUnsupportedBankAuthority(entries, budget);
    propagateClaimErrors(entries, budget);

    budget?.reserve({ nodes: 1, structuralBytes: 16 });
    budget?.spend();
    const targetsByCollection: Record<string, Target[]> = budget ? referenceNative(budget, () => Object.create(null)) : Object.create(null);
    const ledger = budget ? referenceList<string>(budget) : undefined;
    if (budget) {
      const names = targetIndexNames(collections, budget);
      for (let i = 0; ; i++) {
        budget.spend();
        const length = referenceNative(budget, () => names.length);
        if (i >= length) break;
        budget.spend(2);
        const name = referenceNative(budget, () => names[i]);
        targetIndexBucket(targetsByCollection, ledger!, name, budget);
      }
    } else {
      // Retain the omission-context expressions without control-flow erasing their types.
      const budget = undefined as BudgetContext | undefined;
      for (const name of [...collections].sort(compareCodeUnits)) {
      budget?.reserve({ nodes: 1, slots: 1, structuralBytes: 20 + utf8ByteLength(name, budget) });
      targetsByCollection[name] = [];
      }
    }
    budget?.reserve({ nodes: 2, structuralBytes: 32 });
    budget?.spend();
    const sourceRecords: NormalizedSourceRecord[] = budget ? referenceNative(budget, () => []) : [];
    budget?.spend();
    const mappings: SourceMapping[] = budget ? referenceNative(budget, () => []) : [];
    if (budget) {
    for (let entryIndex = 0; ; entryIndex++) {
      budget.spend();
      const entryLength = referenceNative(budget, () => entries.length);
      if (entryIndex >= entryLength) break;
      budget.spend(2);
      const entry = referenceNative(budget, () => entries[entryIndex]);
      budget.spend();
      const errors = referenceNative(budget, () => entry.errors);
      budget.spend();
      const errorLength = referenceNative(budget, () => errors.length);
      if (errorLength) {
        if (output) referenceNative(budget, () => output.sourceRecord(sourceRecords, true, () => toSourceRecord(entry, output, budget)));
        else sourceRecords.push(toSourceRecord(entry));
        if (budget) {
          const codes = sourceCodeList(() => entry.errors, budget);
          for (let i = 0; ; i++) {
            budget.spend();
            const length = referenceNative(budget, () => codes.length);
            if (i >= length) break;
            budget.spend(2);
            const code = referenceNative(budget, () => codes[i]);
            // Diagnostic/code and variadic scratch, including the destination once.
            // The path/hash own their string occurrences; raw scratch adds no category.
            budget.reserve({ nodes: 5, slots: 6, structuralBytes: 112 }); budget.spend(8);
            const path = rawDiagnosticPath(() => entry.source, budget);
            const digest = rawDiagnosticDigest(() => entry.source, budget);
            const sourceDigest = referenceNative(budget, () => sha256(digest, budget));
            const diagnostic = referenceNative(budget, () => ({ code, path, sourceDigest }));
            // Keep the combined raw cap AFTER argument/hash evaluation, without refund.
            referenceNative(budget, () => pushDiagnostics(conflicts, diagnostic));
          }
        } else for (const code of [...new Set(entry.errors)].sort(compareCodeUnits)) pushDiagnostics(conflicts, diag(code, sourcePath(entry.source), sourceDigest(entry.source)));
        continue;
      }
      budget.spend();
      const entryTargets = referenceNative(budget, () => entry.targets);
      for (let targetIndex = 0; ; targetIndex++) {
        budget.spend();
        const targetLength = referenceNative(budget, () => entryTargets.length);
        if (targetIndex >= targetLength) break;
        budget.spend(2);
        const target = referenceNative(budget, () => entryTargets[targetIndex]);
        budget.spend();
        const name = referenceNative(budget, () => target.table);
        budget.spend(1 + Math.ceil(name.length / 256));
        let bucket = referenceNative(budget, () => targetsByCollection[name]);
        if (!bucket) bucket = targetIndexBucket(targetsByCollection, ledger!, name, budget);
        referenceAppend(bucket, target, budget);
        if (output) referenceNative(budget, () => output.mapping(mappings, () => {
          // Closed four-field payload; the emitter already owns its category/destination.
          budget!.reserve({ nodes: 5, slots: 4, structuralBytes: 85 });
          budget!.spend(5);
          const source = referenceNative(budget, () => entry.source);
          const kind = referenceNative(budget, () => source.kind);
          const digest = referenceNative(budget, () => kind === 'SHEET' ? (source as Extract<SourcePointer, { kind: 'SHEET' }>).rowHash : (source as Extract<SourcePointer, { kind: 'REDIS' }>).sourceDigest);
          const table = referenceNative(budget, () => target.table);
          const id = referenceNative(budget, () => target.id);
          return { sourceDigest: digest, targetTable: table, targetId: id, status: 'STAGED' };
        }));
        else mappings.push({ sourceDigest: sourceDigest(entry.source), targetTable: target.table, targetId: target.id, status: 'STAGED' });
      }
      if (output) referenceNative(budget, () => output.sourceRecord(sourceRecords, false, () => toSourceRecord(entry, output, budget)));
      else sourceRecords.push(toSourceRecord(entry));
    }
    } else {
    const budget = undefined as BudgetContext | undefined;
    for (const entry of entries) {
      if (entry.errors.length) {
        if (output) referenceNative(budget, () => output.sourceRecord(sourceRecords, true, () => toSourceRecord(entry, output, budget)));
        else sourceRecords.push(toSourceRecord(entry));
        if (budget) {
          const codes = sourceCodeList(() => entry.errors, budget);
          for (let i = 0; ; i++) {
            budget.spend();
            const length = referenceNative(budget, () => codes.length);
            if (i >= length) break;
            budget.spend(2);
            const code = referenceNative(budget, () => codes[i]);
            // Diagnostic/code and variadic scratch, including the destination once.
            // The path/hash own their string occurrences; raw scratch adds no category.
            budget.reserve({ nodes: 5, slots: 6, structuralBytes: 112 }); budget.spend(8);
            const path = rawDiagnosticPath(() => entry.source, budget);
            const digest = rawDiagnosticDigest(() => entry.source, budget);
            const sourceDigest = referenceNative(budget, () => sha256(digest, budget));
            const diagnostic = referenceNative(budget, () => ({ code, path, sourceDigest }));
            // Keep the combined raw cap AFTER argument/hash evaluation, without refund.
            referenceNative(budget, () => pushDiagnostics(conflicts, diagnostic));
          }
        } else for (const code of [...new Set(entry.errors)].sort(compareCodeUnits)) pushDiagnostics(conflicts, diag(code, sourcePath(entry.source), sourceDigest(entry.source)));
        continue;
      }
      for (const target of entry.targets) {
        if (budget && !targetsByCollection[target.table]) budget.reserve({ nodes: 1, slots: 1, structuralBytes: 20 + utf8ByteLength(target.table, budget) });
        targetsByCollection[target.table] ??= [];
        // Intermediate duplicate Target references are slots, NOT canonical rows.
        budget?.reserve({ slots: 1, structuralBytes: 4 });
        targetsByCollection[target.table].push(target);
        if (output) referenceNative(budget, () => output.mapping(mappings, () => {
          // Closed four-field payload; the emitter already owns its category/destination.
          budget!.reserve({ nodes: 5, slots: 4, structuralBytes: 85 });
          budget!.spend(5);
          const source = referenceNative(budget, () => entry.source);
          const kind = referenceNative(budget, () => source.kind);
          const digest = referenceNative(budget, () => kind === 'SHEET' ? (source as Extract<SourcePointer, { kind: 'SHEET' }>).rowHash : (source as Extract<SourcePointer, { kind: 'REDIS' }>).sourceDigest);
          const table = referenceNative(budget, () => target.table);
          const id = referenceNative(budget, () => target.id);
          return { sourceDigest: digest, targetTable: table, targetId: id, status: 'STAGED' };
        }));
        else mappings.push({ sourceDigest: sourceDigest(entry.source), targetTable: target.table, targetId: target.id, status: 'STAGED' });
      }
      if (output) referenceNative(budget, () => output.sourceRecord(sourceRecords, false, () => toSourceRecord(entry, output, budget)));
      else sourceRecords.push(toSourceRecord(entry));
    }
    }
    budget?.reserve({ nodes: 1, structuralBytes: 16 });
    budget?.spend();
    const records: Record<string, Record<string, unknown>[]> = budget ? referenceNative(budget, () => Object.create(null)) : Object.create(null);
    if (budget) {
      const tableEntries = targetIndexEntries(targetsByCollection, ledger!, budget);
      for (let i = 0; ; i++) {
        budget.spend();
        const length = referenceNative(budget, () => tableEntries.length);
        if (i >= length) break;
        budget.spend(2);
        const tuple = referenceNative(budget, () => tableEntries[i]);
        budget.spend();
        const name = referenceNative(budget, () => tuple[0]);
        budget.spend();
        const targets = referenceNative(budget, () => tuple[1]);
        targetIndexSort(targets, budget);
        targetIndexRows(name, targets, records, output!, budget);
      }
    } else for (const [name, targets] of Object.entries(targetsByCollection)) {
      targets.sort((a, b) => compareCodeUnits(a.id, b.id));
      const unique = new Map<string, Target>();
      for (const target of targets) unique.set(target.id, target);
      if (output) {
        budget!.reserve({ nodes: 1, slots: 1, structuralBytes: 20 + utf8ByteLength(name, budget) });
        const rows: Record<string, unknown>[] = [];
        for (const target of unique.values()) output.target(rows, () => target.record);
        records[name] = rows;
      } else records[name] = [...unique.values()].map((target) => target.record);
    }
    if (budget) finalMappingSort(mappings, budget);
    else mappings.sort((a, b) => compareCodeUnits(`${a.targetTable}\0${a.targetId}\0${a.sourceDigest}`, `${b.targetTable}\0${b.targetId}\0${b.sourceDigest}`));
    sourceRecords.sort((a, b) => compareCodeUnits(sourcePath(a.source), sourcePath(b.source)) || compareCodeUnits(sourceDigest(a.source), sourceDigest(b.source)));
    return { records, sourceRecords, mappings, warnings: stableDiagnostics(warnings, undefined, budget), blockingConflicts: stableDiagnostics(conflicts, output, budget) };
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check(); throw error;
  }
}

function finalMappingKey(item: SourceMapping, budget: BudgetContext): string {
  budget.spend();
  const table = referenceNative(budget, () => item.targetTable);
  const T = referenceNative(budget, () => utf8ByteLength(table, budget));
  budget.reserveString(T + 1);
  budget.spend(1 + Math.ceil((table.length + 1) / 256));
  const first = referenceNative(budget, () => table + '\0');
  budget.spend();
  const id = referenceNative(budget, () => item.targetId);
  const I = referenceNative(budget, () => utf8ByteLength(id, budget));
  budget.reserveString(T + 1 + I);
  budget.spend(1 + Math.ceil((first.length + id.length) / 256));
  const second = referenceNative(budget, () => first + id);
  budget.reserveString(T + I + 2);
  budget.spend(1 + Math.ceil((second.length + 1) / 256));
  const third = referenceNative(budget, () => second + '\0');
  budget.spend();
  const rawDigest = referenceNative(budget, () => item.sourceDigest);
  const digest = typeof rawDigest === 'string' ? rawDigest : referenceString(rawDigest, budget);
  const D = referenceNative(budget, () => utf8ByteLength(digest, budget));
  budget.reserveString(T + I + D + 2);
  budget.spend(1 + Math.ceil((third.length + digest.length) / 256));
  return referenceNative(budget, () => third + digest);
}
function finalMappingSort(mappings: SourceMapping[], budget: BudgetContext): void {
  budget.spend();
  const sorted = referenceNative(budget, () => stableBudgetSort(mappings, (a, b) => {
    const left = finalMappingKey(a, budget);
    const right = finalMappingKey(b, budget);
    return referenceNative(budget, () => compareCodeUnits(left, right, budget));
  }, budget));
  for (let i = 0; ; i++) {
    budget.spend();
    if (i >= referenceNative(budget, () => sorted.length)) break;
    budget.spend(2);
    const item = referenceNative(budget, () => sorted[i]);
    budget.spend();
    referenceNative(budget, () => mappings[i] = item);
  }
  budget.check();
}

function targetIndexNames(collections: Set<string>, budget: BudgetContext): string[] {
  const names = referenceList<string>(budget);
  budget.spend();
  const forEach = referenceNative(budget, () => collections.forEach);
  referenceNative(budget, () => forEach.call(collections, name => {
    budget.spend();
    referenceAppend(names, name, budget);
    budget.check();
  }));
  return referenceNative(budget, () => stableBudgetSort(names, (a, b) => referenceNative(budget, () => compareCodeUnits(a, b, budget)), budget));
}

function targetIndexBucket(targetsByCollection: Record<string, Target[]>, ledger: string[], name: string, budget: BudgetContext): Target[] {
  const bytes = referenceNative(budget, () => utf8ByteLength(name, budget));
  budget.reserve({ nodes: 1, slots: 1, structuralBytes: 20 + bytes });
  budget.spend();
  const bucket: Target[] = referenceNative(budget, () => []);
  budget.spend(1 + Math.ceil(name.length / 256));
  referenceNative(budget, () => { targetsByCollection[name] = bucket; });
  referenceAppend(ledger, name, budget);
  return bucket;
}

function targetIndexEntries(targetsByCollection: Record<string, Target[]>, ledger: string[], budget: BudgetContext): [string, Target[]][] {
  let count = 0;
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => ledger.length);
    if (i >= length) { count = length; break; }
    budget.spend(2);
    const name = referenceNative(budget, () => ledger[i]);
    const bytes = referenceNative(budget, () => utf8ByteLength(name, budget));
    budget.reserveString(bytes);
  }
  budget.reserve({ nodes: 2 + count, slots: 4 * count, structuralBytes: 32 + 32 * count });
  budget.spend(2 + 2 * count);
  const entries = referenceNative(budget, () => Object.entries);
  return referenceNative(budget, () => entries(targetsByCollection));
}

function targetIndexSort(targets: Target[], budget: BudgetContext): void {
  const sorted = referenceNative(budget, () => stableBudgetSort(targets, (a, b) => {
    budget.spend();
    const left = referenceNative(budget, () => a.id);
    budget.spend();
    const right = referenceNative(budget, () => b.id);
    return referenceNative(budget, () => compareCodeUnits(left, right, budget));
  }, budget));
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => sorted.length);
    if (i >= length) break;
    budget.spend(2);
    const target = referenceNative(budget, () => sorted[i]);
    budget.spend();
    referenceNative(budget, () => { targets[i] = target; });
  }
}

function targetIndexRows(name: string, targets: Target[], records: Record<string, Record<string, unknown>[]>, output: ReturnType<typeof createNormalizationOutput>, budget: BudgetContext): void {
  const unique = referenceMap<Target>(budget);
  const keys = referenceList<string>(budget);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => targets.length);
    if (i >= length) break;
    budget.spend(2);
    const target = referenceNative(budget, () => targets[i]);
    budget.spend();
    const id = referenceNative(budget, () => target.id);
    const present = referenceHas(unique, id, budget);
    if (!present) budget.reserve({ slots: 2, structuralBytes: 8 });
    budget.spend(1 + Math.ceil(id.length / 256));
    referenceNative(budget, () => unique.set(id, target));
    if (!present) referenceAppend(keys, id, budget);
  }
  const bytes = referenceNative(budget, () => utf8ByteLength(name, budget));
  budget.reserve({ nodes: 1, slots: 1, structuralBytes: 20 + bytes });
  budget.spend();
  const rows: Record<string, unknown>[] = referenceNative(budget, () => []);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => keys.length);
    if (i >= length) break;
    budget.spend(2);
    const key = referenceNative(budget, () => keys[i]);
    const target = referenceGet(unique, key, budget)!;
    referenceNative(budget, () => output.target(rows, () => {
      budget.spend();
      return referenceNative(budget, () => target.record);
    }));
  }
  budget.spend(1 + Math.ceil(name.length / 256));
  referenceNative(budget, () => { records[name] = rows; });
}

function firstHeaderPosition(headers: readonly string[], header: string, budget?: BudgetContext): number {
  if (!budget) return headers.indexOf(header);
  for (let i = 0; i < headers.length; i++) {
    budget.spend();
    if (compareCodeUnits(headers[i], header, budget) === 0) return i;
  }
  return -1;
}

function recognizedHeaders(headers: readonly string[], known: ReadonlySet<string>, budget?: BudgetContext): number {
  if (!budget) return headers.filter((header) => known.has(header.trim())).length;
  let count = 0;
  for (let i = 0; i < headers.length; i++) {
    budget.spend(); const header = trimBudgetString(headers[i], budget);
    budget.spend(1 + Math.ceil(header.length / 256));
    if (known.has(header)) count++;
    budget.check();
  }
  return count;
}

const REDIS_ROW_COLLECTIONS = ['v2Claims', 'operationBindings', 'v1Tombstones', 'orphanedClaimDigests'] as const;

function preflightNormalizationRows(input: Parameters<typeof normalizeLegacySnapshots>[0], budget: BudgetContext): void {
  // Admission precedes input.sheets, ownKeys and every application allocation.
  // The decoder owns the entire immutable graph, not just a caller's root shape.
  assertRegisteredBoundedJson(input, budget);
  const tabs = registeredBoundedKeys(input.sheets.tabs, budget);
  let sheets = 0;
  for (let i = 0; i < tabs.length; i++) {
    budget.spend();
    const count = input.sheets.tabs[tabs[i]].rows.length;
    if (count > 2_000 - sheets) throw new BudgetExceededError();
    sheets += count;
  }
  if (input.redis) {
    let redis = 0;
    for (let i = 0; i < REDIS_ROW_COLLECTIONS.length; i++) {
      budget.spend();
      const count = input.redis[REDIS_ROW_COLLECTIONS[i]].length;
      if (count > 2_000 - redis) throw new BudgetExceededError();
      redis += count;
    }
  }
  budget.check();
}

function readNormalizationCell(row: SheetSnapshotRow, index: Map<string, number>, name: string, trimmed: boolean, budget?: BudgetContext): string {
    if (!budget) { const position = index.get(name); if (position === undefined || position < 0) return ''; const value = String(row.cells[position] ?? ''); return trimmed ? value.trim() : value; }
    try {
      budget.spend(3 + Math.ceil(name.length / 256));
      const position = index.get(name); budget.check();
      if (position === undefined || position < 0) return '';
      budget.spend(2);
      const value = stringBoundedJson(row.cells[position] ?? '', budget);
      return trimmed ? trimBudgetString(value, budget) : value;
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
      budget.check(); throw error;
    }
}

function makeEntry(sheets: SheetsSnapshot, tab: string, row: SheetSnapshotRow, headers: readonly string[], index: Map<string, number>, tenantId: string, jobId: string, badHeader: boolean, budget?: BudgetContext): Entry {
  const cell = (name: string) => readNormalizationCell(row, index, name, true, budget);
  // Closed SHEET pointer: one object, five scalar occurrences/properties;
  // 16 container + 57 property/key + 20 scalar structural units. Shared
  // input strings are not copied and this mutable result is not registered.
  budget?.reserve({ nodes: 6, slots: 5, structuralBytes: 93 });
  budget?.spend(6);
  const source: SourcePointer = { kind: 'SHEET', artifactDigest: sheets.digest, tab, rowNumber: row.rowNumber, rowHash: row.hash };
  const sourcePrimaryIdentity = canonicalId(cell(primaryField(tab)), budget);
  const identity = cell(primaryField(tab)) || row.hash;
  const known = knownHeaders(sheets.schemaVersion, tab, budget);
  const recognizedFieldCount = recognizedHeaders(headers, known, budget);
  // Closed mutable Entry shell only: Entry + redacted + four empty arrays,
  // seven scalar occurrences, thirteen properties. The identity hash payload
  // is separately reserved by sha256, AFTER this recipe and before its native
  // allocation. Subsequent canonical/Target/ref/error expansions are separate.
  budget?.reserve({ nodes: 13, slots: 13, structuralBytes: 307 });
  if (badHeader) budget?.reserve({ nodes: 1, slots: 1, structuralBytes: 8 });
  budget?.spend(badHeader ? 14 : 13);
  const entry: Entry = { source, tab, identity, sourcePrimaryIdentity, redacted: { identityDigest: sha256(identity, budget), recognizedFieldCount, omittedFieldCount: headers.length - recognizedFieldCount }, canonical: null, targets: [], refs: [], warnings: [], errors: badHeader ? ['INVALID_HEADER'] : [] };
  if (badHeader) return entry;
  const target = (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => {
    if (!context) { entry.targets.push({ table, id, record: { ...record } }); return; }
    // Guarded callers pre-reserve their closed payload/clone/shell/destination
    // BEFORE argument evaluation. Never infer a mutable record's shape here.
    try {
      const copy = { ...record }; context.check();
      entry.targets.push({ table, id, record: copy }); context.check();
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
      context.check(); throw error;
    }
  };
  const requiredId = (name: string, context?: BudgetContext) => canonicalId(cell(name), context);
  const malformed = () => entry.errors.push(FINANCIAL_TABS.has(tab) ? 'MALFORMED_REQUIRED_HISTORY' : 'MALFORMED_REQUIRED_RECORD');
  const malformedHistory = () => {
    if (!budget) return malformed();
    budget.spend(2);
    return allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, malformed);
  };
  // Only definition callers use this closed occurrence recipe. The four tabs
  // are not financial history; preserve the original sibling closure unchanged.
  const malformedDefinition = () => {
    if (!budget) return malformed();
    budget.spend();
    return allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.errors.push('MALFORMED_REQUIRED_RECORD'));
  };

  if (tab === 'Students') {
    const id = requiredId('studentId', budget), name = cell('name'), balance = safeInteger(cell('balance'), undefined, budget);
    const status = cell('status');
    budget?.spend(3);
    if (!id || !name || balance === null || !definitionStudentStatus(status, budget)) malformedDefinition();
    else {
      budget?.spend(5);
      entry.canonical = allocate(budget, { nodes: 5, slots: 4, structuralBytes: 74 }, () => ({ studentId: id, name, balance, status }));
      budget?.spend(14);
      const student = allocate(budget, { nodes: 14, slots: 12, structuralBytes: 214 }, () => ({ tenantId, studentId: id, name, status }));
      target('students', id, student, budget);
      budget?.spend(12);
      const account = allocate(budget, { nodes: 12, slots: 10, structuralBytes: 192 }, () => ({ tenantId, studentId: id, balance }));
      target('accounts', id, account, budget);
    }
  } else if (tab === 'Products') {
    const id = requiredId('productId', budget), name = cell('name'), price = safeInteger(cell('price'), { min: 0 }, budget), stock = safeInteger(cell('stock'), { min: 0 }, budget), active = strictBoolean(cell('isActive'), budget), sort = safeInteger(cell('sortOrder'), undefined, budget);
    budget?.spend(6);
    if (!id || !name || price === null || stock === null || active === null || sort === null) malformedDefinition();
    else {
      budget?.spend(9);
      entry.canonical = allocate(budget, { nodes: 9, slots: 8, structuralBytes: 136 }, () => ({ productId: id, name, price, stock, isActive: active, imageUrl: cell('imageUrl') || null, category: cell('category') || null, sortOrder: sort }));
      budget?.spend(24);
      const product = allocate(budget, { nodes: 24, slots: 22, structuralBytes: 368 }, () => ({ tenantId, ...entry.canonical }));
      target('products', id, product, budget);
    }
  } else if (tab === 'Transactions') {
    normalizeTransaction(entry, cell, tenantId, jobId, target, malformed, budget);
  } else if (tab === 'Adjustments') {
    if (!budget) {
      const id = requiredId('adjustmentId'), timestamp = canonicalInstant(cell('timestamp')), studentId = requiredId('studentId'), amount = safeInteger(cell('amount')), mode = cell('mode'), operator = cell('operator');
      if (!id || !timestamp || !studentId || amount === null || !['add', 'subtract', 'set'].includes(mode) || !operator
        || (mode !== 'set' && amount < 0)) malformed();
      else { entry.canonical = { adjustmentId: id, timestamp, studentId, amount, mode, operator, operatorDigest: sha256(operator) }; entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }); }
    } else {
      try {
        const id = requiredId('adjustmentId', budget), timestamp = canonicalInstant(cell('timestamp'), budget), studentId = requiredId('studentId', budget), amount = safeInteger(cell('amount'), undefined, budget), mode = cell('mode'), operator = cell('operator');
        // Fixed predicates and three short mode comparisons, including rejected
        // long discriminants. Reserve the actual legacy includes literal before
        // evaluating it; keep the original short-circuit operand order.
        budget.spend(8 + Math.ceil(mode.length / 256));
        if (!id || !timestamp || !studentId || amount === null || !allocate(budget, { nodes: 4, slots: 3, structuralBytes: 40 }, () => ['add', 'subtract', 'set'].includes(mode)) || !operator
          || (mode !== 'set' && amount < 0)) {
          budget.spend(2);
          allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => {
            const financial = FINANCIAL_TABS.has(tab); budget.check();
            return entry.errors.push(financial ? 'MALFORMED_REQUIRED_HISTORY' : 'MALFORMED_REQUIRED_RECORD');
          });
        } else {
          // Seven-key public mutable canonical shell; never freeze/register it.
          // The hash's UTF-8 input frame is separate from its existing digest
          // reservation. No joined encoding or new ID algorithm is introduced.
          budget.spend(8);
          entry.canonical = allocate(budget, { nodes: 8, slots: 7, structuralBytes: 134 }, () => {
            const bytes = utf8ByteLength(operator, budget);
            budget.reserve({ nodes: 1, contentBytes: bytes, structuralBytes: 16 });
            return { adjustmentId: id, timestamp, studentId, amount, mode, operator, operatorDigest: sha256(operator, budget) };
          });
          budget.spend(4);
          allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }));
        }
        budget.check();
      } catch (error) {
        if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
        budget.check(); throw error;
      }
    }
  } else if (tab === 'Settings') {
    if (!budget) {
      const key = cell('key'), value = cell('value');
      if (!key) malformed();
      else if (OPERATIONAL_SETTINGS.has(key)) { entry.canonical = { key, value }; target('settings', key, { tenantId, key, value }); }
      else { entry.canonical = { key, valueDigest: sha256(value) }; entry.warnings.push('SETTING_OMITTED'); }
    } else {
      try {
        // Shared cells already reserve their String/trim operands on this owner.
        const key = cell('key'), value = cell('value');
        budget.spend();
        if (!key) {
          budget.spend(2);
          allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => {
            const financial = FINANCIAL_TABS.has(tab); budget.check();
            return entry.errors.push(financial ? 'MALFORMED_REQUIRED_HISTORY' : 'MALFORMED_REQUIRED_RECORD');
          });
        } else {
          budget.spend(1 + Math.ceil(key.length / 256));
          const operational = OPERATIONAL_SETTINGS.has(key); budget.check();
          budget.spend(3);
          if (operational) {
            entry.canonical = allocate(budget, { nodes: 3, slots: 2, structuralBytes: 40 }, () => ({ key, value }));
            // Conservative closed bundle: staged record + clone (56 each),
            // Target shell (49), destination (4), plus 11 structural/one node
            // margin. No generated ID: the key is shared. Reserve the entire
            // 12-node/10-slot/176-byte bundle BEFORE literal/clone operands.
            budget.spend(12);
            const setting = allocate(budget, { nodes: 12, slots: 10, structuralBytes: 176 }, () => ({ tenantId, key, value }));
            target('settings', key, setting, budget);
          } else {
            // Public mutable two-key canonical shell, not a registered graph.
            // SHA already reserves its digest; separately admit its UTF-8 frame.
            entry.canonical = allocate(budget, { nodes: 3, slots: 2, structuralBytes: 46 }, () => {
              const bytes = utf8ByteLength(value, budget);
              budget.reserve({ nodes: 1, contentBytes: bytes, structuralBytes: 16 });
              return { key, valueDigest: sha256(value, budget) };
            });
            budget.spend();
            allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.warnings.push('SETTING_OMITTED'));
          }
        }
        budget.check();
      } catch (error) {
        if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
        budget.check(); throw error;
      }
    }
  } else if (tab === 'Tasks') {
    normalizeTask(entry, cell, index, row, sheets.schemaVersion, tenantId, target, () => {
      // Preserve the native financial-tab predicate and exception order inside
      // malformed; reserve its single occurrence/destination before invoking it.
      budget?.spend(2);
      return allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, malformed);
    }, budget);
  } else if (tab === 'TaskAssignments') {
    normalizeAssignment(entry, cell, tenantId, target, malformedHistory, budget);
  } else if (tab === 'TaskCompletions') {
    normalizeCompletion(entry, cell, row, index, sheets.schemaVersion, tenantId, target, malformedHistory, budget);
  } else if (tab === 'Promotions') {
    normalizePromotion(entry, row, index, tenantId, target, malformedDefinition, budget);
  } else if (tab === 'PromotionProducts') {
    const id = requiredId('promotionProductId', budget), promotionId = requiredId('promotionId', budget), productId = requiredId('productId', budget), createdAt = canonicalInstant(cell('createdAt'), budget), version = safeInteger(cell('schemaVersion'), { min: 1 }, budget);
    budget?.spend(5);
    if (!id || !promotionId || !productId || !createdAt || version !== 3) malformedDefinition();
    else {
      budget?.spend(6);
      entry.canonical = allocate(budget, { nodes: 6, slots: 5, structuralBytes: 116 }, () => ({ promotionProductId: id, promotionId, productId, createdAt, schemaVersion: version }));
      budget?.spend(8);
      allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => entry.refs.push({ code: 'BROKEN_PROMOTION_REFERENCE', table: 'promotions', id: promotionId }, { code: 'BROKEN_PRODUCT_REFERENCE', table: 'products', id: productId }));
      budget?.spend(18);
      const link = allocate(budget, { nodes: 18, slots: 16, structuralBytes: 328 }, () => ({ tenantId, ...entry.canonical }));
      target('promotion_products', id, link, budget);
    }
  } else entry.warnings.push('UNSUPPORTED_TAB');
  return entry;
}

/** Closed status array and its two bounded native comparisons. */
function definitionStudentStatus(status: string, budget?: BudgetContext): boolean {
  if (!budget) return ['ACTIVE', 'INACTIVE'].includes(status);
  budget.spend(10 + 2 * Math.ceil(status.length / 256));
  const statuses = allocate(budget, { nodes: 3, slots: 2, structuralBytes: 32 }, () => ['ACTIVE', 'INACTIVE']);
  try {
    const valid = statuses.includes(status); budget.check(); return valid;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

function normalizeTransaction(entry: Entry, cell: (name: string) => string, tenantId: string, jobId: string, target: (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => void, malformedHistory: () => void, budget?: BudgetContext) {
  // Only this transaction caller reserves its malformed occurrence; sibling
  // branches retain their existing contextless emission behavior.
  const malformed = () => {
    budget?.spend();
    allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, malformedHistory);
    budget?.check();
  };
  const id = canonicalId(cell('transactionId'), budget), timestamp = canonicalInstant(cell('timestamp'), budget), studentId = canonicalId(cell('studentId'), budget), studentName = cell('studentName');
  const total = safeInteger(cell('totalAmount'), undefined, budget), before = safeInteger(cell('balanceBefore'), undefined, budget), after = safeInteger(cell('balanceAfter'), undefined, budget), status = cell('status'), operator = cell('operator');
  let items: unknown;
  if (budget) items = parseTransactionItemsJson(cell('items'), budget);
  else { try { items = JSON.parse(cell('items')); } catch { items = null; } }
  // Closed five-status source array and Set, including scalar occurrences,
  // insertion slots and native iteration work, BEFORE either literal/constructor.
  budget?.spend(11);
  const supportedStatuses = allocate(budget, { nodes: 7, slots: 10, structuralBytes: 92 }, () => new Set(['COMPLETED', 'CANCELLED', 'TASK_REWARD', 'ADMIN_ADJUSTMENT', 'CANCEL_REVERSAL']));
  budget?.check();
  budget?.spend(16 + Math.ceil(status.length / 256));
  if (!id || !timestamp || !studentId || !studentName || total === null || before === null || after === null
    || !operator || !supportedStatuses.has(status) || !Array.isArray(items)) { malformed(); return; }
  budget?.check(); budget?.spend(3);
  const balanceDelta = after - before;
  const safeDelta = Number.isSafeInteger(balanceDelta); budget?.check();
  if (!safeDelta) { malformed(); return; }

  budget?.spend(2 + Math.ceil(status.length / 256));
  if (status === 'CANCEL_REVERSAL') {
    const originalId = cancellationOriginalId(operator, budget); budget?.check();
    // Eleven fixed fields (118 key bytes), scalar occurrences and the new empty
    // items array. Preserve canonical-before-malformed ordering and mutability.
    budget?.spend(13);
    entry.canonical = allocate(budget, { nodes: 13, slots: 11, structuralBytes: 238 }, () => ({ transactionId: id, timestamp, studentId, studentName, items: [], totalAmount: total, balanceBefore: before, balanceAfter: after, status, operator, reversesTransactionId: originalId }));
    budget?.check();
    budget?.spend(10 + Math.ceil((originalId?.length ?? 0) / 256) + Math.ceil(id.length / 256));
    if (!originalId || originalId === id || items.length !== 0 || total >= 0 || balanceDelta <= 0 || total !== -balanceDelta) {
      budget?.spend();
      allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.errors.push('MALFORMED_CANCELLATION_HISTORY'));
      budget?.check();
      return;
    }
    // Two closed ref records, all scalar occurrences and both append slots.
    budget?.spend(8);
    allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => entry.refs.push(
      { code: 'BROKEN_TRANSACTION_REFERENCE', table: 'transactions', id: originalId },
      { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId },
    ));
    budget?.check();
    // Two 13-field records (174 key bytes each), Target shell and destination.
    // Reserve at the caller BEFORE the staged literal, never inside target.
    budget?.spend(32);
    const staged = allocate(budget, { nodes: 32, slots: 30, structuralBytes: 645 }, () => ({ tenantId, transactionId: id, occurredAt: timestamp, studentId, studentNameSnapshot: studentName, kind: 'CANCELLATION', legacyTotalAmount: total, balanceDelta, balanceBefore: before, balanceAfter: after, operatorSnapshot: operator, legacyStatusSnapshot: status, reversesTransactionId: originalId }));
    budget?.check();
    target('transactions', id, staged, budget);
    budget?.check();
    return;
  }

  const purchase = status === 'COMPLETED' || status === 'CANCELLED';
  const adminAdjustment = status === 'ADMIN_ADJUSTMENT';
  const bankReward = isSheetsBankRewardLedger(status, operator, id, items.length, total, balanceDelta, budget);
  if ((purchase && (!items.length || total < 0 || balanceDelta !== -total))
    || (adminAdjustment ? items.length !== 1 : !purchase && !bankReward && items.length !== 0)
    || (status === 'TASK_REWARD' && !bankReward && balanceDelta !== total)
    || (status === 'ADMIN_ADJUSTMENT' && balanceDelta !== -total)) { malformed(); return; }
  // Closed empty containers and all canonicalItems destinations, before either
  // constructor. Product Set entries are reserved individually, not refunded.
  budget?.reserve({ nodes: 2, slots: items.length, structuralBytes: 32 + 4 * items.length });
  budget?.spend(2);
  const canonicalItems: Record<string, unknown>[] = [];
  const productIds = new Set<string>();
  budget?.check();
  let itemTotal = 0;
  for (let line = 0; line < items.length; line += 1) {
    budget?.spend();
    const item = canonicalTransactionItem(items[line], adminAdjustment || bankReward, budget);
    if (!item) { malformed(); return; }
    if (bankReward && (item.quantity !== 1 || item.price !== total || item.subtotal !== total)) { malformed(); return; }
    budget?.spend(1 + Math.ceil(item.productId.length / 256));
    const duplicate = productIds.has(item.productId); budget?.check();
    if (duplicate) { malformed(); return; }
    const productId = item.productId;
    addBudgetSet(productIds, productId, budget); budget?.check();
    budget?.spend(2);
    const nextTotal = itemTotal + item.subtotal;
    const safeTotal = Number.isSafeInteger(nextTotal); budget?.check();
    if (!safeTotal) { malformed(); return; }
    itemTotal = nextTotal;
    if (!adminAdjustment && !bankReward) {
      // Ref + three scalar occurrences/properties + append slot; 11 key bytes.
      budget?.reserve({ nodes: 4, slots: 4, structuralBytes: 55 }); budget?.spend(4);
      entry.refs.push({ code: 'BROKEN_PRODUCT_REFERENCE', table: 'products', id: productId }); budget?.check();
    }
    if (budget) {
      // Six framed arguments: rest array and scalar references BEFORE String,
      // canonical serialization or the callee can evaluate/allocate anything.
      budget.reserve({ nodes: 7, slots: 6, structuralBytes: 64 });
      budget.reserveString(32); budget.spend(2);
    }
    const lineNumber = String(line + 1); budget?.check();
    // Acceptance enforces exact keys recursively (all four promotion variants,
    // adjustments and productIds). Every accepted scalar is preserved: IDs/name
    // are rejected rather than trimmed, nested strings are copied verbatim,
    // schemaVersion is already 3. Only insertion order/detachment change, which
    // canonical JSON ignores. Hash the decoder-owned immutable SOURCE, never
    // certify or serialize the public mutable parser result with a budget.
    const itemJson = budget ? canonicalJson(items[line], budget) : canonicalJson(item);
    budget?.check();
    const itemId = budget
      ? deterministicIdWithBudget(budget, tenantId, jobId, 'transaction_items', id, lineNumber, itemJson)
      : deterministicId(tenantId, jobId, 'transaction_items', id, lineNumber, itemJson);
    budget?.check();
    // Closed maximum accepted schema: 14 item fields + 3 identity fields,
    // 179 key bytes. Nested parser lists are shared, not cloned/certified.
    // Destination slots were reserved above; this reserves the spread payload.
    budget?.reserve({ nodes: 18, slots: 17, structuralBytes: 331 }); budget?.spend(18);
    canonicalItems.push({ ...item, itemId, transactionId: id, lineNumber: line + 1 }); budget?.check();
  }
  if (purchase && itemTotal !== total) { malformed(); return; }
  // Closed 10-field canonical shell (97 key bytes). Shared mutable items are
  // not cloned or certified; the scalar-occurrence bound is conservative.
  budget?.spend(11);
  entry.canonical = allocate(budget, { nodes: 11, slots: 10, structuralBytes: 193 }, () => ({ transactionId: id, timestamp, studentId, studentName, items: canonicalItems, totalAmount: total, balanceBefore: before, balanceAfter: after, status, operator }));
  budget?.check();
  budget?.spend(4);
  allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }));
  budget?.check();
  // BEFORE target's argument literal: two 12-field records (153 key bytes
  // each), the 3-field Target, and its destination. Includes the shared target
  // closure's spread/append work; other branches keep their unbudgeted contract.
  // Twelve work units bound four status comparisons, including both operands'
  // single 256-code-unit blocks. These statuses are already closed/accepted.
  budget?.spend(42);
  allocate(budget, { nodes: 30, slots: 28, structuralBytes: 587 }, () => target('transactions', id, { tenantId, transactionId: id, occurredAt: timestamp, studentId, studentNameSnapshot: studentName, kind: transactionKind(status), legacyTotalAmount: total, balanceDelta, balanceBefore: before, balanceAfter: after, operatorSnapshot: operator, legacyStatusSnapshot: status }, budget));
  budget?.check();
  budget?.spend();
  canonicalItems.forEach((item) => {
    budget?.spend();
    // Closed maximum staged schema: 19 fields/262 key bytes. Reserve its
    // shallow Target clone, Target shell and append slot BEFORE String or the
    // staged builder evaluates. This grants no certificate to mutable output.
    budget?.reserve({ nodes: 24, slots: 23, structuralBytes: 487 }); budget?.spend(24);
    // itemId is the internally generated UUID, never a caller shape assertion.
    budget?.reserveString(36); budget?.spend(2);
    const itemId = String(item.itemId); budget?.check();
    const record = stagedTransactionItem(item, tenantId, adminAdjustment || bankReward, budget); budget?.check();
    target('transaction_items', itemId, record, budget); budget?.check();
  });
  budget?.check();
}

function stagedTransactionItem(item: Record<string, unknown>, tenantId: string, adminAdjustment: boolean, budget?: BudgetContext) {
  // Ten fixed base fields, 130 key bytes, before any source getter/operand.
  budget?.reserve({ nodes: 11, slots: 10, structuralBytes: 226 }); budget?.spend(11);
  const record: Record<string, unknown> = {
    tenantId,
    itemId: item.itemId,
    transactionId: item.transactionId,
    lineNumber: item.lineNumber,
    productIdSnapshot: item.productId,
    currentProductId: adminAdjustment ? null : item.productId,
    productNameSnapshot: item.name,
    quantity: item.quantity,
    unitPriceSnapshot: item.price,
    subtotalSnapshot: item.subtotal,
  };
  budget?.check(); budget?.spend();
  const extended = 'regularUnitPrice' in item; budget?.check();
  if (extended) {
    // Nine-field temporary operand plus nine new destination properties and
    // scalar occurrences (132 key bytes each); reserve before the literal,
    // not inside Object.assign after its source argument already exists.
    budget?.reserve({ nodes: 19, slots: 18, structuralBytes: 424 }); budget?.spend(20);
    Object.assign(record, {
      regularUnitPrice: item.regularUnitPrice,
      regularTotal: item.regularTotal,
      totalQuantity: item.totalQuantity,
      paidQuantity: item.paidQuantity,
      freeQuantity: item.freeQuantity,
      finalTotal: item.finalTotal,
      totalDiscount: item.totalDiscount,
      adjustmentsSnapshot: item.adjustments,
      appliedPromotionsSnapshot: item.appliedPromotions,
    });
    budget?.check();
  }
  return record;
}

const NONNEGATIVE = Object.freeze({ min: 0 });
const INTEGER_OPTIONS = Object.freeze({});
function taskDate(value: string, budget?: BudgetContext): number {
  budget?.reserve({ nodes: 1, structuralBytes: 4 });
  budget?.spend(1 + Math.ceil(value.length / 256));
  const result = Date.parse(value); budget?.check(); return result;
}

function normalizeTask(entry: Entry, cell: (name: string) => string, index: Map<string, number>, row: SheetSnapshotRow, version: number, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => void, malformed: () => void, budget?: BudgetContext) {
  const id = canonicalId(cell('taskId'), budget), title = cell('title'), reward = safeInteger(cell('reward'), NONNEGATIVE, budget), active = strictBoolean(cell('isActive'), budget), sort = safeInteger(cell('sortOrder'), INTEGER_OPTIONS, budget);
  const createdAt = canonicalInstant(cell('createdAt'), budget), updatedAt = canonicalInstant(cell('updatedAt'), budget);
  const availableFrom = cell('availableFrom') ? canonicalInstant(cell('availableFrom'), budget) : null;
  const dueAt = cell('dueAt') ? canonicalInstant(cell('dueAt'), budget) : null;
  budget?.spend(20); // fixed scalar truth/null/chronology predicate upper bound
  if (!id || !title || reward === null || active === null || sort === null || !createdAt || !updatedAt
    || (cell('availableFrom') && !availableFrom) || (cell('dueAt') && !dueAt)
    || taskDate(updatedAt, budget) < taskDate(createdAt, budget)
    || (availableFrom && dueAt && taskDate(dueAt, budget) <= taskDate(availableFrom, budget))) { malformed(); return; }
  budget?.spend();
  const parsed = budget ? parseTaskRow(row.cells as string[], index, 'Asia/Seoul', budget) : parseTaskRow([...row.cells], index, 'Asia/Seoul');
  budget?.check(); budget?.spend(3);
  if (!parsed || parsed.scheduleReadWarnings?.length) { malformed(); return; }
  let instanceId = canonicalId(parsed.taskInstanceId, budget);
  if (instanceId === null) {
    if (budget) {
      const bytes = 8 + utf8ByteLength(id, budget) + utf8ByteLength(createdAt, budget);
      if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
      budget.spend(1 + Math.ceil((8 + id.length + createdAt.length) / 256));
      instanceId = allocate(budget, { nodes: 1, contentBytes: bytes, structuralBytes: 4 }, () => `legacy:${id}:${createdAt}`);
    } else instanceId = `legacy:${id}:${createdAt}`;
  }
  let allowed = rawAllowedStudentIds(cell('allowedStudentIds'), budget);
  budget?.spend();
  if (allowed.some((studentId) => { budget?.spend(); return !canonicalId(studentId, budget); })) { malformed(); return; }
  if (!uniqueBudgetStrings(allowed, budget)) {
    budget?.spend();
    allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.errors.push('DUPLICATE_ALLOWED_STUDENT_ID')); return;
  }
  const prerequisiteTaskId = cell('prerequisiteTaskId') ? canonicalId(cell('prerequisiteTaskId'), budget) : null;
  if (cell('prerequisiteTaskId') && !prerequisiteTaskId) { malformed(); return; }
  if (equalBudgetValue(prerequisiteTaskId, id, budget)) {
    budget?.spend();
    allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.errors.push('SELF_TASK_REFERENCE')); return;
  }
  if (budget) allowed = stableBudgetSort(allowed, (a, b) => compareCodeUnits(a, b, budget), budget);
  else allowed.sort(compareCodeUnits);
  // Closed 16-field shell (173 key bytes). Scalar upper bound also covers
  // nullable schedules; referenced mutable parser graphs remain uncertified.
  budget?.spend(17);
  entry.canonical = allocate(budget, { nodes: 17, slots: 16, structuralBytes: 317 }, () => ({ taskId: id, taskInstanceId: instanceId, title, description: cell('description'), reward, isActive: active, sortOrder: sort, createdAt, updatedAt, allowedStudentIds: allowed, currentSchedule: parsed.schedule, pendingSchedule: parsed.pendingSchedule ?? null, availableFrom, dueAt, prerequisiteTaskId, schemaVersion: version }));
  for (const studentId of allowed) {
    budget?.spend(5); // loop visit + closed ref/append work
    allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_ALLOWED_STUDENT_REFERENCE', table: 'students', id: studentId }));
  }
  if (prerequisiteTaskId) {
    budget?.spend(4);
    allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: prerequisiteTaskId }));
  }
  // Each bundle reserves staged literal + shallow clone + Target + destination
  // BEFORE the spread/operand. No arbitrary mutable graph certification.
  budget?.spend(40);
  const staged = allocate(budget, { nodes: 40, slots: 38, structuralBytes: 720 }, () => ({ tenantId, ...entry.canonical }));
  target('tasks', instanceId, staged, budget);
  for (const studentId of allowed) {
    budget?.spend();
    // Four shared rest operands: reserve the array before calling the encoder.
    budget?.reserve({ nodes: 1, slots: 4, structuralBytes: 32 });
    const linkId = budget ? deterministicIdWithBudget(budget, tenantId, 'task_allowed_students', instanceId, studentId) : deterministicId(tenantId, 'task_allowed_students', instanceId, studentId);
    budget?.check(); budget?.spend(12);
    const link = allocate(budget, { nodes: 12, slots: 10, structuralBytes: 196 }, () => ({ tenantId, taskInstanceId: instanceId, studentId }));
    target('task_allowed_students', linkId, link, budget);
  }
}

/** Same delimiters and duplicate-preserving semantics as the original normalizer,
 * deliberately NOT the Sheets parser's first-occurrence dedupe. */
function rawAllowedStudentIds(value: string, budget?: BudgetContext): string[] {
  if (!budget) return value.split(/[\n,;]/).map((studentId) => studentId.trim()).filter(Boolean);
  let count = 1;
  budget.spend();
  for (let i = 0; i < value.length; i++) {
    if (i % 256 === 0) budget.spend();
    const code = value.charCodeAt(i);
    if (code === 10 || code === 44 || code === 59) count++;
  }
  const bytes = utf8ByteLength(value, budget);
  if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
  budget.reserve({ nodes: count + 1, slots: count, contentBytes: bytes, structuralBytes: 16 + 8 * count });
  budget.spend(1 + Math.ceil(value.length / 256));
  const pieces = value.split(/[\n,;]/); budget.check();
  budget.reserve({ nodes: 1, slots: count, structuralBytes: 16 + 4 * count });
  const allowed: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    budget.spend(); const id = trimBudgetString(pieces[i], budget);
    budget.spend(); if (id) { budget.spend(); allowed.push(id); budget.check(); }
  }
  budget.check(); return allowed;
}

const HISTORY_POSITIVE = Object.freeze({ min: 1 });
const HISTORY_ASSIGNMENT_STATUSES = ['ASSIGNED', 'UNASSIGNED'] as const;
const HISTORY_ASSIGNMENT_SOURCES = ['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'] as const;
const HISTORY_COMPLETION_SOURCES = ['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'] as const;
const HISTORY_SNAPSHOT_REQUIRED = ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'ruleVersion', 'timeZone', 'source', 'schemaVersion'] as const;

/** The original operational decision algorithm remains in operationalProjection.
 * This caller owns selection, timestamp keys, stable chronology and diagnostics;
 * other global joins/reference fixed points are intentionally still deferred. */
function validateOperationalHistory(entries: Entry[], budget?: BudgetContext): void {
  if (!budget) {
    const assignments = entries.filter((entry) => entry.tab === 'TaskAssignments' && entry.canonical);
    const completions = entries.filter((entry) => entry.tab === 'TaskCompletions' && entry.canonical)
      .sort((left, right) => compareCodeUnits(String(left.canonical!.timestamp), String(right.canonical!.timestamp))
        || (left.source.kind === 'SHEET' && right.source.kind === 'SHEET' ? left.source.rowNumber - right.source.rowNumber : 0));
    const unsupported = unsupportedOperationalRecords(assignments.map((entry) => entry.canonical!), completions.map((entry) => entry.canonical!));
    for (const entry of [...assignments, ...completions]) {
      if (unsupported.has(entry.canonical!)) entry.errors.push('UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY');
    }
    return;
  }
  // Lists and native chronology-key index before construction; destination slots
  // are admitted per selected occurrence, retaining duplicates and input order.
  budget.spend(3);
  const assignments = allocate(budget, { nodes: 1, structuralBytes: 16 }, () => [] as Entry[]);
  const completions = allocate(budget, { nodes: 1, structuralBytes: 16 }, () => [] as Entry[]);
  const timestamps = allocate(budget, { nodes: 1, structuralBytes: 16 }, () => new Map<Entry, string>());
  for (const entry of entries) {
    budget.spend(2);
    if (equalBudgetValue(entry.tab, 'TaskAssignments', budget) && entry.canonical) {
      budget.reserve({ slots: 1, structuralBytes: 4 }); budget.spend(); assignments.push(entry); budget.check();
    } else if (equalBudgetValue(entry.tab, 'TaskCompletions', budget) && entry.canonical) {
      budget.reserve({ slots: 1, structuralBytes: 4 }); budget.spend(); completions.push(entry); budget.check();
      const view = boundedOperationalHistoryView(entry.canonical, budget);
      budget.spend(); const value = view.timestamp;
      // Closed normal/legacy completion has a string; invalid evidence has no
      // timestamp and must retain the original String(undefined) chronology key.
      budget.reserveString(typeof value === 'string' ? utf8ByteLength(value, budget) : 32);
      budget.spend(1 + (typeof value === 'string' ? Math.ceil(value.length / 256) : 0));
      const key = String(value); budget.check();
      budget.spend(); const present = timestamps.has(entry); budget.check();
      if (!present) budget.reserve({ slots: 2, structuralBytes: 8 });
      budget.spend(); timestamps.set(entry, key); budget.check();
    }
  }
  const chronological = stableBudgetSort(completions, (left, right) => {
    budget.spend(); const leftKey = timestamps.get(left)!; budget.check();
    budget.spend(); const rightKey = timestamps.get(right)!; budget.check();
    const order = compareCodeUnits(leftKey, rightKey, budget);
    if (order) return order;
    budget.spend(3);
    return left.source.kind === 'SHEET' && right.source.kind === 'SHEET' ? left.source.rowNumber - right.source.rowNumber : 0;
  }, budget);
  const assignmentViews = createBoundedOperationalHistoryList(assignments.length, (i) => assignments[i].canonical!, budget);
  const completionViews = createBoundedOperationalHistoryList(chronological.length, (i) => chronological[i].canonical!, budget);
  const unsupported = unsupportedOperationalRecords(assignmentViews, completionViews, budget); budget.check();
  // Avoid the old concatenation allocation without changing assignment-first,
  // completion-chronology occurrence order or deduplicating diagnostics.
  for (let group = 0; group < 2; group++) {
    budget.spend(); const selected = group === 0 ? assignments : chronological;
    const views = group === 0 ? assignmentViews : completionViews;
    for (let i = 0; i < selected.length; i++) {
      budget.spend(2); const rejected = unsupported.has(views[i]); budget.check();
      if (rejected) {
        budget.reserve({ nodes: 1, slots: 1, structuralBytes: 8 }); budget.spend();
        selected[i].errors.push('UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY'); budget.check();
      }
    }
  }
}

function historyIncludes(values: readonly string[], value: string, budget?: BudgetContext): boolean {
  // Fixed literal vocabularies; charge every possible comparison and both
  // operands' blocks before the original native includes (including rejection).
  budget?.spend(1 + values.length * (3 + Math.ceil(value.length / 256)));
  try { const result = values.includes(value); budget?.check(); return result; }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}
function historyError(entry: Entry, code: 'SELF_ASSIGNMENT_REFERENCE' | 'MISSING_ADMIN_OPERATION_PROVENANCE', budget?: BudgetContext): void {
  budget?.spend();
  allocate(budget, { nodes: 1, slots: 1, structuralBytes: 8 }, () => entry.errors.push(code));
}
function historyLower(value: string, budget?: BudgetContext): string {
  // Unicode default lowercase can expand; three UTF-8 bytes per original byte
  // is a conservative bound, not an ASCII-only assumption about invalid input.
  if (budget) { budget.reserveString(3 * utf8ByteLength(value, budget)); budget.spend(1 + Math.ceil(value.length / 256)); }
  try { const result = value.toLowerCase(); budget?.check(); return result; }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}
function historyRegex(regex: RegExp, value: string, budget?: BudgetContext): boolean {
  budget?.spend(1 + Math.ceil(value.length / 256));
  try { const result = regex.test(value); budget?.check(); return result; }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}
function historySafeInteger(value: number, budget?: BudgetContext): boolean {
  budget?.spend();
  try { const result = Number.isSafeInteger(value); budget?.check(); return result; }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}
function historyTupleDigest(board: string, post: string, budget?: BudgetContext): string {
  if (budget) { budget.reserveString(utf8ByteLength(board, budget) + 1 + utf8ByteLength(post, budget)); budget.spend(1 + Math.ceil((board.length + 1 + post.length) / 256)); }
  return sha256(`${board}\0${post}`, budget);
}
function historyBinding(cell: (name: string) => string, taskId: string, studentId: string, starts: string | null, budget?: BudgetContext) {
  // Two closed shells, nine properties. Reserve before the first cell operand.
  // The local mutable result is never frozen, registered, or exported as owned.
  budget?.spend(11);
  return allocate(budget, { nodes: 11, slots: 9, structuralBytes: 224 }, () => ({ taskId, studentId, cycleStartsAt: starts, evidence: { evidenceProvider: 'PADLET', evidenceBoardId: cell('evidenceBoardId'), evidencePostId: cell('evidencePostId'), evidenceCreatedAt: cell('evidenceCreatedAt'), evidenceAuthorFullName: cell('evidenceAuthorFullName') } }));
}
type HistoryBinding = ReturnType<typeof historyBinding>;
function historyPayloadHash(binding: HistoryBinding, budget?: BudgetContext): string {
  if (!budget) return `sha256:${sha256(canonicalJson(binding))}`;
  // This private closed recipe encodes only primitive fields from our own local
  // binding. It does NOT admit/certify arbitrary mutable graphs. Exact sorted
  // canonical key order, scalar escaping and null semantics remain unchanged.
  budget.spend(9);
  const cycle = canonicalJson(binding.cycleStartsAt, budget), author = canonicalJson(binding.evidence.evidenceAuthorFullName, budget);
  const board = canonicalJson(binding.evidence.evidenceBoardId, budget), created = canonicalJson(binding.evidence.evidenceCreatedAt, budget);
  const post = canonicalJson(binding.evidence.evidencePostId, budget), provider = canonicalJson(binding.evidence.evidenceProvider, budget);
  const student = canonicalJson(binding.studentId, budget), task = canonicalJson(binding.taskId, budget);
  const bytes = 160 + utf8ByteLength(cycle, budget) + utf8ByteLength(author, budget) + utf8ByteLength(board, budget) + utf8ByteLength(created, budget) + utf8ByteLength(post, budget) + utf8ByteLength(provider, budget) + utf8ByteLength(student, budget) + utf8ByteLength(task, budget);
  budget.reserveString(bytes); budget.spend(1 + Math.ceil(bytes / 256));
  const encoded = `{"cycleStartsAt":${cycle},"evidence":{"evidenceAuthorFullName":${author},"evidenceBoardId":${board},"evidenceCreatedAt":${created},"evidencePostId":${post},"evidenceProvider":${provider}},"studentId":${student},"taskId":${task}}`;
  budget.reserveString(71); budget.spend(2);
  return `sha256:${sha256(encoded, budget)}`;
}
function historyEvidenceRecord(binding: HistoryBinding, budget?: BudgetContext) {
  budget?.spend(7);
  return allocate(budget, { nodes: 7, slots: 6, structuralBytes: 159 }, () => ({ ...binding.evidence, tupleDigest: historyTupleDigest(binding.evidence.evidenceBoardId, binding.evidence.evidencePostId, budget) }));
}
function historyEmptyEvidence(budget?: BudgetContext) {
  budget?.spend(); return allocate(budget, { nodes: 1, structuralBytes: 16 }, () => ({}));
}

function normalizeAssignment(entry: Entry, cell: (name: string) => string, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => void, malformed: () => void, budget?: BudgetContext) {
  const id = canonicalId(cell('assignmentId'), budget), taskId = canonicalId(cell('taskId'), budget), instanceId = canonicalId(cell('taskInstanceId'), budget), studentId = canonicalId(cell('studentId'), budget);
  const starts = canonicalInstant(cell('cycleStartsAt'), budget), ends = cell('cycleEndsAt') ? canonicalInstant(cell('cycleEndsAt'), budget) : null, created = canonicalInstant(cell('createdAt'), budget);
  const rule = safeInteger(cell('ruleVersion'), HISTORY_POSITIVE, budget), schema = safeInteger(cell('schemaVersion'), HISTORY_POSITIVE, budget), status = cell('status'), source = cell('source');
  const previousAssignmentId = cell('previousAssignmentId') ? canonicalId(cell('previousAssignmentId'), budget) : null;
  budget?.spend(30);
  if (!id || !taskId || !instanceId || !studentId || !starts || (cell('cycleEndsAt') && !ends) || (ends && taskDate(ends, budget) <= taskDate(starts, budget)) || !created || rule === null || schema !== 2 || !equalBudgetValue(cell('timeZone'), 'Asia/Seoul', budget) || !historyIncludes(HISTORY_ASSIGNMENT_STATUSES, status, budget) || !historyIncludes(HISTORY_ASSIGNMENT_SOURCES, source, budget) || !canonicalId(cell('cycleId'), budget) || (cell('previousAssignmentId') && !previousAssignmentId)) { malformed(); return; }
  if (equalBudgetValue(previousAssignmentId, id, budget)) { historyError(entry, 'SELF_ASSIGNMENT_REFERENCE', budget); return; }
  budget?.spend(16);
  entry.canonical = allocate(budget, { nodes: 16, slots: 15, structuralBytes: 285 }, () => budget ? createBoundedHistoryAssignment(budget, id, taskId, instanceId, cell('cycleId'), starts, ends, rule, 'Asia/Seoul', studentId, status, source, previousAssignmentId, created, schema, cell('note')) : ({ assignmentId: id, taskId, taskInstanceId: instanceId, cycleId: cell('cycleId'), cycleStartsAt: starts, cycleEndsAt: ends, ruleVersion: rule, timeZone: 'Asia/Seoul', studentId, status, source, previousAssignmentId, createdAt: created, schemaVersion: schema, note: cell('note') }));
  if (equalBudgetValue(source, 'ADMIN', budget) || equalBudgetValue(source, 'QR', budget)) historyError(entry, 'MISSING_ADMIN_OPERATION_PROVENANCE', budget);
  budget?.spend(8);
  allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'tasks', id: instanceId }, { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }));
  if (previousAssignmentId) {
    budget?.spend(4);
    allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_ASSIGNMENT_REFERENCE', table: 'task_assignments', id: previousAssignmentId }));
  }
  budget?.spend(38);
  const staged = allocate(budget, { nodes: 38, slots: 36, structuralBytes: 658 }, () => ({ tenantId, ...entry.canonical }));
  target('task_assignments', id, staged, budget);
}

function normalizeCompletion(entry: Entry, cell: (name: string) => string, row: SheetSnapshotRow, index: Map<string, number>, sourceSchemaVersion: number, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => void, malformed: () => void, budget?: BudgetContext) {
  const raw = (name: string) => readNormalizationCell(row, index, name, false, budget);
  const id = canonicalId(cell('completionId'), budget), taskId = canonicalId(cell('taskId'), budget), studentId = canonicalId(cell('studentId'), budget), timestamp = canonicalInstant(cell('timestamp'), budget);
  const reward = safeInteger(cell('reward'), undefined, budget), before = safeInteger(cell('balanceBefore'), undefined, budget), after = safeInteger(cell('balanceAfter'), undefined, budget), status = cell('status');
  budget?.spend(12);
  if (!id || !taskId || !studentId || !timestamp || !cell('studentName') || reward === null || before === null || after === null || !status) { malformed(); return; }
  const snapshotRequired = HISTORY_SNAPSHOT_REQUIRED;
  const hasSnapshot = sourceSchemaVersion >= 2;
  const instanceId = hasSnapshot ? canonicalId(cell('taskInstanceId'), budget) : null;
  const starts = canonicalInstant(cell('cycleStartsAt'), budget);
  const ends = cell('cycleEndsAt') ? canonicalInstant(cell('cycleEndsAt'), budget) : null;
  budget?.spend(22);
  if (hasSnapshot && (snapshotRequired.some((name) => { budget?.spend(); return !cell(name); }) || !instanceId || !canonicalId(cell('cycleId'), budget) || !starts
    || (cell('cycleEndsAt') && !ends) || (ends && starts && taskDate(ends, budget) <= taskDate(starts, budget))
    || safeInteger(cell('ruleVersion'), HISTORY_POSITIVE, budget) === null || !equalBudgetValue(cell('timeZone'), 'Asia/Seoul', budget)
    || !historyIncludes(HISTORY_COMPLETION_SOURCES, cell('source'), budget) || safeInteger(cell('schemaVersion'), undefined, budget) !== 2)) { malformed(); return; }
  const operationId = cell('operationId'), operationPayloadHash = historyLower(cell('operationPayloadHash'), budget);
  budget?.spend(6);
  if (Boolean(operationId) !== Boolean(operationPayloadHash) || (operationId && (!canonicalId(operationId, budget) || !historyRegex(/^sha256:[a-f0-9]{64}$/, operationPayloadHash, budget)))) { malformed(); return; }
  budget?.spend(6);
  const evidenceHeaders = allocate(budget, { nodes: 1, slots: 5, structuralBytes: 36 }, () => EVIDENCE_HEADERS.slice(2));
  const evidenceValues = budget ? mapBudgetList(evidenceHeaders, cell, budget) : evidenceHeaders.map(cell);
  const rememberInvalidEvidence = () => { budget?.spend(10); entry.canonical = allocate(budget, { nodes: 10, slots: 9, structuralBytes: 191 }, () => budget ? createBoundedHistoryInvalidCompletion(budget, id, taskId, studentId, instanceId, cell('cycleId') || null, starts, operationId || null, operationPayloadHash || null, historyTupleDigest(cell('evidenceBoardId'), cell('evidencePostId'), budget)) : ({ completionId: id, taskId, studentId, taskInstanceId: instanceId, cycleId: cell('cycleId') || null, cycleStartsAt: starts, operationId: operationId || null, operationPayloadHash: operationPayloadHash || null, tupleDigest: historyTupleDigest(cell('evidenceBoardId'), cell('evidencePostId'), budget) })); malformed(); };
  budget?.spend(12);
  if (evidenceValues.some((value) => { budget?.spend(); return Boolean(value); }) && (!evidenceValues.every((value) => { budget?.spend(); return Boolean(value); }) || !operationId || !equalBudgetValue(cell('evidenceProvider'), 'PADLET', budget)
    || !historyRegex(/^[A-Za-z0-9]{16,22}$/, cell('evidenceBoardId'), budget) || !historyRegex(/^[A-Za-z0-9_-]{3,128}$/, cell('evidencePostId'), budget)
    || !canonicalInstant(cell('evidenceCreatedAt'), budget) || !equalBudgetValue(raw('evidenceAuthorFullName'), cell('evidenceAuthorFullName'), budget)
    || cell('evidenceAuthorFullName').length > 200)) { rememberInvalidEvidence(); return; }
  const source = cell('source');
  budget?.spend(30);
  if (hasSnapshot && equalBudgetValue(source, 'CARRY_FORWARD', budget) && (reward !== 0 || before !== after)) { malformed(); return; }
  if (hasSnapshot && equalBudgetValue(source, 'BANK', budget) && operationId && after - before !== reward) { malformed(); return; }
  if (equalBudgetValue(source, 'ADMIN_RESET', budget)) {
    const administratorReset = reward === 0 && before === after;
    const cancellationReset = Boolean(operationId) && reward > 0 && historySafeInteger(before - reward, budget) && after === before - reward;
    if (!equalBudgetValue(status, 'RESET', budget) || (!administratorReset && !cancellationReset)) { malformed(); return; }
  }
  if (equalBudgetValue(source, 'ADMIN', budget) || equalBudgetValue(source, 'ADMIN_RESET', budget)) historyError(entry, 'MISSING_ADMIN_OPERATION_PROVENANCE', budget);
  budget?.spend();
  const binding = evidenceValues.every((value) => { budget?.spend(); return Boolean(value); }) ? historyBinding(cell, taskId, studentId, starts, budget) : null;
  if (binding && !equalBudgetValue(operationPayloadHash, historyPayloadHash(binding, budget), budget)) { rememberInvalidEvidence(); return; }
  budget?.spend(28);
  entry.canonical = allocate(budget, { nodes: 28, slots: 27, structuralBytes: 542 }, () => {
    if (!budget) return { completionId: id, timestamp, taskId, studentId, studentName: cell('studentName'), reward, balanceBefore: before, balanceAfter: after, status, note: cell('note'), taskInstanceId: instanceId, cycleId: cell('cycleId') || null, cycleStartsAt: starts, cycleEndsAt: ends, ruleVersion: hasSnapshot ? safeInteger(cell('ruleVersion'), undefined, budget) : null, timeZone: cell('timeZone') || null, source: source || null, assignmentId: cell('assignmentId') || null, schemaVersion: hasSnapshot ? 2 : 1, operationId: operationId || null, operationPayloadHash: operationPayloadHash || null, ...(binding ? historyEvidenceRecord(binding, budget) : historyEmptyEvidence(budget)) };
    // Evaluate the original typed operands in their original order. No mutable
    // canonical/parser object is supplied as an ownership/shape assertion.
    const studentName = cell('studentName'), note = cell('note'), cycleId = cell('cycleId') || null;
    const ruleVersion = hasSnapshot ? safeInteger(cell('ruleVersion'), undefined, budget) : null;
    const timeZone = cell('timeZone') || null, assignmentId = cell('assignmentId') || null;
    const evidence = binding ? historyEvidenceRecord(binding, budget) : historyEmptyEvidence(budget);
    return createBoundedHistoryCompletion(budget, id, timestamp, taskId, studentId, studentName, reward, before, after, status, note,
      instanceId, cycleId, starts, ends, ruleVersion, timeZone, source || null, assignmentId, hasSnapshot ? 2 : 1,
      operationId || null, operationPayloadHash || null, binding !== null,
      binding?.evidence.evidenceProvider ?? null, binding?.evidence.evidenceBoardId ?? null,
      binding?.evidence.evidencePostId ?? null, binding?.evidence.evidenceCreatedAt ?? null,
      binding?.evidence.evidenceAuthorFullName ?? null, 'tupleDigest' in evidence ? evidence.tupleDigest as string : null);
  });
  budget?.spend(8);
  allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }, { code: 'BROKEN_TASK_REFERENCE', table: instanceId ? 'tasks' : 'task_business', id: instanceId ?? taskId }));
  budget?.spend();
  if (cell('assignmentId')) {
    budget?.spend(4);
    allocate(budget, { nodes: 4, slots: 4, structuralBytes: 55 }, () => entry.refs.push({ code: 'BROKEN_ASSIGNMENT_REFERENCE', table: 'task_assignments', id: cell('assignmentId') }));
  }
  budget?.spend(62);
  const staged = allocate(budget, { nodes: 62, slots: 60, structuralBytes: 1170 }, () => ({ tenantId, ...entry.canonical }));
  target('task_completions', id, staged, budget);
}

function normalizePromotion(entry: Entry, row: SheetSnapshotRow, index: Map<string, number>, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>, context?: BudgetContext) => void, malformed: () => void, budget?: BudgetContext) {
  budget?.spend();
  const parsed = budget ? parsePromotionRow(row.cells as string[], index, budget) : parsePromotionRow([...row.cells], index);
  budget?.check();
  const id = parsed && canonicalId(parsed.promotionId, budget);
  budget?.spend(2);
  if (!parsed || !id) { malformed(); return; }
  const promotion = budget ? promotionRecord(parsed, budget) : Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'productIds'));
  entry.canonical = promotion;
  // Closed maximum of fourteen scalar fields, including tenantId. Reserve
  // staged payload, shallow copy, Target and destination before the spread.
  // The mutable canonical projection is never given a shape certificate.
  budget?.spend(34);
  const staged = allocate(budget, { nodes: 34, slots: 32, structuralBytes: 1024 }, () => ({ tenantId, ...promotion }));
  target('promotions', id, staged, budget);
}

/** Closed parser-result projection: reserve the fixed variant upper bound before
 * reading operands. No enumeration, caller shape assertions, freeze or certificate
 * for this mutable canonical result. The legacy common/variant key order matters. */
function promotionRecord(parsed: NonNullable<ReturnType<typeof parsePromotionRow>>, budget: BudgetContext): Record<string, unknown> {
  // Common has eleven scalar occurrences; result has at most thirteen. Includes
  // both containers, every property key, and the maximum variant spread.
  budget.reserve({ nodes: 26, slots: 24, structuralBytes: 768 });
  // Existing projection visits plus three comparisons of two one-block
  // operands. The discriminant is the closed parser's validated union.
  budget.spend(37);
  const common = {
    promotionId: parsed.promotionId, name: parsed.name, description: parsed.description,
    startsAt: parsed.startsAt, endsAt: parsed.endsAt, isActive: parsed.isActive,
    sortOrder: parsed.sortOrder, createdAt: parsed.createdAt, updatedAt: parsed.updatedAt,
    schemaVersion: parsed.schemaVersion, type: parsed.type,
  };
  // This discriminant comes only from the real closed parser immediately above.
  if (parsed.type === 'N_PLUS_ONE') return { ...common, buyQuantity: parsed.buyQuantity, freeQuantity: parsed.freeQuantity };
  if (parsed.type === 'PROMOTIONAL_PRICE') return { ...common, promotionalUnitPrice: parsed.promotionalUnitPrice };
  if (parsed.type === 'PERCENT_DISCOUNT') return { ...common, percent: parsed.percent };
  return { ...common, discountAmount: parsed.discountAmount };
}

function correlateAdjustments(entries: Entry[], tenantId: string, budget?: BudgetContext) {
  try {
    budget?.spend(); budget?.reserve({ nodes: 1, structuralBytes: 16 });
    const transactionIndex = new Map<string, Entry[]>();
    budget?.check();
    for (const entry of entries) {
      budget?.spend();
      if (!equalBudgetValue(entry.tab, 'Transactions', budget) || !entry.canonical
        || !equalBudgetValue(entry.canonical.status, 'ADMIN_ADJUSTMENT', budget)) continue;
      const key = adjustmentTransactionKey(budget ? createBoundedCorrelationInput('transaction', () => entry.canonical!, budget) : entry.canonical, budget);
      if (!key) {
        if (!referenceContains(entry.errors, 'MALFORMED_REQUIRED_HISTORY', budget)) appendCorrelationError(entry, 'MALFORMED_REQUIRED_HISTORY', budget);
        continue;
      }
      const group = referenceGet(transactionIndex, key, budget) ?? referenceList<Entry>(budget);
      referenceAppend(group, entry, budget);
      referenceSet(transactionIndex, key, group, budget);
    }

    const adjustmentIndex = referenceMap<Entry[]>(budget);
    for (const entry of entries) {
      budget?.spend();
      if (!equalBudgetValue(entry.tab, 'Adjustments', budget) || !entry.canonical) continue;
      const key = adjustmentKey(budget ? createBoundedCorrelationInput('adjustment', () => entry.canonical!, budget) : entry.canonical, budget);
      if (!key) continue;
      const group = referenceGet(adjustmentIndex, key, budget) ?? referenceList<Entry>(budget);
      referenceAppend(group, entry, budget);
      referenceSet(adjustmentIndex, key, group, budget);
    }

    const keys = correlationKeys(adjustmentIndex, transactionIndex, budget);
    for (const key of keys) {
      budget?.spend();
      const adjustments = referenceGet(adjustmentIndex, key, budget) ?? referenceList<Entry>(budget);
      const transactions = referenceGet(transactionIndex, key, budget) ?? referenceList<Entry>(budget);
      budget?.spend(2);
      if (adjustments.length !== 1 || transactions.length !== 1) {
        for (const implicated of claimConcat(adjustments, transactions, budget)) {
          budget?.spend();
          if (!referenceContains(implicated.errors, 'AMBIGUOUS_ADJUSTMENT_TRANSACTION', budget)) {
            appendCorrelationError(implicated, 'AMBIGUOUS_ADJUSTMENT_TRANSACTION', budget);
          }
        }
        continue;
      }
      budget?.spend(2);
      const adjustment = adjustments[0];
      const transaction = transactions[0];
      budget?.spend(2);
      if (adjustment.errors.length > 0 || transaction.errors.length > 0) {
        budget?.spend(2);
        const pair = referenceNative(budget, () => allocate(budget, { nodes: 1, slots: 2, structuralBytes: 24 }, () => [adjustment, transaction]));
        for (const implicated of pair) {
          budget?.spend();
          if (!referenceContains(implicated.errors, 'AMBIGUOUS_ADJUSTMENT_TRANSACTION', budget)) {
            appendCorrelationError(implicated, 'AMBIGUOUS_ADJUSTMENT_TRANSACTION', budget);
          }
        }
        continue;
      }
      // Preserve the exact contextless destination/method/operand evaluation order.
      if (!budget) {
        const transactionId = String(transaction.canonical!.transactionId);
        const value = adjustment.canonical!;
        value.transactionId = transactionId;
        adjustment.refs.push({ code: 'BROKEN_TRANSACTION_REFERENCE', table: 'transactions', id: transactionId });
        adjustment.targets.push({
          table: 'adjustments', id: String(value.adjustmentId), record: {
            tenantId, adjustmentId: value.adjustmentId, transactionId,
            mode: value.mode, requestedAmount: value.amount, operatorSnapshot: value.operator,
            legacyAdjustmentId: value.adjustmentId,
          },
        });
        continue;
      }
      // New canonical transactionId property, BEFORE its source operand/coercion.
      budget.spend(3); budget.reserve({ nodes: 1, slots: 1, structuralBytes: 21 });
      const transactionId = referenceString(transaction.canonical!.transactionId, budget);
      const value = adjustment.canonical!; budget.check();
      referenceNative(budget, () => { value.transactionId = transactionId; });
      // Ref shell and append destination are separate from category emissions.
      budget.spend(5); budget.reserve({ nodes: 4, slots: 4, structuralBytes: 55 });
      const refs = adjustment.refs, appendRef = refs.push; budget.check();
      const ref = referenceNative(budget, () => ({ code: 'BROKEN_TRANSACTION_REFERENCE', table: 'transactions', id: transactionId }));
      referenceNative(budget, () => appendRef.call(refs, ref));
      // Target + seven-field record + destination; reserve before any literal,
      // getter or String operand. Mutable result/alias contracts are unchanged.
      budget.spend(12); budget.reserve({ nodes: 11, slots: 11, structuralBytes: 218 });
      const targets = adjustment.targets, appendTarget = targets.push; budget.check();
      const target = referenceNative(budget, () => ({
        table: 'adjustments', id: referenceString(value.adjustmentId, budget), record: {
          tenantId, adjustmentId: value.adjustmentId, transactionId,
          mode: value.mode, requestedAmount: value.amount, operatorSnapshot: value.operator,
          legacyAdjustmentId: value.adjustmentId,
        },
      }));
      referenceNative(budget, () => appendTarget.call(targets, target));
    }
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check(); throw error;
  }
}

function appendCorrelationError(entry: Entry, code: string, budget?: BudgetContext): void {
  if (!budget) { entry.errors.push(code); return; }
  budget.spend(); budget.reserve({ nodes: 1, slots: 1, structuralBytes: 8 });
  referenceNative(budget, () => {
    const errors = entry.errors, append = errors.push; budget.check();
    append.call(errors, code);
  });
}

function correlationKeys(first: Map<string, Entry[]>, second: Map<string, Entry[]>, budget?: BudgetContext): Set<string> {
  if (!budget) return new Set([...first.keys(), ...second.keys()]);
  const count = first.size + second.size;
  // Two key iterators, union array, Set, destination entries and native scratch.
  budget.spend(4 + 3 * count);
  budget.reserve({ nodes: 4 + 2 * count, slots: 3 * count, structuralBytes: 64 + 20 * count });
  const firstKeys = referenceNative(budget, () => first.keys());
  const values = referenceNative(budget, () => [...firstKeys]);
  const secondKeys = referenceNative(budget, () => second.keys());
  referenceNative(budget, () => { for (const key of secondKeys) { budget.spend(); values.push(key); budget.check(); } });
  // Set string hashing/comparisons are admitted before its native constructor.
  for (const key of values) budget.spend(1 + Math.ceil(key.length / 256));
  return referenceNative(budget, () => new Set(values));
}

function markDuplicates(entries: Entry[], budget?: BudgetContext) {
  const byTarget = referenceMap<Entry[]>(budget);
  for (const entry of entries) {
    budget?.spend();
    for (const target of entry.targets) {
      budget?.spend();
      if (equalBudgetValue(target.table, 'padlet_evidence_claims', budget)) continue;
      const key = budget ? claimJoined(target.table, '\0', target.id, budget) : `${target.table}\0${target.id}`;
      const group = referenceGet(byTarget, key, budget) ?? referenceList<Entry>(budget);
      referenceAppend(group, entry, budget); referenceSet(byTarget, key, group, budget);
    }
  }
  for (const group of claimValues(byTarget, budget)) {
    budget?.spend(2); // group visit and length comparison; keep every occurrence.
    if (group.length > 1) for (const entry of group) {
      budget?.spend();
      if (!budget) {
        // Preserve legacy destination/method getter evaluation before the ternary.
        entry.errors.push(FINANCIAL_TABS.has(entry.tab) ? 'DUPLICATE_LEDGER_ID'
          : entry.tab === 'Settings' ? 'DUPLICATE_SETTING_KEY' : 'DUPLICATE_PRIMARY_ID');
        continue;
      }
      const code = claimHas(FINANCIAL_TABS, entry.tab, budget) ? 'DUPLICATE_LEDGER_ID'
        : equalBudgetValue(entry.tab, 'Settings', budget) ? 'DUPLICATE_SETTING_KEY' : 'DUPLICATE_PRIMARY_ID';
      referenceAppend(entry.errors, code, budget, true);
    }
  }
  markBusinessDuplicate(referenceFilter(entries, (entry) => equalBudgetValue(entry.tab, 'Tasks', budget) && entry.canonical, budget), (entry) => referenceString(entry.canonical!.taskId, budget), undefined, budget);
  markBusinessDuplicate(
    referenceFilter(entries, (entry) => claimHas(FINANCIAL_TABS, entry.tab, budget) && entry.sourcePrimaryIdentity, budget),
    (entry) => budget ? claimJoined(entry.tab, '\0', referenceString(entry.sourcePrimaryIdentity, budget), budget) : `${entry.tab}\0${entry.sourcePrimaryIdentity}`,
    'DUPLICATE_LEDGER_ID', budget,
  );
  markBusinessDuplicate(referenceFilter(entries, (entry) => equalBudgetValue(entry.tab, 'PromotionProducts', budget) && entry.canonical, budget),
    (entry) => budget ? claimJoined(referenceString(entry.canonical!.promotionId, budget), '\0', referenceString(entry.canonical!.productId, budget), budget) : `${entry.canonical!.promotionId}\0${entry.canonical!.productId}`, undefined, budget);
  markBusinessDuplicate(referenceFilter(entries, (entry) => equalBudgetValue(entry.tab, 'TaskCompletions', budget) && entry.canonical?.operationId, budget),
    (entry) => referenceString(entry.canonical!.operationId, budget), 'DUPLICATE_LEDGER_ID', budget);
}

function validateRequiredSettings(entries: Entry[], schemaVersion: number, missing: (code: string, path: string) => void, budget?: BudgetContext) {
  if (!budget) { validateRequiredSettingsUnbounded(entries, schemaVersion, missing); return; }
  const settings = referenceFilter(entries, (entry) => equalBudgetValue(entry.tab, 'Settings', budget) && entry.canonical, budget);
  const validateOne = (key: string, code: string, valid: (value: unknown) => boolean) => {
    budget.spend();
    const matches = referenceFilter(settings, (entry) => equalBudgetValue(entry.canonical!.key, key, budget), budget);
    budget.spend();
    if (matches.length === 0) {
      const path = claimJoined('Settings.', '', key, budget);
      budget.spend(); referenceNative(budget, () => missing(code, path));
      return;
    }
    budget.spend();
    if (matches.length !== 1 || !referenceNative(budget, () => valid(matches[0].canonical!.value))) {
      budget.spend();
      referenceNative(budget, () => matches.forEach((entry) => { budget.spend(); appendCorrelationError(entry, code, budget); }));
    }
  };
  validateOne('schemaVersion', 'INVALID_SCHEMA_VERSION_SETTING', (value) => {
    // Admission already selected a numeric schema version. Preserve native String,
    // rather than replacing coercion by a table or certifying a mutable record.
    budget.spend(2); budget.reserveString(32);
    const expected = referenceNative(budget, () => String(schemaVersion));
    return equalBudgetValue(value, expected, budget);
  });
  validateOne('classTimeZone', 'INVALID_CLASS_TIME_ZONE_SETTING', (value) => {
    budget.spend(); return typeof value === 'string' && isSupportedTimeZone(value, budget);
  });
}

function validateRequiredSettingsUnbounded(entries: Entry[], schemaVersion: number, missing: (code: string, path: string) => void) {
  const settings = entries.filter((entry) => entry.tab === 'Settings' && entry.canonical);
  const validateOne = (key: string, code: string, valid: (value: unknown) => boolean) => {
    const matches = settings.filter((entry) => entry.canonical!.key === key);
    if (matches.length === 0) {
      missing(code, `Settings.${key}`);
      return;
    }
    if (matches.length !== 1 || !valid(matches[0].canonical!.value)) {
      matches.forEach((entry) => entry.errors.push(code));
    }
  };
  validateOne('schemaVersion', 'INVALID_SCHEMA_VERSION_SETTING', (value) => value === String(schemaVersion));
  validateOne('classTimeZone', 'INVALID_CLASS_TIME_ZONE_SETTING', (value) => typeof value === 'string' && isSupportedTimeZone(value));
}

function isSupportedTimeZone(value: string, budget?: BudgetContext): boolean {
  if (budget) {
    const trimmed = referenceNative(budget, () => trimBudgetString(value, budget));
    if (!equalBudgetValue(value, trimmed, budget)) return false;
    if (!equalBudgetValue(value, 'UTC', budget)) {
      // RegExp shell precedes its literal; scan work precedes native execution.
      budget.reserve({ nodes: 1, structuralBytes: 16 });
      budget.spend(1 + Math.ceil(value.length / 256));
      if (!referenceNative(budget, () => /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return false;
    }
    try {
      // Closed timeZone options/key plus opaque formatter handle. The engine's
      // ICU internals are native work, not an asserted/certified public graph.
      budget.spend(2 + Math.ceil(value.length / 256));
      budget.reserve({ nodes: 3, slots: 1, structuralBytes: 52, contentBytes: 8 });
      const formatter = referenceNative(budget, () => new Intl.DateTimeFormat('en-US', { timeZone: value }));
      // Closed default-date result: seven fields, their fixed keys/scalar
      // occurrences, and four temporary native result slots. Host-provided
      // locale/calendar/timezone strings remain opaque runtime metadata; no
      // enumeration, cache, clone, certificate or acceptance shortcut is used.
      budget.spend(); budget.reserve({ nodes: 15, slots: 11, structuralBytes: 116, contentBytes: 49 });
      const options = referenceNative(budget, () => formatter.resolvedOptions());
      budget.spend(2);
      return referenceNative(budget, () => options.timeZone.length > 0);
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
      budget.check(); return false;
    }
  }
  if (value !== value.trim() || (value !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function validateTransactionCancellations(entries: Entry[], budget?: BudgetContext) {
  // Keep the contextless expression, including native method/getter evaluation
  // and short circuit order. The guarded branch owns only mutable local Entries;
  // it never installs a graph certificate on canonical records or public aliases.
  if (!budget) { validateTransactionCancellationsUnbounded(entries); return; }
  const transactions = cancellationFilter(entries, (entry) => {
    budget.spend();
    return referenceNative(budget, () => equalBudgetValue(entry.tab, 'Transactions', budget) && entry.canonical);
  }, budget);
  const byId = referenceMap<Entry[]>(budget);
  for (let i = 0; i < transactions.length; i++) {
    budget.spend(); const entry = transactions[i];
    const id = cancellationString(() => entry.canonical!.transactionId, budget);
    const group = referenceGet(byId, id, budget) ?? referenceList<Entry>(budget);
    referenceAppend(group, entry, budget); referenceSet(byId, id, group, budget);
  }
  const reversals = cancellationFilter(transactions, (entry) => {
    budget.spend();
    return referenceNative(budget, () => equalBudgetValue(entry.canonical!.status, 'CANCEL_REVERSAL', budget));
  }, budget);
  const linked = referenceMap<Entry[]>(budget);
  for (let i = 0; i < reversals.length; i++) {
    budget.spend(); const reversal = reversals[i];
    const value = referenceNative(budget, () => reversal.canonical!);
    const originalId = cancellationString(() => value.reversesTransactionId ?? '', budget);
    const group = referenceGet(linked, originalId, budget) ?? referenceList<Entry>(budget);
    referenceAppend(group, reversal, budget); referenceSet(linked, originalId, group, budget);
    const candidates = referenceGet(byId, originalId, budget) ?? referenceList<Entry>(budget);
    budget.spend(); const original = candidates.length === 1 ? candidates[0] : null;
    const originalValue = referenceNative(budget, () => original?.canonical);
    // Closed scalar scratch: 2 parsed dates, 6 Number results, 2 negations,
    // 2 differences, final predicate. No pair tuple/map or payload clone exists.
    // Reserve the whole upper bound before even the first predicate operand.
    budget.reserve({ nodes: 13, structuralBytes: 52 }); budget.spend(13);
    const valid = referenceNative(budget, () => reversal.errors.length === 0 && original && original !== reversal
      && equalBudgetValue(originalValue?.status, 'CANCELLED', budget)
      && equalBudgetValue(originalValue.studentId, value.studentId, budget)
      && cancellationDate(() => value.timestamp, budget) > cancellationDate(() => originalValue.timestamp, budget)
      && cancellationNumber(() => originalValue.totalAmount, budget) === -cancellationNumber(() => value.totalAmount, budget)
      && cancellationNumber(() => originalValue.balanceAfter, budget) - cancellationNumber(() => originalValue.balanceBefore, budget)
        === -(cancellationNumber(() => value.balanceAfter, budget) - cancellationNumber(() => value.balanceBefore, budget)));
    if (!valid) {
      cancellationError(reversal, budget);
      for (let j = 0; j < candidates.length; j++) { budget.spend(); cancellationError(candidates[j], budget); }
    }
  }
  const cancelled = cancellationFilter(transactions, (entry) => {
    budget.spend();
    return referenceNative(budget, () => equalBudgetValue(entry.canonical!.status, 'CANCELLED', budget));
  }, budget);
  for (let i = 0; i < cancelled.length; i++) {
    budget.spend(); const original = cancelled[i];
    const id = cancellationString(() => original.canonical!.transactionId, budget);
    const candidates = referenceGet(linked, id, budget) ?? referenceList<Entry>(budget);
    budget.spend();
    if (referenceNative(budget, () => candidates.length !== 1 || candidates[0].errors.length)) {
      cancellationError(original, budget);
      // Preserve native forEach semantics and order, including empty invocation.
      budget.spend();
      referenceNative(budget, () => candidates.forEach((entry) => { budget.spend(); cancellationError(entry, budget); }));
    }
  }
}
function cancellationFilter(list: Entry[], predicate: (entry: Entry) => unknown, budget: BudgetContext): Entry[] {
  budget.spend(); budget.reserve({ nodes: 1, slots: list.length, structuralBytes: 16 + 4 * list.length });
  return referenceNative(budget, () => list.filter(predicate));
}
function cancellationString(operand: () => unknown, budget: BudgetContext): string {
  budget.spend();
  const value = referenceNative(budget, operand);
  return referenceString(value, budget);
}
function cancellationDate(operand: () => unknown, budget: BudgetContext): number {
  const value = cancellationString(operand, budget);
  budget.spend(1 + Math.ceil(value.length / 256));
  return referenceNative(budget, () => Date.parse(value));
}
function cancellationNumber(operand: () => unknown, budget: BudgetContext): number {
  budget.spend(); const value = referenceNative(budget, operand);
  // Only the closed transaction constructor's numeric primitive fields reach
  // this conversion. Their result/scratch was reserved before the pair operands.
  budget.spend(1 + (typeof value === 'string' ? Math.ceil(value.length / 256) : 0));
  return referenceNative(budget, () => Number(value));
}
function cancellationError(entry: Entry, budget: BudgetContext): void {
  budget.spend();
  const errors = referenceNative(budget, () => entry.errors);
  // These private normalizer error lists contain fixed diagnostic codes, each
  // shorter than 256 UTF-16 units. Precharge the native includes worst-case scan
  // without a second getter walk or replacing its SameValueZero semantics.
  budget.spend(1 + 3 * errors.length);
  if (!referenceNative(budget, () => errors.includes('MALFORMED_CANCELLATION_HISTORY'))) {
    appendCorrelationError(entry, 'MALFORMED_CANCELLATION_HISTORY', budget);
  }
}

function validateTransactionCancellationsUnbounded(entries: Entry[]) {
  const transactions = entries.filter((entry) => entry.tab === 'Transactions' && entry.canonical);
  const byId = new Map<string, Entry[]>();
  for (const entry of transactions) {
    const id = String(entry.canonical!.transactionId);
    const group = byId.get(id) ?? [];
    group.push(entry);
    byId.set(id, group);
  }
  const reversals = transactions.filter((entry) => entry.canonical!.status === 'CANCEL_REVERSAL');
  const linked = new Map<string, Entry[]>();
  for (const reversal of reversals) {
    const value = reversal.canonical!;
    const originalId = String(value.reversesTransactionId ?? '');
    const group = linked.get(originalId) ?? [];
    group.push(reversal);
    linked.set(originalId, group);
    const candidates = byId.get(originalId) ?? [];
    const original = candidates.length === 1 ? candidates[0] : null;
    const originalValue = original?.canonical;
    const valid = reversal.errors.length === 0 && original && original !== reversal
      && originalValue?.status === 'CANCELLED'
      && originalValue.studentId === value.studentId
      && Date.parse(String(value.timestamp)) > Date.parse(String(originalValue.timestamp))
      && Number(originalValue.totalAmount) === -Number(value.totalAmount)
      && Number(originalValue.balanceAfter) - Number(originalValue.balanceBefore)
        === -(Number(value.balanceAfter) - Number(value.balanceBefore));
    if (!valid) {
      if (!reversal.errors.includes('MALFORMED_CANCELLATION_HISTORY')) reversal.errors.push('MALFORMED_CANCELLATION_HISTORY');
      for (const candidate of candidates) if (!candidate.errors.includes('MALFORMED_CANCELLATION_HISTORY')) candidate.errors.push('MALFORMED_CANCELLATION_HISTORY');
    }
  }
  for (const original of transactions.filter((entry) => entry.canonical!.status === 'CANCELLED')) {
    const id = String(original.canonical!.transactionId);
    const candidates = linked.get(id) ?? [];
    if (candidates.length !== 1 || candidates[0].errors.length) {
      if (!original.errors.includes('MALFORMED_CANCELLATION_HISTORY')) original.errors.push('MALFORMED_CANCELLATION_HISTORY');
      candidates.forEach((entry) => {
        if (!entry.errors.includes('MALFORMED_CANCELLATION_HISTORY')) entry.errors.push('MALFORMED_CANCELLATION_HISTORY');
      });
    }
  }
}

/** Reference-local recipes operate only on this normalizer's mutable Entries.
 * No Entry/canonical object is certified, frozen, or accepted from a caller here.
 * Shared records/string payloads incur destination slots; native String copies,
 * filters, Map iteration tuples, sort scratch and cycle paths are separate costs.
 */
function referenceNative<T>(budget: BudgetContext | undefined, operation: () => T): T {
  try { const result = operation(); budget?.check(); return result; }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check(); throw error;
  }
}
function referenceMap<T>(budget?: BudgetContext): Map<string, T> {
  budget?.spend(); budget?.reserve({ nodes: 1, structuralBytes: 16 });
  return referenceNative(budget, () => new Map<string, T>());
}
function referenceGet<T>(map: Map<string, T>, key: string, budget?: BudgetContext): T | undefined {
  budget?.spend(1 + Math.ceil(key.length / 256));
  return referenceNative(budget, () => map.get(key));
}
function referenceHas<T>(map: Map<string, T>, key: string, budget?: BudgetContext): boolean {
  budget?.spend(1 + Math.ceil(key.length / 256));
  return referenceNative(budget, () => map.has(key));
}
function referenceSet<T>(map: Map<string, T>, key: string, value: T, budget?: BudgetContext): void {
  if (budget) {
    if (!referenceHas(map, key, budget)) budget.reserve({ slots: 2, structuralBytes: 8 });
    // New numeric occurrences (state and path position), not copied graph payloads.
    if (typeof value === 'number') budget.reserve({ nodes: 1, structuralBytes: 4 });
    budget.spend(1 + Math.ceil(key.length / 256));
  }
  referenceNative(budget, () => map.set(key, value));
}
function referenceList<T>(budget?: BudgetContext): T[] {
  budget?.spend(); budget?.reserve({ nodes: 1, structuralBytes: 16 });
  return referenceNative(budget, () => []);
}
function referenceAppend<T>(list: T[], value: T, budget?: BudgetContext, scalar = false): void {
  budget?.spend(); budget?.reserve({ nodes: scalar ? 1 : 0, slots: 1, structuralBytes: scalar ? 8 : 4 });
  referenceNative(budget, () => list.push(value));
}
function referenceFilter<T>(list: T[], predicate: (value: T) => unknown, budget?: BudgetContext): T[] {
  budget?.spend(); budget?.reserve({ nodes: 1, slots: list.length, structuralBytes: 16 + 4 * list.length });
  return referenceNative(budget, () => list.filter(value => { budget?.spend(); return predicate(value); }));
}
function referenceString(value: unknown, budget?: BudgetContext): string {
  // These closed constructor fields are primitive, not an asserted mutable shape.
  return referenceNative(budget, () => budget ? stringBoundedJson(value, budget) : String(value));
}
function referenceEntries<T>(map: Map<string, T>, budget?: BudgetContext): [string, T][] {
  // Reserve iterator, result list, each yielded entry tuple and its slots BEFORE
  // native iteration. Payloads are shared. All native visits are precharged.
  budget?.spend(1 + map.size);
  budget?.reserve({ nodes: 2 + map.size, slots: 3 * map.size, structuralBytes: 32 + 28 * map.size });
  return referenceNative(budget, () => [...map]);
}
function referenceContains(list: string[], code: string, budget?: BudgetContext): boolean {
  if (!budget) return list.includes(code);
  budget.spend();
  for (let index = 0; index < list.length; index++) {
    budget.spend();
    if (equalBudgetValue(list[index], code, budget)) return true;
  }
  return false;
}
function referencePrerequisite(record: Record<string, unknown>, value: unknown, budget?: BudgetContext): void {
  if (budget) {
    budget.spend();
    if (!referenceNative(budget, () => Object.hasOwn(record, 'prerequisiteTaskInstanceId'))) {
      budget.reserve({ slots: 1, structuralBytes: 30 });
    }
    budget.spend();
  }
  referenceNative(budget, () => { record.prerequisiteTaskInstanceId = value; });
}
function validateReferences(entries: Entry[], budget?: BudgetContext) {
  const ids = referenceMap<Map<string, Entry[]>>(budget);
  const add = (table: string, id: string, entry: Entry) => {
    budget?.spend();
    const values = referenceGet(ids, table, budget) ?? referenceMap<Entry[]>(budget);
    const group = referenceGet(values, id, budget) ?? referenceList<Entry>(budget);
    referenceAppend(group, entry, budget); referenceSet(values, id, group, budget); referenceSet(ids, table, values, budget);
  };
  const candidatesFor = (table: string, id: string) => {
    budget?.spend();
    const values = referenceGet(ids, table, budget);
    return (values && referenceGet(values, id, budget)) ?? referenceList<Entry>(budget);
  };
  const business = referenceFilter(entries, item => equalBudgetValue(item.tab, 'Tasks', budget) && item.canonical, budget);
  for (let i = 0; i < business.length; i++) { budget?.spend(); const entry = business[i]; add('task_business', referenceString(entry.canonical!.taskId, budget), entry); }
  for (let i = 0; i < entries.length; i++) {
    budget?.spend(); const entry = entries[i];
    for (let j = 0; j < entry.targets.length; j++) { budget?.spend(); const target = entry.targets[j]; add(target.table, target.id, entry); }
  }
  const addError = (entry: Entry, code: string) => {
    budget?.spend();
    if (referenceContains(entry.errors, code, budget)) return false;
    referenceAppend(entry.errors, code, budget, true); return true;
  };

  const assignmentEntries = referenceFilter(entries, item => equalBudgetValue(item.tab, 'TaskAssignments', budget) && item.canonical, budget);
  for (let i = 0; i < assignmentEntries.length; i++) {
    budget?.spend(); const entry = assignmentEntries[i];
    const tasks = candidatesFor('tasks', referenceString(entry.canonical!.taskInstanceId, budget));
    if (equalBudgetValue(tasks.length, 1, budget) && !equalBudgetValue(tasks[0].canonical!.taskId, entry.canonical!.taskId, budget)) addError(entry, 'TASK_INSTANCE_TUPLE_CONFLICT');
  }
  const completionEntries = referenceFilter(entries, item => equalBudgetValue(item.tab, 'TaskCompletions', budget) && item.canonical?.taskInstanceId, budget);
  for (let i = 0; i < completionEntries.length; i++) {
    budget?.spend(); const entry = completionEntries[i], completion = entry.canonical!;
    const tasks = candidatesFor('tasks', referenceString(completion.taskInstanceId, budget));
    if (equalBudgetValue(tasks.length, 1, budget) && !equalBudgetValue(tasks[0].canonical!.taskId, completion.taskId, budget)) addError(entry, 'TASK_INSTANCE_TUPLE_CONFLICT');
    budget?.spend(); if (!completion.assignmentId) continue;
    const assignments = candidatesFor('task_assignments', referenceString(completion.assignmentId, budget));
    if (!equalBudgetValue(assignments.length, 1, budget)) continue;
    const assignmentEntry = assignments[0], assignment = assignmentEntry.canonical!;
    // Reuse the existing tuple algorithm and private immutable siblings, never
    // register mutable Entry/canonical records or duplicate tuple semantics.
    if (!sameAssignmentCompletionTuple(
      budget ? boundedOperationalHistoryView(assignment, budget) : assignment,
      budget ? boundedOperationalHistoryView(completion, budget) : completion, budget)) {
      addError(entry, 'ASSIGNMENT_TUPLE_CONFLICT'); addError(assignmentEntry, 'ASSIGNMENT_TUPLE_CONFLICT');
    }
  }

  markDirectedReferenceCycles(entries, 'Tasks', 'taskId', 'prerequisiteTaskId', 'CYCLIC_TASK_PREREQUISITE', budget);
  markDirectedReferenceCycles(entries, 'TaskAssignments', 'assignmentId', 'previousAssignmentId', 'CYCLIC_ASSIGNMENT_PREDECESSOR', budget);

  let changed = true;
  while (changed) {
    budget?.spend(); changed = false;
    for (let i = 0; i < entries.length; i++) {
      budget?.spend(); const entry = entries[i];
      for (let j = 0; j < entry.refs.length; j++) {
        budget?.spend(); const ref = entry.refs[j];
        const candidates = candidatesFor(ref.table, ref.id);
        const stageable = referenceFilter(candidates, candidate => equalBudgetValue(candidate.errors.length, 0, budget), budget);
        if (equalBudgetValue(stageable.length, 1, budget)) continue;
        budget?.spend();
        changed = addError(entry, candidates.length > 1 ? 'AMBIGUOUS_REFERENCE' : ref.code) || changed;
      }
    }
  }

  const prerequisites = referenceFilter(entries, item => equalBudgetValue(item.tab, 'Tasks', budget) && item.canonical?.prerequisiteTaskId && equalBudgetValue(item.errors.length, 0, budget), budget);
  for (let i = 0; i < prerequisites.length; i++) {
    budget?.spend(); const entry = prerequisites[i];
    const candidates = referenceFilter(candidatesFor('task_business', referenceString(entry.canonical!.prerequisiteTaskId, budget)), candidate => equalBudgetValue(candidate.errors.length, 0, budget), budget);
    if (equalBudgetValue(candidates.length, 1, budget)) {
      const prerequisiteInstanceId = candidates[0].canonical!.taskInstanceId;
      // First resolution adds the closed property to both mutable shells;
      // the second validation replaces it. Shared payload, no graph certificate.
      referencePrerequisite(entry.canonical!, prerequisiteInstanceId, budget);
      budget?.spend();
      const target = referenceNative(budget, () => entry.targets.find(item => { budget?.spend(); return equalBudgetValue(item.table, 'tasks', budget); }));
      if (target) referencePrerequisite(target.record, prerequisiteInstanceId, budget);
    }
  }
}

function markDirectedReferenceCycles(entries: Entry[], tab: string, idField: string, edgeField: string, code: string, budget?: BudgetContext) {
  const selected = referenceFilter(entries, entry => equalBudgetValue(entry.tab, tab, budget) && entry.canonical && equalBudgetValue(entry.errors.length, 0, budget), budget);
  const compare = (left: Entry, right: Entry) => {
    const a = referenceString(left.canonical![idField], budget), b = referenceString(right.canonical![idField], budget);
    budget?.spend(1 + Math.ceil(a.length / 256) + Math.ceil(b.length / 256));
    return referenceNative(budget, () => compareCodeUnits(a, b));
  };
  const stageable = budget ? stableBudgetSort(selected, compare, budget) : selected.sort(compare);
  const groups = referenceMap<Entry[]>(budget);
  for (let i = 0; i < stageable.length; i++) {
    budget?.spend(); const entry = stageable[i], id = referenceString(entry.canonical![idField], budget);
    const group = referenceGet(groups, id, budget) ?? referenceList<Entry>(budget);
    referenceAppend(group, entry, budget); referenceSet(groups, id, group, budget);
  }
  const nodes = referenceMap<Entry>(budget), grouped = referenceEntries(groups, budget);
  for (let i = 0; i < grouped.length; i++) {
    budget?.spend(); const [id, group] = grouped[i];
    if (equalBudgetValue(group.length, 1, budget)) referenceSet(nodes, id, group[0], budget);
  }
  const edges = referenceMap<string>(budget), nodeEntries = referenceEntries(nodes, budget);
  for (let i = 0; i < nodeEntries.length; i++) {
    budget?.spend(); const [id, entry] = nodeEntries[i], destination = entry.canonical![edgeField];
    budget?.spend();
    if (typeof destination === 'string' && referenceHas(nodes, destination, budget)) referenceSet(edges, id, destination, budget);
  }

  const state = referenceMap<1 | 2>(budget);
  budget?.spend(1 + nodes.size); budget?.reserve({ nodes: 2, slots: nodes.size, structuralBytes: 32 + 4 * nodes.size });
  const keys = referenceNative(budget, () => [...nodes.keys()]);
  const compareKeys = (a: string, b: string) => { budget?.spend(1 + Math.ceil(a.length / 256) + Math.ceil(b.length / 256)); return referenceNative(budget, () => compareCodeUnits(a, b)); };
  const starts = budget ? stableBudgetSort(keys, compareKeys, budget) : keys.sort(compareKeys);
  for (let i = 0; i < starts.length; i++) {
    budget?.spend(); const start = starts[i];
    if (referenceHas(state, start, budget)) continue;
    const path = referenceList<string>(budget), positions = referenceMap<number>(budget);
    let current: string | undefined = start;
    while (!equalBudgetValue(current, undefined, budget) && !referenceHas(state, current, budget)) {
      budget?.spend();
      referenceSet(state, current, 1, budget); referenceSet(positions, current, path.length, budget);
      referenceAppend(path, current, budget); current = referenceGet(edges, current, budget);
    }
    if (!equalBudgetValue(current, undefined, budget) && equalBudgetValue(referenceGet(state, current, budget), 1, budget) && referenceHas(positions, current, budget)) {
      const position = referenceGet(positions, current, budget)!;
      budget?.spend(1 + path.length - position);
      budget?.reserve({ nodes: 1, slots: path.length - position, structuralBytes: 16 + 4 * (path.length - position) });
      const cycle = referenceNative(budget, () => path.slice(position));
      for (let j = 0; j < cycle.length; j++) {
        budget?.spend(); const entry = referenceGet(nodes, cycle[j], budget)!;
        // Original cycle marking deliberately appends directly (not addError).
        referenceAppend(entry.errors, code, budget, true);
      }
    }
    for (let j = 0; j < path.length; j++) { budget?.spend(); referenceSet(state, path[j], 2, budget); }
  }
}

function markBusinessDuplicate(entries: Entry[], keyOf: (entry: Entry) => string, code = 'DUPLICATE_BUSINESS_ID', budget?: BudgetContext) {
  const groups = referenceMap<Entry[]>(budget);
  for (const entry of entries) {
    budget?.spend(2); // entry visit and key callback
    const key = referenceNative(budget, () => keyOf(entry));
    const group = referenceGet(groups, key, budget) ?? referenceList<Entry>(budget);
    referenceAppend(group, entry, budget); referenceSet(groups, key, group, budget);
  }
  for (const group of claimValues(groups, budget)) {
    budget?.spend(2);
    if (group.length > 1) claimEach(group, (entry) => referenceAppend(entry.errors, code, budget, true), budget);
  }
}

// Application-owned mutable collections only: these helpers grant no immutable
// graph certificate. Retain the original lists, Sets and ordered peer scans.
function claimMap<T, U>(list: T[], project: (value: T) => U, budget?: BudgetContext): U[] {
  budget?.spend(); budget?.reserve({ nodes: 1, slots: list.length, structuralBytes: 16 + 4 * list.length });
  return referenceNative(budget, () => list.map(value => { budget?.spend(); const result = project(value); budget?.check(); return result; }));
}
function claimSet<T>(values: T[] | undefined, budget?: BudgetContext): Set<T> {
  const length = values?.length ?? 0;
  budget?.spend(); budget?.reserve({ nodes: 1, slots: length, structuralBytes: 16 + 4 * length });
  if (budget && values) for (let i = 0; i < values.length; i++) {
    budget.spend(); const value = values[i];
    budget.spend(1 + (typeof value === 'string' ? Math.ceil(value.length / 256) : 0));
  }
  return referenceNative(budget, () => new Set(values));
}
function claimHas(set: Set<unknown>, value: unknown, budget?: BudgetContext): boolean {
  budget?.spend(1 + (typeof value === 'string' ? Math.ceil(value.length / 256) : 0));
  return referenceNative(budget, () => set.has(value));
}
function claimAdd(set: Set<string>, value: string, budget?: BudgetContext): void {
  if (budget && !claimHas(set, value, budget)) budget.reserve({ slots: 1, structuralBytes: 4 });
  budget?.spend(1 + Math.ceil(value.length / 256));
  referenceNative(budget, () => set.add(value));
}
function claimField(entry: Entry, key: string, budget?: BudgetContext): unknown {
  budget?.spend();
  return referenceNative(budget, () => entry.canonical?.[key]);
}
function claimSourceDigest(entry: Entry, budget?: BudgetContext): string {
  // Closed SourcePointer kind: one visit, equality and its two string blocks.
  budget?.spend(4);
  return referenceNative(budget, () => sourceDigest(entry.source));
}
function bankContains(bank: Entry[], entry: Entry, budget?: BudgetContext): boolean {
  if (!budget) return bank.includes(entry);
  budget.spend();
  for (let i = 0; i < bank.length; i++) {
    budget.spend();
    if (equalBudgetValue(bank[i], entry, budget)) return true;
  }
  budget.check(); return false;
}
const BANK_CONTRIBUTOR_TABS = ['SheetPadletClaim', 'RedisPadletClaim', 'RedisOperationBinding'];

// Legacy Sheets/Redis evidence proves a historical binding, not the modern
// TASK_REWARD command preimage and transaction authority. Keep it intact for
// reconciliation, but never publish it as an operational completion/operation.
function quarantineUnsupportedBankAuthority(entries: Entry[], budget?: BudgetContext) {
  const bank = referenceFilter(entries, entry => equalBudgetValue(entry.tab, 'TaskCompletions', budget)
    && equalBudgetValue(claimField(entry, 'source', budget), 'BANK', budget), budget);
  const operations = claimSet(referenceFilter(claimMap(bank, entry => claimField(entry, 'operationId', budget), budget), value => { budget?.spend(); return Boolean(value); }, budget), budget);
  const tuples = claimSet(referenceFilter(claimMap(bank, entry => claimField(entry, 'tupleDigest', budget), budget), value => { budget?.spend(); return Boolean(value); }, budget), budget);
  for (let i = 0; i < entries.length; i++) {
    budget?.spend(); const entry = entries[i];
    const contributor = referenceContains(BANK_CONTRIBUTOR_TABS, entry.tab, budget)
      && (claimHas(operations, claimField(entry, 'operationId', budget), budget) || claimHas(tuples, claimField(entry, 'tupleDigest', budget), budget));
    if (bankContains(bank, entry, budget) || contributor) referenceAppend(entry.errors, 'UNSUPPORTED_LEGACY_BANK_AUTHORITY', budget, true);
  }
}

function propagateClaimErrors(entries: Entry[], budget?: BudgetContext) {
  const failedSheetDigests = claimSet(claimMap(referenceFilter(entries, entry => equalBudgetValue(entry.tab, 'TaskCompletions', budget) && entry.errors.length, budget), entry => claimSourceDigest(entry, budget), budget), budget);
  const failedOperations = claimSet<string>(undefined, budget);
  const failedTuples = claimSet<string>(undefined, budget);
  const failedSheets = referenceFilter(entries, item => equalBudgetValue(item.tab, 'TaskCompletions', budget) && item.errors.length && item.canonical, budget);
  for (let i = 0; i < failedSheets.length; i++) {
    budget?.spend(); const entry = failedSheets[i];
    if (claimField(entry, 'operationId', budget)) claimAdd(failedOperations, referenceString(claimField(entry, 'operationId', budget), budget), budget);
    if (claimField(entry, 'tupleDigest', budget)) claimAdd(failedTuples, referenceString(claimField(entry, 'tupleDigest', budget), budget), budget);
  }
  const failedClaims = referenceFilter(entries, item => equalBudgetValue(item.tab, 'SheetPadletClaim', budget) && claimHas(failedSheetDigests, claimSourceDigest(item, budget), budget), budget);
  for (let i = 0; i < failedClaims.length; i++) {
    budget?.spend(); const entry = failedClaims[i];
    referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true);
    if (claimField(entry, 'operationId', budget)) claimAdd(failedOperations, referenceString(claimField(entry, 'operationId', budget), budget), budget);
    if (claimField(entry, 'tupleDigest', budget)) claimAdd(failedTuples, referenceString(claimField(entry, 'tupleDigest', budget), budget), budget);
  }
  const redisPairEntries = referenceFilter(entries, entry => equalBudgetValue(entry.tab, 'RedisPadletClaim', budget) || equalBudgetValue(entry.tab, 'RedisOperationBinding', budget), budget);
  for (let i = 0; i < redisPairEntries.length; i++) {
    budget?.spend(); const entry = redisPairEntries[i];
    const referenceErrors = referenceFilter(entry.errors, code => {
      if (equalBudgetValue(code, 'AMBIGUOUS_REFERENCE', budget)) return true;
      budget?.spend();
      return referenceNative(budget, () => entry.refs.some(ref => { budget?.spend(); return equalBudgetValue(ref.code, code, budget); }));
    }, budget);
    if (!referenceErrors.length) continue;
    for (let j = 0; j < redisPairEntries.length; j++) {
      budget?.spend(); const peer = redisPairEntries[j];
      budget?.spend();
      if (peer === entry || (!equalBudgetValue(claimField(peer, 'operationId', budget), claimField(entry, 'operationId', budget), budget)
        && !equalBudgetValue(claimField(peer, 'tupleDigest', budget), claimField(entry, 'tupleDigest', budget), budget))) continue;
      for (let k = 0; k < referenceErrors.length; k++) {
        budget?.spend(); const code = referenceErrors[k];
        if (!referenceContains(peer.errors, code, budget)) referenceAppend(peer.errors, code, budget, true);
      }
    }
  }
  const failedPeers = referenceFilter(redisPairEntries, item => item.errors.length, budget);
  for (let i = 0; i < failedPeers.length; i++) {
    budget?.spend(); const entry = failedPeers[i];
    if (claimField(entry, 'operationId', budget)) claimAdd(failedOperations, referenceString(claimField(entry, 'operationId', budget), budget), budget);
    if (claimField(entry, 'tupleDigest', budget)) claimAdd(failedTuples, referenceString(claimField(entry, 'tupleDigest', budget), budget), budget);
  }
  budget?.spend(2);
  if (!failedOperations.size && !failedTuples.size) return;
  for (let i = 0; i < entries.length; i++) {
    budget?.spend(); const entry = entries[i];
    if ((equalBudgetValue(entry.tab, 'SheetPadletClaim', budget) || equalBudgetValue(entry.tab, 'RedisPadletClaim', budget))
      && (claimHas(failedOperations, referenceString(claimField(entry, 'operationId', budget) ?? '', budget), budget) || claimHas(failedTuples, referenceString(claimField(entry, 'tupleDigest', budget) ?? '', budget), budget))) referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true);
    if (equalBudgetValue(entry.tab, 'RedisOperationBinding', budget)
      && (claimHas(failedOperations, referenceString(claimField(entry, 'operationId', budget) ?? '', budget), budget) || claimHas(failedTuples, referenceString(claimField(entry, 'tupleDigest', budget) ?? '', budget), budget))) referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true);
  }
}

// Claim-local collection recipes preserve repeated contributor occurrences. They
// reserve only internal containers/reference slots, never certify mutable records.
function claimEach<T>(items: T[], visit: (item: T) => void, budget?: BudgetContext): void {
  budget?.spend();
  referenceNative(budget, () => items.forEach(item => { budget?.spend(); visit(item); budget?.check(); }));
}
function claimEvery<T>(items: T[], predicate: (item: T) => boolean, budget?: BudgetContext): boolean {
  budget?.spend();
  return referenceNative(budget, () => items.every(item => { budget?.spend(); const result = predicate(item); budget?.check(); return result; }));
}
function claimValues<T>(map: Map<string, T>, budget?: BudgetContext): Iterable<T> {
  if (!budget) return map.values();
  budget.spend(1 + map.size);
  budget.reserve({ nodes: 2, slots: map.size, structuralBytes: 32 + 4 * map.size });
  return referenceNative(budget, () => [...map.values()]);
}
function claimConcat<T>(left: T[], right: T[], budget?: BudgetContext): T[] {
  const length = left.length + right.length;
  budget?.spend(1 + length); budget?.reserve({ nodes: 3, slots: length, structuralBytes: 48 + 4 * length });
  return referenceNative(budget, () => [...left, ...right]);
}
function claimCollection(collections: Set<string>, name: string, budget?: BudgetContext): void {
  if (budget) {
    if (!claimHas(collections, name, budget)) budget.reserve({ slots: 1, structuralBytes: 4 });
    budget.spend(1 + Math.ceil(name.length / 256));
  }
  referenceNative(budget, () => collections.add(name));
}
function claimJoined(left: string, separator: string, right: string, budget?: BudgetContext): string {
  if (budget) {
    budget.reserveString(utf8ByteLength(left, budget) + utf8ByteLength(separator, budget) + utf8ByteLength(right, budget));
    budget.spend(1 + Math.ceil((left.length + separator.length + right.length) / 256));
  }
  return referenceNative(budget, () => `${left}${separator}${right}`);
}
function claimRegex(pattern: RegExp, value: string, budget?: BudgetContext): boolean {
  budget?.spend(1 + Math.ceil(value.length / 256));
  return referenceNative(budget, () => pattern.test(value));
}
const CLAIM_BOARD = /^[A-Za-z0-9]{16,22}$/;
const CLAIM_POST = /^[A-Za-z0-9_-]{3,128}$/;

function normalizeClaims(input: { tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot }, sheetEntries: Entry[], budget?: BudgetContext) {
  budget?.spend(3); budget?.reserve({ nodes: 3, structuralBytes: 48 });
  const entries: Entry[] = []; const conflicts: Diagnostic[] = []; const collections = new Set<string>();
  type ClaimGroup = { record: Record<string, unknown>; bindingKey: string; members: Entry[]; sheetEntries: Entry[] };
  const claims = referenceMap<ClaimGroup>(budget);
  const addClaim = (digest: string, record: Record<string, unknown>, member: Entry, sheet?: Entry) => {
    budget?.spend();
    const prior = referenceGet(claims, digest, budget);
    if (!prior) {
      const bindingKey = claimBindingKey(record, budget);
      budget?.spend(3);
      const group = allocate(budget, { nodes: 3, slots: 5 + (sheet ? 1 : 0), structuralBytes: 103 + (sheet ? 4 : 0) }, () => ({ record, bindingKey, members: [member], sheetEntries: sheet ? [sheet] : [] }));
      referenceSet(claims, digest, group, budget); return;
    }
    referenceAppend(prior.members, member, budget); if (sheet) referenceAppend(prior.sheetEntries, sheet, budget);
    if (!equalBudgetValue(prior.bindingKey, claimBindingKey(record, budget), budget)) {
      claimEach(claimConcat(prior.members, prior.sheetEntries, budget), (entry) => referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget);
    }
  };
  for (const completion of referenceFilter(sheetEntries, (entry) => equalBudgetValue(entry.tab, 'TaskCompletions', budget) && entry.canonical?.tupleDigest && !entry.errors.length, budget)) {
    budget?.spend();
    const record = completion.canonical!; const digest = referenceString(record.tupleDigest, budget); const operationId = referenceString(record.operationId, budget);
    reserveClaimRecord('SheetPadletClaim', budget);
    const claimRecord = { tenantId: input.tenantId, provider: 'PADLET', tupleDigest: digest, boardId: record.evidenceBoardId, postId: record.evidencePostId,
      ownerDigest: sha256(operationId, budget), operationId, operationPayloadHash: record.operationPayloadHash, taskId: record.taskId, studentId: record.studentId,
      cycleStartsAt: record.cycleStartsAt, evidenceCreatedAt: record.evidenceCreatedAt, evidenceAuthorFullName: record.evidenceAuthorFullName, provenances: [completion.source] };
    budget?.reserve({ nodes: 1, slots: 4, structuralBytes: 32 });
    const targetId = budget ? deterministicIdWithBudget(budget, input.tenantId, input.migrationJobId, 'padlet_evidence_claims', digest) : deterministicId(input.tenantId, input.migrationJobId, 'padlet_evidence_claims', digest);
    addClaim(digest, claimRecord, derivedEntry(completion.source, 'SheetPadletClaim', digest, 'padlet_evidence_claims', targetId, claimRecord, budget), completion);
  }
  if (input.redis) {
    claimCollection(collections, 'padlet_evidence_claims', budget);
    const bindingGroups = referenceMap<Array<{ binding: RedisClaimSnapshot['operationBindings'][number]; entry: Entry }>>(budget);
    for (const binding of input.redis.operationBindings) {
      budget?.spend();
      const source = redisPointer(input.redis, binding.sourceProvenance, () => canonicalJson(binding, budget), budget);
      reserveClaimRecord('RedisOperationBinding', budget);
      budget?.reserve({ nodes: 1, slots: 4, structuralBytes: 32 });
      const id = budget ? deterministicIdWithBudget(budget, input.tenantId, input.migrationJobId, 'legacy_operation_bindings', binding.operationId) : deterministicId(input.tenantId, input.migrationJobId, 'legacy_operation_bindings', binding.operationId);
      const entry = derivedEntry(source, 'RedisOperationBinding', binding.operationId, 'legacy_operation_bindings', id, { tenantId: input.tenantId, operationId: binding.operationId, tupleDigest: binding.tupleDigest, ownerDigest: binding.ownerDigest, payloadHash: binding.payloadHash, binding: binding.binding, claimField: binding.claimField, sourceProvenance: binding.sourceProvenance }, budget);
      budget?.spend(8);
      allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: binding.binding.taskId },
        { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: binding.binding.studentId }));
      const group = referenceGet(bindingGroups, binding.operationId, budget) ?? referenceList<{ binding: RedisClaimSnapshot['operationBindings'][number]; entry: Entry }>(budget);
      budget?.spend(2);
      allocate(budget, { nodes: 1, slots: 3, structuralBytes: 40 }, () => group.push({ binding, entry }));
      referenceSet(bindingGroups, binding.operationId, group, budget);
      referenceAppend(entries, entry, budget); claimCollection(collections, 'legacy_operation_bindings', budget);
    }
    const redisClaimsByOperation = referenceMap<RedisClaimSnapshot['v2Claims'][number][]>(budget);
    for (const claim of input.redis.v2Claims) {
      budget?.spend();
      const group = referenceGet(redisClaimsByOperation, claim.operationId, budget) ?? referenceList<RedisClaimSnapshot['v2Claims'][number]>(budget);
      referenceAppend(group, claim, budget); referenceSet(redisClaimsByOperation, claim.operationId, group, budget);
    }
    for (const claim of input.redis.v2Claims) {
      budget?.spend();
      const source = redisPointer(input.redis, claim.sourceProvenance, () => canonicalJson(claim, budget), budget);
      reserveClaimRecord('RedisPadletClaim', budget);
      budget?.reserve({ nodes: 1, slots: 4, structuralBytes: 32 });
      const targetId = budget ? deterministicIdWithBudget(budget, input.tenantId, input.migrationJobId, 'padlet_evidence_claims', claim.tupleDigest) : deterministicId(input.tenantId, input.migrationJobId, 'padlet_evidence_claims', claim.tupleDigest);
      const candidates = referenceGet(bindingGroups, claim.operationId, budget) ?? referenceList<{ binding: RedisClaimSnapshot['operationBindings'][number]; entry: Entry }>(budget);
      const binding = equalBudgetValue(candidates.length, 1, budget) ? candidates[0].binding : null;
      const claimRecord: Record<string, unknown> = { tenantId: input.tenantId, provider: 'PADLET', tupleDigest: claim.tupleDigest, boardId: claim.boardId, postId: claim.postId,
        ownerDigest: claim.ownerDigest, operationId: claim.operationId, operationPayloadHash: binding?.payloadHash ?? null,
        ...(binding ? { taskId: binding.binding.taskId, studentId: binding.binding.studentId, cycleStartsAt: binding.binding.cycleStartsAt, evidenceCreatedAt: binding.binding.evidence.evidenceCreatedAt, evidenceAuthorFullName: binding.binding.evidence.evidenceAuthorFullName } : {}), provenances: [source] };
      const claimEntry = derivedEntry(source, 'RedisPadletClaim', claim.tupleDigest, 'padlet_evidence_claims', targetId, claimRecord, budget);
      if (binding) {
        budget?.spend(8);
        allocate(budget, { nodes: 8, slots: 8, structuralBytes: 110 }, () => claimEntry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: binding.binding.taskId },
          { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: binding.binding.studentId }));
      }
      if (binding) { budget?.reserveString(71); budget?.spend(2); }
      const expectedPayload = binding ? referenceNative(budget, () => `sha256:${sha256(canonicalJson(binding.binding, budget), budget)}`) : '';
      const affectedSheets = referenceFilter(sheetEntries, (entry) => equalBudgetValue(entry.tab, 'TaskCompletions', budget) && entry.canonical
        && (equalBudgetValue(entry.canonical.operationId, claim.operationId, budget) || equalBudgetValue(entry.canonical.tupleDigest, claim.tupleDigest, budget)
          || equalBudgetValue(entry.canonical.tupleDigest, binding?.tupleDigest, budget)), budget);
      const duplicateClaim = !equalBudgetValue(referenceGet(redisClaimsByOperation, claim.operationId, budget)?.length ?? 0, 1, budget);
      const valid = referenceNative(budget, () => Boolean(!duplicateClaim && binding && isHexDigest(claim.tupleDigest, budget) && claimRegex(CLAIM_BOARD, claim.boardId, budget)
        && claimRegex(CLAIM_POST, claim.postId, budget) && equalBudgetValue(referenceNative(budget, () => sha256(claimJoined(claim.boardId, '\0', claim.postId, budget), budget)), claim.tupleDigest, budget)
        && equalBudgetValue(claim.ownerDigest, referenceNative(budget, () => sha256(claim.operationId, budget)), budget) && equalBudgetValue(binding!.operationId, claim.operationId, budget)
        && equalBudgetValue(binding!.tupleDigest, claim.tupleDigest, budget) && equalBudgetValue(binding!.ownerDigest, claim.ownerDigest, budget)
        && equalBudgetValue(binding!.claimField, claimJoined('claim:', '', claim.tupleDigest, budget), budget) && equalBudgetValue(binding!.payloadHash, expectedPayload, budget)
        && equalBudgetValue(binding!.binding.evidence.evidenceBoardId, claim.boardId, budget) && equalBudgetValue(binding!.binding.evidence.evidencePostId, claim.postId, budget)
        && claimEvery(affectedSheets, (entry) => !entry.errors.length, budget)));
      if (!valid) {
        referenceAppend(claimEntry.errors, 'CLAIM_BINDING_CONFLICT', budget, true); claimEach(candidates, (candidate) => referenceAppend(candidate.entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget);
        claimEach(affectedSheets, (entry) => referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget);
        const sheetClaim = referenceGet(claims, claim.tupleDigest, budget); if (sheetClaim) { claimEach(sheetClaim.members, (entry) => referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget); claimEach(sheetClaim.sheetEntries, (entry) => referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget); }
      }
      addClaim(claim.tupleDigest, claimRecord, claimEntry);
    }
    for (const [operationId, candidates] of budget ? referenceEntries(bindingGroups, budget) : bindingGroups) {
      budget?.spend();
      if (equalBudgetValue(referenceGet(redisClaimsByOperation, operationId, budget)?.length ?? 0, 1, budget) && equalBudgetValue(candidates.length, 1, budget)) continue;
      claimEach(candidates, (candidate) => referenceAppend(candidate.entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget);
      const affectedSheets = referenceFilter(sheetEntries, (entry) => equalBudgetValue(entry.tab, 'TaskCompletions', budget) && equalBudgetValue(entry.canonical?.operationId, operationId, budget), budget);
      claimEach(affectedSheets, (entry) => referenceAppend(entry.errors, 'CLAIM_BINDING_CONFLICT', budget, true), budget);
    }
    for (const tombstone of input.redis.v1Tombstones) {
      budget?.spend();
      const source = redisPointer(input.redis, tombstone.sourceProvenance, () => canonicalJson(tombstone, budget), budget);
      reserveClaimRecord('RedisV1Tombstone', budget);
      budget?.reserve({ nodes: 1, slots: 3, structuralBytes: 28 });
      const id = budget ? deterministicIdWithBudget(budget, 'global', 'padlet_claim_digest_tombstones', tombstone.tupleDigest) : deterministicId('global', 'padlet_claim_digest_tombstones', tombstone.tupleDigest);
      const entry = derivedEntry(source, 'RedisV1Tombstone', tombstone.tupleDigest, 'padlet_claim_digest_tombstones', id, { tupleDigest: tombstone.tupleDigest, ownerDigest: tombstone.ownerDigest, kind: 'V1_GLOBAL', provenance: tombstone.sourceProvenance }, budget);
      const collision = referenceGet(claims, tombstone.tupleDigest, budget);
      if (collision) {
        referenceAppend(entry.errors, 'V1_TOMBSTONE_COLLISION', budget, true); claimEach(claimConcat(collision.members, collision.sheetEntries, budget), (item) => referenceAppend(item.errors, 'V1_TOMBSTONE_COLLISION', budget, true), budget);
        for (const group of claimValues(bindingGroups, budget)) { budget?.spend(); for (const candidate of group) { budget?.spend(); if (equalBudgetValue(candidate.binding.tupleDigest, tombstone.tupleDigest, budget)) referenceAppend(candidate.entry.errors, 'V1_TOMBSTONE_COLLISION', budget, true); } }
      }
      referenceAppend(entries, entry, budget); claimCollection(collections, 'padlet_claim_digest_tombstones', budget);
    }
    for (const digest of input.redis.orphanedClaimDigests) {
      budget?.spend();
      const source = redisPointer(input.redis, 'upstash:padlet:evidence-bindings:v2:orphan', () => digest, budget);
      reserveClaimRecord('RedisOrphanClaim', budget);
      budget?.reserve({ nodes: 1, slots: 3, structuralBytes: 28 });
      const id = budget ? deterministicIdWithBudget(budget, 'global', 'padlet_claim_digest_tombstones', digest) : deterministicId('global', 'padlet_claim_digest_tombstones', digest);
      const entry = derivedEntry(source, 'RedisOrphanClaim', digest, 'padlet_claim_digest_tombstones', id, { tupleDigest: digest, kind: 'ORPHAN_V2', provenance: 'upstash:padlet:evidence-bindings:v2' }, budget);
      const collision = referenceGet(claims, digest, budget);
      if (collision) {
        referenceAppend(entry.errors, 'ORPHAN_CLAIM_COLLISION', budget, true);
        claimEach(claimConcat(collision.members, collision.sheetEntries, budget), (item) => referenceAppend(item.errors, 'ORPHAN_CLAIM_COLLISION', budget, true), budget);
        for (const group of claimValues(bindingGroups, budget)) { budget?.spend(); for (const candidate of group) {
          budget?.spend(); if (equalBudgetValue(candidate.binding.tupleDigest, digest, budget)) referenceAppend(candidate.entry.errors, 'ORPHAN_CLAIM_COLLISION', budget, true);
        } }
      }
      referenceAppend(entries, entry, budget);
      claimCollection(collections, 'padlet_claim_digest_tombstones', budget);
    }
  }
  for (const claim of claimValues(claims, budget)) {
    budget?.spend();
    const sources = referenceNative(budget, () => mapBudgetList(claim.members, (entry) => entry.source, budget));
    const provenances = budget ? referenceNative(budget, () => stableBudgetSort(sources, (a, b) => {
      budget.spend(3); const left = sourceDigest(a), right = sourceDigest(b);
      budget.spend(Math.ceil(left.length / 256) + Math.ceil(right.length / 256));
      return referenceNative(budget, () => compareCodeUnits(left, right));
    }, budget)) : sources.sort((a, b) => compareCodeUnits(sourceDigest(a), sourceDigest(b)));
    const agrees = claimEvery(claim.members, (member) => equalBudgetValue(claimBindingKey(member.canonical!, budget), claim.bindingKey, budget), budget);
    if (agrees) claim.record.provenances = provenances;
    for (const member of claim.members) {
      budget?.spend();
      // A shared target is valid only for exact agreement. Quarantine must retain
      // the conflicting contributor's own owner, binding fields and provenance.
      if (agrees) { member.canonical = claim.record; member.targets[0].record = claim.record; }
      referenceAppend(entries, member, budget);
    }
    claimCollection(collections, 'padlet_evidence_claims', budget);
  }
  budget?.spend();
  return allocate(budget, { nodes: 1, slots: 3, structuralBytes: 55 }, () => ({ entries, conflicts, collections }));
}

// Closed internal variants only. The clone remains mutable and uncertified.
// Includes Entry/redacted/Target/clone/four list containers, primitive occurrences,
// property keys and target-list destination. This does not reserve caller literals.
const DERIVED_ENTRY_SHELL = {
  SheetPadletClaim: { nodes: 30, slots: 31, structuralBytes: 644 },
  RedisPadletClaim: { nodes: 30, slots: 31, structuralBytes: 644 },
  RedisOperationBinding: { nodes: 24, slots: 25, structuralBytes: 521 },
  RedisV1Tombstone: { nodes: 20, slots: 21, structuralBytes: 440 },
  RedisOrphanClaim: { nodes: 19, slots: 20, structuralBytes: 421 },
} as const;
function derivedEntry(source: SourcePointer, tab: keyof typeof DERIVED_ENTRY_SHELL, identity: string, table: string, id: string, record: Record<string, unknown>, budget?: BudgetContext): Entry {
  budget?.spend(DERIVED_ENTRY_SHELL[tab].nodes);
  return allocate(budget, DERIVED_ENTRY_SHELL[tab], () => ({ source, tab, identity, sourcePrimaryIdentity: null, redacted: { identityDigest: sha256(identity, budget), recognizedFieldCount: 1, omittedFieldCount: 0 }, canonical: record, targets: [{ table, id, record: { ...record } }], refs: [], warnings: [], errors: [] }));
}
// Caller-side fixed schemas, reserved before ID rest operands and record literals.
// Claim bounds include provenance list and Redis's conditional spread temporary.
// They are numeric allocation recipes only, never mutable graph certificates.
const CLAIM_RECORD = {
  SheetPadletClaim: { nodes: 16, slots: 15, structuralBytes: 308 },
  RedisPadletClaim: { nodes: 22, slots: 20, structuralBytes: 431 },
  RedisOperationBinding: { nodes: 9, slots: 8, structuralBytes: 165 },
  RedisV1Tombstone: { nodes: 5, slots: 4, structuralBytes: 84 },
  RedisOrphanClaim: { nodes: 4, slots: 3, structuralBytes: 65 },
} as const;
function reserveClaimRecord(tab: keyof typeof CLAIM_RECORD, budget?: BudgetContext): void {
  budget?.spend(CLAIM_RECORD[tab].nodes);
  budget?.reserve(CLAIM_RECORD[tab]);
}
function redisPointer(redis: RedisClaimSnapshot, provenance: string, value: () => string, budget?: BudgetContext): SourcePointer {
  // Preserve original argument evaluation before redis.digest on no-budget calls.
  if (!budget) { const encoded = value(); return { kind: 'REDIS', artifactDigest: redis.digest, provenance, sourceDigest: sha256(encoded) }; }
  budget.spend(5);
  return allocate(budget, { nodes: 5, slots: 4, structuralBytes: 88 }, () => ({ kind: 'REDIS', artifactDigest: redis.digest, provenance, sourceDigest: sha256(value(), budget) }));
}
const CLAIM_KEY_PREFIXES = ['"boardId":', '"cycleStartsAt":', '"evidenceAuthorFullName":', '"evidenceCreatedAt":', '"operationId":', '"operationPayloadHash":', '"ownerDigest":', '"postId":', '"studentId":', '"taskId":'] as const;
function claimBindingKey(record: Record<string, unknown>, budget?: BudgetContext): string {
  if (!budget) return canonicalJson({ boardId: record.boardId, postId: record.postId, ownerDigest: record.ownerDigest, operationId: record.operationId, operationPayloadHash: record.operationPayloadHash ?? null, taskId: record.taskId ?? null, studentId: record.studentId ?? null, cycleStartsAt: record.cycleStartsAt ?? null, evidenceCreatedAt: record.evidenceCreatedAt ?? null, evidenceAuthorFullName: record.evidenceAuthorFullName ?? null });
  // Closed scalar projection, not a certificate for the mutable canonical record.
  // Prefixes are the original canonical code-unit key order. Values and encoded
  // fragments have separate pre-reserved lists; every copied string is admitted
  // before concatenation/join (including the unwrapped join intermediate).
  budget.spend(11); budget.reserve({ nodes: 12, slots: 20, structuralBytes: 152 });
  return referenceNative(budget, () => {
    const values = [record.boardId, record.cycleStartsAt ?? null, record.evidenceAuthorFullName ?? null, record.evidenceCreatedAt ?? null, record.operationId,
      record.operationPayloadHash ?? null, record.ownerDigest, record.postId, record.studentId ?? null, record.taskId ?? null];
    budget.check();
    const parts = new Array<string>(10);
    let bytes = 9;
    for (let i = 0; i < 10; i++) {
      budget.spend();
      const encoded = canonicalJson(values[i], budget); budget.check();
      const prefix = CLAIM_KEY_PREFIXES[i], size = prefix.length + utf8ByteLength(encoded, budget);
      budget.reserveString(size); budget.spend(1 + Math.ceil((prefix.length + encoded.length) / 256));
      parts[i] = `${prefix}${encoded}`; bytes += size; budget.check();
    }
    budget.reserveString(bytes); budget.reserveString(bytes + 2);
    budget.spend(11 + Math.ceil(bytes / 256));
    return `{${parts.join(',')}}`;
  });
}
function transactionKind(status: string) { return status === 'COMPLETED' || status === 'CANCELLED' ? 'CHECKOUT' : status === 'TASK_REWARD' ? 'TASK_REWARD' : status === 'ADMIN_ADJUSTMENT' ? 'ADMIN_ADJUSTMENT' : 'LEGACY'; }
function primaryField(tab: string) { return ({ Students: 'studentId', Products: 'productId', Transactions: 'transactionId', Adjustments: 'adjustmentId', Settings: 'key', Tasks: 'taskId', TaskAssignments: 'assignmentId', TaskCompletions: 'completionId', Promotions: 'promotionId', PromotionProducts: 'promotionProductId' } as Record<string, string>)[tab] ?? ''; }
// Closed typed source pointers only; this raw-only path grants no graph certificate.
function rawDiagnosticPath(operand: () => SourcePointer, budget: BudgetContext): string {
  const source = referenceNative(budget, operand);
  const kind = referenceNative(budget, () => source.kind);
  if (referenceNative(budget, () => equalBudgetValue(kind, 'SHEET', budget))) {
    const sheet = source as Extract<SourcePointer, { kind: 'SHEET' }>;
    const tab = referenceNative(budget, () => sheet.tab);
    const bytes = referenceNative(budget, () => utf8ByteLength(tab, budget));
    budget.reserveString(bytes + 1); budget.spend(1 + Math.ceil((tab.length + 1) / 256));
    const prefix = referenceNative(budget, () => `${tab}[`);
    // Number text has a fixed bound; this does not authorize arbitrary object coercion.
    budget.reserveString(32); budget.spend();
    const rowNumber = referenceNative(budget, () => sheet.rowNumber);
    const numberText = referenceNative(budget, () => String(rowNumber));
    budget.reserveString(32); budget.spend(1 + Math.ceil(numberText.length / 256));
    const padStart = referenceNative(budget, () => numberText.padStart);
    const padded = referenceNative(budget, () => padStart.call(numberText, 9, '0'));
    budget.reserveString(bytes + 33); budget.spend(1 + Math.ceil((prefix.length + padded.length) / 256));
    const body = referenceNative(budget, () => prefix + padded);
    budget.reserveString(bytes + 34); budget.spend(1 + Math.ceil((body.length + 1) / 256));
    return referenceNative(budget, () => `${body}]`);
  }
  const redis = source as Extract<SourcePointer, { kind: 'REDIS' }>;
  const provenance = referenceNative(budget, () => redis.provenance);
  const prefixBytes = referenceNative(budget, () => utf8ByteLength(provenance, budget)) + 1;
  budget.reserveString(prefixBytes); budget.spend(1 + Math.ceil((provenance.length + 1) / 256));
  const prefix = referenceNative(budget, () => `${provenance}.`);
  const digest = referenceNative(budget, () => redis.sourceDigest);
  const digestBytes = referenceNative(budget, () => utf8ByteLength(digest, budget));
  budget.reserveString(prefixBytes + digestBytes); budget.spend(1 + Math.ceil((prefix.length + digest.length) / 256));
  return referenceNative(budget, () => prefix + digest);
}
function rawDiagnosticDigest(operand: () => SourcePointer, budget: BudgetContext): string {
  const source = referenceNative(budget, operand);
  const kind = referenceNative(budget, () => source.kind);
  const sheet = referenceNative(budget, () => equalBudgetValue(kind, 'SHEET', budget));
  return referenceNative(budget, () => sheet
    ? (source as Extract<SourcePointer, { kind: 'SHEET' }>).rowHash
    : (source as Extract<SourcePointer, { kind: 'REDIS' }>).sourceDigest);
}
function diag(code: string, path: string, digest: string): Diagnostic { return { code, path, sourceDigest: sha256(digest) }; }
function sourceDigest(source: SourcePointer) { return source.kind === 'SHEET' ? source.rowHash : source.sourceDigest; }
function sourcePath(source: SourcePointer) { return source.kind === 'SHEET' ? `${source.tab}[${String(source.rowNumber).padStart(9, '0')}]` : `${source.provenance}.${source.sourceDigest}`; }
function finalDiagnosticKey(item: Diagnostic, budget: BudgetContext): string {
  budget.spend();
  const code = referenceNative(budget, () => item.code);
  const codeBytes = referenceNative(budget, () => utf8ByteLength(code, budget));
  budget.reserveString(codeBytes + 1);
  budget.spend(1 + Math.ceil((code.length + 1) / 256));
  const first = referenceNative(budget, () => code + '\0');
  budget.spend();
  const path = referenceNative(budget, () => item.path);
  const pathBytes = referenceNative(budget, () => utf8ByteLength(path, budget));
  budget.reserveString(codeBytes + 1 + pathBytes);
  budget.spend(1 + Math.ceil((first.length + path.length) / 256));
  const second = referenceNative(budget, () => first + path);
  budget.reserveString(codeBytes + pathBytes + 2);
  budget.spend(1 + Math.ceil((second.length + 1) / 256));
  const third = referenceNative(budget, () => second + '\0');
  budget.spend();
  const digest = referenceNative(budget, () => item.sourceDigest);
  const digestBytes = referenceNative(budget, () => utf8ByteLength(digest, budget));
  budget.reserveString(codeBytes + pathBytes + digestBytes + 2);
  budget.spend(1 + Math.ceil((third.length + digest.length) / 256));
  return referenceNative(budget, () => third + digest);
}
function finalDiagnosticsBudget(items: Diagnostic[], output: NormalizationOutput | undefined, budget: BudgetContext): Diagnostic[] {
  const unique = referenceMap<Diagnostic>(budget);
  const keys = referenceList<string>(budget);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => items.length);
    if (i >= length) break;
    budget.spend(2);
    const item = referenceNative(budget, () => items[i]);
    const key = finalDiagnosticKey(item, budget);
    const present = referenceHas(unique, key, budget);
    if (!present) budget.reserve({ slots: 2, structuralBytes: 8 });
    budget.spend(1 + Math.ceil(key.length / 256));
    referenceNative(budget, () => unique.set(key, item));
    if (!present) referenceAppend(keys, key, budget);
  }
  const result = referenceList<Diagnostic>(budget);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => keys.length);
    if (i >= length) break;
    budget.spend(2);
    const key = referenceNative(budget, () => keys[i]);
    const item = referenceGet(unique, key, budget)!;
    if (output) referenceNative(budget, () => output.conflict(result, () => item));
    else referenceAppend(result, item, budget);
  }
  return referenceNative(budget, () => stableBudgetSort(result, (left, right) => {
    const leftKey = finalDiagnosticKey(left, budget);
    const rightKey = finalDiagnosticKey(right, budget);
    return referenceNative(budget, () => compareCodeUnits(leftKey, rightKey, budget));
  }, budget));
}
function stableDiagnostics(items: Diagnostic[], output?: NormalizationOutput, budget?: BudgetContext) {
  if (budget) return finalDiagnosticsBudget(items, output, budget);
  const unique = new Map(items.map((item) => [`${item.code}\0${item.path}\0${item.sourceDigest}`, item]));
  let result: Diagnostic[];
  if (output) {
    budget!.reserve({ nodes: 1, structuralBytes: 16 });
    result = [];
    for (const item of unique.values()) output.conflict(result, () => item);
  } else result = [...unique.values()];
  return result.sort((a, b) => compareCodeUnits(`${a.code}\0${a.path}\0${a.sourceDigest}`, `${b.code}\0${b.path}\0${b.sourceDigest}`));
}
// Closed source-local scratch: mutable code arrays are never graph certificates.
// Each kind owns Set + distinct + emission + two merge-sort containers. Only
// emitted scalar occurrences are new payload; scratch holds shared references.
function sourceCodeList(operand: () => string[], budget: BudgetContext, output?: NormalizationOutput): string[] {
  budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
  const seen = referenceNative(budget, () => new Set<string>());
  budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
  const distinct: string[] = referenceNative(budget, () => []);
  const values = referenceNative(budget, operand);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => values.length);
    if (i >= length) break;
    budget.spend(2);
    const code = referenceNative(budget, () => values[i]);
    const work = 1 + Math.ceil(code.length / 256);
    budget.spend(work);
    if (!referenceNative(budget, () => seen.has(code))) {
      budget.reserve({ slots: 1, structuralBytes: 4 }); budget.spend(work);
      referenceNative(budget, () => seen.add(code));
      budget.reserve({ slots: 1, structuralBytes: 4 }); budget.spend();
      referenceNative(budget, () => distinct.push(code));
    }
  }
  budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
  const result: string[] = referenceNative(budget, () => []);
  for (let i = 0; ; i++) {
    budget.spend();
    const length = referenceNative(budget, () => distinct.length);
    if (i >= length) break;
    budget.spend(2);
    const code = referenceNative(budget, () => distinct[i]);
    if (output) referenceNative(budget, () => output.errorCode(result, () => {
      // Category and destination belong exclusively to the real emitter.
      budget.reserve({ nodes: 1, structuralBytes: 4 }); budget.spend();
      return referenceNative(budget, () => code);
    }));
    else {
      budget.reserve({ nodes: 1, slots: 1, structuralBytes: 8 }); budget.spend(2);
      referenceNative(budget, () => result.push(code));
    }
  }
  return referenceNative(budget, () => stableBudgetSort(result,
    (a, b) => referenceNative(budget, () => compareCodeUnits(a, b, budget)), budget));
}
function toSourceRecord(entry: Entry, output?: NormalizationOutput, budget?: BudgetContext): NormalizedSourceRecord {
  if (output && budget) {
    // Six base fields: object + status occurrence, six slots, key bytes 76.
    // The source emitter already owns the destination slot/category.
    budget.reserve({ nodes: 2, slots: 6, structuralBytes: 120 }); budget.spend(7);
    const errors = sourceCodeList(() => entry.errors, budget, output);
    const warningCodes = sourceCodeList(() => entry.warnings, budget);
    const targets = referenceNative(budget, () => entry.targets);
    const first = referenceNative(budget, () => targets[0]);
    const source = referenceNative(budget, () => entry.source);
    const redactedSourceRecord = referenceNative(budget, () => entry.redacted);
    const count = referenceNative(budget, () => errors.length);
    let retained = count === 0;
    for (let i = 0; i < count && !retained; i++) {
      budget.spend();
      const code = referenceNative(budget, () => errors[i]);
      retained = equalBudgetValue(code, 'UNSUPPORTED_LEGACY_BANK_AUTHORITY', budget)
        || equalBudgetValue(code, 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY', budget);
    }
    let canonicalRecord: Entry['canonical'];
    if (retained) canonicalRecord = referenceNative(budget, () => entry.canonical);
    else {
      budget.reserve({ nodes: 1, structuralBytes: 4 }); budget.spend();
      canonicalRecord = null;
    }
    const mappingStatus = count ? 'QUARANTINED' : 'STAGED';
    if (!count && first) {
      // Two primitive occurrences + two slots + 19 key bytes; no spread temporary.
      budget.reserve({ nodes: 2, slots: 2, structuralBytes: 35 }); budget.spend(2);
      const targetTable = referenceNative(budget, () => first.table);
      const targetId = referenceNative(budget, () => first.id);
      return { source, redactedSourceRecord, canonicalRecord, mappingStatus, targetTable, targetId, warningCodes, errorCodes: errors };
    }
    return { source, redactedSourceRecord, canonicalRecord, mappingStatus, warningCodes, errorCodes: errors };
  }
  let errors: string[];
  if (output) {
    budget!.reserve({ nodes: 1, structuralBytes: 16 });
    errors = [];
    for (const code of new Set(entry.errors)) output.errorCode(errors, () => code);
    errors.sort(compareCodeUnits);
  } else errors = [...new Set(entry.errors)].sort(compareCodeUnits);
  const warningCodes = [...new Set(entry.warnings)].sort(compareCodeUnits);
  const first = entry.targets[0];
  return { source: entry.source, redactedSourceRecord: entry.redacted, canonicalRecord: errors.length && !errors.some((code) => code === 'UNSUPPORTED_LEGACY_BANK_AUTHORITY' || code === 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY') ? null : entry.canonical, mappingStatus: errors.length ? 'QUARANTINED' : 'STAGED', ...(errors.length || !first ? {} : { targetTable: first.table, targetId: first.id }), warningCodes, errorCodes: errors };
}