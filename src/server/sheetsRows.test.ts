import { describe, expect, it } from 'vitest';
import {
  buildTaskAppendRow,
  createHeaderIndex,
  parseAllowedStudentIds,
  parseProductRow,
  parseStudentRow,
  parseTaskRow,
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
});
