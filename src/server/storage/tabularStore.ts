export type OperationalSheetName =
  | 'Students'
  | 'Products'
  | 'Transactions'
  | 'Adjustments'
  | 'Settings'
  | 'Tasks'
  | 'TaskAssignments'
  | 'TaskCompletions'
  | 'Promotions'
  | 'PromotionProducts';

export type SheetCellUpdate = {
  rowNumber: number;
  columnName: string;
  value: string | number;
};

/** A one-based physical cell address suitable for one provider-level atomic request. */
export type CrossSheetCellUpdate = {
  sheetName: OperationalSheetName;
  rowNumber: number;
  columnNumber: number;
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

/** Structured schema-migration failure with explicit retry guidance for callers. */
export class MigrationConflictError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly sheetName: OperationalSheetName,
    detail: string,
    options: { retryable?: boolean } = {},
  ) {
    const retryable = options.retryable ?? true;
    super(`${retryable ? 'Retryable ' : ''}schema migration conflict in ${sheetName}: ${detail}`);
    this.name = 'MigrationConflictError';
    this.retryable = retryable;
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
  updateCellsAtomicallyAcrossSheets?(updates: CrossSheetCellUpdate[]): Promise<void>;
  updateHeaderRow?(sheetName: OperationalSheetName, headers: string[]): Promise<void>;
  appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void>;
  deleteRow?(sheetName: OperationalSheetName, rowNumber: number): Promise<void>;
  deleteRows?(sheetName: OperationalSheetName, rowNumbers: number[]): Promise<void>;
};

/** Never emulates atomicity by looping primitive writes. */
export async function updateCellsAtomicallyAcrossSheets(
  store: TabularStore,
  updates: CrossSheetCellUpdate[],
): Promise<void> {
  if (!store.updateCellsAtomicallyAcrossSheets) {
    throw new Error('현재 Sheets 저장소가 원자적 다중 시트 업데이트를 지원하지 않습니다.');
  }
  await store.updateCellsAtomicallyAcrossSheets(updates);
}

/** Capabilities required to add structurally missing sheets explicitly. */
export interface AdditiveSchemaMigrationStore extends TabularStore {
  lookupSheet(sheetName: OperationalSheetName): Promise<SheetLookupResult>;
  createSheetWithHeader(sheetName: OperationalSheetName, headers: readonly string[]): Promise<void>;
}

/** Capabilities required by the explicit recurring-schema migration command. */
export interface RecurringSchemaMigrationStore extends AdditiveSchemaMigrationStore {
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
