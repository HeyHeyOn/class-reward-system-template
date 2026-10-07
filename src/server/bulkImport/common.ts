import 'server-only';

import type { BulkImportIssue } from '@/lib/bulkImport';

export function fileNotices(
  sheetName: string,
  preferredSheetName: string,
  examples: number,
  ignoredHeaders: ReadonlyArray<string>,
): string[] {
  const notices: string[] = [];
  if (sheetName.trim() !== preferredSheetName) notices.push(`'${sheetName}' 시트를 읽었어요.`);
  if (examples > 0) notices.push(`양식의 예시 줄 ${examples}개는 건너뛰었어요.`);
  if (ignoredHeaders.length) {
    const shown = ignoredHeaders.slice(0, 5).map((label) => `'${label}'`).join(', ');
    notices.push(`모르는 열(${shown}${ignoredHeaders.length > 5 ? ' 등' : ''})은 읽지 않았어요.`);
  }
  return notices;
}

/** Orders issues by spreadsheet row, keeping the original order within a row. */
export function sortIssues(issues: ReadonlyArray<BulkImportIssue>): BulkImportIssue[] {
  return issues.map((issue, index) => ({ issue, index }))
    .sort((left, right) => (left.issue.rowNumber ?? 0) - (right.issue.rowNumber ?? 0) || left.index - right.index)
    .map(({ issue }) => issue);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

export function rowList(rowNumbers: ReadonlyArray<number>): string {
  return rowNumbers.map((rowNumber) => `${rowNumber}행`).join(', ');
}
