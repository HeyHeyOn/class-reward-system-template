import type { BulkImportErrorCode, BulkImportIssue } from '@/lib/bulkImport';

/** A problem with the uploaded file as a whole (format, size, missing headers, too many rows). */
export class BulkImportFileError extends Error {
  constructor(
    readonly code: Extract<BulkImportErrorCode,
      'INVALID_FILE' | 'FILE_TOO_LARGE' | 'NO_MATCHING_SHEET' | 'TOO_MANY_ROWS' | 'NO_ROWS'>,
    message: string,
  ) {
    super(message);
    this.name = 'BulkImportFileError';
  }
}

/** The commit could not be applied; nothing was written. */
export class BulkImportCommitError extends Error {
  constructor(
    readonly code: Extract<BulkImportErrorCode, 'VALIDATION_FAILED' | 'OPERATION_CONFLICT'>,
    message: string,
    readonly issues: ReadonlyArray<BulkImportIssue> = [],
  ) {
    super(message);
    this.name = 'BulkImportCommitError';
  }
}

/** The configured storage cannot run bulk imports (legacy unscoped Google Sheets mode). */
export class BulkImportUnsupportedError extends Error {
  constructor() {
    super('엑셀 일괄 추가는 이 학급에서 사용할 수 없어요.');
    this.name = 'BulkImportUnsupportedError';
  }
}

/** Walks an error's cause chain for a PostgreSQL SQLSTATE. */
export function sqlStateOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
