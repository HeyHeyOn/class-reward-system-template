import { describe, expect, it } from 'vitest';
import {
  buildTaskAssignmentAppendRow,
  buildTaskCompletionAppendRow,
  buildTaskAppendRow,
  buildTransactionAppendRow,
  createHeaderIndex,
  parseAllowedStudentIds,
  parseProductRow,
  parseStudentRow,
  parseTaskAssignmentRow,
  parseTaskAssignmentRows,
  parseTaskCompletionRow,
  parseTaskRow,
  parseTransactionRow,
  requireColumns,
} from '@/server/sheetsRows';

describe('sheets row parsing', () => {
  it('creates a header index and verifies required columns', () => {
    const headers = ['studentId', 'name', 'balance', 'status', 'note'];
    const headerIndex = createHeaderIndex(headers);

    expect(headerIndex.get('studentId')).toBe(0);
    expect(headerIndex.get('balance')).toBe(2);
    expect(requireColumns(headerIndex, ['studentId', 'name', 'balance'])).toEqual({ ok: true });
  });

  it('reports missing required columns', () => {
    const headerIndex = createHeaderIndex(['studentId', 'name']);

    expect(requireColumns(headerIndex, ['studentId', 'name', 'balance'])).toEqual({
      ok: false,
      missingColumns: ['balance'],
    });
  });

  it('parses a student row into a Student object', () => {
    const headerIndex = createHeaderIndex(['studentId', 'name', 'balance', 'status', 'note']);

    expect(parseStudentRow(['S001', '김민준', '3500', 'ACTIVE', ''], headerIndex)).toEqual({
      studentId: 'S001',
      name: '김민준',
      balance: 3500,
      status: 'ACTIVE',
    });
  });

  it('returns null for inactive or malformed student rows', () => {
    const headerIndex = createHeaderIndex(['studentId', 'name', 'balance', 'status']);

    expect(parseStudentRow(['S002', '이서연', '1200', 'INACTIVE'], headerIndex)).toEqual({
      studentId: 'S002',
      name: '이서연',
      balance: 1200,
      status: 'INACTIVE',
    });
    expect(parseStudentRow(['', '이름없음', '100', 'ACTIVE'], headerIndex)).toBeNull();
    expect(parseStudentRow(['S003', '박도윤', 'not-number', 'ACTIVE'], headerIndex)).toBeNull();
  });

  it('parses a product row into a Product object', () => {
    const headerIndex = createHeaderIndex([
      'productId',
      'name',
      'price',
      'stock',
      'isActive',
      'imageUrl',
      'category',
      'sortOrder',
    ]);

    expect(parseProductRow(['P001', '연필', '300', '20', 'TRUE', '', '문구', '1'], headerIndex)).toEqual({
      productId: 'P001',
      name: '연필',
      price: 300,
      stock: 20,
      isActive: true,
      imageUrl: undefined,
      category: '문구',
      sortOrder: 1,
    });
  });

  it('returns null for malformed product rows', () => {
    const headerIndex = createHeaderIndex(['productId', 'name', 'price', 'stock', 'isActive', 'sortOrder']);

    expect(parseProductRow(['', '이름없음', '300', '20', 'TRUE', '1'], headerIndex)).toBeNull();
    expect(parseProductRow(['P001', '연필', 'NaN', '20', 'TRUE', '1'], headerIndex)).toBeNull();
    expect(parseProductRow(['P002', '지우개', '500', 'NaN', 'TRUE', '2'], headerIndex)).toBeNull();
  });

  it('parses a canonical task row into the existing domain shape', () => {
    const headerIndex = createHeaderIndex([
      'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds',
    ]);

    expect(parseTaskRow([
      ' T001 ', ' 책 읽기 ', ' 책 10분 읽기 ', '1,000', '활성', '2',
      '2026-05-21T00:00:00.000Z', '2026-05-22T00:00:00.000Z', ' S002, S001 ',
    ], headerIndex)).toEqual({
      taskId: 'T001',
      title: '책 읽기',
      description: '책 10분 읽기',
      reward: 1000,
      isActive: true,
      sortOrder: 2,
      allowedStudentIds: ['S002', 'S001'],
      createdAt: '2026-05-21T00:00:00.000Z',
      taskInstanceId: 'legacy:T001:2026-05-21T00:00:00.000Z',
      schedule: {
        ruleVersion: 1, effectiveFrom: '2026-05-21T00:00:00.000Z', timeZone: 'Asia/Seoul',
        recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false,
      },
      pendingSchedule: null,
    });
  });

  it('removes blank and duplicate allowed student IDs while preserving first-seen order', () => {
    expect(parseAllowedStudentIds(' S002, ,S001;S002\n S003 ; S001 ')).toEqual(['S002', 'S001', 'S003']);
  });

  it('ignores the legacy maxCompletionsPerStudent column when parsing a task', () => {
    const headerIndex = createHeaderIndex([
      'taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'allowedStudentIds',
    ]);

    expect(parseTaskRow(['T010', '레거시 과제', '', '5', '2', 'TRUE', '1', 'S001'], headerIndex)).toEqual({
      taskId: 'T010',
      title: '레거시 과제',
      description: '',
      reward: 5,
      isActive: true,
      sortOrder: 1,
      allowedStudentIds: ['S001'],
      taskInstanceId: 'legacy:T010:1970-01-01T00:00:00.000Z',
      schedule: {
        ruleVersion: 1, effectiveFrom: '1970-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
        recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false,
      },
      pendingSchedule: null,
    });
  });

  it('serializes task values in the live header order and writes 1 to the legacy max column', () => {
    const headers = [
      'title', 'taskId', 'maxCompletionsPerStudent', 'allowedStudentIds', 'reward',
      'updatedAt', 'description', 'isActive', 'sortOrder', 'createdAt', 'unknown',
    ];
    const timestamp = '2026-05-21T00:00:00.000Z';

    expect(buildTaskAppendRow(headers, {
      taskId: 'T011',
      title: '순서 확인',
      description: '실제 헤더 기준',
      reward: 8,
      isActive: false,
      sortOrder: 4,
      allowedStudentIds: ['S002', 'S001'],
      createdAt: timestamp,
    }, timestamp)).toEqual([
      '순서 확인', 'T011', '1', 'S002,S001', '8', timestamp,
      '실제 헤더 기준', 'FALSE', '4', timestamp, '',
    ]);
  });

  it('parses and serializes versioned schedules in permuted live header order', () => {
    const headers = [
      'pendingRecurrenceWeekday', 'title', 'recurrenceType', 'taskId', 'pendingRuleVersion',
      'ruleVersion', 'taskInstanceId', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceTime',
      'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'pendingEffectiveFrom', 'pendingTimeZone',
      'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingResetCompletionOnCycle',
      'pendingResetAssignmentOnCycle', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt',
      'allowedStudentIds', 'maxCompletionsPerStudent', 'unknownTrailing',
    ];
    const row = [
      '5', '예약 과제', 'DAILY', 'T100', '2', '1', 'instance-100', '2026-08-01T00:00:00Z',
      'Asia/Seoul', '09:00', 'TRUE', 'FALSE', '2026-08-02T00:00:00Z', 'America/New_York',
      'WEEKLY', '08:30', 'FALSE', 'TRUE', '설명', '10', 'TRUE', '1', '2026-08-01T00:00:00Z',
      'S001', '7', 'keep-me',
    ];
    const task = parseTaskRow(row, createHeaderIndex(headers), 'Asia/Seoul');
    expect(task).toMatchObject({
      taskInstanceId: 'instance-100',
      schedule: { ruleVersion: 1, recurrence: { type: 'DAILY', time: '09:00' } },
      pendingSchedule: { ruleVersion: 2, recurrence: { type: 'WEEKLY', weekday: 5, time: '08:30' } },
    });
    expect(buildTaskAppendRow(headers, task!, '2026-08-03T00:00:00Z', row)).toEqual([
      '5', '예약 과제', 'DAILY', 'T100', '2', '1', 'instance-100', '2026-08-01T00:00:00.000Z',
      'Asia/Seoul', '09:00', 'TRUE', 'FALSE', '2026-08-02T00:00:00.000Z', 'America/New_York',
      'WEEKLY', '08:30', 'FALSE', 'TRUE', '설명', '10', 'TRUE', '1', '2026-08-03T00:00:00Z',
      'S001', '7', 'keep-me',
    ]);
  });

  it('interprets a legacy task with deterministic schedule defaults without adding columns', () => {
    const headers = ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'allowedStudentIds'];
    expect(parseTaskRow(['T-L', '레거시', '', '1', 'TRUE', '1', 'broken', ''], createHeaderIndex(headers), 'Asia/Tokyo'))
      .toMatchObject({
        taskInstanceId: 'legacy:T-L:1970-01-01T00:00:00.000Z',
        schedule: { ruleVersion: 1, effectiveFrom: '1970-01-01T00:00:00.000Z', timeZone: 'Asia/Tokyo', recurrence: { type: 'NONE' } },
        pendingSchedule: null,
      });
  });

  it('forwards malformed schedule diagnostics to ClassTask and blocks accidental repair writes', () => {
    const headers = [
      'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'taskInstanceId', 'ruleVersion',
    ];
    const task = parseTaskRow(
      ['T-BAD', '손상', '', '1', 'TRUE', '1', 'instance-bad', 'broken'],
      createHeaderIndex(headers),
    );
    expect(task?.scheduleReadWarnings).toEqual(['INVALID_CURRENT_SCHEDULE']);
    expect(() => buildTaskAppendRow(headers, task!, '2026-08-03T00:00:00Z')).toThrow();
  });

  it('parses canonical transaction items and preserves the legacy fallback precedence', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'itemsJson', 'itemJson', 'products',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const headerIndex = createHeaderIndex(headers);
    const item = (productId: string) => JSON.stringify([{ productId, name: productId, price: 1, quantity: 1, subtotal: 1 }]);
    const row = (values: string[]) => [
      'TR-1', '2026-05-21T00:00:00.000Z', 'S001', '김민준', ...values,
      '1', '10', '9', 'COMPLETED', 'kiosk',
    ];

    expect(parseTransactionRow(row([item('canonical'), item('itemsJson'), item('itemJson'), item('products')]), headerIndex)?.items[0].productId).toBe('canonical');
    expect(parseTransactionRow(row(['', item('itemsJson'), item('itemJson'), item('products')]), headerIndex)?.items[0].productId).toBe('itemsJson');
    expect(parseTransactionRow(row(['', '', item('itemJson'), item('products')]), headerIndex)?.items[0].productId).toBe('itemJson');
    expect(parseTransactionRow(row(['', '', '', item('products')]), headerIndex)?.items[0].productId).toBe('products');
  });

  it('keeps malformed transaction item JSON as an empty item list without falling through', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'itemsJson',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const row = [
      'TR-2', '2026-05-21T00:00:00.000Z', 'S001', '김민준', '{broken',
      '[{"productId":"legacy"}]', '1', '10', '9', 'COMPLETED', 'kiosk',
    ];

    expect(parseTransactionRow(row, createHeaderIndex(headers))?.items).toEqual([]);
  });

  it('parses a task completion by live headers and serializes both ledger row types by live header order', () => {
    const completionHeaders = [
      'note', 'status', 'balanceAfter', 'studentName', 'completionId', 'reward',
      'taskId', 'timestamp', 'balanceBefore', 'studentId',
    ];
    const completion = {
      completionId: 'TC-1', timestamp: '2026-05-21T00:00:00.000Z', taskId: 'T001', studentId: 'S001',
      studentName: '김민준', reward: 5, balanceBefore: 10, balanceAfter: 15,
      status: 'SUCCESS', note: 'bank-self-completion',
    };
    const completionRow = ['bank-self-completion', 'SUCCESS', '15', '김민준', 'TC-1', '5', 'T001', completion.timestamp, '10', 'S001'];

    expect(parseTaskCompletionRow(completionRow, createHeaderIndex(completionHeaders))).toEqual(completion);
    expect(buildTaskCompletionAppendRow(completionHeaders, completion)).toEqual(completionRow);

    const transaction = {
      transactionId: 'TR-3', timestamp: completion.timestamp, studentId: 'S001', studentName: '김민준',
      items: [{ productId: 'P001', name: '연필', price: 3, quantity: 2, subtotal: 6 }],
      totalAmount: 6, balanceBefore: 10, balanceAfter: 4, status: 'COMPLETED', operator: 'kiosk',
    };
    const transactionHeaders = ['operator', 'balanceAfter', 'items', 'transactionId', 'status', 'studentName', 'totalAmount', 'timestamp', 'studentId', 'balanceBefore'];
    expect(buildTransactionAppendRow(transactionHeaders, transaction)).toEqual([
      'kiosk', '4', JSON.stringify(transaction.items), 'TR-3', 'COMPLETED', '김민준', '6', completion.timestamp, 'S001', '10',
    ]);
  });

  it('round-trips TaskAssignments by canonical headers and preserves physical row order', () => {
    const headers = [
      'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt',
      'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId',
      'createdAt', 'schemaVersion', 'note',
    ];
    const first = {
      assignmentId: 'A-2', taskId: 'T-1', taskInstanceId: 'TI-1', cycleId: 'C-1',
      cycleStartsAt: '2026-08-25T00:00:00.000Z', cycleEndsAt: '2026-08-26T00:00:00.000Z',
      ruleVersion: 2, timeZone: 'Asia/Seoul', studentId: 'S-1', status: 'ASSIGNED' as const,
      source: 'ADMIN' as const, previousAssignmentId: '', createdAt: '2026-08-25T09:00:00.000Z',
      schemaVersion: 2, note: 'first physical row',
    };
    const second = {
      ...first, assignmentId: 'A-1', status: 'UNASSIGNED' as const, source: 'CARRY_FORWARD' as const,
      previousAssignmentId: 'A-2', createdAt: '2026-08-24T09:00:00.000Z', note: '',
    };
    const rows = [buildTaskAssignmentAppendRow(headers, first), buildTaskAssignmentAppendRow(headers, second)];

    expect(rows[0]).toEqual([
      'A-2', 'T-1', 'TI-1', 'C-1', first.cycleStartsAt, first.cycleEndsAt, '2', 'Asia/Seoul',
      'S-1', 'ASSIGNED', 'ADMIN', '', first.createdAt, '2', 'first physical row',
    ]);
    expect(parseTaskAssignmentRow(rows[0], createHeaderIndex(headers))).toEqual(first);
    expect(parseTaskAssignmentRows(rows, createHeaderIndex(headers)).map(({ assignmentId }) => assignmentId))
      .toEqual(['A-2', 'A-1']);
  });

  it('rejects malformed TaskAssignment enum and version cells', () => {
    const headers = [
      'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt',
      'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId',
      'createdAt', 'schemaVersion', 'note',
    ];
    const valid = ['A-1', 'T-1', 'TI-1', 'C-1', 'start', 'end', '1', 'Asia/Seoul', 'S-1', 'ASSIGNED', 'QR', '', 'created', '2', ''];
    expect(parseTaskAssignmentRow([...valid.slice(0, 9), 'DONE', ...valid.slice(10)], createHeaderIndex(headers))).toBeNull();
    expect(parseTaskAssignmentRow([...valid.slice(0, 10), 'BANK', ...valid.slice(11)], createHeaderIndex(headers))).toBeNull();
    expect(parseTaskAssignmentRow([...valid.slice(0, 6), 'not-a-version', ...valid.slice(7)], createHeaderIndex(headers))).toBeNull();
    expect(parseTaskAssignmentRow([...valid.slice(0, 13), '0', ...valid.slice(14)], createHeaderIndex(headers))).toBeNull();
  });

  it('reads legacy completions unchanged and round-trips additive cycle snapshots', () => {
    const legacyHeaders = ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'];
    const legacyRow = ['TC-L', '2026-08-25T00:00:00Z', 'T-1', 'S-1', '학생', '5', '10', '15', 'SUCCESS', 'legacy'];
    expect(parseTaskCompletionRow(legacyRow, createHeaderIndex(legacyHeaders))).toEqual({
      completionId: 'TC-L', timestamp: '2026-08-25T00:00:00Z', taskId: 'T-1', studentId: 'S-1',
      studentName: '학생', reward: 5, balanceBefore: 10, balanceAfter: 15, status: 'SUCCESS', note: 'legacy',
    });

    const headers = [...legacyHeaders, 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion'];
    const carried = {
      completionId: 'TC-C', timestamp: '2026-08-26T00:00:00Z', taskId: 'T-1', studentId: 'S-1',
      studentName: '학생', reward: 0 as const, balanceBefore: 15, balanceAfter: 15, status: 'SUCCESS', note: '',
      taskInstanceId: 'TI-1', cycleId: 'C-2', cycleStartsAt: '2026-08-26T00:00:00Z',
      cycleEndsAt: '2026-08-27T00:00:00Z', ruleVersion: 2, timeZone: 'Asia/Seoul',
      source: 'CARRY_FORWARD' as const, assignmentId: 'A-1', schemaVersion: 2,
    };
    const row = buildTaskCompletionAppendRow(headers, carried);
    expect(parseTaskCompletionRow(row, createHeaderIndex(headers))).toEqual(carried);
    expect(row.slice(-9)).toEqual(['TI-1', 'C-2', carried.cycleStartsAt, carried.cycleEndsAt, '2', 'Asia/Seoul', 'CARRY_FORWARD', 'A-1', '2']);
  });

  it('round-trips NONE-cycle rows with null cycleEndsAt as an empty cell', () => {
    const assignmentHeaders = [
      'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
      'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
    ];
    const noneCycleStartsAt = '2026-08-25T00:00:00Z';
    const noneCycleId = `v1|TI-1|r1|${noneCycleStartsAt}`;
    const assignment = {
      assignmentId: 'A-NONE', taskId: 'T-1', taskInstanceId: 'TI-1', cycleId: noneCycleId,
      cycleStartsAt: noneCycleStartsAt,
      cycleEndsAt: null, ruleVersion: 1, timeZone: 'Asia/Seoul', studentId: 'S-1', status: 'ASSIGNED' as const,
      source: 'ADMIN' as const, previousAssignmentId: '', createdAt: 'created', schemaVersion: 2, note: '',
    };
    const assignmentRow = buildTaskAssignmentAppendRow(assignmentHeaders, assignment);
    expect(assignmentRow[5]).toBe('');
    expect(parseTaskAssignmentRow(assignmentRow, createHeaderIndex(assignmentHeaders))).toEqual(assignment);

    const completionHeaders = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter',
      'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone',
      'source', 'assignmentId', 'schemaVersion',
    ];
    const completion = {
      completionId: 'TC-NONE', timestamp: 'now', taskId: 'T-1', studentId: 'S-1', studentName: '학생', reward: 5,
      balanceBefore: 10, balanceAfter: 15, status: 'SUCCESS', note: '', taskInstanceId: 'TI-1',
      cycleId: noneCycleId, cycleStartsAt: noneCycleStartsAt, cycleEndsAt: null, ruleVersion: 1,
      timeZone: 'Asia/Seoul', source: 'BANK' as const, assignmentId: '', schemaVersion: 2,
    };
    const completionRow = buildTaskCompletionAppendRow(completionHeaders, completion);
    expect(completionRow[13]).toBe('');
    expect(parseTaskCompletionRow(completionRow, createHeaderIndex(completionHeaders))).toEqual(completion);
  });

  it('fails closed when serializing malformed versioned ledger snapshots', () => {
    const completionHeaders = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter',
      'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone',
      'source', 'assignmentId', 'schemaVersion',
    ];
    const legacy = {
      completionId: 'TC-1', timestamp: 'now', taskId: 'T-1', studentId: 'S-1', studentName: '학생', reward: 5,
      balanceBefore: 10, balanceAfter: 15, status: 'SUCCESS', note: '',
    };
    expect(() => buildTaskCompletionAppendRow(completionHeaders, legacy)).not.toThrow();
    for (const malformed of [
      { ...legacy, taskInstanceId: 'partial' },
      { ...legacy, taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null, ruleVersion: 1, timeZone: 'Asia/Seoul', source: 'INVALID', schemaVersion: 2 },
      { ...legacy, taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null, ruleVersion: 0, timeZone: 'Asia/Seoul', source: 'BANK', schemaVersion: 2 },
      { ...legacy, taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null, ruleVersion: 1, timeZone: 'Asia/Seoul', source: 'BANK', schemaVersion: 1.5 },
    ]) expect(() => buildTaskCompletionAppendRow(completionHeaders, malformed as never)).toThrow();

    const assignmentHeaders = [
      'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
      'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
    ];
    const assignment = {
      assignmentId: 'A', taskId: 'T', taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null,
      ruleVersion: 1, timeZone: 'Asia/Seoul', studentId: 'S', status: 'ASSIGNED', source: 'ADMIN',
      previousAssignmentId: '', createdAt: 'created', schemaVersion: 2, note: '',
    };
    for (const malformed of [
      { ...assignment, assignmentId: '' }, { ...assignment, cycleEndsAt: undefined }, { ...assignment, status: 'DONE' },
      { ...assignment, source: 'BANK' }, { ...assignment, ruleVersion: 0 }, { ...assignment, schemaVersion: -1 },
    ]) expect(() => buildTaskAssignmentAppendRow(assignmentHeaders, malformed as never)).toThrow();
  });

  it('returns null for partial or malformed versioned rows', () => {
    const headers = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter',
      'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone',
      'source', 'assignmentId', 'schemaVersion',
    ];
    const base = ['TC', 'now', 'T', 'S', '학생', '5', '10', '15', 'SUCCESS', '', 'TI', 'C', 'start', '', '1', 'Asia/Seoul', 'BANK', '', '2'];
    expect(parseTaskCompletionRow([...base.slice(0, 11), '', ...base.slice(12)], createHeaderIndex(headers))).toBeNull();
    expect(parseTaskCompletionRow([...base.slice(0, 16), 'INVALID', ...base.slice(17)], createHeaderIndex(headers))).toBeNull();
    expect(parseTaskCompletionRow([...base.slice(0, 18), '0'], createHeaderIndex(headers))).toBeNull();
  });

  it('fails closed for whitespace IDs, unsupported schema versions, and incomplete ledger headers', () => {
    const assignmentHeaders = [
      'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
      'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
    ];
    const assignment = {
      assignmentId: 'A', taskId: 'T', taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null,
      ruleVersion: 1, timeZone: 'Asia/Seoul', studentId: 'S', status: 'ASSIGNED' as const, source: 'ADMIN' as const,
      previousAssignmentId: '', createdAt: 'created', schemaVersion: 2, note: '',
    };
    expect(() => buildTaskAssignmentAppendRow(assignmentHeaders, { ...assignment, assignmentId: '   ' })).toThrow();
    expect(() => buildTaskAssignmentAppendRow(assignmentHeaders.filter((header) => header !== 'studentId'), assignment)).toThrow(/studentId/);
    expect(() => buildTaskAssignmentAppendRow([...assignmentHeaders, ' studentId '], assignment)).toThrow(/studentId/);
    expect(() => buildTaskAssignmentAppendRow(['extra', ...assignmentHeaders].reverse(), assignment)).not.toThrow();
    for (const schemaVersion of [1, 3]) {
      const row = ['A', 'T', 'TI', 'C', 'start', '', '1', 'Asia/Seoul', 'S', 'ASSIGNED', 'ADMIN', '', 'created', String(schemaVersion), ''];
      expect(parseTaskAssignmentRow(row, createHeaderIndex(assignmentHeaders))).toBeNull();
      expect(() => buildTaskAssignmentAppendRow(assignmentHeaders, { ...assignment, schemaVersion })).toThrow();
    }

    const legacyHeaders = ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'];
    const legacy = { completionId: 'TC', timestamp: 'now', taskId: 'T', studentId: 'S', studentName: '학생', reward: 1, balanceBefore: 1, balanceAfter: 2, status: 'SUCCESS', note: '' };
    expect(() => buildTaskCompletionAppendRow(legacyHeaders.filter((header) => header !== 'taskId'), legacy)).toThrow(/taskId/);
    expect(() => buildTaskCompletionAppendRow(legacyHeaders, legacy)).not.toThrow();

    const versionedHeaders = [...legacyHeaders, 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion'];
    const versioned = { ...legacy, taskInstanceId: 'TI', cycleId: 'C', cycleStartsAt: 'start', cycleEndsAt: null, ruleVersion: 1, timeZone: 'Asia/Seoul', source: 'BANK' as const, assignmentId: '', schemaVersion: 2 };
    expect(() => buildTaskCompletionAppendRow(versionedHeaders, { ...versioned, cycleId: '   ' })).toThrow();
    expect(() => buildTaskCompletionAppendRow(versionedHeaders.filter((header) => header !== 'assignmentId'), versioned)).toThrow(/assignmentId/);
    expect(() => buildTaskCompletionAppendRow([...versionedHeaders, ' schemaVersion '], versioned)).toThrow(/schemaVersion/);
    for (const schemaVersion of [1, 3]) {
      const row = ['TC', 'now', 'T', 'S', '학생', '1', '1', '2', 'SUCCESS', '', 'TI', 'C', 'start', '', '1', 'Asia/Seoul', 'BANK', '', String(schemaVersion)];
      expect(parseTaskCompletionRow(row, createHeaderIndex(versionedHeaders))).toBeNull();
      expect(() => buildTaskCompletionAppendRow(versionedHeaders, { ...versioned, schemaVersion })).toThrow();
    }
  });
});
