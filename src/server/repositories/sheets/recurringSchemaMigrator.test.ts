import { describe, expect, it } from 'vitest';
import {
  MigrationConflictError,
  migrateRecurringTaskSchema,
  TASK_ASSIGNMENT_HEADERS,
  TASK_COMPLETION_SCHEMA_HEADERS,
  TASK_SCHEMA_HEADERS,
} from '@/server/repositories/sheets/recurringSchemaMigrator';
import {
  SheetProviderError,
  type OperationalSheetName,
  type RecurringSchemaMigrationStore,
  type SheetInfo,
} from '@/server/storage/tabularStore';

class FakeStore implements RecurringSchemaMigrationStore {
  readonly writes: string[] = [];
  readonly sheets = new Map<OperationalSheetName, { info: SheetInfo; rows: string[][] }>();
  beforeCreate?: () => void;
  beforeSecondTasksRead?: () => void;
  beforeHeaderWrite?: (name: OperationalSheetName, startColumn: number, headers: string[]) => void;
  failAfterHeaderWrite?: OperationalSheetName;
  private taskReads = 0;

  constructor(initial: Partial<Record<OperationalSheetName, { columnCount: number; rows: string[][] }>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.sheets.set(name as OperationalSheetName, {
        info: { sheetId: this.sheets.size + 1, title: name as OperationalSheetName, columnCount: value.columnCount },
        rows: structuredClone(value.rows),
      });
    }
  }

  async lookupSheet(name: OperationalSheetName) {
    const sheet = this.sheets.get(name);
    return sheet ? { found: true as const, info: { ...sheet.info } } : { found: false as const, reason: 'SHEET_NOT_FOUND' as const };
  }
  async createSheetWithHeader(name: OperationalSheetName, headers: readonly string[]) {
    this.beforeCreate?.();
    if (this.sheets.has(name)) throw new SheetProviderError('SHEET_ALREADY_EXISTS', name);
    this.writes.push(`createWithHeader:${name}:${headers.length}`);
    this.sheets.set(name, {
      info: { sheetId: 99, title: name, columnCount: headers.length }, rows: [[...headers]],
    });
  }
  async getRows(name: OperationalSheetName) {
    if (name === 'Tasks' && ++this.taskReads === 2) this.beforeSecondTasksRead?.();
    return structuredClone(this.sheets.get(name)?.rows ?? []);
  }
  async ensureColumnCount(name: OperationalSheetName, expected: number, required: number) {
    const sheet = this.sheets.get(name)!;
    if (sheet.info.columnCount !== expected) throw new MigrationConflictError(name, 'grid width changed');
    this.writes.push(`expand:${name}:${expected}->${required}`);
    sheet.info.columnCount = required;
  }
  async verifyHeaderCells(
    name: OperationalSheetName,
    expected: { sheetId: number; columnCount: number; header: readonly string[] },
  ) {
    this.beforeHeaderWrite?.(name, expected.header.length, []);
    const sheet = this.sheets.get(name);
    const current = sheet?.rows[0] ?? [];
    if (!sheet || sheet.info.sheetId !== expected.sheetId || sheet.info.columnCount !== expected.columnCount
      || current.length !== expected.header.length
      || !current.every((value, index) => value === expected.header[index])) {
      throw new MigrationConflictError(name, 'header or grid changed before expansion');
    }
  }
  async verifyAndWriteHeaderCells(
    name: OperationalSheetName,
    expected: { sheetId: number; columnCount: number; header: readonly string[] },
    headers: string[],
  ) {
    this.beforeHeaderWrite?.(name, expected.header.length, headers);
    const sheet = this.sheets.get(name);
    const current = sheet?.rows[0] ?? [];
    const required = expected.header.length + headers.length;
    if (!sheet || sheet.info.sheetId !== expected.sheetId || sheet.info.columnCount !== expected.columnCount
      || sheet.info.columnCount < required || current.length !== expected.header.length
      || !current.every((value, index) => value === expected.header[index])) {
      throw new MigrationConflictError(name, 'header or grid changed before header update, or target cells are occupied');
    }
    this.writes.push(`header:${name}:${expected.header.length}:${headers.join(',')}`);
    headers.forEach((header, index) => { current[expected.header.length + index] = header; });
    if (this.failAfterHeaderWrite === name) {
      this.failAfterHeaderWrite = undefined;
      throw new Error(`simulated failure after ${name} header update`);
    }
  }
  async writeHeaderCells(name: OperationalSheetName, startColumn: number, headers: string[]) {
    this.beforeHeaderWrite?.(name, startColumn, headers);
    this.writes.push(`header:${name}:${startColumn}:${headers.join(',')}`);
    const sheet = this.sheets.get(name)!;
    const row = (sheet.rows[0] ??= []);
    headers.forEach((header, index) => { row[startColumn + index] = header; });
    if (this.failAfterHeaderWrite === name) {
      this.failAfterHeaderWrite = undefined;
      throw new Error(`simulated failure after ${name} header update`);
    }
  }
  async updateCell() { throw new Error('not used'); }
  async appendRow() { throw new Error('not used'); }
}

