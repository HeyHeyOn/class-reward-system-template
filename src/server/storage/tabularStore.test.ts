import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  OperationalSheetName,
  SheetCellUpdate,
  TabularReader,
  TabularStore,
} from '@/server/storage/tabularStore';

class InMemoryTabularStore implements TabularStore {
  readonly updates: SheetCellUpdate[] = [];

  constructor(private readonly rows: Partial<Record<OperationalSheetName, string[][]>>) {}

  async getRows(sheetName: OperationalSheetName): Promise<string[][]> {
    return this.rows[sheetName] ?? [];
  }

  async updateCell(
    sheetName: OperationalSheetName,
    rowNumber: number,
    columnName: string,
    value: string | number,
  ): Promise<void> {
    await this.updateCells?.(sheetName, [{ rowNumber, columnName, value }]);
  }

  async updateCells(_sheetName: OperationalSheetName, updates: SheetCellUpdate[]): Promise<void> {
    this.updates.push(...updates);
  }

  async appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void> {
    (this.rows[sheetName] ??= []).push(values);
  }
}

describe('tabular store port', () => {
  it('accepts an in-memory adapter as a reader and store', async () => {
    const adapter = new InMemoryTabularStore({ Students: [['studentId'], ['S001']] });
    const reader: TabularReader = adapter;
    const store: TabularStore = adapter;

    await expect(reader.getRows('Students')).resolves.toEqual([['studentId'], ['S001']]);
    await store.appendRow('Transactions', ['T001']);
    await expect(store.getRows('Transactions')).resolves.toEqual([['T001']]);
  });

  it('supports the existing single-cell and batch-cell update contracts', async () => {
    const store: TabularStore = new InMemoryTabularStore({});

    await store.updateCell('Students', 2, 'balance', 1000);
    await store.updateCells?.('Products', [
      { rowNumber: 2, columnName: 'stock', value: 3 },
      { rowNumber: 3, columnName: 'isActive', value: 'FALSE' },
    ]);

    expect((store as InMemoryTabularStore).updates).toEqual([
      { rowNumber: 2, columnName: 'balance', value: 1000 },
      { rowNumber: 2, columnName: 'stock', value: 3 },
      { rowNumber: 3, columnName: 'isActive', value: 'FALSE' },
    ]);
  });

  it('excludes Recovery from operational sheet names', () => {
    expectTypeOf<OperationalSheetName>().toEqualTypeOf<
      | 'Students'
      | 'Products'
      | 'Transactions'
      | 'Adjustments'
      | 'Settings'
      | 'Tasks'
      | 'TaskCompletions'
    >();

    if (false) {
      const reader = {} as TabularReader;
      // @ts-expect-error Recovery is intentionally outside the operational store port.
      void reader.getRows('Recovery');
    }
  });
});
