import 'server-only';

import type { Transaction } from '@/domain/types';
import { ADMIN_TRANSACTION_PAGE_SIZE, type TransactionPage, type TransactionPageRequest } from '@/lib/transactionHistory';

export class TransactionPageRequestError extends Error {}

function invalid(): never {
  throw new TransactionPageRequestError('거래 조회 조건이 올바르지 않습니다.');
}

function validDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateTransactionPageRequest(request: TransactionPageRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
    || !['all', 'income', 'expense'].includes(request.direction)
    || typeof request.query !== 'string' || request.query.length > 100 || request.query !== request.query.trim()
    || typeof request.studentId !== 'string' || request.studentId.length > 100 || request.studentId !== request.studentId.trim()
    || typeof request.from !== 'string' || !validDate(request.from)
    || typeof request.through !== 'string' || !validDate(request.through)
    || (request.from && request.through && request.from > request.through)
    || (request.cursor !== null && (typeof request.cursor !== 'string' || request.cursor.length > 2048))) invalid();
}

export function parseTransactionPageRequest(params: URLSearchParams): TransactionPageRequest {
  for (const key of ['limit', 'direction', 'query', 'studentId', 'from', 'through', 'cursor']) {
    if (params.getAll(key).length > 1) invalid();
  }
  const limit = params.get('limit');
  if (limit !== null && !/^\d{1,3}$/.test(limit)) invalid();
  const request: TransactionPageRequest = {
    limit: limit === null ? ADMIN_TRANSACTION_PAGE_SIZE : Number(limit),
    direction: (params.get('direction') ?? 'all') as TransactionPageRequest['direction'],
    query: (params.get('query') ?? '').trim(),
    studentId: (params.get('studentId') ?? '').trim(),
    from: params.get('from') ?? '', through: params.get('through') ?? '',
    cursor: params.get('cursor'),
  };
  validateTransactionPageRequest(request);
  return request;
}

type Cursor = { source: 'postgresql' | 'sheets'; at: string; key: string; filter: string };
const filterKey = ({ direction, query, studentId, from, through }: TransactionPageRequest) =>
  JSON.stringify([direction, query, studentId, from, through]);

export function encodeTransactionCursor(source: Cursor['source'], at: string, key: string, request: TransactionPageRequest): string {
  return Buffer.from(JSON.stringify({ source, at, key, filter: filterKey(request) })).toString('base64url');
}

export function readTransactionCursor(request: TransactionPageRequest, source: Cursor['source']): Cursor | null {
  validateTransactionPageRequest(request);
  if (request.cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(request.cursor)) invalid();
    const value = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as Cursor;
    if (!value || value.source !== source || value.filter !== filterKey(request)
      || typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value.at)
      || !Number.isFinite(Date.parse(value.at)) || typeof value.key !== 'string' || !value.key || value.key.length > 200) invalid();
    if (source === 'postgresql' && (!/^[1-9]\d{0,18}$/.test(value.key) || BigInt(value.key) > BigInt('9223372036854775807'))) invalid();
    return value;
  } catch {
    return invalid();
  }
}

/** Sheets still reads its existing table, but optional paged callers receive the same bounded contract. */
export function pageSheetTransactions(transactions: Transaction[], request: TransactionPageRequest): TransactionPage {
  const cursor = readTransactionCursor(request, 'sheets');
  const from = request.from ? Date.parse(`${request.from}T00:00:00+09:00`) : -Infinity;
  const through = request.through ? Date.parse(`${request.through}T00:00:00+09:00`) + 86_400_000 : Infinity;
  const needle = request.query.toLowerCase();
  const filtered = transactions.filter((transaction) => {
    const delta = transaction.balanceAfter - transaction.balanceBefore;
    return (!request.studentId || transaction.studentId === request.studentId)
      && (request.direction === 'all' || (delta > 0 ? 'income' : 'expense') === request.direction)
      && Date.parse(transaction.timestamp) >= from && Date.parse(transaction.timestamp) < through
      && (!needle || `${transaction.studentName} ${transaction.studentId}`.toLowerCase().includes(needle)
        || transaction.items.some((item) => item.name.toLowerCase().includes(needle)));
  }).sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
    || (left.transactionId < right.transactionId ? -1 : left.transactionId > right.transactionId ? 1 : 0));
  const totals = { count: filtered.length, income: 0, expense: 0 };
  for (const transaction of filtered) {
    if (transaction.status === 'CANCELLED' || transaction.status === 'CANCEL_REVERSAL') continue;
    const delta = transaction.balanceAfter - transaction.balanceBefore;
    if (delta > 0) totals.income += delta; else totals.expense -= delta;
  }
  if (![totals.income, totals.expense].every(Number.isSafeInteger)) throw new Error('Transaction totals exceed safe range.');
  const remaining = cursor ? filtered.filter((row) => Date.parse(row.timestamp) < Date.parse(cursor.at)
    || (Date.parse(row.timestamp) === Date.parse(cursor.at) && row.transactionId > cursor.key)) : filtered;
  const page = remaining.slice(0, request.limit);
  const last = page.at(-1);
  return { transactions: page, totals,
    nextCursor: remaining.length > page.length && last ? encodeTransactionCursor('sheets', last.timestamp, last.transactionId, request) : null };
}
