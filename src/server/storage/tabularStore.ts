export type OperationalSheetName =
  | 'Students'
  | 'Products'
  | 'Transactions'
  | 'Adjustments'
  | 'Settings'
  | 'Tasks'
  | 'TaskAssignments'
  | 'TaskCompletions';

export type SheetCellUpdate = {
  rowNumber: number;
  columnName: string;
  value: string | number;
};

export type SheetInfo = {
  sheetId: number;
  title: OperationalSheetName;
  columnCount: number;
};

export type SheetLookupResult =
  | { found: true; info: SheetInfo }
  | { found: false; reason: 'SHEET_NOT_FOUND' };

export type HeaderWritePrecondition = {
  sheetId: number;
  columnCount: number;
  header: readonly string[];
};

export type SheetProviderErrorReason = 'SHEET_ALREADY_EXISTS';

/** A provider fact, rather than a guess based on a localized error message. */
export class SheetProviderError extends Error {
  constructor(public readonly reason: SheetProviderErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'SheetProviderError';
  }
}

/** Signals that migration preconditions raced; callers may safely retry the explicit command. */
export class MigrationConflictError extends Error {
  readonly retryable = true;

  constructor(public readonly sheetName: OperationalSheetName, detail: string) {
    super(`Retryable recurring schema migration conflict in ${sheetName}: ${detail}`);
    this.name = 'MigrationConflictError';
  }
}

export type TabularReader = {
  getRows(sheetName: OperationalSheetName): Promise<string[][]>;
};

export type TabularStore = TabularReader & {
  updateCell(
    sheetName: OperationalSheetName,
    rowNumber: number,
    columnName: string,
    value: string | number,
  ): Promise<void>;
  updateCells?(sheetName: OperationalSheetName, updates: SheetCellUpdate[]): Promise<void>;
  updateHeaderRow?(sheetName: OperationalSheetName, headers: string[]): Promise<void>;
  appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void>;
  deleteRow?(sheetName: OperationalSheetName, rowNumber: number): Promise<void>;
  deleteRows?(sheetName: OperationalSheetName, rowNumbers: number[]): Promise<void>;
};

/** Capabilities required by the explicit recurring-schema migration command. */
export interface RecurringSchemaMigrationStore extends TabularStore {
  lookupSheet(sheetName: OperationalSheetName): Promise<SheetLookupResult>;
  createSheetWithHeader(sheetName: OperationalSheetName, headers: readonly string[]): Promise<void>;
  ensureColumnCount(
    sheetName: OperationalSheetName,
    expectedColumnCount: number,
    requiredColumnCount: number,
  ): Promise<void>;
  writeHeaderCells(sheetName: OperationalSheetName, startColumn: number, headers: readonly string[]): Promise<void>;
  verifyHeaderCells(
    sheetName: OperationalSheetName,
    expected: HeaderWritePrecondition,
  ): Promise<void>;
  verifyAndWriteHeaderCells(
    sheetName: OperationalSheetName,
    expected: HeaderWritePrecondition,
    headers: readonly string[],
  ): Promise<void>;
}
