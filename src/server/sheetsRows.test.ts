import { describe, expect, it } from 'vitest';
import type { Promotion, PromotionProductLink } from '@/domain/types';
import {
  buildPromotionAppendRow,
  buildPromotionProductAppendRow,
  buildTaskAssignmentAppendRow,
  buildTaskCompletionAppendRow,
  buildTaskAppendRow,
  buildTransactionAppendRow,
  createHeaderIndex,
  parseAllowedStudentIds,
  parseProductRow,
  parsePromotionProductRow,
  parsePromotionRow,
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
      pendingSchedule: { ruleVersion: 2, recurrence: { type: 'WEEKLY', weekdays: [5], time: '08:30' } },
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

  it('normalizes multi-weekday cells and falls back only to the legacy singleton column', () => {
    const baseHeaders = [
      'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'taskInstanceId',
      'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType', 'recurrenceTime',
      'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
      'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType',
      'pendingRecurrenceTime', 'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth',
      'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle', 'recurrenceWeekdays',
      'pendingRecurrenceWeekdays',
    ];
    const values: Record<string, string> = {
      taskId: 'T-W', title: '주간', reward: '1', isActive: 'TRUE', sortOrder: '1',
      createdAt: '2026-08-01T00:00:00Z', taskInstanceId: 'I-W', ruleVersion: '1',
      scheduleEffectiveFrom: '2026-08-01T00:00:00Z', recurrenceTimeZone: 'Asia/Seoul',
      recurrenceType: 'WEEKLY', recurrenceTime: '09:00', recurrenceWeekday: '2',
      recurrenceWeekdays: '4,1', resetCompletionOnCycle: 'TRUE', resetAssignmentOnCycle: 'FALSE',
    };
    const row = baseHeaders.map((header) => values[header] ?? '');
    expect(parseTaskRow(row, createHeaderIndex(baseHeaders))?.schedule?.recurrence)
      .toEqual({ type: 'WEEKLY', weekdays: [1, 4], time: '09:00' });

    row[baseHeaders.indexOf('recurrenceWeekdays')] = '';
    expect(parseTaskRow(row, createHeaderIndex(baseHeaders))?.schedule?.recurrence)
      .toEqual({ type: 'WEEKLY', weekdays: [2], time: '09:00' });
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

  it('requires transaction money cells to be safe integers and balances to be nonnegative', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const valid = ['TR-MONEY', '2026-08-15T00:00:00.000Z', 'S001', '학생', '[]', '-5', '10', '15', 'TASK_REWARD', 'bank'];
    const index = createHeaderIndex(headers);

    expect(parseTransactionRow(valid, index)?.totalAmount).toBe(-5);
    for (const [column, value] of [
      [5, '1.5'], [5, '9007199254740992'],
      [6, '-1'], [6, '1.5'], [6, '9007199254740992'],
      [7, '-1'], [7, '1.5'], [7, '9007199254740992'],
    ] as const) {
      const malformed = [...valid];
      malformed[column] = value;
      expect(parseTransactionRow(malformed, index)).toBeNull();
    }
  });

  it('round-trips complete checkout snapshots while retaining legacy five-field items', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const snapshot = {
      productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540,
      regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2,
      freeQuantity: 1, finalTotal: 540, totalDiscount: 360,
      adjustments: [
        { promotionId: 'N21', type: 'N_PLUS_ONE' as const, beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 },
        { promotionId: 'P10', type: 'PERCENT_DISCOUNT' as const, beforeAmount: 600, afterAmount: 540, discountAmount: 60 },
      ],
      appliedPromotions: [
        { promotionId: 'N21', name: '2+1', description: '', productIds: ['P001'], type: 'N_PLUS_ONE' as const, buyQuantity: 2, freeQuantity: 1, startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3 },
        { promotionId: 'P10', name: '10%', description: '', productIds: ['P001'], type: 'PERCENT_DISCOUNT' as const, percent: 10, startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3 },
      ],
    };
    const transaction = {
      transactionId: 'TR-S', timestamp: '2026-08-15T00:00:00.000Z', studentId: 'S001', studentName: '김민준',
      items: [snapshot], totalAmount: 540, balanceBefore: 3500, balanceAfter: 2960,
      status: 'COMPLETED', operator: 'kiosk',
    };
    const row = buildTransactionAppendRow(headers, transaction);
    expect(JSON.parse(row[4])).toEqual([snapshot]);
    expect(parseTransactionRow(row, createHeaderIndex(headers))).toEqual(transaction);

    const legacy = { productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500 };
    const legacyRow = [...row];
    legacyRow[4] = JSON.stringify([legacy]);
    expect(parseTransactionRow(legacyRow, createHeaderIndex(headers))?.items).toEqual([legacy]);
  });

  it('marks partial, malformed, or alias-inconsistent snapshots unsafe instead of reinterpreting them as legacy', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const base = ['TR-BAD', '2026-08-15T00:00:00.000Z', 'S001', '김민준', '', '540', '3500', '2960', 'COMPLETED', 'kiosk'];
    for (const item of [
      { productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540, totalQuantity: 3 },
      { productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540, regularUnitPrice: 301, regularTotal: 900, totalQuantity: 3, paidQuantity: 2, freeQuantity: 1, finalTotal: 540, totalDiscount: 360, adjustments: [], appliedPromotions: [] },
      { productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540, regularUnitPrice: 300, regularTotal: 900, totalQuantity: -3, paidQuantity: 2, freeQuantity: 1, finalTotal: 540, totalDiscount: 360, adjustments: [], appliedPromotions: [] },
    ]) {
      const parsed = parseTransactionRow([...base.slice(0, 4), JSON.stringify([item]), ...base.slice(5)], createHeaderIndex(headers));
      expect(parsed?.itemsMalformed).toBe(true);
    }
  });

  it('marks persisted promotion snapshots with invalid identity, version, timestamps, or intervals unsafe', () => {
    const headers = [
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ];
    const promotion = {
      promotionId: 'N21', name: '2+1', description: '', productIds: ['P001'], type: 'N_PLUS_ONE' as const,
      buyQuantity: 2, freeQuantity: 1, startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z', schemaVersion: 3,
    };
    const snapshot = {
      productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 600,
      regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2,
      freeQuantity: 1, finalTotal: 600, totalDiscount: 300,
      adjustments: [{
        promotionId: 'N21', type: 'N_PLUS_ONE' as const, beforeAmount: 900,
        afterAmount: 600, discountAmount: 300, freeQuantity: 1,
      }],
      appliedPromotions: [promotion],
    };
    const malformedPromotions = [
      { ...promotion, productIds: ['P999'] },
      { ...promotion, schemaVersion: 2 },
      { ...promotion, createdAt: 'not-a-date' },
      { ...promotion, updatedAt: '2026-07-02' },
      { ...promotion, endsAt: promotion.startsAt },
      { ...promotion, startsAt: '2026-10-01T00:00:00.000Z' },
    ];

    for (const malformedPromotion of malformedPromotions) {
      const row = [
        'TR-BAD-PROMO', '2026-08-15T00:00:00.000Z', 'S001', '김민준',
        JSON.stringify([{ ...snapshot, appliedPromotions: [malformedPromotion] }]),
        '600', '3500', '2900', 'COMPLETED', 'kiosk',
      ];
      expect(parseTransactionRow(row, createHeaderIndex(headers))?.itemsMalformed).toBe(true);
    }
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

  it('round-trips append-only task completion operation metadata after legacy columns', () => {
    const headers = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
      'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt',
      'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId',
      'operationPayloadHash',
    ];
    const pending = {
      completionId: 'TC-OP', timestamp: '2026-08-26T00:00:00.000Z', taskId: 'T-1', studentId: 'S-1',
      studentName: '학생', reward: 5, balanceBefore: 10, balanceAfter: 15, status: 'PENDING', note: '',
      taskInstanceId: 'TI-1', cycleId: 'C-2', cycleStartsAt: '2026-08-26T00:00:00.000Z',
      cycleEndsAt: '2026-08-27T00:00:00.000Z', ruleVersion: 2, timeZone: 'Asia/Seoul',
      source: 'BANK' as const, assignmentId: 'A-1', schemaVersion: 2,
      operationId: '11111111-1111-4111-8111-111111111111', operationPayloadHash: 'sha256:abc',
    };

    const row = buildTaskCompletionAppendRow(headers, pending);

    expect(row.slice(-2)).toEqual([pending.operationId, pending.operationPayloadHash]);
    expect(parseTaskCompletionRow(row, createHeaderIndex(headers))).toEqual(pending);
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

describe('promotion sheet row codecs', () => {
  const headers = [
    'unknownLeading', 'type', 'name', 'promotionId', 'value', 'freeQuantity', 'buyQuantity',
    'description', 'endsAt', 'startsAt', 'sortOrder', 'isActive', 'updatedAt', 'createdAt',
    'schemaVersion', 'unknownTrailing',
  ];
  const common = {
    promotionId: 'PROMO-1', name: '학급 할인', description: '', productIds: [] as string[],
    startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T23:59:59.000Z',
    isActive: true, sortOrder: 4, createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z', schemaVersion: 3,
  };
  const promotions: Promotion[] = [
    { ...common, type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1 },
    { ...common, promotionId: 'PROMO-2', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 0 },
    { ...common, promotionId: 'PROMO-3', type: 'PERCENT_DISCOUNT', percent: 12.5 },
    { ...common, promotionId: 'PROMO-4', type: 'FIXED_DISCOUNT', discountAmount: 300 },
  ];

  it('round-trips all four promotion types in permuted live header order with blank irrelevant cells', () => {
    const expectedTypeCells = [
      ['N_PLUS_ONE', '', '1', '2'], ['PROMOTIONAL_PRICE', '0', '', ''],
      ['PERCENT_DISCOUNT', '12.5', '', ''], ['FIXED_DISCOUNT', '300', '', ''],
    ];
    promotions.forEach((promotion, index) => {
      const row = buildPromotionAppendRow(headers, promotion);
      expect([row[1], row[4], row[5], row[6]]).toEqual(expectedTypeCells[index]);
      expect(row[11]).toBe('TRUE');
      expect(parsePromotionRow(row, createHeaderIndex(headers))).toEqual(promotion);
    });
  });

  it('preserves unknown existing cells while overwriting canonical promotion cells', () => {
    const existingRow = headers.map(() => 'stale');
    existingRow[0] = 'keep-leading';
    existingRow[15] = 'keep-trailing';
    const row = buildPromotionAppendRow(headers, { ...promotions[3], isActive: false }, existingRow);
    expect(row[0]).toBe('keep-leading');
    expect(row[15]).toBe('keep-trailing');
    expect(row[11]).toBe('FALSE');
    expect(row[5]).toBe('');
    expect(row[6]).toBe('');
  });

  it('preserves duplicate unknown columns and headerless trailing cells by physical index', () => {
    const duplicateUnknownHeaders = [...headers, 'unknownLeading'];
    const existingRow = duplicateUnknownHeaders.map((_, index) => `existing-${index}`);
    existingRow.push('headerless-tail');

    const row = buildPromotionAppendRow(duplicateUnknownHeaders, promotions[0], existingRow);

    expect(row[0]).toBe('existing-0');
    expect(row[16]).toBe('existing-16');
    expect(row[17]).toBe('headerless-tail');
  });

  it('returns null for malformed common promotion cells', () => {
    const canonicalHeaders = [
      'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
      'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
    ];
    const valid = ['P', 'Name', '', 'FIXED_DISCOUNT', '1', '', '', '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z', 'TRUE', '0', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '3'];
    const malformedRows = [
      ['', ...valid.slice(1)], [valid[0], '   ', ...valid.slice(2)],
      [...valid.slice(0, 7), 'not-a-date', ...valid.slice(8)],
      [...valid.slice(0, 7), '2026-08-01T00:00:00Z', ...valid.slice(8)],
      [...valid.slice(0, 7), '2026-09-01T00:00:00Z', ...valid.slice(8)],
      [...valid.slice(0, 8), valid[7], ...valid.slice(9)],
      [...valid.slice(0, 8), 'not-a-date', ...valid.slice(9)],
      [...valid.slice(0, 9), 'yes', ...valid.slice(10)],
      [...valid.slice(0, 10), '1.5', ...valid.slice(11)],
      [...valid.slice(0, 10), '9007199254740992', ...valid.slice(11)],
      [...valid.slice(0, 11), 'bad', ...valid.slice(12)],
      [...valid.slice(0, 12), 'bad', valid[13]], [...valid.slice(0, 13), '2'], valid.slice(0, 13),
    ];
    for (const row of malformedRows) {
      expect(parsePromotionRow(row, createHeaderIndex(canonicalHeaders))).toBeNull();
    }
  });

  it('returns null for unsupported or malformed type-specific promotion cells', () => {
    const typeHeaders = ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
      'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'];
    const suffix = ['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'FALSE', '1',
      '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '3'];
    const row = (type: string, value: string, buy: string, free: string) =>
      ['P', 'Name', '', type, value, buy, free, ...suffix];
    const malformedRows = [
      row('BOGO', '', '1', '1'), row('N_PLUS_ONE', '10', '1', '1'), row('N_PLUS_ONE', '', '0', '1'),
      row('N_PLUS_ONE', '', '1.5', '1'), row('N_PLUS_ONE', '', '1', '9007199254740992'),
      row('PROMOTIONAL_PRICE', '-1', '', ''), row('PROMOTIONAL_PRICE', '1.5', '', ''),
      row('PROMOTIONAL_PRICE', '1', '1', ''), row('PERCENT_DISCOUNT', '0', '', ''),
      row('PERCENT_DISCOUNT', '100.1', '', ''), row('PERCENT_DISCOUNT', 'Infinity', '', ''),
      row('PERCENT_DISCOUNT', '10', '', '1'), row('FIXED_DISCOUNT', '0', '', ''),
      row('FIXED_DISCOUNT', '1.5', '', ''), row('FIXED_DISCOUNT', '1', '', '1'),
    ];
    for (const malformed of malformedRows) {
      expect(parsePromotionRow(malformed, createHeaderIndex(typeHeaders))).toBeNull();
    }
  });

  it('throws for malformed promotions and incomplete or duplicate required headers', () => {
    expect(() => buildPromotionAppendRow(headers, { ...promotions[0], buyQuantity: 0 } as Promotion)).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[1], promotionalUnitPrice: 1.5 } as Promotion)).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[2], percent: 101 } as Promotion)).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], discountAmount: 0 } as Promotion)).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], startsAt: 'bad' })).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], startsAt: '2026-08-01T00:00:00Z' })).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], endsAt: promotions[3].startsAt })).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], createdAt: '2026-07-20T00:00:00Z' })).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], schemaVersion: 2 })).toThrow();
    expect(() => buildPromotionAppendRow(headers, { ...promotions[3], productIds: ['PRODUCT-1'] })).toThrow(/productIds/);
    expect(() => buildPromotionAppendRow(headers.filter((header) => header !== 'value'), promotions[0])).toThrow(/value/);
    expect(() => buildPromotionAppendRow([...headers, ' promotionId '], promotions[0])).toThrow(/promotionId/);
  });

  it('returns null when normalized required promotion headers are duplicated', () => {
    const duplicateHeaders = [...headers, ' promotionId '];
    const row = buildPromotionAppendRow(headers, promotions[0]);
    row.push('CONFLICTING-ID');

    expect(parsePromotionRow(row, createHeaderIndex(duplicateHeaders))).toBeNull();
  });

  it('returns null when a blank-capable required promotion header is missing or duplicated', () => {
    const row = buildPromotionAppendRow(headers, promotions[0]);
    const missingDescriptionHeaders = headers.filter((header) => header !== 'description');
    const missingDescriptionRow = headers
      .map((header, index) => ({ header, value: row[index] }))
      .filter(({ header }) => header !== 'description')
      .map(({ value }) => value);
    expect(parsePromotionRow(missingDescriptionRow, createHeaderIndex(missingDescriptionHeaders))).toBeNull();

    const duplicateValueHeaders = [...headers, ' value '];
    expect(parsePromotionRow([...row, 'conflicting'], createHeaderIndex(duplicateValueHeaders))).toBeNull();
  });
});

