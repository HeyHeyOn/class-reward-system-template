import { describe, expect, it } from 'vitest';
import {
  createProduct,
  createStudent,
  getActiveProducts,
  getProducts,
  getStudentById,
  getStudents,
  updateProductDetails,
  updateStudentDetails,
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
    ['P001', '연필', '300', '20', 'TRUE', '', '문구', '1'],
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
        imageUrl: undefined,
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
        imageUrl: undefined,
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
        category: '쿠폰',
        sortOrder: 4,
      }),
    ).resolves.toEqual({
      productId: 'P004',
      name: '간식쿠폰',
      price: 1000,
      stock: 5,
      isActive: true,
      imageUrl: undefined,
      category: '쿠폰',
      sortOrder: 4,
    });

    expect(appended).toEqual([
      { sheetName: 'Products', values: ['P004', '간식쿠폰', '1000', '5', 'TRUE', '', '쿠폰', '4'] },
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
        category: '문구류',
        sortOrder: 5,
      }),
    ).resolves.toEqual({
      productId: 'P001',
      name: '연필 세트',
      price: 900,
      stock: 12,
      isActive: false,
      imageUrl: undefined,
      category: '문구류',
      sortOrder: 5,
    });

    expect(updates).toEqual([
      { sheetName: 'Products', rowNumber: 3, columnName: 'name', value: '연필 세트' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'price', value: 900 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 12 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'isActive', value: 'FALSE' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'category', value: '문구류' },
      { sheetName: 'Products', rowNumber: 3, columnName: 'sortOrder', value: 5 },
    ]);
  });
});
