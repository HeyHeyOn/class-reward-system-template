import { describe, expect, it } from 'vitest';
import {
  createProduct,
  createStudent,
  getActiveProducts,
  getProducts,
  getStudentById,
  getStudents,
  bulkAdjustStudentBalances,
  deleteProduct,
  deleteProductsBatch,
  deleteStudent,
  deleteStudentsBatch,
  updateProductDetails,
  updateProductDetailsBatch,
  updateStudentDetails,
  updateStudentDetailsBatch,
} from '@/server/sheetsRepository';

const sheetRows = {
  Students: [
    ['studentId', 'name', 'number', 'balance', 'qrValue', 'status', 'note'],
    ['S001', '김민준', '1', '3500', 'S001', 'ACTIVE', ''],
    ['S002', '이서연', '2', '1200', 'S002', 'INACTIVE', ''],
  ],
  Products: [
    ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
    ['P002', '지우개', '500', '15', 'TRUE', '', '문구', '2'],
    ['P001', '연필', '300', '20', 'TRUE', 'https://example.com/pencil.png', '문구', '1'],
    ['P003', '판매중지', '700', '10', 'FALSE', '', '문구', '3'],
  ],
};

const fakeReader = {
  async getRows(sheetName: 'Students' | 'Products') {
    return sheetRows[sheetName];
  },
};

describe('sheets repository', () => {
  it('finds a student by studentId', async () => {
    await expect(getStudentById(fakeReader, 'S001')).resolves.toEqual({
      studentId: 'S001',
      name: '김민준',
      number: 1,
      balance: 3500,
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
        number: 1,
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

  it('updates editable student cells by row number', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
    };

    await expect(
      updateStudentDetails(fakeStore, 'S001', { name: '김민준 수정', number: 11, balance: 4000, status: 'INACTIVE' }),
    ).resolves.toEqual({ studentId: 'S001', name: '김민준 수정', number: 11, balance: 4000, status: 'INACTIVE' });

    expect(updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'name', value: '김민준 수정' },
      { sheetName: 'Students', rowNumber: 2, columnName: 'number', value: 11 },
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 4000 },
      { sheetName: 'Students', rowNumber: 2, columnName: 'status', value: 'INACTIVE' },
    ]);
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
        { studentId: 'S001', name: '김민준 수정', number: 11, balance: 4000, status: 'INACTIVE' },
        { studentId: 'S002', name: '이서연', number: 22, balance: 9000, status: 'ACTIVE' },
      ]),
    ).resolves.toEqual([
      { studentId: 'S001', name: '김민준 수정', number: 11, balance: 4000, status: 'INACTIVE' },
      { studentId: 'S002', name: '이서연', number: 22, balance: 9000, status: 'ACTIVE' },
    ]);

    expect(batches).toEqual([
      {
        sheetName: 'Students',
        updates: [
          { rowNumber: 2, columnName: 'name', value: '김민준 수정' },
          { rowNumber: 2, columnName: 'number', value: 11 },
          { rowNumber: 2, columnName: 'balance', value: 4000 },
          { rowNumber: 2, columnName: 'status', value: 'INACTIVE' },
          { rowNumber: 3, columnName: 'name', value: '이서연' },
          { rowNumber: 3, columnName: 'number', value: 22 },
          { rowNumber: 3, columnName: 'balance', value: 9000 },
          { rowNumber: 3, columnName: 'status', value: 'ACTIVE' },
        ],
      },
    ]);
  });

  it('appends a new student row with QR value matching studentId', async () => {
    const appended: Array<{ sheetName: string; values: string[] }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell() {},
      async appendRow(sheetName: 'Students' | 'Products', values: string[]) {
        appended.push({ sheetName, values });
      },
    };

    await expect(
      createStudent(fakeStore, { studentId: 'S003', name: '박도윤', number: 3, balance: 0, status: 'ACTIVE' }),
    ).resolves.toEqual({ studentId: 'S003', name: '박도윤', number: 3, balance: 0, status: 'ACTIVE' });

    expect(appended).toEqual([
      { sheetName: 'Students', values: ['S003', '박도윤', '3', '0', 'S003', 'ACTIVE', ''] },
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

  it('bulk adjusts selected student balances with set/add/subtract modes', async () => {
    const updates: Array<{ sheetName: string; rowNumber: number; columnName: string; value: string | number }> = [];
    const fakeStore = {
      ...fakeReader,
      async updateCell(sheetName: 'Students' | 'Products', rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow() {},
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
});
