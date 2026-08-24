export type OperationalSheetName =
  | 'Students'
  | 'Products'
  | 'Transactions'
  | 'Adjustments'
  | 'Settings'
  | 'Tasks'
  | 'TaskCompletions';

export type SheetCellUpdate = {
  rowNumber: number;
  columnName: string;
  value: string | number;
};

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
