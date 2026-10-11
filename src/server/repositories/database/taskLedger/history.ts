import 'server-only';

import type { TaskHistoryCause } from '@/lib/taskLedgerApi';
import { TEACHER_REWARD_NOTE } from './reward';
import type { LedgerEventRow } from './store';

/**
 * Why a row was written, for the teacher. `null` hides it: carried states (the move to the
 * ledger, old per-cycle copies) are bookkeeping, not something that happened.
 */
export function historyCause(event: LedgerEventRow): TaskHistoryCause | null {
  const prefix = event.id.split(':', 1)[0];
  if (event.table === 'A') {
    if (event.source === 'QR' || prefix === 'tl-q') return 'QR';
    if (event.source === 'LEGACY_SEED') return 'IMPORTED';
    if (event.source === 'CARRY_FORWARD') return prefix === 'tl-s' ? 'AUTO_RESET' : null;
    if (prefix === 'tl-p') return 'PADLET';
    return prefix === 'tl-r' ? 'RESET' : 'TEACHER';
  }
  if (event.kind === 'UNCOMPLETED') return event.transactionId ? 'CANCELLED' : 'RESET';
  if (event.source === 'BANK') return event.note === TEACHER_REWARD_NOTE ? 'TEACHER' : 'BANK';
  if (event.source === 'CARRY_FORWARD') return prefix === 'tl-cs' ? 'AUTO_RESET' : null;
  if (event.source === 'ADMIN') return prefix === 'tl-cr' ? 'RESET' : prefix === 'tl-cq' ? 'QR' : 'TEACHER';
  return 'IMPORTED';
}

/** Indexed history pages, including automatic resets at a frozen snapshot time. */
export { readTaskHistoryPage as readTaskLedgerHistory } from './historyQueries';