describe('promotion-product sheet row codecs', () => {
  const headers = ['unknown', 'productId', 'schemaVersion', 'promotionProductId', 'createdAt', 'promotionId', 'trailing'];
  const link: PromotionProductLink = {
    promotionProductId: 'PP-1', promotionId: 'PROMO-1', productId: 'PRODUCT-1',
    createdAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3,
  };

  it('round-trips a link in live header order and preserves unknown existing cells', () => {
    const existingRow = ['keep-unknown', 'old', 'old', 'old', 'old', 'old', 'keep-trailing'];
    const row = buildPromotionProductAppendRow(headers, link, existingRow);
    expect(row).toEqual(['keep-unknown', 'PRODUCT-1', '3', 'PP-1', link.createdAt, 'PROMO-1', 'keep-trailing']);
    expect(parsePromotionProductRow(row, createHeaderIndex(headers))).toEqual(link);
  });

  it('preserves duplicate unknown link columns and headerless trailing cells by physical index', () => {
    const duplicateUnknownHeaders = [...headers, 'unknown'];
    const existingRow = duplicateUnknownHeaders.map((_, index) => `existing-${index}`);
    existingRow.push('headerless-tail');

    const row = buildPromotionProductAppendRow(duplicateUnknownHeaders, link, existingRow);

    expect(row[0]).toBe('existing-0');
    expect(row[7]).toBe('existing-7');
    expect(row[8]).toBe('headerless-tail');
  });

  it('returns null for malformed links and throws for malformed serialization inputs', () => {
    const canonicalHeaders = ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'];
    const valid = ['PP-1', 'PROMO-1', 'PRODUCT-1', link.createdAt, '3'];
    for (const malformed of [
      ['', ...valid.slice(1)], [valid[0], ' ', ...valid.slice(2)],
      [...valid.slice(0, 2), '', ...valid.slice(3)], [...valid.slice(0, 3), 'bad', valid[4]],
      [...valid.slice(0, 3), '2026-08-01T00:00:00Z', valid[4]],
      [...valid.slice(0, 4), '2'], valid.slice(0, 4),
    ]) expect(parsePromotionProductRow(malformed, createHeaderIndex(canonicalHeaders))).toBeNull();
    expect(() => buildPromotionProductAppendRow(headers, { ...link, productId: ' ' })).toThrow();
    expect(() => buildPromotionProductAppendRow(headers, { ...link, createdAt: 'bad' })).toThrow();
    expect(() => buildPromotionProductAppendRow(headers, { ...link, createdAt: '2026-08-01T00:00:00Z' })).toThrow();
    expect(() => buildPromotionProductAppendRow(headers, { ...link, schemaVersion: 4 })).toThrow();
    expect(() => buildPromotionProductAppendRow(headers.filter((header) => header !== 'promotionId'), link)).toThrow(/promotionId/);
    expect(() => buildPromotionProductAppendRow([...headers, ' productId '], link)).toThrow(/productId/);
  });

  it('returns null when normalized required link headers are duplicated', () => {
    const duplicateHeaders = [...headers, ' promotionId '];
    const row = buildPromotionProductAppendRow(headers, link);
    row.push('CONFLICTING-ID');

    expect(parsePromotionProductRow(row, createHeaderIndex(duplicateHeaders))).toBeNull();
  });
});