const legacyTasks = TASK_SCHEMA_HEADERS.slice(0, 9);
const legacyCompletions = TASK_COMPLETION_SCHEMA_HEADERS.slice(0, 10);
const deployedLegacyTaskHeaders = [
  [
    'B',
    ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'],
  ],
  [
    'C',
    ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds', 'createdAt', 'updatedAt'],
  ],
  [
    'D',
    ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'],
  ],
] as const;

function baseStore() {
  return new FakeStore({
    Tasks: { columnCount: 26, rows: [legacyTasks, ['T1', '제목']] },
    TaskCompletions: { columnCount: 10, rows: [legacyCompletions, ['C1']] },
  });
}

describe('recurring schema migrator', () => {
  it.each(deployedLegacyTaskHeaders)('migrates deployed legacy Tasks variant %s by appending at the physical right edge', async (_variant, header) => {
    const customHeader = 'teacherCustomMetadata';
    const values: Record<string, string> = {
      taskId: 'T1', title: '제목', description: '설명', reward: '10', maxCompletionsPerStudent: '1',
      isActive: 'TRUE', sortOrder: '7', createdAt: 'created', updatedAt: 'updated', allowedStudentIds: 'S1',
    };
    const originalRow = [...header.map((column) => values[column] ?? ''), 'preserve-me'];
    const store = new FakeStore({
      Tasks: { columnCount: header.length + 1, rows: [[...header, customHeader], originalRow] },
      TaskCompletions: { columnCount: legacyCompletions.length, rows: [[...legacyCompletions], ['C1']] },
    });

    await migrateRecurringTaskSchema(store);

    const existingHeaders = new Set<string>(header);
    const expectedMissing = TASK_SCHEMA_HEADERS.filter((candidate) => !existingHeaders.has(candidate));
    expect(store.writes).toContain(`header:Tasks:${header.length + 1}:${expectedMissing.join(',')}`);
    expect(store.sheets.get('Tasks')?.rows[0]).toEqual([...header, customHeader, ...expectedMissing]);
    expect(store.sheets.get('Tasks')?.rows[1]).toEqual(originalRow);
  });

  it.each([
    ['duplicate required header', [...legacyTasks, 'title']],
    ['duplicate missing canonical header', [...legacyTasks, 'recurrenceType', ' recurrenceType ']],
    ['blank trailing header', [...legacyTasks, '']],
    ['renamed core header', ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'active', 'sortOrder', 'createdAt', 'updatedAt']],
    ['unrecognized legacy interleaving', ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'allowedStudentIds', 'sortOrder', 'createdAt', 'updatedAt']],
  ])('rejects a malformed Tasks header with %s before any write', async (_case, header) => {
    const store = new FakeStore({
      Tasks: { columnCount: header.length, rows: [header] },
      TaskCompletions: { columnCount: legacyCompletions.length, rows: [[...legacyCompletions]] },
    });

    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'Tasks', retryable: true,
    });
    expect(store.writes).toEqual([]);
  });

  it('creates a structurally missing TaskAssignments sheet and initializes exactly A1:O1 once', async () => {
    const store = baseStore();
    await migrateRecurringTaskSchema(store);
    expect(store.writes).toContain('createWithHeader:TaskAssignments:15');
    expect(store.writes.filter((write) => write.startsWith('header:TaskAssignments'))).toHaveLength(0);
    expect(store.sheets.get('TaskAssignments')?.rows).toEqual([TASK_ASSIGNMENT_HEADERS]);
  });

  it('accepts a concurrent already-exists create after re-reading canonical state', async () => {
    const store = baseStore();
    store.beforeCreate = () => store.sheets.set('TaskAssignments', {
      info: { sheetId: 7, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    await expect(migrateRecurringTaskSchema(store)).resolves.toBeUndefined();
    expect(store.writes.filter((write) => write.startsWith('header:TaskAssignments'))).toHaveLength(0);
  });

  it.each([
    ['blank', []],
    ['noncanonical', [['assignmentId', 'wrongHeader']]],
  ] as const)('rejects a concurrent already-exists create when the raced sheet is %s without initializing it', async (_state, rows) => {
    const store = baseStore();
    store.beforeCreate = () => store.sheets.set('TaskAssignments', {
      info: { sheetId: 7, title: 'TaskAssignments', columnCount: 15 }, rows: rows.map((row) => [...row]),
    });

    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'TaskAssignments', retryable: true,
    });
    expect(store.writes.filter((write) => write.startsWith('header:TaskAssignments'))).toEqual([]);
    expect(store.sheets.get('TaskAssignments')?.rows).toEqual(rows);
  });

  it('is idempotent after a partial create whose header was already initialized', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    await migrateRecurringTaskSchema(store);
    await migrateRecurringTaskSchema(store);
    expect(store.writes.filter((write) => write.includes('TaskAssignments'))).toHaveLength(0);
  });

  it('accepts and preserves unknown columns trailing the canonical TaskAssignments header', async () => {
    const store = new FakeStore({
      Tasks: { columnCount: TASK_SCHEMA_HEADERS.length, rows: [[...TASK_SCHEMA_HEADERS]] },
      TaskCompletions: { columnCount: TASK_COMPLETION_SCHEMA_HEADERS.length, rows: [[...TASK_COMPLETION_SCHEMA_HEADERS]] },
      TaskAssignments: {
        columnCount: TASK_ASSIGNMENT_HEADERS.length + 1,
        rows: [[...TASK_ASSIGNMENT_HEADERS, 'teacherCustomMetadata'], ['', ...Array(14).fill(''), 'preserve-me']],
      },
    });

    await expect(migrateRecurringTaskSchema(store)).resolves.toBeUndefined();
    expect(store.writes).toEqual([]);
    expect(store.sheets.get('TaskAssignments')?.rows[0].at(-1)).toBe('teacherCustomMetadata');
    expect(store.sheets.get('TaskAssignments')?.rows[1].at(-1)).toBe('preserve-me');
  });

  it('aborts with an explicit retryable conflict before writes when a header extension races', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    store.beforeSecondTasksRead = () => store.sheets.get('Tasks')!.rows[0].push('concurrentLegacy');
    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({ name: 'MigrationConflictError', retryable: true });
    expect(store.writes).toEqual([]);
  });

  it('revalidates immediately before writing and rejects a prefix mutation after preflight', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    store.beforeHeaderWrite = (name) => {
      if (name === 'Tasks') store.sheets.get(name)!.rows[0][4] = 'racedIsActive';
    };

    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'Tasks', retryable: true,
    });
    expect(store.writes.filter((write) => write.startsWith('header:Tasks'))).toEqual([]);
    expect(store.writes.filter((write) => write.startsWith('expand:Tasks'))).toEqual([]);
  });

  it('rejects an existing blank TaskAssignments sheet without expanding or initializing it', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 2 }, rows: [],
    });

    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'TaskAssignments', retryable: true,
    });
    expect(store.writes).toEqual([]);
  });

  it('refuses occupied right-side target cells immediately before the header update', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    store.beforeHeaderWrite = (name, startColumn) => {
      if (name === 'TaskCompletions') store.sheets.get(name)!.rows[0][startColumn] = 'concurrentOwner';
    };

    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'TaskCompletions', retryable: true,
    });
    expect(store.sheets.get('TaskCompletions')!.rows[0][10]).toBe('concurrentOwner');
    expect(store.writes.filter((write) => write.startsWith('header:TaskCompletions'))).toEqual([]);
  });

  it('expands only to the required A:AB+ width and writes only the empty right header ranges', async () => {
    const store = baseStore();
    await migrateRecurringTaskSchema(store);
    expect(store.writes).toEqual([
      'expand:Tasks:26->28',
      `header:Tasks:9:${TASK_SCHEMA_HEADERS.slice(9).join(',')}`,
      'expand:TaskCompletions:10->19',
      `header:TaskCompletions:10:${TASK_COMPLETION_SCHEMA_HEADERS.slice(10).join(',')}`,
      'createWithHeader:TaskAssignments:15',
    ]);
    expect(store.sheets.get('Tasks')?.rows[1]).toEqual(['T1', '제목']);
  });

  it('is idempotent on retry after grid expansion and a header update succeeded before failure', async () => {
    const store = baseStore();
    store.sheets.set('TaskAssignments', {
      info: { sheetId: 8, title: 'TaskAssignments', columnCount: 15 }, rows: [[...TASK_ASSIGNMENT_HEADERS]],
    });
    store.failAfterHeaderWrite = 'Tasks';

    await expect(migrateRecurringTaskSchema(store)).rejects.toThrow('simulated failure after Tasks header update');
    expect(store.sheets.get('Tasks')!.info.columnCount).toBe(TASK_SCHEMA_HEADERS.length);
    expect(store.sheets.get('Tasks')!.rows[0]).toEqual(TASK_SCHEMA_HEADERS);
    await expect(migrateRecurringTaskSchema(store)).resolves.toBeUndefined();
    expect(store.writes.filter((write) => write === 'expand:Tasks:26->28')).toHaveLength(1);
    expect(store.writes.filter((write) => write.startsWith('header:Tasks'))).toHaveLength(1);
  });

  it('preserves an unknown trailing legacy column by extending after it', async () => {
    const store = baseStore();
    store.sheets.get('Tasks')!.rows[0].push('legacyCustom');
    store.sheets.get('Tasks')!.info.columnCount = 29;
    await migrateRecurringTaskSchema(store);
    expect(store.sheets.get('Tasks')!.rows[0][9]).toBe('legacyCustom');
    expect(store.writes).toContain(`header:Tasks:10:${TASK_SCHEMA_HEADERS.slice(9).join(',')}`);
  });

  it('rejects a non-canonical legacy prefix before any migration side effect', async () => {
    const store = baseStore();
    store.sheets.get('Tasks')!.rows[0][4] = 'renamedIsActive';
    await expect(migrateRecurringTaskSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'Tasks', retryable: true,
    });
    expect(store.writes).toEqual([]);
  });
});
