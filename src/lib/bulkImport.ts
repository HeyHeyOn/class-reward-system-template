// Shared (client + server) contract for the admin xlsx bulk import of students and products.
// Server modules own parsing/validation; this file only holds limits, DTO shapes and the
// client-side response guards, so it must stay free of server-only imports.

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Largest accepted upload (bytes). */
export const BULK_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Most data rows one upload may add (template example rows are not counted). */
export const BULK_IMPORT_MAX_ROWS = 200;
/** Largest commit JSON body (bytes); 200 product rows with long image URLs stay well below this. */
export const BULK_IMPORT_MAX_COMMIT_BYTES = 1024 * 1024;

export const BULK_IMPORT_TEXT_LIMITS = {
  studentId: 50,
  studentName: 50,
  productName: 60,
  category: 30,
  imageUrl: 2000,
} as const;

export type BulkImportKind = 'students' | 'products';

export type BulkImportIssue = Readonly<{
  /** Spreadsheet row number as the teacher sees it in Excel; null for file-level issues. */
  rowNumber: number | null;
  /** Column label shown to the teacher, or null when the issue concerns the whole row. */
  column: string | null;
  message: string;
}>;

export type StudentImportRow = Readonly<{
  rowNumber: number;
  studentId: string;
  name: string;
  balance: number;
}>;

export type ProductImportRow = Readonly<{
  rowNumber: number;
  name: string;
  price: number;
  stock: number;
  category: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}>;

export type BulkImportPreview<TRow> = Readonly<{
  ok: true;
  kind: BulkImportKind;
  sheetName: string;
  /** Rows that passed every check and will be created on confirm. */
  rows: ReadonlyArray<TRow>;
  /** Per-row problems; rows listed here are not part of `rows`. */
  errors: ReadonlyArray<BulkImportIssue>;
  /** Friendly remarks (skipped example rows, ignored columns, …). */
  notices: ReadonlyArray<string>;
  /** Non-empty data rows read from the sheet (examples excluded). */
  readRowCount: number;
}>;

export type StudentImportPreview = BulkImportPreview<StudentImportRow>;
export type ProductImportPreview = BulkImportPreview<ProductImportRow>;

export type StudentImportCreated = Readonly<{
  rowNumber: number;
  studentId: string;
  name: string;
  balance: number;
}>;

export type ProductImportCreated = Readonly<{
  rowNumber: number;
  productId: string;
  name: string;
}>;

export type BulkImportCommitResult<TItem> = Readonly<{
  ok: true;
  kind: BulkImportKind;
  operationId: string;
  created: number;
  /** True when this request repeated an import that had already been committed. */
  replayed: boolean;
  items: ReadonlyArray<TItem>;
}>;

export type StudentImportCommitResult = BulkImportCommitResult<StudentImportCreated>;
export type ProductImportCommitResult = BulkImportCommitResult<ProductImportCreated>;

export type BulkImportCommitRequest<TRow> = Readonly<{
  operationId: string;
  rows: ReadonlyArray<TRow>;
}>;

export type BulkImportErrorCode =
  | 'ADMIN_REQUIRED'
  | 'UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILE'
  | 'NO_MATCHING_SHEET'
  | 'TOO_MANY_ROWS'
  | 'NO_ROWS'
  | 'VALIDATION_FAILED'
  | 'OPERATION_CONFLICT'
  | 'OUTCOME_UNCERTAIN'
  | 'INTERNAL';

export type BulkImportFailure = Readonly<{
  ok: false;
  code: BulkImportErrorCode;
  error: string;
  errors?: ReadonlyArray<BulkImportIssue>;
}>;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalOperationId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

/* ------------------------------------------------------------------ */
/* Response guards (client side; tolerate nothing unexpected)         */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRowNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isIssue(value: unknown): value is BulkImportIssue {
  return isRecord(value)
    && (value.rowNumber === null || isRowNumber(value.rowNumber))
    && (value.column === null || typeof value.column === 'string')
    && typeof value.message === 'string';
}

function isStudentRow(value: unknown): value is StudentImportRow {
  return isRecord(value)
    && isRowNumber(value.rowNumber)
    && typeof value.studentId === 'string'
    && typeof value.name === 'string'
    && Number.isSafeInteger(value.balance);
}

function isProductRow(value: unknown): value is ProductImportRow {
  return isRecord(value)
    && isRowNumber(value.rowNumber)
    && typeof value.name === 'string'
    && Number.isSafeInteger(value.price)
    && Number.isSafeInteger(value.stock)
    && (value.category === null || typeof value.category === 'string')
    && (value.imageUrl === null || typeof value.imageUrl === 'string')
    && Number.isSafeInteger(value.sortOrder)
    && typeof value.isActive === 'boolean';
}

function parsePreview<TRow>(
  value: unknown,
  kind: BulkImportKind,
  isRow: (row: unknown) => row is TRow,
): BulkImportPreview<TRow> | null {
  if (!isRecord(value) || value.ok !== true || value.kind !== kind
    || typeof value.sheetName !== 'string'
    || !Array.isArray(value.rows) || !value.rows.every(isRow)
    || !Array.isArray(value.errors) || !value.errors.every(isIssue)
    || !Array.isArray(value.notices) || !value.notices.every((notice) => typeof notice === 'string')
    || !Number.isSafeInteger(value.readRowCount)) {
    return null;
  }
  return value as unknown as BulkImportPreview<TRow>;
}

export function parseStudentImportPreview(value: unknown): StudentImportPreview | null {
  return parsePreview(value, 'students', isStudentRow);
}

export function parseProductImportPreview(value: unknown): ProductImportPreview | null {
  return parsePreview(value, 'products', isProductRow);
}

function parseCommit<TItem>(
  value: unknown,
  kind: BulkImportKind,
  isItem: (item: unknown) => item is TItem,
): BulkImportCommitResult<TItem> | null {
  if (!isRecord(value) || value.ok !== true || value.kind !== kind
    || !isCanonicalOperationId(value.operationId)
    || !Number.isSafeInteger(value.created) || (value.created as number) < 0
    || typeof value.replayed !== 'boolean'
    || !Array.isArray(value.items) || value.items.length !== value.created
    || !value.items.every(isItem)) {
    return null;
  }
  return value as unknown as BulkImportCommitResult<TItem>;
}

export function parseStudentImportCommitResult(value: unknown): StudentImportCommitResult | null {
  return parseCommit(value, 'students', (item): item is StudentImportCreated => isRecord(item)
    && isRowNumber(item.rowNumber) && typeof item.studentId === 'string'
    && typeof item.name === 'string' && Number.isSafeInteger(item.balance));
}

export function parseProductImportCommitResult(value: unknown): ProductImportCommitResult | null {
  return parseCommit(value, 'products', (item): item is ProductImportCreated => isRecord(item)
    && isRowNumber(item.rowNumber) && typeof item.productId === 'string'
    && typeof item.name === 'string');
}

export function parseBulkImportFailure(value: unknown): BulkImportFailure | null {
  if (!isRecord(value) || value.ok !== false || typeof value.code !== 'string'
    || typeof value.error !== 'string') return null;
  if (value.errors !== undefined && (!Array.isArray(value.errors) || !value.errors.every(isIssue))) return null;
  return value as unknown as BulkImportFailure;
}
