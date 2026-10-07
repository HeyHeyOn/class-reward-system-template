import 'server-only';

import { createHash } from 'node:crypto';
import {
  normalizeSchema4BankHistory, readSchema4BankHistory, type BankHistoryPlan,
} from './schema4BankHistory';

// Bounded development contract, NOT a migration manifest or authority token.
// A matching writer fingerprint proves consistency of observed bytes only. The
// capture contains no authenticated TASK_ADMIN operation/result/audit binding.
export type AdminResetObservation = {
  rowNumber: number;
  consistency: 'SINGLE_BANK_RESET_WRITER_MATCH' | 'UNPROVEN';
  authority: 'UNPROVEN_ADMIN_RESET_OPERATION';
  facts: Record<string, boolean>;
  diagnosticCodes: string[];
  anchor: { assignmentRow: number; checkpointRows: number[]; transactionRow: number } | null;
};
export type Schema4AdminHistory = {
  authority: 'OFFLINE_NONAUTHORITY'; sourceDigest: string;
  resets: AdminResetObservation[];
  legacyDiagnostics: BankHistoryPlan['diagnostics'];
  operationalBridge: {
    status: 'BLOCKED'; readerConnected: false; importerConnected: false; reasons: readonly string[];
  };
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const tuple = ['taskId', 'taskInstanceId', 'studentId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone'];
const integer = (value: string | undefined) => value !== undefined && /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
const identifier = (value: string | undefined) => Boolean(value && value.trim() === value && value.length <= 4096);
type Row = { rowNumber: number; values: Record<string, string> };

export function inspectSchema4AdminHistory(gridJson: string): Schema4AdminHistory {
  return inspectVerifiedPlan(normalizeSchema4BankHistory(gridJson));
}

function inspectVerifiedPlan(plan: BankHistoryPlan): Schema4AdminHistory {
  const table = (tab: string): Row[] => {
    const sources = plan.sources.filter(row => row.tab === tab);
    const headers = sources.find(row => row.rowNumber === 1)?.cells ?? [];
    return sources.filter(row => row.rowNumber > 1 && row.cells.some(Boolean)).map(row => ({
      rowNumber: row.rowNumber,
      values: Object.fromEntries(headers.filter(Boolean).map(key => [key, row.cells[headers.indexOf(key)] ?? ''])),
    }));
  };
  const completions = table('TaskCompletions'), assignments = table('TaskAssignments'), settings = table('Settings');
  const resets: AdminResetObservation[] = completions.filter(row => row.values.source === 'ADMIN_RESET').map(row => {
    const r = row.values;
    const identity = sha(r.operationId ?? '');
    const sameTuple = (other: Row) => tuple.every(key => other.values[key] === r[key]);
    const groups = plan.groups.filter(group => {
      const bank = completions.find(event => event.rowNumber === group.checkpointRows[2]);
      return bank && sameTuple(bank) && bank.values.assignmentId === r.assignmentId && bank.values.studentName === r.studentName;
    });
    const group = groups.length === 1 ? groups[0] : undefined;
    const bank = group && completions.find(event => event.rowNumber === group.checkpointRows[2]);
    // Only this minimum one-reset/one-task, BANK-anchored variant is supported.
    // Multi-target batches, carry materialization, duplicate deliveries, omitted
    // no-op taskIds and other reset writers remain explicitly UNPROVEN.
    const facts = {
      batchShape: r.status === 'RESET' && r.note === 'admin-reset' && r.schemaVersion === '2'
        && !Object.keys(r).some(key => key.startsWith('evidence') && r[key]),
      completionIdBound: identifier(r.operationId) && r.completionId === `TC-RESET-${identity}-1-1`,
      singleTaskPayloadBound: identifier(r.taskId) && r.operationPayloadHash === `sha256:${sha(JSON.stringify([r.taskId]))}`,
      operationExclusive: identifier(r.operationId)
        && completions.filter(other => other.values.operationId === r.operationId
          || other.values.completionId?.startsWith(`TC-RESET-${identity}-`)).length === 1
        && completions.filter(other => other.values.completionId === r.completionId).length === 1
        && !settings.some(other => other.values.key === `taskResetOperation:${identity}`),
      bankAnchor: Boolean(bank),
      assignmentUnambiguous: Boolean(group) && assignments.filter(sameTuple).length === 1,
      timestampReused: Boolean(bank && r.timestamp === bank.values.timestamp),
      physicalOrder: Boolean(bank && bank.rowNumber < row.rowNumber
        && !completions.some(other => other.rowNumber > bank.rowNumber && other.rowNumber < row.rowNumber && sameTuple(other))),
      zeroEffect: r.reward === '0' && integer(r.balanceBefore) && r.balanceBefore === r.balanceAfter,
      bankBalanceLinked: Boolean(bank && r.balanceBefore === bank.values.balanceAfter),
    };
    const codes: Record<keyof typeof facts, string> = {
      batchShape: 'ADMIN_RESET_BATCH_SHAPE_UNPROVEN', completionIdBound: 'ADMIN_RESET_ID_UNPROVEN',
      singleTaskPayloadBound: 'ADMIN_RESET_PAYLOAD_SCOPE_UNPROVEN', operationExclusive: 'ADMIN_RESET_OPERATION_REUSE_OR_MARKER_CONFLICT',
      bankAnchor: 'ADMIN_RESET_BANK_ANCHOR_UNPROVEN', assignmentUnambiguous: 'ADMIN_RESET_ASSIGNMENT_ORDER_UNPROVEN',
      timestampReused: 'ADMIN_RESET_TIMESTAMP_REUSE_UNPROVEN', physicalOrder: 'ADMIN_RESET_PHYSICAL_ORDER_UNPROVEN',
      zeroEffect: 'ADMIN_RESET_ZERO_EFFECT_UNPROVEN', bankBalanceLinked: 'ADMIN_RESET_BALANCE_LINK_UNPROVEN',
    };
    return {
      rowNumber: row.rowNumber,
      consistency: Object.values(facts).every(Boolean) ? 'SINGLE_BANK_RESET_WRITER_MATCH' : 'UNPROVEN',
      authority: 'UNPROVEN_ADMIN_RESET_OPERATION', facts,
      diagnosticCodes: [...(Object.keys(facts) as (keyof typeof facts)[]).filter(key => !facts[key]).map(key => codes[key]),
        'MISSING_ADMIN_OPERATION_PROVENANCE'],
      anchor: group ? { assignmentRow: group.assignmentRow, checkpointRows: [...group.checkpointRows], transactionRow: group.transactionRow } : null,
    };
  });
  return { authority: 'OFFLINE_NONAUTHORITY', sourceDigest: plan.sourceDigest, resets,
    legacyDiagnostics: plan.diagnostics.map(row => ({ ...row })),
    operationalBridge: { status: 'BLOCKED', readerConnected: false, importerConnected: false,
      reasons: ['OFFLINE_NONAUTHORITY', 'MISSING_ADMIN_OPERATION_PROVENANCE', 'NO_SCHEMA4_OPERATIONAL_ADAPTER'] } };
}

/** Fail-closed bridge admission, deliberately disconnected from configured
 * repositories and the operational importer. There is no caller-supplied
 * authority flag or callback that can promote history into modern operations.
 * Non-inspection intents fail BEFORE any runner/SQL. Offline reads rederive the
 * observation from A04's immutable, exact-readback PG source, never a saved PASS.
 * The nested snapshot is for inspection only, not an operational reader result. */
export async function readSchema4AdminHistory(input: Parameters<typeof readSchema4BankHistory>[0] & {
  intent: 'OFFLINE_INSPECTION' | 'OPERATIONAL_READER' | 'OPERATIONAL_IMPORT';
}) {
  if (input.intent !== 'OFFLINE_INSPECTION') throw new Error('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
  const observation = await readSchema4BankHistory(input);
  return { authority: 'OFFLINE_NONAUTHORITY' as const, currentStateAuthority: 'BLOCKED' as const,
    adminHistory: inspectVerifiedPlan(observation.plan), observation };
}
