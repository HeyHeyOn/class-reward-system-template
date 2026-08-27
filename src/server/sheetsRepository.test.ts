import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecurrence } from '@/domain/types';
import {
  createProduct,
  createStudent,
  getActiveProducts,
  getProducts,
  getTransactions,
  getStudentById,
  getStudents,
  bulkAdjustStudentBalances,
  cancelTransaction,
  completeTaskForStudent,
  createTask,
  getTasks,
  deleteProduct,
  deleteProductsBatch,
  deleteStudent,
  deleteStudentsBatch,
  deleteTask,
  deleteTasksBatch,
  updateProductDetails,
  updateProductDetailsBatch,
  updateStudentDetails,
  updateStudentDetailsBatch,
  updateTaskDetails,
  updateTaskSchedule,
  updateTaskDetailsBatch,
  getTaskAssignmentStatus,
  getTaskCycleState,
  getSheetSettings,
  verifyRequiredOperationalSheetHeaders,
  resetTaskCompletionsBatch,

  saveSheetSetting,
} from '@/server/sheetsRepository';
import { getTaskHistoryDetail } from '@/server/repositories/sheets/taskHistoryQueries';
import {
  TASK_ASSIGNMENT_HEADERS,
  TASK_COMPLETION_SCHEMA_HEADERS,
  TASK_SCHEMA_HEADERS,
} from '@/server/repositories/sheets/recurringSchemaMigrator';
import { enqueueTaskCommand, taskCommandQueueKey } from '@/server/repositories/sheets/taskCommandQueue';

type LocalStore = {
  getRows(sheetName: string): Promise<string[][]>;
  updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number): Promise<void>;
  appendRow(sheetName: string, values: string[]): Promise<void>;
  [key: string]: unknown;
};

/** Adds the real stateful migration capabilities omitted by old repository fakes. */
function withRecurringMigration<T extends LocalStore>(base: T) {
  const cached = new Map<string, string[][]>();
  const widths = new Map<string, number>();

  async function rowsFor(sheetName: string): Promise<string[][]> {
    const existing = cached.get(sheetName);
    if (existing) return existing;
    const source = (await base.getRows(sheetName)).map((row) => [...row]);
    const rows = sheetName === 'Tasks' ? normalizeLegacyTasks(source) : source;
    cached.set(sheetName, rows);
    widths.set(sheetName, Math.max(rows[0]?.length ?? 0, 26));
    return rows;
  }

  const adapter = {
    ...base,
    async getRows(sheetName: string) { return (await rowsFor(sheetName)).map((row) => [...row]); },
    async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) {
      await base.updateCell(sheetName, rowNumber, columnName, value);
      const rows = await rowsFor(sheetName);
      const column = rows[0]?.indexOf(columnName) ?? -1;
      if (column >= 0 && rows[rowNumber - 1]) rows[rowNumber - 1][column] = String(value);
    },
    async appendRow(sheetName: string, values: string[]) {
      await base.appendRow(sheetName, values);
      (await rowsFor(sheetName)).push([...values]);
    },
    async lookupSheet(sheetName: string) {
      if (sheetName === 'TaskAssignments' && !cached.has(sheetName)) return { found: false as const, reason: 'SHEET_NOT_FOUND' as const };
      const rows = await rowsFor(sheetName);
      return { found: true as const, info: { sheetId: sheetName === 'Tasks' ? 1 : 2, title: sheetName, columnCount: widths.get(sheetName) ?? rows[0]?.length ?? 0 } };
    },
    async createSheetWithHeader(sheetName: string, headers: readonly string[]) {
      cached.set(sheetName, [[...headers]]);
      widths.set(sheetName, Math.max(headers.length, 26));
    },
    async ensureColumnCount(sheetName: string, expected: number, required: number) {
      if ((widths.get(sheetName) ?? expected) !== expected) throw new Error('column width changed');
      widths.set(sheetName, required);
    },
    async writeHeaderCells(sheetName: string, startColumn: number, headers: readonly string[]) {
      const rows = await rowsFor(sheetName);
      headers.forEach((header, index) => { rows[0][startColumn + index] = header; });
    },
    async verifyHeaderCells(sheetName: string, expected: { header: readonly string[] }) {
      const header = (await rowsFor(sheetName))[0] ?? [];
      if (!expected.header.every((value, index) => header[index] === value)) throw new Error('header changed');
    },
    async verifyAndWriteHeaderCells(sheetName: string, expected: { header: readonly string[] }, headers: readonly string[]) {
      await adapter.verifyHeaderCells(sheetName, expected);
      await adapter.writeHeaderCells(sheetName, expected.header.length, headers);
    },
  };
  return adapter;
}

function normalizeLegacyTasks(rows: string[][]): string[][] {
  const header = rows[0] ?? [];
  if (TASK_SCHEMA_HEADERS.slice(0, 9).every((value, index) => header[index]?.trim() === value)) return rows;
  const index = new Map(header.map((value, position) => [value.trim(), position]));
  const legacy = TASK_SCHEMA_HEADERS.slice(0, 9);
  return [
    [...legacy],
    ...rows.slice(1).map((row) => legacy.map((column) => row[index.get(column) ?? -1] ?? '')),
  ];
}

function legacyRecurringStore(taskIds: string[], taskHeader: readonly string[] = TASK_SCHEMA_HEADERS.slice(0, 9)) {
  const rows: Record<string, string[][]> = {
    Tasks: [
      [...taskHeader],
      ...taskIds.map((taskId) => {
        const values: Record<string, string> = {
          taskId, title: `Task ${taskId}`, description: '', reward: '1', maxCompletionsPerStudent: '1',
          isActive: 'TRUE', sortOrder: '1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '', allowedStudentIds: '',
        };
        return taskHeader.map((header) => values[header] ?? '');
      }),
    ],
    TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS.slice(0, 10)]],
    Settings: [['key', 'value'], ['classTimeZone', 'UTC']],
  };
  const widths = new Map([['Tasks', 28], ['TaskCompletions', 19]]);
  const migrationWrite = vi.fn();
  const store = {
    async getRows(sheetName: string) { return (rows[sheetName] ?? []).map((row) => [...row]); },
    async lookupSheet(sheetName: string) {
      if (!rows[sheetName]) return { found: false as const, reason: 'SHEET_NOT_FOUND' as const };
      return { found: true as const, info: { sheetId: 1, title: sheetName, columnCount: widths.get(sheetName) ?? rows[sheetName][0].length } };
    },
    createSheetWithHeader: vi.fn(async (sheetName: string, headers: readonly string[]) => {
      migrationWrite();
      rows[sheetName] = [[...headers]];
      widths.set(sheetName, headers.length);
    }),
    ensureColumnCount: vi.fn(async () => { migrationWrite(); }),
    verifyHeaderCells: vi.fn(async () => undefined),
    verifyAndWriteHeaderCells: vi.fn(async (sheetName: string, expected: { header: readonly string[] }, headers: string[]) => {
      migrationWrite();
      rows[sheetName][0] = [...expected.header, ...headers];
    }),
    writeHeaderCells: vi.fn(async () => { migrationWrite(); }),
    updateHeaderRow: vi.fn(async () => { migrationWrite(); }),
    updateCell: vi.fn(),
    updateCells: vi.fn(),
    appendRow: vi.fn(async (_sheetName: string, _values: string[]) => {
      void _sheetName;
      void _values;
      migrationWrite();
    }),
    deleteRow: vi.fn(),
    deleteRows: vi.fn(),
  };
  return { store, migrationWrite };
}

function versionedScheduleMutationStore(warning?: 'current' | 'pending', coordinateConcurrentWrites = false) {
  const taskValues: Record<string, string> = {
    taskId: 'T-SERIAL', title: 'Task', description: '', reward: '1', isActive: 'TRUE', sortOrder: '1',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', allowedStudentIds: '',
    taskInstanceId: 'instance-serial', ruleVersion: '1', scheduleEffectiveFrom: '2026-08-20T00:00:00.000Z',
    recurrenceTimeZone: 'UTC', recurrenceType: warning === 'current' ? 'BROKEN' : 'DAILY', recurrenceTime: '08:00',
    resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
    ...(warning === 'pending' ? {
      pendingRuleVersion: '2', pendingEffectiveFrom: '2026-08-24T00:00:00.000Z', pendingTimeZone: 'UTC',
      pendingRecurrenceType: 'BROKEN', pendingRecurrenceTime: '09:00',
      pendingResetCompletionOnCycle: 'FALSE', pendingResetAssignmentOnCycle: 'FALSE',
    } : {}),
  };
  const rows: Record<string, string[][]> = {
    Tasks: [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => taskValues[header] ?? '')],
    TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS]],
    TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS]],
  };
  const writes: Array<{ pendingRuleVersion: string; ruleVersion: string }> = [];
  let concurrentWriteCount = 0;
  let releaseConcurrentWrites: (() => void) | undefined;
  const concurrentWrites = new Promise<void>((resolve) => { releaseConcurrentWrites = resolve; });
  const migrationWrite = vi.fn();
  const taskWrite = vi.fn(async (_sheetName: string, updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) => {
    if (coordinateConcurrentWrites) {
      concurrentWriteCount += 1;
      if (concurrentWriteCount === 1) {
        await Promise.race([concurrentWrites, new Promise<void>((resolve) => setTimeout(resolve, 20))]);
      } else {
        releaseConcurrentWrites?.();
      }
    }
    const header = rows.Tasks[0];
    for (const update of updates) {
      const column = header.indexOf(update.columnName);
      if (column >= 0) rows.Tasks[update.rowNumber - 1][column] = String(update.value);
    }
    const saved = new Map(updates.map((update) => [update.columnName, String(update.value)]));
    writes.push({
      pendingRuleVersion: saved.get('pendingRuleVersion') ?? '',
      ruleVersion: saved.get('ruleVersion') ?? '',
    });
  });
  const store = {
    async getRows(sheetName: string) { return (rows[sheetName] ?? []).map((row) => [...row]); },
    async lookupSheet() {
      return { found: true as const, info: { sheetId: 1, title: 'TaskAssignments', columnCount: TASK_ASSIGNMENT_HEADERS.length } };
    },
    updateCell: vi.fn(),
    updateCells: taskWrite,
    updateHeaderRow: migrationWrite,
    appendRow: migrationWrite,
  };
  return { store, writes, migrationWrite, taskWrite };
}

