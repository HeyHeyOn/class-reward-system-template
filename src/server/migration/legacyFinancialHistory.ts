import 'server-only';
import type { Transaction } from '@/domain/types';
import { createHeaderIndex, parseTransactionRow } from '@/server/sheetsRows';
import { readOfflineGoogleGrid } from './offlineGoogleGrid';
import { canonicalJson, sha256 } from './validators';

const transactionHeaders = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const statuses = new Set(['COMPLETED', 'CANCELLED', 'CANCEL_REVERSAL', 'TASK_REWARD', 'ADMIN_ADJUSTMENT']);

export type LegacyFinancialRecord = Readonly<{
  rowNumber: number;
  rowDigest: string;
  originalCells: readonly string[];
  transaction: Transaction;
  balanceDelta: number;
  reversesTransactionId: string | null;
}>;
export type LegacyFinancialHistory = Readonly<{
  sourceDigest: string;
  records: readonly LegacyFinancialRecord[];
  currentBalances: Readonly<Record<string, number>>;
  /** These are observed pre-history balances, never generated deposits. */
  firstRecordedBalances: Readonly<Record<string, number>>;
  netRecordedDelta: string;
  discrepancies: readonly LegacyFinancialDiscrepancy[];
  review: LegacyFinancialReview | null;
  digest: string;
}>;
export type LegacyFinancialDiscrepancy = Readonly<{
  code: 'BALANCE_CHAIN_GAP' | 'MISSING_REVERSAL';
  rowNumber: number; rowDigest: string;
  previousRowNumber: number | null; previousRowDigest: string | null;
  amount: number;
}>;
/** Trusted operator input, never inferred from an imperfect source or a public
 * request. Exact reviewed row hashes allow later valid appends, not new gaps. */
export type LegacyFinancialReview = Readonly<{
  policy: 'PRESERVE_RECORDED_BALANCES';
  sourceIdentityDigest: string;
  approvedBySubjectDigest: string;
  approvalEvidenceDigest: string;
  discrepancies: readonly LegacyFinancialDiscrepancy[];
}>;

function fail(code: string, rowNumber: number): never {
  // No upstream error text, raw cell values, names or identifiers in errors.
  throw new Error(`LEGACY_FINANCIAL_${code}:row:${rowNumber}`);
}
function integer(value: string | undefined, row: number): number {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INTEGER', row);
  return Number(value);
}
function id(value: string | undefined, row: number): string {
  if (!value || value.trim() !== value || value.length > 4096 || /[\p{Cc}\p{Cs}]/u.test(value)) fail('IDENTIFIER', row);
  return value;
}
function rows(tabs: Record<string, string[][]>, tab: string, expected: readonly string[]) {
  const table = tabs[tab];
  if (!table || !expected.every((key, index) => table[0]?.[index] === key)
    || table[0].slice(expected.length).some(Boolean)) fail('HEADERS', 1);
  return table.slice(1).flatMap((cells, index) => {
    if (!cells.some(Boolean)) return [];
    const extra = cells.slice(expected.length);
    // An older four-column Students writer left a duplicate status in E.
    // Admit only the exact duplicate; the full archive retains its coordinate.
    const duplicateStudentStatus = tab === 'Students' && expected.join('|') === 'studentId|name|balance|status'
      && extra[0] === cells[3] && ['ACTIVE', 'INACTIVE'].includes(cells[3]) && !extra.slice(1).some(Boolean);
    if (extra.some(Boolean) && !duplicateStudentStatus) fail('EXTRA_CELL', index + 2);
    return [{ rowNumber: index + 2, cells, values: Object.fromEntries(expected.map((key, i) => [key, cells[i] ?? ''])) }];
  });
}

/** Parse historical facts for the full-snapshot importer. This never executes a
 * historical command or creates a modern operation. Source acquisition, actor,
 * writer exclusion and activation are the calling migration service's job.
 *
 * Exact source rows are retained alongside the projections. In particular, an
 * ADMIN_ADJUSTMENT without an Adjustments counterpart remains an observed
 * transaction; this function does not invent its request or counterpart.
 */
