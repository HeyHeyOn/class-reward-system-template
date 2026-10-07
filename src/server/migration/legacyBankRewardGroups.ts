import 'server-only';
import type { TaskAssignment, TaskCompletion } from '@/domain/types';
import type { LegacyFinancialRecord } from './legacyFinancialHistory';
import { canonicalJson } from './validators';

type Event = { row: { rowNumber: number }; event: TaskCompletion };
export type LegacyBankRewardGroup = Readonly<{
  checkpointRows: number[];
  transactionId: string;
  historicalOperation?: { id: string; hash: string };
}>;
function fail(): never { throw new Error('LEGACY_TASK_BANK_CHECKPOINTS'); }

/** Recognize both deployed reward writers. An older writer persisted one
 * SUCCESS and TASK-<completion ID>; the later writer persisted three
 * checkpoints and TASK-LOGICAL-<logical ID>. Neither becomes a new command.
 * Financial continuity is validated separately before this function is called.
 */
export function parseLegacyBankRewardGroups(input: Readonly<{
  events: readonly Event[];
  assignments: ReadonlyMap<string, TaskAssignment>;
  financial: readonly LegacyFinancialRecord[];
}>): LegacyBankRewardGroup[] {
  const operations = new Map<string, Event[]>();
  const singles: Event[] = [];
  for (const entry of input.events) {
    const e = entry.event;
    if (e.source !== 'BANK') continue;
    if (!e.operationId) singles.push(entry);
    else {
      if (e.operationId.length > 4096 || e.operationId.trim() !== e.operationId
        || /[\p{Cc}\p{Cs}]/u.test(e.operationId)) fail();
      const group = operations.get(e.operationId) ?? [];
      group.push(entry); operations.set(e.operationId, group);
    }
  }
  const groups: LegacyBankRewardGroup[] = [];
  const ledgerIds = new Set<string>();
  const shared = (e: TaskCompletion) => {
    const { completionId: _id, status: _status, note: _note, ...rest } = e;
    void _id; void _status; void _note;
    return canonicalJson(rest);
  };
  const bind = (entries: Event[], transactionId: string, operation?: { id: string; hash: string }) => {
    const e = entries.at(-1)!.event, a = input.assignments.get(e.assignmentId ?? '');
    if (!a || a.status !== 'ASSIGNED' || a.createdAt > e.timestamp
      || a.taskId !== e.taskId || a.taskInstanceId !== e.taskInstanceId || a.studentId !== e.studentId
      || a.cycleId !== e.cycleId || a.ruleVersion !== e.ruleVersion || a.timeZone !== e.timeZone
      || Date.parse(a.cycleStartsAt) !== Date.parse(e.cycleStartsAt ?? '')
      || (a.cycleEndsAt === null ? e.cycleEndsAt !== null : Date.parse(a.cycleEndsAt) !== Date.parse(e.cycleEndsAt ?? ''))
      || e.reward <= 0 || e.balanceAfter !== e.balanceBefore + e.reward || e.status !== 'SUCCESS') fail();
    const matches = input.financial.filter(row => row.transaction.transactionId === transactionId);
    const ledger = matches[0]?.transaction, item = ledger?.items[0];
    if (matches.length !== 1 || ledgerIds.has(transactionId) || !ledger
      || !['TASK_REWARD', 'CANCELLED'].includes(ledger.status) || ledger.operator !== 'bank'
      || ledger.timestamp !== e.timestamp || ledger.studentId !== e.studentId || ledger.studentName !== e.studentName
      || ledger.totalAmount !== -e.reward || ledger.balanceBefore !== e.balanceBefore || ledger.balanceAfter !== e.balanceAfter
      || ledger.items.length !== 1 || !item || item.productId !== e.taskId || !item.name.trim()
      || item.quantity !== 1 || item.price !== -e.reward || item.subtotal !== -e.reward) fail();
    ledgerIds.add(transactionId);
    groups.push({ checkpointRows: entries.map(entry => entry.row.rowNumber), transactionId,
      ...(operation ? { historicalOperation: operation } : {}) });
  };
  for (const entry of singles) {
    if (entry.event.operationPayloadHash || entry.event.status !== 'SUCCESS') fail();
    bind([entry], `TASK-${entry.event.completionId}`);
  }
  const statuses = ['PENDING', 'BALANCE_APPLIED', 'SUCCESS'];
  for (const [operationId, entries] of operations) {
    const first = entries[0].event, logicalId = first.completionId.replace(/-PENDING$/, '');
    if (entries.length !== 3 || logicalId === first.completionId || !logicalId
      || !/^sha256:[a-f0-9]{64}$/.test(first.operationPayloadHash ?? '')
      || input.events.some(entry => entry.event.operationId === operationId && entry.event.source !== 'BANK')
      || entries.some((entry, i) => entry.event.status !== statuses[i]
        || entry.event.completionId !== `${logicalId}-${statuses[i]}` || shared(entry.event) !== shared(first))) fail();
    bind(entries, `TASK-LOGICAL-${encodeURIComponent(logicalId)}`, { id: operationId, hash: first.operationPayloadHash! });
  }
  return groups;
}
