import 'server-only';

import { createHeaderIndex, isCheckoutLineSnapshot, parseTransactionRow } from '@/server/sheetsRows';
import {
  normalizeSchema4BankHistory, importSchema4BankHistory, readSchema4BankHistory, type BankHistoryPlan,
} from './schema4BankHistory';

// A06 development-only slice, not a general cancellation normalizer or importer.
// Coordinates include the header. Only (3,5) and (4,6) are assessed. All rows
// still participate in identity/link ambiguity checks and exact A04 raw readback.
const coordinates = [[3, 5], [4, 6]] as const;
const headers = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const prefixes = ['cancel:', 'cancel-task:', 'cancel-task-unlinked:', 'cancel-task-pre-reset:'];
const identifier = (v: string | undefined) => Boolean(v && v.trim() === v && v.length <= 4096);
const integer = (v: string | undefined): number | null => v !== undefined && /^(0|-?[1-9][0-9]*)$/.test(v)
  && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const instant = (v: string | undefined) => Boolean(v && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const linkedId = (operator: string) => {
  const prefix = prefixes.find(p => operator.startsWith(p));
  return prefix ? operator.slice(prefix.length) : null;
};
export type CancellationObservation = {
  rowNumber: number; peerRow: number; consistency: 'CHECKOUT_CANCELLATION_WRITER_MATCH' | 'UNPROVEN';
  facts: Record<string, boolean>; diagnosticCodes: string[];
};
export type CancellationHistory = {
  authority: 'OFFLINE_NONAUTHORITY'; sourceDigest: string; rows: CancellationObservation[];
  pairs: Array<{ originalRow: number; reversalRow: number; balanceDelta: number;
    stockDeltas: Array<{ itemIndex: number; quantity: number }>; stockAuthority: 'DERIVED_ONLY_NOT_OBSERVED' }>;
  operationalBridge: { status: 'BLOCKED'; readerConnected: false; importerConnected: false };
};

export function inspectSchema4CancellationHistory(gridJson: string): CancellationHistory {
  return inspectPlan(normalizeSchema4BankHistory(gridJson));
}
function inspectPlan(plan: BankHistoryPlan): CancellationHistory {
  const sources = plan.sources.filter(r => r.tab === 'Transactions');
  const actualHeaders = sources.find(r => r.rowNumber === 1)?.cells ?? [];
  const headerMatch = JSON.stringify(actualHeaders) === JSON.stringify(headers);
  const index = createHeaderIndex(actualHeaders);
  const records = sources.filter(r => r.rowNumber > 1).map(r => ({ ...r,
    values: Object.fromEntries(headers.map(key => [key, r.cells[actualHeaders.indexOf(key)] ?? ''])),
  }));
  const rows: CancellationObservation[] = [], pairs: CancellationHistory['pairs'] = [];
  for (const [originalRow, reversalRow] of coordinates) {
    const original = records.find(r => r.rowNumber === originalRow), reversal = records.find(r => r.rowNumber === reversalRow);
    const o = original?.values ?? {}, r = reversal?.values ?? {};
    const parsedO = original && parseTransactionRow(original.cells, index), parsedR = reversal && parseTransactionRow(reversal.cells, index);
    const total = integer(o.totalAmount), before = integer(o.balanceBefore), after = integer(o.balanceAfter);
    const rTotal = integer(r.totalAmount), rBefore = integer(r.balanceBefore), rAfter = integer(r.balanceAfter);
    const one = parsedO?.items[0], item = parsedR?.items[0];
    const stock = one && isCheckoutLineSnapshot(one) ? one.totalQuantity : null;
    // Do not infer operationId from CANCEL- suffix, nor prior original status
    // from CANCELLED. Both deterministic and timestamp fallback writer IDs exist.
    const facts = {
      rawShape: headerMatch && Boolean(original && reversal && original.cells.length === headers.length && reversal.cells.length === headers.length)
        && ['transactionId', 'studentId', 'studentName', 'operator'].every(key => identifier(o[key]) && identifier(r[key])),
      uniqueIds: Boolean(o.transactionId && r.transactionId && o.transactionId !== r.transactionId)
        && [o.transactionId, r.transactionId].every(id => records.filter(v => v.values.transactionId.trim() === id).length === 1),
      exactLink: r.operator === `cancel:${o.transactionId}`
        && records.filter(v => linkedId(v.values.operator.trim()) === o.transactionId).length === 1
        && !records.some(v => linkedId(v.values.operator.trim()) === r.transactionId),
      writerIdShape: identifier(r.transactionId) && r.transactionId.startsWith('CANCEL-') && r.transactionId.length > 'CANCEL-'.length,
      checkoutShape: o.status === 'CANCELLED' && o.operator === 'kiosk' && r.status === 'CANCEL_REVERSAL'
        && Boolean(parsedO && !parsedO.itemsMalformed && parsedO.items.length === 1 && one && isCheckoutLineSnapshot(one)),
      chronology: instant(o.timestamp) && instant(r.timestamp) && Date.parse(r.timestamp) > Date.parse(o.timestamp),
      sameStudent: identifier(o.studentId) && identifier(o.studentName) && o.studentId === r.studentId && o.studentName === r.studentName,
      signedBalance: total !== null && total >= 0 && before !== null && after !== null && rTotal !== null && rBefore !== null && rAfter !== null
        && Number.isSafeInteger(before - after) && total === before - after && rTotal === -total
        && Number.isSafeInteger(rBefore + total) && rBefore + total === rAfter,
      checkoutTotal: total !== null && Boolean(one && isCheckoutLineSnapshot(one) && one.finalTotal === total),
      reversalItem: Boolean(parsedR && !parsedR.itemsMalformed && parsedR.items.length === 1 && item && !isCheckoutLineSnapshot(item)
        && item.productId === `CANCEL-${o.transactionId}` && item.name === '거래 취소' && item.quantity === 1
        && rTotal !== null && item.price === rTotal && item.subtotal === rTotal),
      stockDerivable: stock !== null && Number.isSafeInteger(stock) && stock > 0,
    };
    const codes: Record<keyof typeof facts, string> = {
      rawShape: 'CANCELLATION_RAW_SHAPE_UNPROVEN', uniqueIds: 'CANCELLATION_ID_AMBIGUOUS', exactLink: 'CANCELLATION_LINK_UNPROVEN',
      writerIdShape: 'CANCELLATION_WRITER_ID_UNPROVEN', checkoutShape: 'CANCELLATION_CHECKOUT_SHAPE_UNPROVEN',
      chronology: 'CANCELLATION_CHRONOLOGY_UNPROVEN', sameStudent: 'CANCELLATION_STUDENT_MISMATCH',
      signedBalance: 'CANCELLATION_SIGNED_BALANCE_UNPROVEN', checkoutTotal: 'CANCELLATION_CHECKOUT_TOTAL_UNPROVEN',
      reversalItem: 'CANCELLATION_REVERSAL_ITEM_UNPROVEN', stockDerivable: 'CANCELLATION_STOCK_DELTA_UNPROVEN',
    };
    const match = Object.values(facts).every(Boolean);
    for (const [rowNumber, peerRow] of [[originalRow, reversalRow], [reversalRow, originalRow]]) {
      rows.push({ rowNumber, peerRow, consistency: match ? 'CHECKOUT_CANCELLATION_WRITER_MATCH' : 'UNPROVEN', facts: { ...facts },
        diagnosticCodes: [...(Object.keys(facts) as (keyof typeof facts)[]).filter(key => !facts[key]).map(key => codes[key]),
          'UNPROVEN_CANCELLATION_AUTHORITY', 'UNPROVEN_HISTORICAL_STOCK_APPLICATION'] });
    }
    if (match) pairs.push({ originalRow, reversalRow, balanceDelta: total!, stockDeltas: [{ itemIndex: 0, quantity: stock! }],
      stockAuthority: 'DERIVED_ONLY_NOT_OBSERVED' });
  }
  return { authority: 'OFFLINE_NONAUTHORITY', sourceDigest: plan.sourceDigest, rows: rows.sort((a, b) => a.rowNumber - b.rowNumber), pairs,
    operationalBridge: { status: 'BLOCKED', readerConnected: false, importerConnected: false } };
}

type Intent = { intent: 'OFFLINE_INSPECTION' | 'OPERATIONAL_READER' | 'OPERATIONAL_IMPORT' };
type ReadInput = Parameters<typeof readSchema4BankHistory>[0] & Intent;
function offline(input: Intent) {
  if (input.intent !== 'OFFLINE_INSPECTION') throw new Error('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
}
/** Reuse A04 immutable raw storage, without new SQL tables or authority records.
 * The explicitly supplied runner is restricted to trusted isolated test callers. */
export async function importSchema4CancellationHistory(input: Parameters<typeof importSchema4BankHistory>[0] & Intent) {
  offline(input);
  const history = inspectSchema4CancellationHistory(input.gridJson);
  if (history.pairs.length !== coordinates.length) throw new Error('CANCELLATION_HISTORY_SLICE_BLOCKED');
  const observation = await importSchema4BankHistory(input);
  return { ...observation, cancellationPairs: history.pairs.length };
}

export async function readSchema4CancellationHistory(input: ReadInput) {
  offline(input);
  const observation = await readSchema4BankHistory(input);
  // Derive from verified stored bytes, not a supplied assessment or current grid.
  const cancellationHistory = inspectPlan(observation.plan);
  return { observation, cancellationHistory, currentStateAuthority: 'BLOCKED' as const };
}

/** Read-only recognition, not a retry of the source writer or an authorization.
 * No operationId is recovered from an opaque CANCEL- ID. No balances or stock
 * are written, even when the exact historical pair can be recognized. */
export async function replaySchema4CancellationHistory(input: ReadInput & { originalRow: number; reversalRow: number }) {
  offline(input);
  const { cancellationHistory } = await readSchema4CancellationHistory(input);
  const pair = cancellationHistory.pairs.find(p => p.originalRow === input.originalRow && p.reversalRow === input.reversalRow);
  if (!pair) throw new Error('CANCELLATION_REPLAY_UNPROVEN');
  return { kind: 'HISTORICAL_CANCELLATION_ALREADY_RECORDED' as const, authority: 'OFFLINE_NONAUTHORITY' as const,
    originalRow: pair.originalRow, reversalRow: pair.reversalRow, changed: false as const,
    balanceToApply: 0, stockToApply: 0, currentStateAuthority: 'BLOCKED' as const };
}
