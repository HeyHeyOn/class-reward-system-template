import 'server-only';

import { createHash } from 'node:crypto';
import { createHeaderIndex, parseTransactionRow } from '@/server/sheetsRows';
import { normalizeSchema4BankHistory, importSchema4BankHistory, readSchema4BankHistory, type BankHistoryPlan } from './schema4BankHistory';

// A07 development-only slice, NOT a general adjustment normalizer. Assess only
// physical rows 7:10, nonzero single-target bulk add/subtract with no counterpart.
// All transaction rows participate in collision/link checks. Never publish claims,
// mint modern operation IDs, infer authenticated authorship, or call a source writer.
const coordinates = [7, 8, 9, 10] as const;
const headers = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const adjustmentHeaders = ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'];
const bulkId = /^ADMIN-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{64})-([0-9a-f]{12})$/;
const cancelPrefixes = ['cancel:', 'cancel-task:', 'cancel-task-unlinked:', 'cancel-task-pre-reset:'];
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const identifier = (v: string | undefined) => Boolean(v && v.trim() === v && v.length <= 4096);
const integer = (v: string | undefined): number | null => v !== undefined && /^(0|-?[1-9][0-9]*)$/.test(v)
  && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const instant = (v: string | undefined) => Boolean(v && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export type AdjustmentObservation = {
  rowNumber: number; mode: 'add' | 'subtract' | 'UNPROVEN'; predecessorRow: number | null;
  predecessorNameMatches: boolean;
  consistency: 'BULK_ADJUSTMENT_WRITER_MATCH' | 'UNPROVEN'; facts: Record<string, boolean>; diagnosticCodes: string[];
  priorTransactionLink: 'NONE' | 'UNPROVEN'; claimAuthority: 'UNOBSERVED';
};
export type AdjustmentHistory = {
  authority: 'OFFLINE_NONAUTHORITY'; sourceDigest: string; rows: AdjustmentObservation[];
  operationalBridge: { status: 'BLOCKED'; readerConnected: false; importerConnected: false };
};

export function inspectSchema4AdjustmentHistory(gridJson: string): AdjustmentHistory {
  return inspectPlan(normalizeSchema4BankHistory(gridJson));
}
function inspectPlan(plan: BankHistoryPlan): AdjustmentHistory {
  const sources = plan.sources.filter(r => r.tab === 'Transactions');
  const actualHeaders = sources.find(r => r.rowNumber === 1)?.cells ?? [];
  const headerMatch = JSON.stringify(actualHeaders) === JSON.stringify(headers), index = createHeaderIndex(actualHeaders);
  const records = sources.filter(r => r.rowNumber > 1).map(r => ({ ...r,
    values: Object.fromEntries(headers.map(key => [key, r.cells[actualHeaders.indexOf(key)] ?? ''])),
  }));
  const adjustments = plan.sources.filter(r => r.tab === 'Adjustments');
  const counterpartAbsent = JSON.stringify(adjustments.find(r => r.rowNumber === 1)?.cells) === JSON.stringify(adjustmentHeaders)
    && adjustments.filter(r => r.rowNumber > 1).every(r => r.cells.every(c => !c));
  const rows: AdjustmentObservation[] = coordinates.map(rowNumber => {
    const raw = records.find(r => r.rowNumber === rowNumber), r = raw?.values ?? {};
    const prior = records.filter(p => p.rowNumber < rowNumber && p.values.studentId === r.studentId).at(-1);
    const p = prior?.values ?? {};
    const parsed = raw && parseTransactionRow(raw.cells, index);
    const id = bulkId.exec(r.transactionId ?? '');
    const total = integer(r.totalAmount), before = integer(r.balanceBefore), after = integer(r.balanceAfter);
    let items: unknown;
    try { items = JSON.parse(r.items ?? 'null'); } catch { items = null; }
    const item: Record<string, unknown> | null = Array.isArray(items) && items.length === 1 && items[0]
      && typeof items[0] === 'object' && !Array.isArray(items[0]) ? items[0] : null;
    const mode = item?.productId === 'ADMIN-ADD' ? 'add' : item?.productId === 'ADMIN-SUBTRACT' ? 'subtract' : 'UNPROVEN';
    const amount = total === null ? null : mode === 'add' ? -total : mode === 'subtract' ? total : null;
    const unlinked = r.operator === 'admin' && !records.some(v => cancelPrefixes.some(prefix =>
      v.values.operator.trim() === `${prefix}${r.transactionId}`));
    const facts = {
      rawShape: headerMatch && Boolean(raw && raw.cells.length === headers.length)
        && ['transactionId', 'studentId', 'studentName'].every(key => identifier(r[key])),
      writerIdShape: Boolean(id),
      uniqueTransactionId: identifier(r.transactionId) && records.filter(v => v.values.transactionId.trim() === r.transactionId).length === 1,
      isolatedOperation: Boolean(id && records.filter(v => v.values.transactionId.trim().startsWith(`ADMIN-${id[1]}-`)).length === 1),
      signedBalance: total !== null && before !== null && after !== null && Number.isSafeInteger(before - after)
        && total === before - after && amount !== null && Number.isSafeInteger(amount) && amount > 0,
      itemShape: Boolean(item && mode !== 'UNPROVEN' && Object.keys(item).sort().join('|') === 'name|price|productId|quantity|subtotal'
        && item.name === (mode === 'add' ? '관리자 지급' : '관리자 회수') && item.quantity === 1
        && total !== null && item.price === total && item.subtotal === total),
      readerShape: Boolean(parsed && !parsed.itemsMalformed && parsed.items.length === 1
        && r.status === 'ADMIN_ADJUSTMENT' && r.operator === 'admin'),
      payloadHashMatches: Boolean(id && mode !== 'UNPROVEN' && amount !== null && amount > 0
        && id[2] === hash(JSON.stringify({ studentIds: [r.studentId], mode, amount }))),
      studentSuffixMatches: Boolean(id && identifier(r.studentId) && id[3] === hash(r.studentId).slice(0, 12)),
      physicalChronology: Boolean(prior && prior.rowNumber === rowNumber - 1 && instant(p.timestamp) && instant(r.timestamp)
        && Date.parse(r.timestamp) > Date.parse(p.timestamp)),
      predecessorContinuity: Boolean(prior && identifier(p.studentId) && p.studentId === r.studentId
        && before !== null && integer(p.balanceAfter) === before
        && records.filter(v => v.values.transactionId.trim() === p.transactionId).length === 1),
      noPriorTransactionLink: unlinked,
      counterpartAbsent,
    };
    // Continuity is an observation, NOT a cancellation link, compensation proof,
    // stock/task reward authorization or evidence that a particular writer ran.
    const match = Object.values(facts).every(Boolean);
    // The writer snapshots the display name at each independent operation. A
    // later rename cannot invalidate stable-ID/balance continuity or be repaired.
    const predecessorNameMatches = Boolean(prior && p.studentName === r.studentName);
    return { rowNumber, mode, predecessorRow: prior?.rowNumber ?? null,
      predecessorNameMatches,
      consistency: match ? 'BULK_ADJUSTMENT_WRITER_MATCH' : 'UNPROVEN', facts,
      diagnosticCodes: [...Object.entries(facts).filter(([, valid]) => !valid).map(([key]) =>
        `ADJUSTMENT_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}_UNPROVEN`),
      ...(predecessorNameMatches ? [] : ['ADJUSTMENT_NAME_SNAPSHOT_CHANGED']),
      'MISSING_ADJUSTMENTS_COUNTERPART', 'UNPROVEN_ADJUSTMENT_AUTHORITY', 'UNOBSERVED_ADJUSTMENT_CLAIM'],
      priorTransactionLink: unlinked ? 'NONE' : 'UNPROVEN', claimAuthority: 'UNOBSERVED' };
  });
  return { authority: 'OFFLINE_NONAUTHORITY', sourceDigest: plan.sourceDigest, rows,
    operationalBridge: { status: 'BLOCKED', readerConnected: false, importerConnected: false } };
}

type Intent = { intent: 'OFFLINE_INSPECTION' | 'OPERATIONAL_READER' | 'OPERATIONAL_IMPORT' };
type ReadInput = Parameters<typeof readSchema4BankHistory>[0] & Intent;
function offline(input: Intent) {
  if (input.intent !== 'OFFLINE_INSPECTION') throw new Error('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
}
const complete = (history: AdjustmentHistory) => history.rows.every(r => r.consistency === 'BULK_ADJUSTMENT_WRITER_MATCH');
/** Reuse A04 immutable raw storage. Only a trusted isolated test runner is allowed
 * by contract; this is not a sandbox for hostile runner code or a runtime adapter. */
export async function importSchema4AdjustmentHistory(input: Parameters<typeof importSchema4BankHistory>[0] & Intent) {
  offline(input);
  if (!complete(inspectSchema4AdjustmentHistory(input.gridJson))) throw new Error('ADJUSTMENT_HISTORY_SLICE_BLOCKED');
  const observation = await importSchema4BankHistory(input);
  return { ...observation, adjustmentRows: coordinates.length };
}
export async function readSchema4AdjustmentHistory(input: ReadInput) {
  offline(input);
  const observation = await readSchema4BankHistory(input);
  return { observation, adjustmentHistory: inspectPlan(observation.plan), currentStateAuthority: 'BLOCKED' as const };
}
/** Recognize the pinned historical row, never retry the Sheets writer. Its own
 * retry additionally checks CURRENT student balances, unlike historical replay. */
export async function replaySchema4AdjustmentHistory(input: ReadInput & { rowNumber: number }) {
  offline(input);
  const { adjustmentHistory } = await readSchema4AdjustmentHistory(input);
  if (!complete(adjustmentHistory) || !adjustmentHistory.rows.some(r => r.rowNumber === input.rowNumber)) {
    throw new Error('ADJUSTMENT_REPLAY_UNPROVEN');
  }
  return { kind: 'HISTORICAL_ADJUSTMENT_ALREADY_RECORDED' as const, authority: 'OFFLINE_NONAUTHORITY' as const,
    rowNumber: input.rowNumber, changed: false as const, balanceToApply: 0, stockToApply: 0, rewardToApply: 0,
    claimPublished: false as const, currentStateAuthority: 'BLOCKED' as const };
}