const scheduleUpdate = (recurrence: TaskRecurrence) => ({
  title: 'Task edited', description: '', reward: 1, isActive: true, sortOrder: 1,
  schedule: { recurrence, timeZone: 'UTC', resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
});

const sheetRows = {
  Students: [
    ['studentId', 'name', 'balance', 'qrValue', 'status', 'note'],
    ['S001', '김민준', '3500', 'S001', 'ACTIVE', ''],
    ['S002', '이서연', '1200', 'S002', 'INACTIVE', ''],
  ],
  Products: [
    ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
    ['P002', '지우개', '500', '15', 'TRUE', '', '문구', '2'],
    ['P001', '연필', '300', '20', 'TRUE', 'https://example.com/pencil.png', '문구', '1'],
    ['P003', '판매중지', '700', '10', 'FALSE', '', '문구', '3'],
  ],
  Transactions: [
    ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
    ['TR001', '2026-05-21T00:00:00.000Z', 'S001', '김민준', '[{"productId":"P001","name":"연필","price":300,"quantity":2,"subtotal":600}]', '600', '3500', '2900', 'COMPLETED', 'kiosk'],
  ],
  Tasks: [
    ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds'],
    ['T002', '비활성 과제', '숨김', '2', '1', 'FALSE', '2', ''],
    ['T001', '책 읽기', '책 10분 읽기', '5', '2', 'TRUE', '1', 'S001'],
  ],
  TaskCompletions: [
    ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'],
    ['TC-OLD', '2026-05-20T00:00:00.000Z', 'T001', 'S001', '김민준', '5', '3495', '3500', 'SUCCESS', ''],
  ],
  Settings: [
    ['key', 'value'],
    ['classTimeZone', 'Asia/Seoul'],
  ],
};

const fakeReader = {
  async getRows(sheetName: keyof typeof sheetRows) {
    return sheetRows[sheetName];
  },
};

describe('sheets repository', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['Students', [], [['productId', 'name', 'price', 'stock', 'isActive']]],
    ['Products', [['studentId', 'name', 'balance', 'status']], []],
  ] as const)('rejects a completely empty required %s sheet', async (_sheetName, studentRows, productRows) => {
    const reader = {
      async getRows(sheetName: string) {
        const rows = sheetName === 'Students' ? studentRows : productRows;
        return rows.map((row) => [...row]);
      },
    };

    await expect(verifyRequiredOperationalSheetHeaders(reader)).rejects.toThrow(/필수 컬럼/);
  });

  it('accepts canonical header-only operational sheets as empty datasets', async () => {
    const reader = {
      async getRows(sheetName: string) {
        return sheetName === 'Students'
          ? [['studentId', 'name', 'balance', 'status']]
          : [['productId', 'name', 'price', 'stock', 'isActive']];
      },
    };

    await expect(verifyRequiredOperationalSheetHeaders(reader)).resolves.toBeUndefined();
  });

  it('finds a student by studentId without requiring student number', async () => {
    const minimalReader = {
      async getRows() {
        return [
          ['studentId', 'name', 'balance', 'status'],
          ['S010', '강하늘', '900', 'ACTIVE'],
        ];
      },
    };
    await expect(getStudentById(minimalReader, 'S010')).resolves.toEqual({
      studentId: 'S010',
      name: '강하늘',
      balance: 900,
      status: 'ACTIVE',
    });
  });

  it('returns null when studentId is not found', async () => {
    await expect(getStudentById(fakeReader, 'S999')).resolves.toBeNull();
  });

  it('returns active students sorted by student number for QR printing', async () => {
    await expect(getStudents(fakeReader)).resolves.toEqual([
      {
        studentId: 'S001',
        name: '김민준',
        balance: 3500,
        status: 'ACTIVE',
      },
    ]);
  });

  it('returns all products sorted by sortOrder for admin editing', async () => {
    await expect(getProducts(fakeReader)).resolves.toEqual([
      {
        productId: 'P001',
        name: '연필',
        price: 300,
        stock: 20,
        isActive: true,
        imageUrl: 'https://example.com/pencil.png',
        category: '문구',
        sortOrder: 1,
      },
      {
        productId: 'P002',
        name: '지우개',
        price: 500,
        stock: 15,
        isActive: true,
        imageUrl: undefined,
        category: '문구',
        sortOrder: 2,
      },
      {
        productId: 'P003',
        name: '판매중지',
        price: 700,
        stock: 10,
        isActive: false,
        imageUrl: undefined,
        category: '문구',
        sortOrder: 3,
      },
    ]);
  });

  it('reads transactions from the generated items column', async () => {
    await expect(getTransactions(fakeReader)).resolves.toEqual([
      {
        transactionId: 'TR001',
        timestamp: '2026-05-21T00:00:00.000Z',
        studentId: 'S001',
        studentName: '김민준',
        items: [{ productId: 'P001', name: '연필', price: 300, quantity: 2, subtotal: 600 }],
        totalAmount: 600,
        balanceBefore: 3500,
        balanceAfter: 2900,
        status: 'COMPLETED',
        operator: 'kiosk',
      },
    ]);
  });

  it('still reads legacy transactions that used itemsJson', async () => {
    const legacyReader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') {
          return [
            ['transactionId', 'timestamp', 'studentId', 'studentName', 'itemsJson', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
            ['TR002', '2026-05-21T01:00:00.000Z', 'S001', '김민준', '[{"productId":"P002","name":"지우개","price":500,"quantity":1,"subtotal":500}]', '500', '2900', '2400', 'COMPLETED', 'kiosk'],
          ];
        }
        return sheetRows[sheetName];
      },
    };

    await expect(getTransactions(legacyReader)).resolves.toMatchObject([
      { transactionId: 'TR002', items: [{ productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500 }] },
    ]);
  });

  it('cancels a completed checkout by refunding balance, restoring stock, and marking the transaction', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    let transactionReads = 0;
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') transactionReads += 1;
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '김민준', '2900', 'S001', 'ACTIVE', ''], sheetRows.Students[2]];
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: 'Students' | 'Products' | 'Transactions', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: 'Transactions', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(cancelTransaction(fakeStore, 'TR001')).resolves.toMatchObject({
      cancelledTransaction: { transactionId: 'TR001', status: 'CANCELLED' },
      reversalTransaction: { status: 'CANCEL_REVERSAL', totalAmount: -600, balanceBefore: 2900, balanceAfter: 3500 },
    });
    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3500 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 22 },
      { sheetName: 'Transactions', rowNumber: 2, columnName: 'status', value: 'CANCELLED' },
    ]);
    expect(transactionReads).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0].sheetName).toBe('Transactions');
    expect(appended[0].values[2]).toBe('S001');
    expect(appended[0].values[3]).toBe('김민준');
    expect(JSON.parse(appended[0].values[4])).toEqual([
      expect.objectContaining({ productId: 'CANCEL-TR001', name: '거래 취소', quantity: 1, subtotal: -600 }),
    ]);
    expect(appended[0].values.slice(5, 10)).toEqual(['-600', '2900', '3500', 'CANCEL_REVERSAL', 'cancel:TR001']);
  });

  it('restores total received quantity from an enriched snapshot without consulting current promotions', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const snapshot = {
      productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540,
      regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
      finalTotal: 540, totalDiscount: 360,
      adjustments: [
        { promotionId: 'N21', type: 'N_PLUS_ONE', beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 },
        { promotionId: 'P10', type: 'PERCENT_DISCOUNT', beforeAmount: 600, afterAmount: 540, discountAmount: 60 },
      ],
      appliedPromotions: [
        { promotionId: 'N21', name: '2+1', description: '', productIds: ['P001'], type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3 },
        { promotionId: 'P10', name: '10%', description: '', productIds: ['P001'], type: 'PERCENT_DISCOUNT', percent: 10, startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3 },
      ],
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Transactions') return [sheetRows.Transactions[0], ['TR-S', '2026-08-15T00:00:00.000Z', 'S001', '김민준', JSON.stringify([snapshot]), '540', '3500', '2960', 'COMPLETED', 'kiosk']];
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '김민준', '2960', 'S001', 'ACTIVE', '']];
        if (sheetName === 'Promotions' || sheetName === 'PromotionProducts') throw new Error('promotions unavailable');
        return sheetRows[sheetName as keyof typeof sheetRows];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(cancelTransaction(store, 'TR-S')).resolves.toMatchObject({
      reversalTransaction: { balanceBefore: 2960, balanceAfter: 3500, totalAmount: -540 },
    });
    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3500 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 23 },
      { sheetName: 'Transactions', rowNumber: 2, columnName: 'status', value: 'CANCELLED' },
    ]);
  });

  it('aborts malformed partial snapshot cancellation before every write', async () => {
    const writes: string[] = [];
    const partial = { productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540, totalQuantity: 3 };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Transactions') return [sheetRows.Transactions[0], ['TR-BAD', '2026-08-15T00:00:00.000Z', 'S001', '김민준', JSON.stringify([partial]), '540', '3500', '2960', 'COMPLETED', 'kiosk']];
        return sheetRows[sheetName as keyof typeof sheetRows];
      },
      async updateCell() { writes.push('update'); },
      async appendRow() { writes.push('append'); },
    };

    await expect(cancelTransaction(store, 'TR-BAD')).rejects.toThrow('상품 스냅샷');
    expect(writes).toEqual([]);
  });

  it('restores received inventory when cancelling a fully discounted zero-total purchase', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const snapshot = {
      productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 0,
      regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 3, freeQuantity: 0,
      finalTotal: 0, totalDiscount: 900,
      adjustments: [{
        promotionId: 'FREE', type: 'FIXED_DISCOUNT', beforeAmount: 900, afterAmount: 0, discountAmount: 900,
      }],
      appliedPromotions: [{
        promotionId: 'FREE', name: '무료', description: '', productIds: ['P001'],
        type: 'FIXED_DISCOUNT', discountAmount: 300,
        startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
        isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3,
      }],
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Transactions') return [
          sheetRows.Transactions[0],
          ['TR-FREE', '2026-08-15T00:00:00.000Z', 'S001', '김민준', JSON.stringify([snapshot]), '0', '3500', '3500', 'COMPLETED', 'kiosk'],
        ];
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '김민준', '3500', 'S001', 'ACTIVE', '']];
        return sheetRows[sheetName as keyof typeof sheetRows];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(cancelTransaction(store, 'TR-FREE')).resolves.toMatchObject({
      reversalTransaction: { balanceBefore: 3500, balanceAfter: 3500 },
    });
    expect(updates).toContainEqual({
      sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 23,
    });
  });

  it('cancels an income transaction by restoring the previous balance and marking it cancelled', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const incomeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') {
          return [
            sheetRows.Transactions[0],
            ['TASK-TC001', '2026-05-21T02:00:00.000Z', 'S001', '김민준', '[{"productId":"T001","name":"책 읽기","price":-5,"quantity":1,"subtotal":-5}]', '-5', '3500', '3505', 'TASK_REWARD', 'bank'],
          ];
        }
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '김민준', '3505', 'S001', 'ACTIVE', '']];
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: 'Students' | 'Products' | 'Transactions', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: 'Transactions', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(cancelTransaction(incomeStore, 'TASK-TC001')).resolves.toMatchObject({
      cancelledTransaction: { transactionId: 'TASK-TC001', status: 'CANCELLED' },
      reversalTransaction: { status: 'CANCEL_REVERSAL', totalAmount: 5, balanceBefore: 3505, balanceAfter: 3500 },
    });
    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3500 },
      { sheetName: 'Transactions', rowNumber: 2, columnName: 'status', value: 'CANCELLED' },
    ]);
  });

  it('rejects cancelling a transaction twice', async () => {
    const cancelledReader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') return [sheetRows.Transactions[0], [...sheetRows.Transactions[1].slice(0, 8), 'CANCELLED', 'kiosk']];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow() {},
    };

    await expect(cancelTransaction(cancelledReader, 'TR001')).rejects.toThrow('이미 취소된 거래입니다.');
  });

  it.each([
    { overflow: 'stock', studentBalance: '2900', stock: String(Number.MAX_SAFE_INTEGER) },
    { overflow: 'balance', studentBalance: '1', stock: '20', balanceBefore: String(Number.MAX_SAFE_INTEGER), balanceAfter: '0' },
  ])('rejects cancellation $overflow overflow before every write', async ({ studentBalance, stock, balanceBefore = '3500', balanceAfter = '2900' }) => {
    const writes = vi.fn();
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Transactions') return [
          sheetRows.Transactions[0],
          ['TR-OVERFLOW', '2026-08-15T00:00:00.000Z', 'S001', '학생',
            '[{"productId":"P001","name":"연필","price":300,"quantity":2,"subtotal":600}]',
            '600', balanceBefore, balanceAfter, 'COMPLETED', 'kiosk'],
        ];
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '학생', studentBalance, 'S001', 'ACTIVE', '']];
        if (sheetName === 'Products') return [sheetRows.Products[0], ['P001', '연필', '300', stock, 'TRUE', '', '문구', '1']];
        return sheetRows[sheetName as keyof typeof sheetRows];
      },
      updateCell: writes,
      appendRow: writes,
    };

    await expect(cancelTransaction(store, 'TR-OVERFLOW')).rejects.toThrow(/safe integer|overflow/i);
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns active products sorted by sortOrder', async () => {
    await expect(getActiveProducts(fakeReader)).resolves.toEqual([
      {
        productId: 'P001',
        name: '연필',
        price: 300,
        stock: 20,
        isActive: true,
        imageUrl: 'https://example.com/pencil.png',
        category: '문구',
        sortOrder: 1,
      },
      {
        productId: 'P002',
        name: '지우개',
        price: 500,
        stock: 15,
        isActive: true,
        imageUrl: undefined,
        category: '문구',
        sortOrder: 2,
      },
    ]);
  });

  it('updates editable student cells by row number without student number', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(
      updateStudentDetails(fakeStore, 'S001', { name: '김민준 수정', balance: 4000, status: 'INACTIVE' }),
    ).resolves.toEqual({ studentId: 'S001', name: '김민준 수정', balance: 4000, status: 'INACTIVE' });

    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'name', value: '김민준 수정' },
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 4000 },
      { sheetName: 'Students', rowNumber: 2, columnName: 'status', value: 'INACTIVE' },
    ]);
  });

  it('allows admin student balance edits to set a negative balance', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(
      updateStudentDetails(fakeStore, 'S001', { name: '김민준', balance: -1, status: 'ACTIVE' }),
    ).resolves.toEqual({ studentId: 'S001', name: '김민준', balance: -1, status: 'ACTIVE' });

    expect(updates).toContainEqual({ sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: -1 });
  });

  it('batch updates students through one store call', async () => {
    const batches: Array<{ sheetName: string; updates: Array<{ rowNumber: number; columnName: string; value: string | number }> }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {
        throw new Error('single-cell update should not be used');
      },
      async updateCells(sheetName: 'Students' | 'Products', updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) {
        batches.push({ sheetName, updates });
      },
      async appendRow() {},
    };

    await expect(
      updateStudentDetailsBatch(fakeStore, [
        { studentId: 'S001', name: '김민준 수정', balance: 4000, status: 'INACTIVE' },
        { studentId: 'S002', name: '이서연', balance: 9000, status: 'ACTIVE' },
      ]),
    ).resolves.toEqual([
      { studentId: 'S001', name: '김민준 수정', balance: 4000, status: 'INACTIVE' },
      { studentId: 'S002', name: '이서연', balance: 9000, status: 'ACTIVE' },
    ]);

    expect(batches).toEqual([
      {
        sheetName: 'Students',
        updates: [
          { rowNumber: 2, columnName: 'name', value: '김민준 수정' },
          { rowNumber: 2, columnName: 'balance', value: 4000 },
          { rowNumber: 2, columnName: 'status', value: 'INACTIVE' },
          { rowNumber: 3, columnName: 'name', value: '이서연' },
          { rowNumber: 3, columnName: 'balance', value: 9000 },
          { rowNumber: 3, columnName: 'status', value: 'ACTIVE' },
        ],
      },
    ]);
  });

  it('appends a new student row using only the generated Students schema columns', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Students') return [['studentId', 'name', 'balance', 'status']];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow(sheetName: 'Students' | 'Products', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(
      createStudent(fakeStore, { studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' }),
    ).resolves.toEqual({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });

    expect(appended).toEqual([
      { sheetName: 'Students', values: ['S003', '박도윤', '0', 'ACTIVE'] },
    ]);
  });

  it('appends a new student row without shifting status in legacy QR-value sheets', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async appendRow(sheetName: 'Students' | 'Products', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(
      createStudent(fakeStore, { studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' }),
    ).resolves.toEqual({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });

    expect(appended).toEqual([
      { sheetName: 'Students', values: ['S003', '박도윤', '0', 'S003', 'ACTIVE', ''] },
    ]);
  });

  it('appends a new product row with default imageUrl column', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async appendRow(sheetName: 'Students' | 'Products', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(
      createProduct(fakeStore, {
        productId: 'P004',
        name: '간식쿠폰',
        price: 1000,
        stock: 5,
        isActive: true,
        imageUrl: 'https://example.com/snack.png',
        category: '쿠폰',
        sortOrder: 4,
      }),
    ).resolves.toEqual({
      productId: 'P004',
      name: '간식쿠폰',
      price: 1000,
      stock: 5,
      isActive: true,
      imageUrl: 'https://example.com/snack.png',
      category: '쿠폰',
      sortOrder: 4,
    });

    expect(appended).toEqual([
      { sheetName: 'Products', values: ['P004', '간식쿠폰', '1000', '5', 'TRUE', 'https://example.com/snack.png', '쿠폰', '4'] },
    ]);
  });

  it('deletes student and product rows by located sheet row number', async () => {
    const deletedRows: Array<{ sheetName: string; rowNumber: number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async appendRow() {},
      async deleteRow(sheetName: 'Students' | 'Products', rowNumber: number) {
        deletedRows.push({ sheetName, rowNumber });
      },
    };

    await expect(deleteStudent(fakeStore, 'S001')).resolves.toEqual({ studentId: 'S001' });
    await expect(deleteProduct(fakeStore, 'P001')).resolves.toEqual({ productId: 'P001' });

    expect(deletedRows).toEqual([
      { sheetName: 'Students', rowNumber: 2 },
      { sheetName: 'Products', rowNumber: 3 },
    ]);
  });

  it('batch deletes students and products by located sheet row numbers', async () => {
    const deletedBatches: Array<{ sheetName: string; rowNumbers: number[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async appendRow() {},
      async deleteRows(sheetName: 'Students' | 'Products', rowNumbers: number[]) {
        deletedBatches.push({ sheetName, rowNumbers });
      },
    };

    await expect(deleteStudentsBatch(fakeStore, ['S001', 'S002', 'S001'])).resolves.toEqual({ studentIds: ['S001', 'S002'] });
    await expect(deleteProductsBatch(fakeStore, ['P001', 'P002'])).resolves.toEqual({ productIds: ['P001', 'P002'] });

    expect(deletedBatches).toEqual([
      { sheetName: 'Students', rowNumbers: [2, 3] },
      { sheetName: 'Products', rowNumbers: [3, 2] },
    ]);
  });

  it('bulk adjusts selected student balances with set/add/subtract modes and records transactions', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(bulkAdjustStudentBalances(fakeStore, { studentIds: ['S001', 'S002'], mode: 'add', amount: 500 })).resolves.toEqual([
      { studentId: 'S001', balance: 4000 },
      { studentId: 'S002', balance: 1700 },
    ]);
    await expect(bulkAdjustStudentBalances(fakeStore, { studentIds: ['S001'], mode: 'subtract', amount: 1000 })).resolves.toEqual([
      { studentId: 'S001', balance: 2500 },
    ]);
    await expect(bulkAdjustStudentBalances(fakeStore, { studentIds: ['S002'], mode: 'set', amount: 9000 })).resolves.toEqual([
      { studentId: 'S002', balance: 9000 },
    ]);

    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 4000 },
      { sheetName: 'Students', rowNumber: 3, columnName: 'balance', value: 1700 },
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 2500 },
      { sheetName: 'Students', rowNumber: 3, columnName: 'balance', value: 9000 },
    ]);
    expect(appended.filter((row) => row.sheetName === 'Transactions')).toHaveLength(4);
    expect(appended[0].values[4]).toContain('관리자 지급');
    expect(appended[0].values.slice(5, 8)).toEqual(['-500', '3500', '4000']);
    expect(appended[2].values[4]).toContain('관리자 회수');
    expect(appended[2].values.slice(5, 8)).toEqual(['1000', '3500', '2500']);
    expect(appended[3].values[4]).toContain('관리자 잔액 지정');
  });

  it('allows admin bulk reclaim to make a selected student balance negative', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(bulkAdjustStudentBalances(fakeStore, { studentIds: ['S002'], mode: 'subtract', amount: 1500 })).resolves.toEqual([
      { studentId: 'S002', balance: -300 },
    ]);

    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 3, columnName: 'balance', value: -300 },
    ]);
    expect(appended[0].values[4]).toContain('관리자 회수');
    expect(appended[0].values.slice(5, 8)).toEqual(['1500', '1200', '-300']);
  });

  it('reads Transactions only once for a bulk balance adjustment batch', async () => {
    let transactionReads = 0;
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') transactionReads += 1;
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow() {},
    };

    await bulkAdjustStudentBalances(fakeStore, { studentIds: ['S001', 'S002'], mode: 'add', amount: 100 });
    expect(transactionReads).toBe(1);
  });

  it('falls back to canonical transaction headers when a bulk adjustment header read fails', async () => {
    const events: string[] = [];
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    let transactionReads = 0;
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Transactions') {
          transactionReads += 1;
          events.push('read:Transactions');
          throw new Error('Transactions header read failed');
        }
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) {
        events.push(`update:${sheetName}`);
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: string, values: string[]) {
        events.push(`append:${sheetName}`);
        appended.push({ sheetName, values });
      },
    };

    await expect(bulkAdjustStudentBalances(fakeStore, {
      studentIds: ['S001', 'S002'],
      mode: 'add',
      amount: 100,
    })).resolves.toEqual([
      { studentId: 'S001', balance: 3600 },
      { studentId: 'S002', balance: 1300 },
    ]);
    expect(transactionReads).toBe(1);
    expect(events).toEqual([
      'read:Transactions',
      'update:Students',
      'update:Students',
      'append:Transactions',
      'append:Transactions',
    ]);
    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3600 },
      { sheetName: 'Students', rowNumber: 3, columnName: 'balance', value: 1300 },
    ]);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toEqual({
      sheetName: 'Transactions',
      values: [
        expect.stringMatching(/^ADMIN-/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        'S001',
        '김민준',
        JSON.stringify([{ productId: 'ADMIN-ADD', name: '관리자 지급', price: -100, quantity: 1, subtotal: -100 }]),
        '-100',
        '3500',
        '3600',
        'ADMIN_ADJUSTMENT',
        'admin',
      ],
    });
    expect(appended[1]).toEqual({
      sheetName: 'Transactions',
      values: [
        expect.stringMatching(/^ADMIN-/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        'S002',
        '이서연',
        JSON.stringify([{ productId: 'ADMIN-ADD', name: '관리자 지급', price: -100, quantity: 1, subtotal: -100 }]),
        '-100',
        '1200',
        '1300',
        'ADMIN_ADJUSTMENT',
        'admin',
      ],
    });
  });

  it('updates editable product cells by row number', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(
      updateProductDetails(fakeStore, 'P001', {
        name: '연필 세트',
        price: 900,
        stock: 12,
        isActive: false,
        imageUrl: 'https://example.com/new-pencil.png',
        category: '문구류',
        sortOrder: 5,
      }),
    ).resolves.toEqual({
      productId: 'P001',
      name: '연필 세트',
      price: 900,
      stock: 12,
      isActive: false,
      imageUrl: 'https://example.com/new-pencil.png',
      category: '문구류',
      sortOrder: 5,
    });

    expect(updates).toEqual([
      { sheetName: 'Products', rowNumber: 3, columnName: 'name', value: '연필 세트' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'price', value: 900 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 12 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'isActive', value: 'FALSE' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'imageUrl', value: 'https://example.com/new-pencil.png' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'category', value: '문구류' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'sortOrder', value: 5 },
    ]);
  });

  it('batch updates products through one store call', async () => {
    const batches: Array<{ sheetName: string; updates: Array<{ rowNumber: number; columnName: string; value: string | number }> }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {
        throw new Error('single-cell update should not be used');
      },
      async updateCells(sheetName: 'Students' | 'Products', updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) {
        batches.push({ sheetName, updates });
      },
      async appendRow() {},
    };

    await expect(
      updateProductDetailsBatch(fakeStore, [
        { productId: 'P001', name: '연필 세트', price: 900, stock: 12, isActive: false, imageUrl: 'https://example.com/new-pencil.png', category: '문구류', sortOrder: 5 },
        { productId: 'P002', name: '지우개 세트', price: 600, stock: 8, isActive: true, imageUrl: '', category: '문구', sortOrder: 2 },
      ]),
    ).resolves.toEqual([
      { productId: 'P002', name: '지우개 세트', price: 600, stock: 8, isActive: true, imageUrl: undefined, category: '문구', sortOrder: 2 },
      { productId: 'P001', name: '연필 세트', price: 900, stock: 12, isActive: false, imageUrl: 'https://example.com/new-pencil.png', category: '문구류', sortOrder: 5 },
    ]);

    expect(batches).toEqual([
      {
        sheetName: 'Products',
        updates: [
          { rowNumber: 3, columnName: 'name', value: '연필 세트' },
          { rowNumber: 3, columnName: 'price', value: 900 },
          { rowNumber: 3, columnName: 'stock', value: 12 },
          { rowNumber: 3, columnName: 'isActive', value: 'FALSE' },
          { rowNumber: 3, columnName: 'imageUrl', value: 'https://example.com/new-pencil.png' },
          { rowNumber: 3, columnName: 'category', value: '문구류' },
          { rowNumber: 3, columnName: 'sortOrder', value: 5 },
          { rowNumber: 2, columnName: 'name', value: '지우개 세트' },
          { rowNumber: 2, columnName: 'price', value: 600 },
          { rowNumber: 2, columnName: 'stock', value: 8 },
          { rowNumber: 2, columnName: 'isActive', value: 'TRUE' },
          { rowNumber: 2, columnName: 'imageUrl', value: '' },
          { rowNumber: 2, columnName: 'category', value: '문구' },
          { rowNumber: 2, columnName: 'sortOrder', value: 2 },
        ],
      },
    ]);
  });

  it('reads active tasks sorted by sort order', async () => {
    await expect(getTasks(fakeReader)).resolves.toEqual([
      {
        taskId: 'T001', title: '책 읽기', description: '책 10분 읽기', reward: 5, isActive: true,
        sortOrder: 1, allowedStudentIds: ['S001'],
        taskInstanceId: 'legacy:T001:1970-01-01T00:00:00.000Z',
        schedule: {
          ruleVersion: 1, effectiveFrom: '1970-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
          recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false,
        },
        pendingSchedule: null,
      },
    ]);
  });

  it('projects legacy tasks with the actual normalized class time zone from Settings', async () => {
    const reader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Settings') return [['key', 'value'], ['classTimeZone', 'America/New_York']];
        return sheetRows[sheetName];
      },
    };
    await expect(getTasks(reader)).resolves.toMatchObject([
      { taskId: 'T001', schedule: { timeZone: 'America/New_York', recurrence: { type: 'NONE' } } },
    ]);
  });

  it('propagates Settings operational and structural errors when legacy task projection needs it', async () => {
    const networkFailure = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Settings') throw new Error('Settings network failure');
        return sheetRows[sheetName];
      },
    };
    await expect(getTasks(networkFailure)).rejects.toThrow('Settings network failure');

    const badHeader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Settings') return [['wrong', 'header']];
        return sheetRows[sheetName];
      },
    };
    await expect(getTasks(badHeader)).rejects.toThrow('Settings 시트에 필수 컬럼이 없습니다');
  });

  it('creates task headers and appends a new task row', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      async getRows(sheetName: keyof typeof sheetRows) { return sheetName === 'Tasks' ? [] : sheetRows[sheetName]; },
      async updateCell() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };
    await expect(createTask(fakeStore, { taskId: 'T003', title: '수학 학습지', description: '1장 풀기', reward: 10, isActive: true, sortOrder: 3 })).resolves.toMatchObject({ taskId: 'T003', title: '수학 학습지' });
    expect(appended[0]).toEqual({ sheetName: 'Tasks', values: ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'] });
    expect(appended[1].sheetName).toBe('Tasks');
    expect(appended[1].values.slice(0, 6)).toEqual(['T003', '수학 학습지', '1장 풀기', '10', 'TRUE', '3']);
    expect(appended[1].values[6]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appended[1].values[7]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appended[1].values[8]).toBe('');
  });

  it('serializes concurrent creates for the same task ID on an empty Tasks sheet', async () => {
    const rows: string[][] = [];
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return rows.map((row) => [...row]);
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      async updateCell() {},
      async appendRow(sheetName: string, values: string[]) {
        if (sheetName === 'Tasks') rows.push([...values]);
      },
    };
    const create = {
      taskId: 'T-RACE', title: '동시 과제', description: '', reward: 1, isActive: true, sortOrder: 1,
    };

    const results = await Promise.allSettled([createTask(store, create), createTask(store, create)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(expect.objectContaining({
      message: '이미 존재하는 과제 ID입니다.',
    }));
    expect(rows.filter((row) => row[0] === 'taskId')).toHaveLength(1);
    expect(rows.filter((row) => row[0] === 'T-RACE')).toHaveLength(1);
  });

  it('creates one header and both rows for concurrent different task IDs on an empty Tasks sheet', async () => {
    const rows: string[][] = [];
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return rows.map((row) => [...row]);
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      async updateCell() {},
      async appendRow(sheetName: string, values: string[]) {
        if (sheetName === 'Tasks') rows.push([...values]);
      },
    };
    const create = (taskId: string) => ({
      taskId, title: taskId, description: '', reward: 1, isActive: true, sortOrder: 1,
    });

    await expect(Promise.all([
      createTask(store, create('T-RACE-A')),
      createTask(store, create('T-RACE-B')),
    ])).resolves.toHaveLength(2);

    expect(rows.filter((row) => row[0] === 'taskId')).toHaveLength(1);
    expect(rows.filter((row) => row[0].startsWith('T-RACE-'))).toHaveLength(2);
  });

  it('persists CRS availability and prerequisite columns after append-only migration', async () => {
    const { store } = legacyRecurringStore(['PRE']);
    const created = await createTask(store as never, {
      taskId: 'MAIN', title: 'Main', description: '', reward: 3, isActive: true, sortOrder: 2,
      availableFrom: '2026-08-01T00:00:00Z', dueAt: '2026-09-01T00:00:00Z', prerequisiteTaskId: 'PRE',
    });
    const append = vi.mocked(store.appendRow).mock.calls.find(([sheetName]) => sheetName === 'Tasks');
    expect(created).toMatchObject({
      availableFrom: '2026-08-01T00:00:00Z', dueAt: '2026-09-01T00:00:00Z', prerequisiteTaskId: 'PRE',
    });
    expect(append?.[1][TASK_SCHEMA_HEADERS.indexOf('availableFrom')]).toBe('2026-08-01T00:00:00Z');
    expect(append?.[1][TASK_SCHEMA_HEADERS.indexOf('dueAt')]).toBe('2026-09-01T00:00:00Z');
    expect(append?.[1][TASK_SCHEMA_HEADERS.indexOf('prerequisiteTaskId')]).toBe('PRE');
  });

  it('rejects an invalid prerequisite before create performs recurring schema migration writes', async () => {
    const { store, migrationWrite } = legacyRecurringStore(['A']);
    await expect(createTask(store as never, {
      taskId: 'B', title: 'B', description: '', reward: 1, isActive: true, sortOrder: 2,
      prerequisiteTaskId: 'MISSING',
    })).rejects.toThrow('찾을 수 없습니다');
    expect(migrationWrite).not.toHaveBeenCalled();
    expect(store.appendRow).not.toHaveBeenCalled();
  });

  it('rejects an invalid prerequisite before a schedule edit performs migration writes', async () => {
    const { store, migrationWrite } = legacyRecurringStore(['A']);
    await expect(updateTaskDetails(store as never, 'A', {
      title: 'A', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [],
      prerequisiteTaskId: 'MISSING',
      schedule: { timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
    })).rejects.toThrow('찾을 수 없습니다');
    expect(migrationWrite).not.toHaveBeenCalled();
    expect(store.updateCells).not.toHaveBeenCalled();
  });

  it('validates a batch prerequisite graph against the final combined state before writes', async () => {
    const { store, migrationWrite } = legacyRecurringStore(['A', 'B']);
    const update = (taskId: string, prerequisiteTaskId: string) => ({
      taskId, title: taskId, description: '', reward: 1, isActive: true, sortOrder: 1,
      allowedStudentIds: [], prerequisiteTaskId,
    });
    await expect(updateTaskDetailsBatch(store as never, [update('A', 'B'), update('B', 'A')]))
      .rejects.toThrow('순환');
    expect(store.updateCells).not.toHaveBeenCalled();
    expect(migrationWrite).not.toHaveBeenCalled();
  });

  it.each(['single', 'batch'] as const)('rejects %s deactivation of a referenced prerequisite before writes', async (mode) => {
    const { store } = legacyRecurringStore(['A', 'B'], TASK_SCHEMA_HEADERS);
    const originalGetRows = store.getRows.bind(store);
    store.getRows = vi.fn(async (sheetName: string) => {
      const rows = await originalGetRows(sheetName);
      if (sheetName === 'Tasks') rows[2][TASK_SCHEMA_HEADERS.indexOf('prerequisiteTaskId')] = 'A';
      return rows;
    });
    const update = { title: 'A', description: '', reward: 1, isActive: false, sortOrder: 1, allowedStudentIds: [] };

    const operation = mode === 'single'
      ? updateTaskDetails(store as never, 'A', update)
      : updateTaskDetailsBatch(store as never, [{ taskId: 'A', ...update }]);

    await expect(operation).rejects.toThrow('비활성');
    expect(store.updateCells).not.toHaveBeenCalled();
  });

  it('migrates a legacy Tasks schema before creating a task with a recurring schedule', async () => {
    const { store } = legacyRecurringStore([]);

    const created = await createTask(store, {
      taskId: 'T-RECURRING', title: '월말 과제', description: '', reward: 3, isActive: true, sortOrder: 1,
      schedule: {
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'MONTHLY', dayOfMonth: 31, time: '17:45' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      },
    });

    expect(created.taskInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.schedule).toMatchObject({
      ruleVersion: 1,
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'MONTHLY', dayOfMonth: 31, time: '17:45' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: false,
    });
    const appendedTask = vi.mocked(store.appendRow).mock.calls.find(([sheetName]) => sheetName === 'Tasks');
    expect(appendedTask).toBeTruthy();
    expect(appendedTask?.[1][TASK_SCHEMA_HEADERS.indexOf('recurrenceType')]).toBe('MONTHLY');
    expect(appendedTask?.[1][TASK_SCHEMA_HEADERS.indexOf('recurrenceDayOfMonth')]).toBe('31');
  });

  it('migrates deployed Tasks variant D before updating a task schedule', async () => {
    const variantD = [
      'taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
    ];
    const { store } = legacyRecurringStore(['T-LEGACY-D'], variantD);

    await expect(updateTaskSchedule(store as never, 'T-LEGACY-D', {
      recurrence: { type: 'WEEKLY', time: '10:00', weekdays: [2] },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
    }, '2026-08-25T09:00:00.000Z')).resolves.toMatchObject({
      taskId: 'T-LEGACY-D',
      pendingSchedule: { ruleVersion: 2, recurrence: { type: 'WEEKLY', time: '10:00', weekdays: [2] } },
    });

    expect(store.verifyAndWriteHeaderCells).toHaveBeenCalledWith(
      'Tasks',
      expect.objectContaining({ header: variantD }),
      TASK_SCHEMA_HEADERS.filter((header) => !variantD.includes(header)),
    );
    expect(store.updateCells).toHaveBeenCalled();
  });

  it('appends new task values by the live Tasks header order', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [[
          'taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds',
        ]];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(createTask(fakeStore, {
      taskId: 'T004',
      title: '일기 쓰기',
      description: '하루 정리',
      reward: 8,
      isActive: true,
      sortOrder: 4,
      allowedStudentIds: ['5630', 'S002'],
    })).resolves.toMatchObject({ allowedStudentIds: ['5630', 'S002'] });

    expect(appended).toHaveLength(1);
    expect(appended[0].values[7]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appended[0].values[8]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appended[0].values[9]).toBe('5630,S002');
  });

  it('ignores the legacy Settings time zone when creating a task without an explicit schedule', async () => {
    const scheduleHeaders = [
      'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
      'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle',
      'resetAssignmentOnCycle', 'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone',
      'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday',
      'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
    ];
    const rows: Record<string, string[][]> = {
      Tasks: [[
        'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
        'allowedStudentIds', ...scheduleHeaders,
      ]],
      Settings: [['key', 'value'], ['classTimeZone', 'UTC']],
    };
    const store = {
      async getRows(sheetName: string) { return rows[sheetName] ?? []; },
      async updateCell() {},
      async updateHeaderRow() { throw new Error('extended header must not be migrated'); },
      async appendRow(sheetName: string, values: string[]) { rows[sheetName].push(values); },
    };

    const created = await createTask(store, {
      taskId: 'T-UUID', title: '새 과제', description: '설명', reward: 3, isActive: true, sortOrder: 1,
    });
    expect(created.taskInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(created.schedule).toEqual({
      ruleVersion: 1,
      effectiveFrom: created.createdAt,
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'NONE' },
      resetCompletionOnCycle: false,
      resetAssignmentOnCycle: false,
    });
    expect(created.pendingSchedule).toBeNull();
    await expect(getTasks(store)).resolves.toEqual([created]);
  });

  it('forces an explicitly non-Seoul new task schedule to Asia/Seoul', async () => {
    const { store } = legacyRecurringStore([]);

    const created = await createTask(store, {
      taskId: 'T-SEOUL', title: '서울 과제', description: '', reward: 3, isActive: true, sortOrder: 1,
      schedule: {
        timeZone: 'Europe/Paris',
        recurrence: { type: 'DAILY', time: '17:45' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      },
    });

    expect(created.schedule).toMatchObject({
      ruleVersion: 1,
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'DAILY', time: '17:45' },
    });
    const appendedTask = vi.mocked(store.appendRow).mock.calls.find(([sheetName]) => sheetName === 'Tasks');
    expect(appendedTask?.[1][TASK_SCHEMA_HEADERS.indexOf('recurrenceTimeZone')]).toBe('Asia/Seoul');
  });

  it('rejects a partially extended Tasks schedule header without appending an incomplete row', async () => {
    let appends = 0;
    const store = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [[
          'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
          'allowedStudentIds', 'recurrenceType',
        ]];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow() { appends += 1; },
    };

    await expect(createTask(store, {
      taskId: 'T-PARTIAL', title: '불완전 헤더', description: '', reward: 1, isActive: true, sortOrder: 1,
    })).rejects.toThrow('Tasks 시트의 versioned schedule 헤더가 불완전합니다.');
    expect(appends).toBe(0);
  });

  it('fails closed when reading a Tasks sheet with only part of the versioned schedule header', async () => {
    const reader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [[
          'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'recurrenceType',
        ], [
          'T-PARTIAL', '불완전 헤더', '', '1', 'TRUE', '1', 'NONE',
        ]];
        return sheetRows[sheetName];
      },
    };

    await expect(getTasks(reader)).rejects.toThrow('Tasks 시트의 versioned schedule 헤더가 불완전합니다.');
  });

  it('fails closed when the only normalized versioned schedule header is duplicated', async () => {
    const headers = [...TASK_SCHEMA_HEADERS.slice(0, 9), 'recurrenceType', ' recurrenceType '];
    const reader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [headers];
        return sheetRows[sheetName];
      },
    };

    await expect(getTasks(reader)).rejects.toThrow('Tasks 시트의 versioned schedule 헤더가 불완전합니다.');
  });

  it('recognizes a complete whitespace-padded versioned header and writes values in its live order', async () => {
    const scheduleHeaders = [
      'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
      'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle',
      'resetAssignmentOnCycle', 'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone',
      'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday',
      'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
    ];
    const headers = [
      ' unknown ', ' title ', ...scheduleHeaders.map((header) => ` ${header} `),
      ' taskId ', ' description ', ' reward ', ' isActive ', ' sortOrder ', ' createdAt ', ' updatedAt ',
      ' allowedStudentIds ',
    ];
    const taskRows = [headers];
    const appended: string[][] = [];
    const store = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return taskRows;
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow(sheetName: string, values: string[]) {
        appended.push(values);
        if (sheetName === 'Tasks') taskRows.push(values);
      },
    };

    const created = await createTask(store, {
      taskId: 'T-PADDED', title: '공백 헤더', description: '설명', reward: 4, isActive: true, sortOrder: 9,
    });
    expect(created.taskInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.schedule).toMatchObject({ ruleVersion: 1, timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' } });
    expect(appended).toHaveLength(1);
    expect(appended[0][headers.indexOf(' unknown ')]).toBe('');
    expect(appended[0][headers.indexOf(' taskId ')]).toBe('T-PADDED');
    expect(appended[0][headers.indexOf(' taskInstanceId ')]).toBe(created.taskInstanceId);
    expect(appended[0][headers.indexOf(' recurrenceType ')]).toBe('NONE');
    await expect(getTasks(store)).resolves.toMatchObject([{
      taskId: 'T-PADDED', taskInstanceId: created.taskInstanceId,
      schedule: { ruleVersion: 1, effectiveFrom: created.schedule?.effectiveFrom, recurrence: { type: 'NONE' } },
    }]);
  });

  it('appends and updates Settings values by normalized live header coordinates', async () => {
    const appends: string[][] = [];
    const updates: Array<{ rowNumber: number; columnName: string; value: string | number }> = [];
    const rows = [
      [' unknown ', ' value ', ' key ', 'audit'],
      ['preserve', 'old', 'existing', 'metadata'],
    ];
    const store = {
      async getRows() { return rows; },
      async updateCell(_sheetName: string, rowNumber: number, columnName: string, value: string | number) {
        updates.push({ rowNumber, columnName, value });
      },
      async appendRow(_sheetName: string, values: string[]) { appends.push(values); },
    };

    await saveSheetSetting(store, { key: 'newSetting', value: 'new-value' });
    await saveSheetSetting(store, { key: 'existing', value: 'updated-value' });

    expect(appends).toEqual([['', 'new-value', 'newSetting', '']]);
    expect(updates).toEqual([{ rowNumber: 2, columnName: ' value ', value: 'updated-value' }]);
  });

  it('rejects normalized duplicate Settings headers for reads and writes', async () => {
    const appends: string[][] = [];
    const rows = [['key', 'value', ' key '], ['existing', 'old', 'conflicting']];
    const store = {
      async getRows() { return rows; },
      async updateCell() {},
      async appendRow(_sheetName: string, values: string[]) { appends.push(values); },
    };

    await expect(getSheetSettings(store)).rejects.toThrow('Settings 시트에 필수 컬럼이 없습니다');
    await expect(saveSheetSetting(store, { key: 'existing', value: 'updated' }))
      .rejects.toThrow('Settings 시트에 필수 컬럼이 없습니다');
    expect(appends).toEqual([]);
  });

  it('does not read legacy Settings when creating a versioned task schedule', async () => {
    let appends = 0;
    const headers = [
      'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
      'allowedStudentIds', 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone',
      'recurrenceType', 'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth',
      'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'pendingRuleVersion', 'pendingEffectiveFrom',
      'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday',
      'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
    ];
    const store = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [headers];
        if (sheetName === 'Settings') throw new Error('Settings must not be read');
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async appendRow() { appends += 1; },
    };
    await expect(createTask(store, {
      taskId: 'T-NO-SETTINGS', title: '새 과제', description: '', reward: 1, isActive: true, sortOrder: 1,
    })).resolves.toMatchObject({ schedule: { timeZone: 'Asia/Seoul' } });
    expect(appends).toBe(1);
  });

  it('batch updates tasks through one store call', async () => {
    const batches: Array<{ sheetName: string; updates: Array<{ rowNumber: number; columnName: string; value: string | number }> }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {
        throw new Error('single-cell update should not be used');
      },
      async updateHeaderRow() {},
      async updateCells(sheetName: 'Tasks', updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) {
        batches.push({ sheetName, updates });
      },
      async appendRow() {},
    };

    await expect(updateTaskDetailsBatch(fakeStore as never, [
      { taskId: 'T001', title: '책 읽기 수정', description: '책 20분 읽기', reward: 7, isActive: true, sortOrder: 5, allowedStudentIds: [] },
      { taskId: 'T002', title: '비활성 과제', description: '숨김', reward: 2, isActive: false, sortOrder: 2, allowedStudentIds: [] },
    ])).resolves.toEqual([
      { taskId: 'T002', title: '비활성 과제', description: '숨김', reward: 2, isActive: false, sortOrder: 2, allowedStudentIds: [] },
      { taskId: 'T001', title: '책 읽기 수정', description: '책 20분 읽기', reward: 7, isActive: true, sortOrder: 5, allowedStudentIds: [] },
    ]);

    expect(batches).toEqual([
      {
        sheetName: 'Tasks',
        updates: [
          { rowNumber: 3, columnName: 'title', value: '책 읽기 수정' },
          { rowNumber: 3, columnName: 'description', value: '책 20분 읽기' },
          { rowNumber: 3, columnName: 'reward', value: 7 },
          { rowNumber: 3, columnName: 'isActive', value: 'TRUE' },
          { rowNumber: 3, columnName: 'sortOrder', value: 5 },
          { rowNumber: 3, columnName: 'allowedStudentIds', value: '' },
          { rowNumber: 2, columnName: 'title', value: '비활성 과제' },
          { rowNumber: 2, columnName: 'description', value: '숨김' },
          { rowNumber: 2, columnName: 'reward', value: 2 },
          { rowNumber: 2, columnName: 'isActive', value: 'FALSE' },
          { rowNumber: 2, columnName: 'sortOrder', value: 2 },
          { rowNumber: 2, columnName: 'allowedStudentIds', value: '' },
        ],
      },
    ]);
  });

  it('persists an already-effective pending schedule as current and one request-time edit as the next pending version', async () => {
    const editedAt = '2026-08-25T09:30:00.000Z';
    const taskValues: Record<string, string> = {
      taskId: 'T-SCHEDULE', title: 'Read', description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', allowedStudentIds: 'S1',
      taskInstanceId: 'instance-stable', ruleVersion: '1', scheduleEffectiveFrom: '2026-08-20T00:00:00.000Z',
      recurrenceTimeZone: 'UTC', recurrenceType: 'DAILY', recurrenceTime: '08:00',
      resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
      pendingRuleVersion: '2', pendingEffectiveFrom: '2026-08-24T10:00:00.000Z', pendingTimeZone: 'UTC',
      pendingRecurrenceType: 'WEEKLY', pendingRecurrenceTime: '09:00', pendingRecurrenceWeekday: '1',
      pendingResetCompletionOnCycle: 'FALSE', pendingResetAssignmentOnCycle: 'FALSE',
    };
    const rows: Record<string, string[][]> = {
      Tasks: [[...TASK_SCHEMA_HEADERS, 'customMetadata'], [
        ...TASK_SCHEMA_HEADERS.map((header) => taskValues[header] ?? ''), 'preserve-me',
      ]],
      TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS, 'customCompletionMetadata']],
      TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS, 'customAssignmentMetadata']],
    };
    const batches: Array<{ sheetName: string; updates: Array<{ rowNumber: number; columnName: string; value: string | number }> }> = [];
    const store = {
      async getRows(sheetName: string) { return rows[sheetName] ?? []; },
      async lookupSheet() { return { found: true as const, info: { sheetId: 1, title: 'TaskAssignments', columnCount: TASK_ASSIGNMENT_HEADERS.length + 1 } }; },
      async updateCell() { throw new Error('single-cell update should not be used'); },
      async updateCells(sheetName: string, updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) {
        batches.push({ sheetName, updates });
      },
      async updateHeaderRow() { throw new Error('current schema must not be migrated'); },
      async appendRow() { throw new Error('schedule edit must not append history or money rows'); },
    };

    const result = await updateTaskDetailsBatch(store as never, [{
      taskId: 'T-SCHEDULE', title: 'Read edited', description: '', reward: 5, isActive: true, sortOrder: 1,
      allowedStudentIds: ['S1'],
      schedule: {
        recurrence: { type: 'MONTHLY', time: '10:15', dayOfMonth: 15 }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
      },
    }], editedAt);

    expect(result[0]).toMatchObject({
      taskId: 'T-SCHEDULE', taskInstanceId: 'instance-stable',
      schedule: { ruleVersion: 2, effectiveFrom: '2026-08-24T10:00:00.000Z', recurrence: { type: 'WEEKLY' } },
      pendingSchedule: {
        ruleVersion: 3, effectiveFrom: editedAt, timeZone: 'Asia/Seoul',
        recurrence: { type: 'MONTHLY', time: '10:15', dayOfMonth: 15 },
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
      },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].sheetName).toBe('Tasks');
    const saved = new Map(batches[0].updates.map((update) => [update.columnName, update.value]));
    expect(saved.get('taskInstanceId')).toBe('instance-stable');
    expect(saved.get('ruleVersion')).toBe('2');
    expect(saved.get('scheduleEffectiveFrom')).toBe('2026-08-24T10:00:00.000Z');
    expect(saved.get('pendingRuleVersion')).toBe('3');
    expect(saved.get('pendingEffectiveFrom')).toBe(editedAt);
    expect(saved.get('pendingRecurrenceType')).toBe('MONTHLY');
    expect(saved.get('updatedAt')).toBe(editedAt);
    expect(rows.TaskAssignments[0].at(-1)).toBe('customAssignmentMetadata');
  });

  it('forces a direct updateTaskDetails schedule edit to Asia/Seoul without rewriting historical current time zone', async () => {
    const { store } = versionedScheduleMutationStore();

    const updated = await updateTaskDetails(
      store as never,
      'T-SERIAL',
      scheduleUpdate({ type: 'DAILY', time: '09:00' }),
      '2026-08-25T09:00:00.000Z',
    );

    expect(updated.schedule?.timeZone).toBe('UTC');
    expect(updated.pendingSchedule?.timeZone).toBe('Asia/Seoul');
    const taskRows = await store.getRows('Tasks');
    expect(taskRows[1][TASK_SCHEMA_HEADERS.indexOf('recurrenceTimeZone')]).toBe('UTC');
    expect(taskRows[1][TASK_SCHEMA_HEADERS.indexOf('pendingTimeZone')]).toBe('Asia/Seoul');
  });

  it('forces a direct updateTaskSchedule edit to Asia/Seoul without rewriting historical current time zone', async () => {
    const { store } = versionedScheduleMutationStore();

    const updated = await updateTaskSchedule(store as never, 'T-SERIAL', {
      recurrence: { type: 'WEEKLY', time: '10:00', weekdays: [2] },
      timeZone: 'Europe/Paris',
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: false,
    }, '2026-08-25T09:00:00.000Z');

    expect(updated.schedule?.timeZone).toBe('UTC');
    expect(updated.pendingSchedule?.timeZone).toBe('Asia/Seoul');
    const taskRows = await store.getRows('Tasks');
    expect(taskRows[1][TASK_SCHEMA_HEADERS.indexOf('recurrenceTimeZone')]).toBe('UTC');
    expect(taskRows[1][TASK_SCHEMA_HEADERS.indexOf('pendingTimeZone')]).toBe('Asia/Seoul');
  });

  it('serializes concurrent single schedule edits in the process-global task mutation queue', async () => {
    const { store, writes } = versionedScheduleMutationStore(undefined, true);
    const [first, second] = await Promise.all([
      updateTaskDetails(store as never, 'T-SERIAL', scheduleUpdate({ type: 'DAILY', time: '09:00' }), '2026-08-25T09:00:00.000Z'),
      updateTaskDetails(store as never, 'T-SERIAL', scheduleUpdate({ type: 'WEEKLY', time: '10:00', weekdays: [2] }), '2026-08-25T09:01:00.000Z'),
    ]);

    expect(first.pendingSchedule?.ruleVersion).toBe(2);
    expect(second.schedule?.ruleVersion).toBe(2);
    expect(second.pendingSchedule?.ruleVersion).toBe(3);
    expect(writes).toEqual([
      { ruleVersion: '1', pendingRuleVersion: '2' },
      { ruleVersion: '2', pendingRuleVersion: '3' },
    ]);
  });

  it('preserves a preceding queued general edit when applying a schedule-only command', async () => {
    const { store } = versionedScheduleMutationStore(undefined, true);
    const [, scheduled] = await Promise.all([
      updateTaskDetails(store as never, 'T-SERIAL', {
        title: 'Latest title', description: 'Latest description', reward: 9,
        isActive: false, sortOrder: 7, allowedStudentIds: ['S2'],
      }, '2026-08-25T09:00:00.000Z'),
      updateTaskSchedule(store as never, 'T-SERIAL', {
        recurrence: { type: 'WEEKLY', time: '10:00', weekdays: [2] },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
      }, '2026-08-25T09:01:00.000Z'),
    ]);

    expect(scheduled).toMatchObject({
      title: 'Latest title', description: 'Latest description', reward: 9,
      isActive: false, sortOrder: 7, allowedStudentIds: ['S2'],
      pendingSchedule: { ruleVersion: 2, timeZone: 'Asia/Seoul' },
    });
  });

  it('observes a default single-edit timestamp only after earlier queued operations finish', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T09:00:00.000Z'));
    let releaseBlocker!: () => void;
    const blocker = enqueueTaskCommand(taskCommandQueueKey(''), () =>
      new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    await Promise.resolve();

    const { store } = versionedScheduleMutationStore();
    const edit = updateTaskDetails(
      store as never,
      'T-SERIAL',
      scheduleUpdate({ type: 'DAILY', time: '09:00' }),
    );
    vi.setSystemTime(new Date('2026-08-25T09:01:00.000Z'));
    releaseBlocker();
    await blocker;

    await expect(edit).resolves.toMatchObject({
      pendingSchedule: { effectiveFrom: '2026-08-25T09:01:00.000Z' },
    });
  });

  it('applies an out-of-order explicit edit immediately and supersedes the future pending version', async () => {
    const { store, writes } = versionedScheduleMutationStore();
    const first = await updateTaskDetails(
      store as never,
      'T-SERIAL',
      scheduleUpdate({ type: 'DAILY', time: '09:00' }),
      '2026-08-25T09:01:00.000Z',
    );
    const second = await updateTaskDetails(
      store as never,
      'T-SERIAL',
      scheduleUpdate({ type: 'WEEKLY', time: '10:00', weekdays: [2] }),
      '2026-08-25T09:00:00.000Z',
    );

    expect(first).toMatchObject({
      taskInstanceId: 'instance-serial',
      schedule: { ruleVersion: 1 },
      pendingSchedule: { ruleVersion: 2, effectiveFrom: '2026-08-25T09:01:00.000Z' },
    });
    expect(second).toMatchObject({
      taskInstanceId: 'instance-serial',
      schedule: { ruleVersion: 1, recurrence: { type: 'DAILY', time: '08:00' } },
      pendingSchedule: {
        ruleVersion: 3,
        effectiveFrom: '2026-08-25T09:00:00.000Z',
        recurrence: { type: 'WEEKLY', time: '10:00', weekdays: [2] },
      },
    });
    expect(writes).toEqual([
      { ruleVersion: '1', pendingRuleVersion: '2' },
      { ruleVersion: '1', pendingRuleVersion: '3' },
    ]);
  });

  it('uses the same process-global queue for concurrent single and batch schedule edits', async () => {
    const { store, writes } = versionedScheduleMutationStore(undefined, true);
    const [single, batch] = await Promise.all([
      updateTaskDetails(store as never, 'T-SERIAL', scheduleUpdate({ type: 'DAILY', time: '09:00' }), '2026-08-25T09:00:00.000Z'),
      updateTaskDetailsBatch(store as never, [{
        taskId: 'T-SERIAL',
        ...scheduleUpdate({ type: 'WEEKLY', time: '10:00', weekdays: [2] }),
      }], '2026-08-25T09:01:00.000Z'),
    ]);

    expect(single.pendingSchedule?.ruleVersion).toBe(2);
    expect(batch[0].schedule?.ruleVersion).toBe(2);
    expect(batch[0].pendingSchedule?.ruleVersion).toBe(3);
    expect(writes.map((write) => write.pendingRuleVersion)).toEqual(['2', '3']);
  });

  it.each([
    ['current', 'INVALID_CURRENT_SCHEDULE'],
    ['pending', 'INVALID_PENDING_SCHEDULE'],
  ] as const)('rejects a malformed persisted %s schedule before migration or task writes', async (warning, warningCode) => {
    const { store, migrationWrite, taskWrite } = versionedScheduleMutationStore(warning);

    await expect(updateTaskDetails(
      store as never,
      'T-SERIAL',
      scheduleUpdate({ type: 'DAILY', time: '09:00' }),
      '2026-08-25T09:00:00.000Z',
    )).rejects.toThrow(`과제 일정 데이터가 손상되었습니다 (${warningCode}). 일정을 먼저 복구해 주세요.`);
    expect(migrationWrite).not.toHaveBeenCalled();
    expect(taskWrite).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();
  });

  it('validates an invalid single schedule edit before recurring migration writes', async () => {
    const { store, migrationWrite } = legacyRecurringStore(['T1']);
    await expect(updateTaskDetails(store as never, 'T1', {
      title: '', description: '', reward: 1, isActive: true, sortOrder: 1,
      schedule: { recurrence: { type: 'NONE' }, timeZone: 'UTC', resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    })).rejects.toThrow('과제명을 입력해 주세요.');
    expect(migrationWrite).not.toHaveBeenCalled();
  });

  it('validates batch duplicates and missing targets before recurring migration writes', async () => {
    const scheduled = (taskId: string) => ({
      taskId, title: 'Task', description: '', reward: 1, isActive: true, sortOrder: 1,
      schedule: { recurrence: { type: 'NONE' } as const, timeZone: 'UTC', resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    });
    const duplicate = legacyRecurringStore(['T1']);
    await expect(updateTaskDetailsBatch(duplicate.store as never, [scheduled('T1'), scheduled('T1')]))
      .rejects.toThrow('중복된 과제 ID가 있습니다: T1');
    expect(duplicate.migrationWrite).not.toHaveBeenCalled();

    const missing = legacyRecurringStore(['T1']);
    await expect(updateTaskDetailsBatch(missing.store as never, [scheduled('missing')]))
      .rejects.toThrow('과제를 찾을 수 없습니다: missing');
    expect(missing.migrationWrite).not.toHaveBeenCalled();
  });

  it('validates reset and delete targets before recurring migration writes', async () => {
    const reset = legacyRecurringStore(['T1']);
    await expect(resetTaskCompletionsBatch(reset.store as never, ['missing']))
      .rejects.toThrow('과제를 찾을 수 없습니다: missing');
    expect(reset.migrationWrite).not.toHaveBeenCalled();

    const singleDelete = legacyRecurringStore(['T1']);
    await expect(deleteTask(singleDelete.store as never, 'missing')).rejects.toThrow('과제를 찾을 수 없습니다.');
    expect(singleDelete.migrationWrite).not.toHaveBeenCalled();

    const batchDelete = legacyRecurringStore(['T1']);
    await expect(deleteTasksBatch(batchDelete.store as never, ['missing']))
      .rejects.toThrow('과제를 찾을 수 없습니다: missing');
    expect(batchDelete.migrationWrite).not.toHaveBeenCalled();
  });

  it('deletes legacy task definitions without migrating recurring ledgers or headers', async () => {
    const single = legacyRecurringStore(['T1']);
    await expect(deleteTask(single.store as never, 'T1')).resolves.toMatchObject({ taskDefinitionDeleted: true });
    expect(single.migrationWrite).not.toHaveBeenCalled();
    expect(single.store.deleteRow).toHaveBeenCalledWith('Tasks', 2);

    const batch = legacyRecurringStore(['T1', 'T2']);
    await expect(deleteTasksBatch(batch.store as never, ['T1', 'T2'])).resolves.toMatchObject({ deletedTaskCount: 2 });
    expect(batch.migrationWrite).not.toHaveBeenCalled();
    expect(batch.store.deleteRows).toHaveBeenCalledWith('Tasks', [2, 3]);
  });

  it('rejects deleting a task that is still referenced as a prerequisite', async () => {
    const fixture = legacyRecurringStore(['A', 'B'], TASK_SCHEMA_HEADERS);
    const originalGetRows = fixture.store.getRows.bind(fixture.store);
    fixture.store.getRows = vi.fn(async (sheetName: string) => {
      const rows = await originalGetRows(sheetName);
      if (sheetName === 'Tasks') rows[2][TASK_SCHEMA_HEADERS.indexOf('prerequisiteTaskId')] = 'A';
      return rows;
    });

    await expect(deleteTask(fixture.store as never, 'A')).rejects.toThrow('선행 과제');
    expect(fixture.store.deleteRow).not.toHaveBeenCalled();
    await expect(deleteTasksBatch(fixture.store as never, ['A', 'B'])).resolves.toMatchObject({ deletedTaskCount: 2 });
  });

  it('serializes delete behind an earlier prerequisite update so it cannot create a dangling reference', async () => {
    const fixture = legacyRecurringStore(['A', 'B'], TASK_SCHEMA_HEADERS);
    const originalGetRows = fixture.store.getRows.bind(fixture.store);
    const rows = await originalGetRows('Tasks');
    fixture.store.getRows = vi.fn(async (sheetName: string) => sheetName === 'Tasks'
      ? rows.map((row) => [...row])
      : originalGetRows(sheetName));
    fixture.store.updateCells = vi.fn(async (_sheetName: string, updates: Array<{ rowNumber: number; columnName: string; value: string | number }>) => {
      for (const update of updates) rows[update.rowNumber - 1][rows[0].indexOf(update.columnName)] = String(update.value);
    });
    fixture.store.deleteRow = vi.fn(async (_sheetName: string, rowNumber: number) => { rows.splice(rowNumber - 1, 1); });

    let releaseBlocker!: () => void;
    const blocker = enqueueTaskCommand(taskCommandQueueKey(''), () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    await Promise.resolve();
    const update = updateTaskDetails(fixture.store as never, 'B', {
      title: 'B', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [], prerequisiteTaskId: 'A',
    });
    const deletion = deleteTask(fixture.store as never, 'A');

    releaseBlocker();
    await blocker;
    const [updateResult, deletionResult] = await Promise.allSettled([update, deletion]);
    expect(updateResult).toMatchObject({ status: 'fulfilled', value: { taskId: 'B', prerequisiteTaskId: 'A' } });
    expect(deletionResult.status).toBe('rejected');
    if (deletionResult.status === 'rejected') expect(String(deletionResult.reason)).toContain('선행 과제');
    expect(fixture.store.deleteRow).not.toHaveBeenCalled();
  });

  it('deletes task definitions without deleting completion history', async () => {
    const deletedBatches: Array<{ sheetName: string; rowNumbers: number[] }> = [];
    const cellUpdates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) { cellUpdates.push({ sheetName, rowNumber, columnName, value }); },
      async updateHeaderRow() {},
      async appendRow() {},
      async deleteRows(sheetName: 'Tasks' | 'TaskCompletions', rowNumbers: number[]) {
        deletedBatches.push({ sheetName, rowNumbers });
      },
    };

    await expect(deleteTasksBatch(withRecurringMigration(fakeStore) as never, ['T001', 'T002', 'T001'])).resolves.toEqual({
      taskIds: ['T001', 'T002'], deletedTaskCount: 2, deletedCompletionCount: 0,
    });

    expect(deletedBatches).toEqual([
      { sheetName: 'Tasks', rowNumbers: [3, 2] },
    ]);
    expect(cellUpdates).toEqual([]);
  });

  it('deletes a single task while retaining its completion rows', async () => {
    const deletedRows: Array<{ sheetName: string; rowNumber: number }> = [];
    const deletedBatches: Array<{ sheetName: string; rowNumbers: number[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow() {},
      async deleteRow(sheetName: 'Tasks' | 'TaskCompletions', rowNumber: number) {
        deletedRows.push({ sheetName, rowNumber });
      },
      async deleteRows(sheetName: 'Tasks' | 'TaskCompletions', rowNumbers: number[]) {
        deletedBatches.push({ sheetName, rowNumbers });
      },
    };

    await expect(deleteTask(withRecurringMigration(fakeStore) as never, 'T001')).resolves.toEqual({
      taskId: 'T001', taskDefinitionDeleted: true, deletedCompletionCount: 0,
    });
    expect(deletedBatches).toEqual([]);
    expect(deletedRows).toEqual([{ sheetName: 'Tasks', rowNumber: 3 }]);
  });

  it('does not rewrite current schemas and preserves unknown trailing columns before delete', async () => {
    const taskValues: Record<string, string> = {
      taskId: 'T-CURRENT', title: 'Current', description: '', reward: '1', isActive: 'TRUE', sortOrder: '1',
      createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', allowedStudentIds: '',
      taskInstanceId: 'current-instance', ruleVersion: '1', scheduleEffectiveFrom: '2026-02-01T00:00:00Z',
      recurrenceTimeZone: 'UTC', recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
    };
    const rows: Record<string, string[][]> = {
      Tasks: [[...TASK_SCHEMA_HEADERS, 'customTaskMetadata'], [
        ...TASK_SCHEMA_HEADERS.map((header) => taskValues[header] ?? ''), 'preserve-task',
      ]],
      TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS, 'customCompletionMetadata']],
      TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS]],
    };
    const migrationWrite = vi.fn();
    const deleteRow = vi.fn();
    const store = {
      async getRows(sheetName: string) { return rows[sheetName].map((row) => [...row]); },
      async updateCell() {},
      async appendRow() {},
      deleteRow,
      async lookupSheet(sheetName: string) {
        return { found: true as const, info: { sheetId: 1, title: sheetName, columnCount: rows[sheetName][0].length } };
      },
      createSheetWithHeader: migrationWrite,
      ensureColumnCount: migrationWrite,
      writeHeaderCells: migrationWrite,
      verifyHeaderCells: migrationWrite,
      verifyAndWriteHeaderCells: migrationWrite,
    };

    await expect(deleteTask(store as never, 'T-CURRENT')).resolves.toMatchObject({ taskDefinitionDeleted: true });
    expect(migrationWrite).not.toHaveBeenCalled();
    expect(deleteRow).toHaveBeenCalledWith('Tasks', 2);
    expect(rows.Tasks[0].at(-1)).toBe('customTaskMetadata');
    expect(rows.Tasks[1].at(-1)).toBe('preserve-task');
    expect(rows.TaskCompletions[0].at(-1)).toBe('customCompletionMetadata');
  });

  it('keeps deleted-task ledgers queryable without invoking write capabilities', async () => {
    const writes = vi.fn();
    const reader = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS]];
        if (sheetName === 'TaskAssignments') return [
          ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'],
          ['A-old', 'T1', 'old-instance', 'old-cycle', '2026-01-01T00:00:00Z', '', '1', 'Asia/Seoul', 'S1', 'ASSIGNED', 'ADMIN', '', '2026-01-01T00:00:00Z', '2', ''],
        ];
        if (sheetName === 'TaskCompletions') return [
          ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion'],
          ['C-old', '2026-01-02T00:00:00Z', 'T1', 'S1', 'Student', '5', '0', '5', 'SUCCESS', '', 'old-instance', 'old-cycle', '2026-01-01T00:00:00Z', '', '1', 'Asia/Seoul', 'BANK', 'A-old', '2'],
        ];
        if (sheetName === 'Settings') return sheetRows.Settings;
        return [];
      },
      appendRow: writes, updateCell: writes, deleteRow: writes, deleteRows: writes,
    };

    const detail = await getTaskHistoryDetail(reader, { taskId: 'T1', taskInstanceId: 'old-instance' });
    expect(detail.currentLifecycle).toEqual({ taskDefinitionExists: false, taskInstanceId: null, currentCycleStatus: null });
    expect(detail.cumulativeHistory.eventCount).toBe(2);
    expect(detail.cumulativeHistory.lifecycles[0]).toMatchObject({ taskInstanceId: 'old-instance', eventCount: 2 });
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns the current reused definition while filtering cumulative detail to an old lifecycle', async () => {
    const currentTask = [
      'T1', 'Current definition', '', '5', 'TRUE', '1', '2026-02-01T00:00:00Z',
      '2026-02-01T00:00:00Z', 'S1', 'current-instance', '1', '2026-02-01T00:00:00Z',
      'UTC', 'NONE', '', '', '', 'FALSE', 'FALSE', '', '', '', '', '', '', '', '', '',
    ];
    const reader = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], currentTask];
        if (sheetName === 'TaskAssignments') return [
          ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'],
          ['A-old', 'T1', 'old-instance', 'old-cycle', '2026-01-01T00:00:00Z', '', '1', 'UTC', 'S1', 'ASSIGNED', 'ADMIN', '', '2026-01-01T00:00:00Z', '2', ''],
        ];
        if (sheetName === 'TaskCompletions') return [[
          'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note',
          'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion',
        ]];
        if (sheetName === 'Settings') return sheetRows.Settings;
        return [];
      },
    };

    const detail = await getTaskHistoryDetail(
      reader,
      { taskId: 'T1', taskInstanceId: 'old-instance' },
      '2026-02-02T00:00:00Z',
    );
    expect(detail.currentLifecycle).toMatchObject({
      taskDefinitionExists: true,
      taskInstanceId: 'current-instance',
      currentCycleStatus: { transition: 'PERMANENT' },
    });
    expect(detail.cumulativeHistory).toMatchObject({
      eventCount: 1,
      lifecycles: [{ taskInstanceId: 'old-instance', isCurrentLifecycle: false, eventCount: 1 }],
    });
  });

  it('returns a truthful reset event count alias without deleting ledger rows', async () => {
    await expect(resetTaskCompletionsBatch(withRecurringMigration({
      ...fakeReader,
      async updateCell() {},
      async appendRow() {},
    } as unknown as LocalStore) as never, ['T002'])).resolves.toEqual({
      taskIds: ['T002'], resetEventsAppended: 0, deletedCount: 0,
    });
  });



  it('migrates legacy task headers before saving assignments so restrictions persist', async () => {
    const rows = {
      ...sheetRows,
      Tasks: [
        ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder'],
        ['T010', '지정 과제', '선택 학생만', '10', '1', 'TRUE', '1'],
      ],
      Students: [sheetRows.Students[0], sheetRows.Students[1], ['S002', '이서연', '1200', 'S002', 'ACTIVE', '']],
      TaskCompletions: [sheetRows.TaskCompletions[0]],
    };
    const headerUpdates: Array<{ sheetName: string; headers: string[] }> = [];
    const cellUpdates: Array<{ rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const store = {
      async getRows(sheetName: keyof typeof rows) { return rows[sheetName]; },
      async updateCell(_sheetName: string, rowNumber: number, columnName: string, value: string | number) {
        cellUpdates.push({ rowNumber, columnName, value });
        const columnIndex = rows.Tasks[0].indexOf(columnName);
        if (columnIndex >= 0) rows.Tasks[rowNumber - 1][columnIndex] = String(value);
      },
      async updateHeaderRow(sheetName: keyof typeof rows, headers: string[]) {
        headerUpdates.push({ sheetName, headers });
        rows[sheetName][0] = headers;
      },
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(updateTaskDetails(store as never, 'T010', {
      title: '지정 과제',
      description: '선택 학생만',
      reward: 10,
      isActive: true,
      sortOrder: 1,
      allowedStudentIds: ['S001'],
    })).resolves.toMatchObject({ allowedStudentIds: ['S001'] });

    expect(headerUpdates).toEqual([
      { sheetName: 'Tasks', headers: ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'] },
    ]);
    expect(cellUpdates).toContainEqual({ rowNumber: 2, columnName: 'allowedStudentIds', value: 'S001' });

    await expect(completeTaskForStudent(withRecurringMigration(store) as never, 'T010', 'S002')).rejects.toThrow('허가되지 않은 과제입니다.');
    expect(appended.some((row) => row.sheetName === 'TaskCompletions')).toBe(false);
  });



  it('reads task assignment and completion status from legacy sheets without createdAt', async () => {
    await expect(getTaskAssignmentStatus(fakeReader, 'T001')).resolves.toMatchObject({
      taskId: 'T001',
      transition: 'PERMANENT',
      students: [
        { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'LEGACY', completionOrigin: 'LEGACY' },
      ],
    });
  });

  it('exposes the latest physical assignment event source in the student status DTO without writes', async () => {
    const values: Record<string, string> = {
      taskId: 'T-SOURCE', title: 'Source task', description: '', reward: '1', isActive: 'TRUE', sortOrder: '1',
      createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z', allowedStudentIds: '',
      taskInstanceId: 'instance-source', ruleVersion: '1', scheduleEffectiveFrom: '2026-08-20T00:00:00Z',
      recurrenceTimeZone: 'UTC', recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE',
    };
    const assignmentRows: string[][] = [[...TASK_ASSIGNMENT_HEADERS]];
    const writes = vi.fn();
    const reader = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '')];
        if (sheetName === 'Students') return [['studentId', 'name', 'balance', 'status'], ['S1', 'Student', '0', 'ACTIVE']];
        if (sheetName === 'TaskAssignments') return assignmentRows;
        if (sheetName === 'TaskCompletions') return [[...TASK_COMPLETION_SCHEMA_HEADERS]];
        return [];
      },
      appendRow: writes, updateCell: writes, updateCells: writes, updateHeaderRow: writes,
    };
    const state = await getTaskCycleState(reader, 'T-SOURCE', '2026-08-25T00:00:00Z');
    const event = (assignmentId: string, source: 'ADMIN' | 'QR', createdAt: string) =>
      TASK_ASSIGNMENT_HEADERS.map((header) => ({
        assignmentId, taskId: 'T-SOURCE', taskInstanceId: 'instance-source', cycleId: state.cycle.cycleId,
        cycleStartsAt: state.cycle.startsAt, cycleEndsAt: state.cycle.endsAt ?? '', ruleVersion: '1', timeZone: 'UTC',
        studentId: 'S1', status: 'ASSIGNED', source, previousAssignmentId: '', createdAt, schemaVersion: '2', note: '',
      }[header] ?? ''));
    assignmentRows.push(
      event('A-admin', 'ADMIN', '2026-08-25T10:00:00Z'),
      event('A-qr', 'QR', '2026-08-25T01:00:00Z'),
    );

    await expect(getTaskAssignmentStatus(reader, 'T-SOURCE')).resolves.toMatchObject({
      students: [{ studentId: 'S1', assignmentOrigin: 'EVENT', assignmentSource: 'QR' }],
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('exposes a pure repository cycle query without invoking any write capability', async () => {
    let writes = 0;
    const store = {
      ...fakeReader,
      async appendRow() { writes += 1; },
      async updateCell() { writes += 1; },
      async updateCells() { writes += 1; },
      async updateHeaderRow() { writes += 1; },
    };

    await expect(getTaskCycleState(store, 'T001', '2026-08-25T00:00:00Z')).resolves.toMatchObject({
      taskId: 'T001',
      transition: 'PERMANENT',
      students: { S001: { assigned: true, completed: true } },
    });
    expect(writes).toBe(0);
  });

  it('does not treat malformed numeric createdAt values as a task-instance boundary', async () => {
    const reader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [
          ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'],
          ['T001', '책 읽기', '책 10분 읽기', '5', '2', 'TRUE', '1', '5630', '2026-06-05T00:00:00.000Z', 'S001'],
        ];
        return sheetRows[sheetName];
      },
    };

    await expect(getTaskAssignmentStatus(reader, 'T001')).resolves.toMatchObject({
      taskId: 'T001',
      transition: 'PERMANENT',
      students: [
        { studentId: 'S001', name: '김민준', assigned: true, completed: true, assignmentOrigin: 'LEGACY', completionOrigin: 'LEGACY' },
      ],
    });
  });

  it('keeps assignment GET projection write-free; assignment commands are covered by the append-only command suite', async () => {
    const writes = vi.fn();
    const reader = {
      ...fakeReader,
      appendRow: writes,
      updateCell: writes,
      deleteRow: writes,
      deleteRows: writes,
    };
    await getTaskAssignmentStatus(reader, 'T001');
    expect(writes).not.toHaveBeenCalled();
  });


  it('stores task assignment student IDs only and rejects unassigned students', async () => {
    const taskReader = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [
          ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds'],
          ['T010', '지정 과제', '선택 학생만', '10', '1', 'TRUE', '1', 'S001, S003'],
        ];
        if (sheetName === 'Students') return [sheetRows.Students[0], sheetRows.Students[1], ['S002', '이서연', '1200', 'S002', 'ACTIVE', '']];
        return sheetRows[sheetName];
      },
    };

    await expect(getTasks(taskReader)).resolves.toEqual([
      {
        taskId: 'T010', title: '지정 과제', description: '선택 학생만', reward: 10, isActive: true,
        sortOrder: 1, allowedStudentIds: ['S001', 'S003'],
        taskInstanceId: 'legacy:T010:1970-01-01T00:00:00.000Z',
        schedule: {
          ruleVersion: 1, effectiveFrom: '1970-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
          recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false,
        },
        pendingSchedule: null,
      },
    ]);

    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const store = {
      ...taskReader,
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(completeTaskForStudent(withRecurringMigration(store) as never, 'T010', 'S002')).rejects.toThrow('허가되지 않은 과제입니다.');
    await expect(completeTaskForStudent(withRecurringMigration(store) as never, 'T010', 'S001')).resolves.toMatchObject({ student: { studentId: 'S001' } });
    expect(appended.some((row) => row.sheetName === 'TaskCompletions')).toBe(true);
  });


  it('rejects completion when a task has no assigned students', async () => {
    const fakeStore = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [
          ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds'],
          ['T099', '미부여 과제', '아직 학생을 고르지 않음', '10', '1', 'TRUE', '1', ''],
        ];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow() {},
    };

    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T099', 'S001')).rejects.toThrow('부여된 학생이 없습니다.');
  });

  it('rejects expired completion before any balance or ledger mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    const writes = vi.fn();
    const values: Record<string, string> = {
      taskId: 'T-WINDOW', title: 'Expired', description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
      allowedStudentIds: 'S001', dueAt: '2026-08-27T00:00:00Z',
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '')];
        if (sheetName === 'Students') return [sheetRows.Students[0], sheetRows.Students[1]];
        if (sheetName === 'TaskAssignments') return [[...TASK_ASSIGNMENT_HEADERS]];
        if (sheetName === 'TaskCompletions') return [[...TASK_COMPLETION_SCHEMA_HEADERS]];
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      updateCell: writes, updateCells: writes, appendRow: writes,
    };

    await expect(completeTaskForStudent(store as never, 'T-WINDOW', 'S001')).rejects.toThrow('현재 완료할 수');
    expect(writes).not.toHaveBeenCalled();
  });

  it('revalidates availability after a queued wait crosses dueAt before any mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T23:59:59Z'));
    let releaseBlocker!: () => void;
    const blocker = enqueueTaskCommand(taskCommandQueueKey(''), () =>
      new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    await Promise.resolve();
    const writes = vi.fn();
    const values: Record<string, string> = {
      taskId: 'T-QUEUE-DUE', title: 'Deadline', description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
      allowedStudentIds: 'S001', dueAt: '2026-08-27T00:00:00Z',
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '')];
        if (sheetName === 'Students') return [sheetRows.Students[0], sheetRows.Students[1]];
        if (sheetName === 'TaskAssignments') return [[...TASK_ASSIGNMENT_HEADERS]];
        if (sheetName === 'TaskCompletions') return [[...TASK_COMPLETION_SCHEMA_HEADERS]];
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      updateCell: writes, updateCells: writes, appendRow: writes,
    };

    const completion = completeTaskForStudent(store as never, 'T-QUEUE-DUE', 'S001');
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    releaseBlocker();
    await blocker;

    await expect(completion).rejects.toThrow('현재 완료할 수');
    expect(writes).not.toHaveBeenCalled();
  });

  it('checks the prerequisite current cycle before any balance or ledger mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    const writes = vi.fn();
    const taskValues = (taskId: string, title: string, prerequisiteTaskId = '') => {
      const values: Record<string, string> = {
        taskId, title, description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
        allowedStudentIds: 'S001', prerequisiteTaskId,
      };
      return TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '');
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], taskValues('PRE', '먼저'), taskValues('MAIN', '나중', 'PRE')];
        if (sheetName === 'Students') return [sheetRows.Students[0], sheetRows.Students[1]];
        if (sheetName === 'TaskAssignments') return [[...TASK_ASSIGNMENT_HEADERS]];
        if (sheetName === 'TaskCompletions') return [[...TASK_COMPLETION_SCHEMA_HEADERS]];
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      updateCell: writes, updateCells: writes, appendRow: writes,
    };

    await expect(completeTaskForStudent(store as never, 'MAIN', 'S001')).rejects.toThrow("선행 과제 '먼저'");
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects an expired prerequisite before mutation even when its legacy completion exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    const writes = vi.fn();
    const taskValues = (taskId: string, title: string, prerequisiteTaskId = '', dueAt = '') => {
      const values: Record<string, string> = {
        taskId, title, description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
        allowedStudentIds: 'S001', prerequisiteTaskId, dueAt,
      };
      return TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '');
    };
    const completionValues: Record<string, string> = {
      completionId: 'C-PRE', timestamp: '2026-08-26T00:00:00Z', taskId: 'PRE',
      studentId: 'S001', studentName: '학생', reward: '5', balanceBefore: '0', balanceAfter: '5', status: 'SUCCESS',
    };
    const store = {
      async getRows(sheetName: string) {
        if (sheetName === 'Tasks') return [[...TASK_SCHEMA_HEADERS], taskValues('PRE', '먼저', '', '2026-08-27T00:00:00Z'), taskValues('MAIN', '나중', 'PRE')];
        if (sheetName === 'Students') return [sheetRows.Students[0], sheetRows.Students[1]];
        if (sheetName === 'TaskAssignments') return [[...TASK_ASSIGNMENT_HEADERS]];
        if (sheetName === 'TaskCompletions') return [[...TASK_COMPLETION_SCHEMA_HEADERS], TASK_COMPLETION_SCHEMA_HEADERS.map((header) => completionValues[header] ?? '')];
        return sheetRows[sheetName as keyof typeof sheetRows] ?? [];
      },
      updateCell: writes, updateCells: writes, appendRow: writes,
    };

    await expect(completeTaskForStudent(withRecurringMigration(store as never) as never, 'MAIN', 'S001')).rejects.toThrow("선행 과제 '먼저'은(는) 현재 완료할 수 없습니다");
    expect(writes).not.toHaveBeenCalled();
  });

  it('completes a task once, pays reward, and records completion', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'TaskCompletions') return [sheetRows.TaskCompletions[0]];
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) { updates.push({ sheetName, rowNumber, columnName, value }); },
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };
    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).resolves.toMatchObject({ student: { studentId: 'S001', balance: 3505 } });
    expect(updates).toContainEqual({ sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3505 });
    expect(appended.some((row) => row.sheetName === 'TaskCompletions')).toBe(true);
  });

  it('obtains the TaskCompletions header before changing a student balance', async () => {
    const events: string[] = [];
    let completionReads = 0;
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'TaskCompletions') {
          completionReads += 1;
          events.push('read:TaskCompletions');
          return [sheetRows.TaskCompletions[0]];
        }
        return sheetRows[sheetName];
      },
      async updateCell() { events.push('update'); },
      async updateHeaderRow() {},
      async appendRow() {},
    };

    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).resolves.toMatchObject({ student: { balance: 3505 } });
    expect(completionReads).toBe(1);
    expect(events[0]).toBe('read:TaskCompletions');
    expect(events.indexOf('read:TaskCompletions')).toBeLessThan(events.indexOf('update'));
  });

  it('attempts a canonical task reward transaction append when its header read fails', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    let transactionReads = 0;
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'TaskCompletions') return [sheetRows.TaskCompletions[0]];
        if (sheetName === 'Transactions' && transactionReads++ === 0) throw new Error('Transactions header read failed');
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).resolves.toMatchObject({ student: { balance: 3505 } });
    expect(appended.find((row) => row.sheetName === 'Transactions')?.values.slice(2, 10)).toEqual([
      'S001', '김민준', expect.stringContaining('T001'), '-5', '3500', '3505', 'TASK_REWARD', 'bank',
    ]);
  });

  it('applies task rewards against a negative balance first', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Students') return [sheetRows.Students[0], ['S001', '김민준', '-1', 'S001', 'ACTIVE', '']];
        if (sheetName === 'Tasks') return [sheetRows.Tasks[0], ['T001', '책 읽기', '책 10분 읽기', '2', '2', 'TRUE', '1', 'S001']];
        if (sheetName === 'TaskCompletions') return [sheetRows.TaskCompletions[0]];
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) { updates.push({ sheetName, rowNumber, columnName, value }); },
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).resolves.toMatchObject({
      student: { studentId: 'S001', balance: 1 },
      completion: { balanceBefore: -1, balanceAfter: 1, reward: 2 },
    });
    expect(updates).toContainEqual({ sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 1 });
    expect(appended.find((row) => row.sheetName === 'TaskCompletions')?.values.slice(5, 8)).toEqual(['2', '-1', '1']);
  });

  it('ignores completions from a deleted previous task when the reused task ID has a newer createdAt', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [
          ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds', 'createdAt', 'updatedAt'],
          ['T001', '새 과제', '삭제 후 같은 ID로 다시 생성됨', '5', '1', 'TRUE', '1', 'S001', '2026-05-21T00:00:00.000Z', '2026-05-21T00:00:00.000Z'],
        ];
        if (sheetName === 'TaskCompletions') return [
          sheetRows.TaskCompletions[0],
          ['TC-OLD', '2026-05-20T00:00:00.000Z', 'T001', 'S001', '김민준', '5', '3495', '3500', 'SUCCESS', ''],
        ];
        return sheetRows[sheetName];
      },
      async updateCell(sheetName: string, rowNumber: number, columnName: string, value: string | number) { updates.push({ sheetName, rowNumber, columnName, value }); },
      async updateHeaderRow() {},
      async appendRow(sheetName: string, values: string[]) { appended.push({ sheetName, values }); },
    };

    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).resolves.toMatchObject({ student: { studentId: 'S001', balance: 3505 } });
    expect(updates).toContainEqual({ sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3505 });
    expect(appended.some((row) => row.sheetName === 'TaskCompletions')).toBe(true);
  });

  it('rejects task completion once the student already completed the current task instance, even if an old sheet still says 2 times', async () => {
    const fakeStore = {
      async getRows(sheetName: keyof typeof sheetRows) {
        if (sheetName === 'Tasks') return [
          ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds', 'createdAt', 'updatedAt'],
          ['T001', '책 읽기', '책 10분 읽기', '5', '2', 'TRUE', '1', 'S001', '2026-05-19T00:00:00.000Z', '2026-05-19T00:00:00.000Z'],
        ];
        if (sheetName === 'TaskCompletions') return [sheetRows.TaskCompletions[0], sheetRows.TaskCompletions[1]];
        return sheetRows[sheetName];
      },
      async updateCell() {},
      async updateHeaderRow() {},
      async appendRow() {},
    };
    await expect(completeTaskForStudent(withRecurringMigration(fakeStore) as never, 'T001', 'S001')).rejects.toThrow('이미 완료한 과제입니다.');
  });

});
