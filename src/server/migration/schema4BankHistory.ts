import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { loadTaskCycleLedgerSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
import { readOfflineGoogleGrid } from './offlineGoogleGrid';
import { canonicalJson } from './validators';

// Development-only historical contract. No production runner, migration authority,
// account mutation, UUID minting, claim publication or modern operation binding.
export type HistoryDiagnostic = { code: string; tab: string; rowNumber: number };
export type HistorySourceRow = { tab: string; rowNumber: number; cells: string[]; digest: string };
export type BankHistoryGroup = {
  operationId: string; operationPayloadHash: string; transactionId: string;
  checkpointRows: number[]; assignmentRow: number; transactionRow: number; laterResetRows: number[];
  reward: number; signedTotal: number; balanceBefore: number; balanceAfter: number;
};
export type BankHistoryPlan = {
  authority: 'OFFLINE_NONAUTHORITY'; sourceDigest: string; sources: HistorySourceRow[];
  groups: BankHistoryGroup[]; diagnostics: HistoryDiagnostic[];
};
type Row = { rowNumber: number; values: Record<string, string> };
type Runner = <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;
type ReadInput = { tenantId: string; sourceDigest: string; runTransaction: Runner };
const tuple = ['taskId', 'taskInstanceId', 'studentId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone'];
const statuses = ['PENDING', 'BALANCE_APPLIED', 'SUCCESS'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const identical = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const identifier = (value: string | undefined) => Boolean(value && value.length <= 4096 && value.trim() === value);
const integer = (value: string | undefined): number | null => value !== undefined && /^-?(0|[1-9][0-9]*)$/.test(value)
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const instant = (value: string | undefined) => Boolean(value && Number.isFinite(Date.parse(value)) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value));

/** Retains every source row, including unrelated invalid rows. Groups are only a
 * proved historical reward view, NOT an alternate READY_FOR_IMPORT manifest. */
export function normalizeSchema4BankHistory(gridJson: string): BankHistoryPlan {
  const { tabs, contentSha256 } = readOfflineGoogleGrid(gridJson);
  const sources: HistorySourceRow[] = [];
  const tables: Record<string, Row[]> = Object.create(null);
  for (const [tab, rows] of Object.entries(tabs)) {
    const headers = rows[0] ?? [];
    if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('BANK_HISTORY_AMBIGUOUS_HEADER');
    tables[tab] = [];
    rows.forEach((cells, index) => {
      sources.push({ tab, rowNumber: index + 1, cells: [...cells], digest: digest(canonicalJson({ tab, rowNumber: index + 1, cells })) });
      if (index > 0 && cells.some(Boolean)) tables[tab].push({ rowNumber: index + 1,
        values: Object.fromEntries(headers.filter(Boolean).map(key => [key, cells[headers.indexOf(key)] ?? ''])) });
    });
  }
  const versions = (tabs.Settings ?? []).slice(1).filter(row => row[0] === 'schemaVersion');
  if (versions.length !== 1 || versions[0][1] !== '4') throw new Error('BANK_HISTORY_REQUIRES_SCHEMA4');
  for (const name of ['TaskCompletions', 'TaskAssignments', 'Transactions']) {
    if (!tabs[name]?.length) throw new Error('BANK_HISTORY_MISSING_TABLE');
  }
  const completions = tables.TaskCompletions, assignments = tables.TaskAssignments, transactions = tables.Transactions;
  const diagnostics: HistoryDiagnostic[] = [];
  const add = (code: string, tab: string, rowNumber: number) => diagnostics.push({ code, tab, rowNumber });
  // Missing admin authority is not repaired by chronology, a BANK match or a
  // sha256-shaped legacy operation. Keep the reset in the observed reader.
  for (const row of completions) {
    if (row.values.source === 'ADMIN_RESET') add('UNPROVEN_ADMIN_RESET_OPERATION', 'TaskCompletions', row.rowNumber);
    else if (row.values.source === 'ADMIN') add('UNPROVEN_ADMIN_COMPLETION_OPERATION', 'TaskCompletions', row.rowNumber);
  }
  for (const row of assignments) {
    if (row.values.source === 'ADMIN' || row.values.source === 'QR') add('UNPROVEN_ADMIN_ASSIGNMENT_OPERATION', 'TaskAssignments', row.rowNumber);
  }
  const byOperation = new Map<string, Row[]>();
  for (const row of completions.filter(row => row.values.source === 'BANK')) {
    const operationId = row.values.operationId;
    if (!identifier(operationId)) { add('BANK_OPERATION_MISSING', 'TaskCompletions', row.rowNumber); continue; }
    const events = byOperation.get(operationId) ?? [];
    events.push(row); byOperation.set(operationId, events);
  }
  const groups: BankHistoryGroup[] = [];
  for (const [operationId, events] of byOperation) {
    const invalid = (code: string) => events.forEach(row => add(code, 'TaskCompletions', row.rowNumber));
    if (completions.some(row => row.values.operationId === operationId && row.values.source !== 'BANK')) {
      invalid('BANK_OPERATION_REUSED'); continue;
    }
    const first = events[0].values;
    const logicalId = first.completionId?.replace(/-PENDING$/, '');
    const hash = first.operationPayloadHash;
    const sharedKeys = (tabs.TaskCompletions[0] ?? []).filter(key => key && !['completionId', 'status', 'note'].includes(key));
    const reward = integer(first.reward), before = integer(first.balanceBefore), after = integer(first.balanceAfter);
    const validShape = events.length === 3 && logicalId && first.completionId.endsWith('-PENDING')
      && /^sha256:[a-f0-9]{64}$/.test(hash ?? '')
      && reward !== null && reward > 0 && before !== null && after !== null
      && Number.isSafeInteger(before + reward) && before + reward === after
      && ['completionId', 'assignmentId', 'taskId', 'taskInstanceId', 'studentId', 'studentName', 'cycleId'].every(key => identifier(first[key]))
      && first.schemaVersion === '2' && first.timeZone === 'Asia/Seoul'
      && (integer(first.ruleVersion) ?? 0) > 0 && instant(first.timestamp) && instant(first.cycleStartsAt)
      && Date.parse(first.timestamp) >= Date.parse(first.cycleStartsAt)
      && (!first.cycleEndsAt || (instant(first.cycleEndsAt) && Date.parse(first.cycleEndsAt) > Date.parse(first.timestamp)))
      && !Object.keys(first).some(key => key.startsWith('evidence') && first[key])
      && events.every((row, index) => row.values.status === statuses[index]
        && row.values.completionId === `${logicalId}-${statuses[index]}`
        && sharedKeys.every(key => row.values[key] === first[key])
        && completions.filter(other => other.values.completionId === row.values.completionId).length === 1);
    if (!validShape) { invalid('BANK_CHECKPOINT_GROUP_UNPROVEN'); continue; }
    const matchingAssignments = assignments.filter(row => row.values.assignmentId === first.assignmentId);
    const assignment = matchingAssignments[0]?.values;
    if (matchingAssignments.length !== 1 || assignment.status !== 'ASSIGNED' || assignment.source !== 'LEGACY_SEED'
      || assignment.schemaVersion !== '2' || assignment.previousAssignmentId
      || !instant(assignment.createdAt) || Date.parse(assignment.createdAt) > Date.parse(first.timestamp)
      || !tuple.every(key => assignment[key] === first[key])) {
      invalid('BANK_ASSIGNMENT_PROVENANCE_UNPROVEN'); continue;
    }
    const transactionId = `TASK-LOGICAL-${encodeURIComponent(logicalId!)}`;
    const ledgers = transactions.filter(row => row.values.transactionId === transactionId);
    const ledger = ledgers[0]?.values;
    let items: unknown;
    try { items = JSON.parse(ledger?.items ?? 'null'); } catch { items = null; }
    const line = Array.isArray(items) && items.length === 1 ? items[0] : null;
    if (ledgers.length !== 1 || !line || typeof line !== 'object'
      || ledger.status !== 'TASK_REWARD' || ledger.operator !== 'bank'
      || ledger.timestamp !== first.timestamp || ledger.studentId !== first.studentId || ledger.studentName !== first.studentName
      || integer(ledger.totalAmount) !== -reward! || integer(ledger.balanceBefore) !== before || integer(ledger.balanceAfter) !== after
      || line.productId !== first.taskId || !identifier(line.name) || line.price !== -reward! || line.quantity !== 1 || line.subtotal !== -reward!) {
      invalid('BANK_SIGNED_LEDGER_UNPROVEN'); continue;
    }
    if (transactions.some(row => row.values.status === 'CANCEL_REVERSAL' && row.values.operator?.includes(transactionId))) {
      invalid('BANK_CANCELLATION_RELATION_UNPROVEN'); continue;
    }
    groups.push({ operationId, operationPayloadHash: hash, transactionId,
      checkpointRows: events.map(row => row.rowNumber), assignmentRow: matchingAssignments[0].rowNumber,
      transactionRow: ledgers[0].rowNumber,
      laterResetRows: completions.filter(row => row.rowNumber > events[2].rowNumber && row.values.source === 'ADMIN_RESET'
        && tuple.every(key => row.values[key] === first[key]) && row.values.assignmentId === first.assignmentId).map(row => row.rowNumber),
      reward: reward!, signedTotal: -reward!, balanceBefore: before!, balanceAfter: after! });
  }
  // Distinct legacy operations cannot each publish the same historical ledger.
  const duplicateLedgers = new Set(groups.filter(group => groups.filter(other => other.transactionId === group.transactionId).length > 1).map(group => group.transactionId));
  for (const group of groups.filter(group => duplicateLedgers.has(group.transactionId))) {
    group.checkpointRows.forEach(row => add('BANK_LEDGER_REUSED', 'TaskCompletions', row));
  }
  return { authority: 'OFFLINE_NONAUTHORITY', sourceDigest: contentSha256, sources,
    groups: groups.filter(group => !duplicateLedgers.has(group.transactionId)), diagnostics };
}

/** A historical replay answers ONLY whether this exact operation was already
 * paid. It does not authorize a new reward, even after an unproven admin reset. */
export function replaySchema4BankReward(plan: BankHistoryPlan, operationId: string, operationPayloadHash: string) {
  const group = plan.groups.find(group => group.operationId === operationId);
  if (!group) throw new Error('BANK_REPLAY_UNPROVEN');
  if (group.operationPayloadHash !== operationPayloadHash) throw new Error('BANK_REPLAY_CONFLICT');
  return { kind: 'HISTORICAL_REWARD_ALREADY_RECORDED' as const, changed: false as const, rewardToApply: 0,
    transactionRow: group.transactionRow, successRow: group.checkpointRows[2], currentStateAuthority: 'BLOCKED' as const };
}

/** Explicit isolated runner only. The DDL lives in test-support, outside normal
 * migrations, so this module cannot silently weaken the production reader. */
export async function importSchema4BankHistory(input: { tenantId: string; gridJson: string; runTransaction: Runner }) {
  if (typeof input.runTransaction !== 'function') throw new Error('BANK_HISTORY_ISOLATED_RUNNER_REQUIRED');
  const plan = normalizeSchema4BankHistory(input.gridJson);
  // Preserve malformed evidence in the returned plan, but never claim its import.
  if (!plan.groups.length || plan.diagnostics.some(row => row.code.startsWith('BANK_'))) throw new Error('BANK_HISTORY_GROUP_BLOCKED');
  return input.runTransaction(input.tenantId, async tx => {
    const { tenantId } = input;
    await tx.execute(sql`INSERT INTO schema4_history.captures (tenant_id, source_digest, grid_json)
      VALUES (${tenantId}, ${plan.sourceDigest}, ${input.gridJson}) ON CONFLICT DO NOTHING`);
    for (const source of plan.sources) {
      await tx.execute(sql`INSERT INTO schema4_history.source_rows (tenant_id, source_digest, tab, row_number, row_digest, cells)
        VALUES (${tenantId}, ${plan.sourceDigest}, ${source.tab}, ${source.rowNumber}, ${source.digest}, ${JSON.stringify(source.cells)}::jsonb)
        ON CONFLICT DO NOTHING`);
    }
    for (const group of plan.groups) {
      await tx.execute(sql`INSERT INTO schema4_history.reward_groups
        (tenant_id, source_digest, operation_id, transaction_id, payload, reward, signed_total, balance_before, balance_after)
        VALUES (${tenantId}, ${plan.sourceDigest}, ${group.operationId}, ${group.transactionId}, ${JSON.stringify(group)}::jsonb,
          ${group.reward}, ${group.signedTotal}, ${group.balanceBefore}, ${group.balanceAfter}) ON CONFLICT DO NOTHING`);
    }
    // Retry is successful only after exact read-back, not just ON CONFLICT.
    const stored = await readStored(tx, tenantId, plan.sourceDigest);
    if (!identical(stored.plan, plan)) throw new Error('BANK_HISTORY_IMPORT_CONFLICT');
    return { authority: plan.authority, sourceDigest: plan.sourceDigest, sourceRows: plan.sources.length,
      checkpoints: plan.groups.length * 3, rewardLedgers: plan.groups.length, currentStateAuthority: 'BLOCKED' as const };
  });
}

export async function readSchema4BankHistory(input: ReadInput) {
  if (typeof input.runTransaction !== 'function') throw new Error('BANK_HISTORY_ISOLATED_RUNNER_REQUIRED');
  return input.runTransaction(input.tenantId, tx => readStored(tx, input.tenantId, input.sourceDigest));
}

async function readStored(tx: TenantTransaction, tenantId: string, sourceDigest: string) {
  const captures = await tx.execute(sql`SELECT grid_json FROM schema4_history.captures
    WHERE tenant_id=${tenantId} AND source_digest=${sourceDigest}`);
  if (captures.rows.length !== 1) throw new Error('BANK_HISTORY_NOT_FOUND');
  const wire = captures.rows[0].grid_json;
  if (typeof wire !== 'string' || digest(wire) !== sourceDigest) throw new Error('BANK_HISTORY_SOURCE_CONFLICT');
  const plan = normalizeSchema4BankHistory(wire);
  const sourceRows = await tx.execute(sql`SELECT tab, row_number, row_digest, cells FROM schema4_history.source_rows
    WHERE tenant_id=${tenantId} AND source_digest=${sourceDigest}`);
  const storedSources = new Map(sourceRows.rows.map(row => [`${row.tab}:${row.row_number}`, row]));
  if (storedSources.size !== plan.sources.length || plan.sources.some(source => {
    const row = storedSources.get(`${source.tab}:${source.rowNumber}`);
    return !row || row.row_digest !== source.digest || !identical(row.cells, source.cells);
  })) throw new Error('BANK_HISTORY_SOURCE_CONFLICT');
  const groups = await tx.execute(sql`SELECT operation_id, transaction_id, payload, reward, signed_total, balance_before, balance_after
    FROM schema4_history.reward_groups WHERE tenant_id=${tenantId} AND source_digest=${sourceDigest}`);
  if (groups.rows.length !== plan.groups.length || plan.groups.some(group => {
    const row = groups.rows.find(row => row.operation_id === group.operationId);
    return !row || row.transaction_id !== group.transactionId || !identical(row.payload, group)
      || Number(row.reward) !== group.reward || Number(row.signed_total) !== group.signedTotal
      || Number(row.balance_before) !== group.balanceBefore || Number(row.balance_after) !== group.balanceAfter;
  })) throw new Error('BANK_HISTORY_GROUP_CONFLICT');
  const { tabs } = readOfflineGoogleGrid(wire);
  const snapshot = await loadTaskCycleLedgerSnapshot({ getRows: async name => tabs[name] ?? [] });
  // Existing Sheets parsers are intentionally reused for their physical-row
  // semantics, but their permissive omission must not hide malformed rows here.
  const nonempty = (name: string) => tabs[name].slice(1).filter(row => row.some(Boolean)).length;
  if (snapshot.assignments.length !== nonempty('TaskAssignments') || snapshot.completions.length !== nonempty('TaskCompletions')) {
    throw new Error('BANK_HISTORY_READER_ROW_LOSS');
  }
  return { plan, snapshot, currentStateAuthority: 'BLOCKED' as const };
}
