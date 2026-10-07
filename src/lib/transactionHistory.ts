import type { Transaction } from '@/domain/types';

export const ADMIN_TRANSACTION_PAGE_SIZE = 50;
export type TransactionDirection = 'all' | 'income' | 'expense';

export type TransactionPageRequest = Readonly<{
  limit: number;
  direction: TransactionDirection;
  query: string;
  studentId: string;
  /** Inclusive calendar dates in Asia/Seoul; empty means no bound. */
  from: string;
  through: string;
  cursor: string | null;
}>;

export type TransactionPage = Readonly<{
  transactions: Transaction[];
  nextCursor: string | null;
  /** Totals for the entire matching set, independent of the current page. */
  totals: { count: number; income: number; expense: number };
}>;
