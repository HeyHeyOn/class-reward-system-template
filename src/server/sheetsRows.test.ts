import { describe, expect, it } from 'vitest';
import {
  createHeaderIndex,
  parseProductRow,
  parseStudentRow,
  requireColumns,
} from '@/server/sheetsRows';

describe('sheets row parsing', () => {
  it('creates a header index and verifies required columns', () => {
    const headers = ['studentId', 'name', 'number', 'balance', 'qrValue', 'status', 'note'];
    const headerIndex = createHeaderIndex(headers);

    expect(headerIndex.get('studentId')).toBe(0);
    expect(headerIndex.get('balance')).toBe(3);
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
    const headerIndex = createHeaderIndex(['studentId', 'name', 'number', 'balance', 'qrValue', 'status', 'note']);

    expect(parseStudentRow(['S001', '김민준', '1', '3500', 'S001', 'ACTIVE', ''], headerIndex)).toEqual({
      studentId: 'S001',
      name: '김민준',
      number: 1,
      balance: 3500,
      status: 'ACTIVE',
    });
  });

  it('returns null for inactive or malformed student rows', () => {
    const headerIndex = createHeaderIndex(['studentId', 'name', 'number', 'balance', 'status']);

    expect(parseStudentRow(['S002', '이서연', '2', '1200', 'INACTIVE'], headerIndex)).toEqual({
      studentId: 'S002',
      name: '이서연',
      number: 2,
      balance: 1200,
      status: 'INACTIVE',
    });
    expect(parseStudentRow(['', '이름없음', '3', '100', 'ACTIVE'], headerIndex)).toBeNull();
    expect(parseStudentRow(['S003', '박도윤', '3', 'not-number', 'ACTIVE'], headerIndex)).toBeNull();
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
});