export function parseLegacyFinancialHistory(gridJson: string, review?: LegacyFinancialReview): LegacyFinancialHistory {
  return parseFinancial(gridJson, review, false);
}
/** A read-only diagnostic report is not an import plan or approval. */
export function inspectLegacyFinancialDiscrepancies(gridJson: string) {
  const plan = parseFinancial(gridJson, undefined, true);
  return { sourceDigest: plan.sourceDigest, discrepancies: plan.discrepancies };
}
function parseFinancial(gridJson: string, review: LegacyFinancialReview | undefined, inspectOnly: boolean): LegacyFinancialHistory {
  const { tabs, contentSha256, spreadsheetId } = readOfflineGoogleGrid(gridJson);
  const schema = (tabs.Settings ?? []).slice(1).filter(row => row[0] === 'schemaVersion');
  // Existing Sheets installations keep their original version setting while
  // later releases append recurring-task columns. Validate each actual table;
  // do not rewrite the source version to pretend it came from a new template.
  if (schema.length !== 1 || !['1', '2', '3', '4'].includes(schema[0][1])) fail('SCHEMA', 1);
  const itemHeader = tabs.Transactions?.[0]?.[4];
  if (!['items', 'itemsJson', 'itemJson', 'products'].includes(itemHeader)) fail('HEADERS', 1);
  const sourceTransactionHeaders = transactionHeaders.map(key => key === 'items' ? itemHeader : key);
  const currentBalances: Record<string, number> = Object.create(null);
  const studentHeaders = tabs.Students?.[0]?.filter(Boolean) ?? [];
  if (!['studentId', 'name', 'balance'].every(key => studentHeaders.includes(key))
    || new Set(studentHeaders).size !== studentHeaders.length) fail('STUDENTS', 1);
  for (const { rowNumber, values } of rows(tabs, 'Students', studentHeaders)) {
    const studentId = id(values.studentId, rowNumber);
    if (Object.hasOwn(currentBalances, studentId)) fail('DUPLICATE_STUDENT', rowNumber);
    currentBalances[studentId] = integer(values.balance, rowNumber);
  }
  const firstRecordedBalances: Record<string, number> = Object.create(null);
  const last = new Map<string, { balance: number; timestamp: string; rowNumber: number; rowDigest: string }>();
  const byId = new Map<string, LegacyFinancialRecord>();
  const reversed = new Set<string>();
  let net = BigInt(0);
  const records: LegacyFinancialRecord[] = [];
  const discrepancies: LegacyFinancialDiscrepancy[] = [];
  for (const { rowNumber, cells, values } of rows(tabs, 'Transactions', sourceTransactionHeaders)) {
    const transactionId = id(values.transactionId, rowNumber), studentId = id(values.studentId, rowNumber);
    if (byId.has(transactionId)) fail('DUPLICATE_TRANSACTION', rowNumber);
    if (!Object.hasOwn(currentBalances, studentId)) fail('STUDENT_REFERENCE', rowNumber);
    if (!statuses.has(values.status)) fail('STATUS', rowNumber);
    if (!Number.isFinite(Date.parse(values.timestamp)) || new Date(values.timestamp).toISOString() !== values.timestamp) fail('TIMESTAMP', rowNumber);
    const before = integer(values.balanceBefore, rowNumber), after = integer(values.balanceAfter, rowNumber);
    const total = integer(values.totalAmount, rowNumber), delta = after - before;
    if (!Number.isSafeInteger(delta) || total !== -delta) fail('BALANCE_DELTA', rowNumber);
    const transaction = parseTransactionRow(cells, createHeaderIndex(sourceTransactionHeaders));
    if (!transaction || transaction.itemsMalformed || !transaction.items.length) fail('ITEMS', rowNumber);
    // The permissive legacy reader cannot silently discard malformed members.
    let rawItems: unknown;
    try { rawItems = JSON.parse(values[itemHeader]); } catch { fail('ITEMS', rowNumber); }
    if (!Array.isArray(rawItems) || rawItems.length !== transaction.items.length
      || canonicalJson(rawItems) !== canonicalJson(transaction.items)) fail('ITEMS', rowNumber);
    const itemTotal = transaction.items.reduce((sum, item) => sum + BigInt('finalTotal' in item ? item.finalTotal : item.subtotal), BigInt(0));
    if (itemTotal !== BigInt(total)) fail('ITEM_TOTAL', rowNumber);
    const previous = last.get(studentId);
    const rowDigest = sha256(canonicalJson({ tab: 'Transactions', rowNumber, cells }));
    if (previous && previous.timestamp > values.timestamp) fail('CHAIN', rowNumber);
    if (previous && previous.balance !== before) {
      const amount = before - previous.balance;
      if (!Number.isSafeInteger(amount)) fail('CHAIN', rowNumber);
      discrepancies.push({ code: 'BALANCE_CHAIN_GAP', rowNumber, rowDigest,
        previousRowNumber: previous.rowNumber, previousRowDigest: previous.rowDigest, amount });
    }
    if (!previous) firstRecordedBalances[studentId] = before;
    let reversesTransactionId: string | null = null;
    if (values.status === 'CANCEL_REVERSAL') {
      const prefix = ['cancel:', 'cancel-task:', 'cancel-task-unlinked:', 'cancel-task-pre-reset:']
        .find(candidate => values.operator.startsWith(candidate));
      if (!prefix) fail('CANCELLATION_VARIANT', rowNumber);
      reversesTransactionId = values.operator.slice(prefix.length);
      const original = byId.get(reversesTransactionId);
      if (!original || original.transaction.studentId !== studentId || original.transaction.status !== 'CANCELLED'
        || original.balanceDelta !== -delta || reversed.has(reversesTransactionId)) fail('CANCELLATION_LINK', rowNumber);
      if (prefix !== 'cancel:' && (original.transaction.operator !== 'bank' || original.balanceDelta <= 0)) {
        fail('CANCELLATION_VARIANT', rowNumber);
      }
      reversed.add(reversesTransactionId);
    }
    const record = { rowNumber, rowDigest,
      originalCells: [...cells], transaction, balanceDelta: delta, reversesTransactionId };
    records.push(record); byId.set(transactionId, record); last.set(studentId, { balance: after, timestamp: values.timestamp, rowNumber, rowDigest }); net += BigInt(delta);
  }
  for (const row of records) {
    if (row.transaction.status === 'CANCELLED' && !reversed.has(row.transaction.transactionId)) {
      discrepancies.push({ code: 'MISSING_REVERSAL', rowNumber: row.rowNumber, rowDigest: row.rowDigest,
        previousRowNumber: null, previousRowDigest: null, amount: row.balanceDelta });
    }
  }
  for (const [studentId, row] of last) {
    if (row.balance !== currentBalances[studentId]) fail('CURRENT_BALANCE', 0);
  }
  discrepancies.sort((a, b) => a.rowNumber - b.rowNumber || a.code.localeCompare(b.code));
  let checkedReview: LegacyFinancialReview | null = null;
  if (!inspectOnly && (discrepancies.length || review)) {
    if (!review || Object.keys(review).sort().join('|') !== 'approvalEvidenceDigest|approvedBySubjectDigest|discrepancies|policy|sourceIdentityDigest'
      || review.policy !== 'PRESERVE_RECORDED_BALANCES'
      || review.sourceIdentityDigest !== sha256(spreadsheetId)
      || !/^[a-f0-9]{64}$/.test(review.approvedBySubjectDigest)
      || !/^[a-f0-9]{64}$/.test(review.approvalEvidenceDigest)
      || canonicalJson(review.discrepancies) !== canonicalJson(discrepancies)) fail('REVIEW_REQUIRED', discrepancies[0]?.rowNumber ?? 0);
    checkedReview = JSON.parse(JSON.stringify(review)) as LegacyFinancialReview;
  }
  const result = { sourceDigest: contentSha256, records, currentBalances, firstRecordedBalances, netRecordedDelta: net.toString(), discrepancies, review: checkedReview };
  return { ...result, digest: sha256(canonicalJson(result)) };
}
