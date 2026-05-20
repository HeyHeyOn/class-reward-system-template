import type { CheckoutLineItem, Product, Student, Transaction } from '@/domain/types';
import {
  createHeaderIndex,
  parseProductRow,
  parseStudentRow,
  requireColumns,
} from '@/server/sheetsRows';

export type SheetName = 'Students' | 'Products' | 'Transactions' | 'Adjustments' | 'Settings';

export type SheetsReader = {
  getRows(sheetName: SheetName): Promise<string[][]>;
};

export type SheetsStore = SheetsReader & {
  updateCell(sheetName: SheetName, rowNumber: number, columnName: string, value: string | number): Promise<void>;
  appendRow(sheetName: SheetName, values: string[]): Promise<void>;
  deleteRow?(sheetName: SheetName, rowNumber: number): Promise<void>;
};

export type StudentRecord = {
  student: Student;
  rowNumber: number;
};

export type ProductRecord = {
  product: Product;
  rowNumber: number;
};

export type StudentUpdate = {
  name: string;
  number: number;
  balance: number;
  status: Student['status'];
};

export type StudentCreate = StudentUpdate & {
  studentId: string;
};

export type ProductUpdate = {
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  category?: string;
  sortOrder: number;
};

export type ProductCreate = ProductUpdate & {
  productId: string;
};

export type StudentBulkBalanceMode = 'set' | 'add' | 'subtract';

export type StudentBulkBalanceUpdate = {
  studentIds: string[];
  mode: StudentBulkBalanceMode;
  amount: number;
};

const REQUIRED_STUDENT_COLUMNS = ['studentId', 'name', 'number', 'balance', 'status'];
const REQUIRED_PRODUCT_COLUMNS = ['productId', 'name', 'price', 'stock', 'isActive'];
const REQUIRED_TRANSACTION_COLUMNS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];

export type SheetSetting = {
  key: string;
  value: string;
};

export async function getStudentById(reader: SheetsReader, studentId: string): Promise<Student | null> {
  return (await getStudentRecordById(reader, studentId))?.student ?? null;
}

export async function getStudentRecordById(reader: SheetsReader, studentId: string): Promise<StudentRecord | null> {
  const rows = await reader.getRows('Students');
  const [headers, ...dataRows] = rows;

  if (!headers) return null;

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');

  for (let index = 0; index < dataRows.length; index += 1) {
    const student = parseStudentRow(dataRows[index], headerIndex);

    if (student?.studentId === studentId) {
      return { student, rowNumber: index + 2 };
    }
  }

  return null;
}

export async function getStudents(reader: SheetsReader): Promise<Student[]> {
  const rows = await reader.getRows('Students');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');

  return dataRows
    .map((row) => parseStudentRow(row, headerIndex))
    .filter((student): student is Student => student !== null)
    .filter((student) => student.status === 'ACTIVE')
    .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
}

export async function getActiveProducts(reader: SheetsReader): Promise<Product[]> {
  return (await getProducts(reader)).filter((product) => product.isActive);
}

export async function getProducts(reader: SheetsReader): Promise<Product[]> {
  return (await getProductRecords(reader)).map((record) => record.product);
}

export async function getTransactions(reader: SheetsReader): Promise<Transaction[]> {
  const rows = await reader.getRows('Transactions');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_TRANSACTION_COLUMNS, 'Transactions');

  return dataRows
    .map((row) => parseTransactionRow(row, headerIndex))
    .filter((transaction): transaction is Transaction => transaction !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getSheetSettings(reader: SheetsReader): Promise<Record<string, string>> {
  const rows = await reader.getRows('Settings');
  const [headers, ...dataRows] = rows;

  if (!headers) return {};

  const headerIndex = createHeaderIndex(headers);
  const keyIndex = headerIndex.get('key');
  const valueIndex = headerIndex.get('value');

  if (keyIndex === undefined || valueIndex === undefined) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  return Object.fromEntries(
    dataRows
      .map((row) => [String(row[keyIndex] ?? '').trim(), String(row[valueIndex] ?? '').trim()] as const)
      .filter(([key]) => Boolean(key)),
  );
}

export async function saveSheetSetting(store: SheetsStore, setting: SheetSetting): Promise<void> {
  const key = setting.key.trim();
  if (!key) throw new Error('설정 키를 입력해 주세요.');

  const rows = await store.getRows('Settings');
  const [headers, ...dataRows] = rows;

  if (!headers) {
    await store.appendRow('Settings', ['key', 'value']);
    await store.appendRow('Settings', [key, setting.value]);
    return;
  }

  const headerIndex = createHeaderIndex(headers);
  const keyIndex = headerIndex.get('key');

  if (keyIndex === undefined || headerIndex.get('value') === undefined) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }

  const existingIndex = dataRows.findIndex((row) => String(row[keyIndex] ?? '').trim() === key);
  if (existingIndex >= 0) {
    await store.updateCell('Settings', existingIndex + 2, 'value', setting.value);
    return;
  }

  await store.appendRow('Settings', [key, setting.value]);
}

export async function getProductRecords(reader: SheetsReader): Promise<ProductRecord[]> {
  const rows = await reader.getRows('Products');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_PRODUCT_COLUMNS, 'Products');

  return dataRows
    .map((row, index) => {
      const product = parseProductRow(row, headerIndex);
      return product ? { product, rowNumber: index + 2 } : null;
    })
    .filter((record): record is ProductRecord => Boolean(record))
    .sort((a, b) => a.product.sortOrder - b.product.sortOrder || a.product.name.localeCompare(b.product.name));
}

export async function createStudent(store: SheetsStore, create: StudentCreate): Promise<Student> {
  const studentId = create.studentId.trim();
  validateStudentId(studentId);
  validateStudentUpdate(create);

  if (await getStudentById(store, studentId)) {
    throw new Error('이미 존재하는 학생 ID입니다.');
  }

  const student: Student = {
    studentId,
    name: create.name.trim(),
    number: create.number,
    balance: create.balance,
    status: create.status,
  };

  await store.appendRow('Students', [
    student.studentId,
    student.name,
    String(student.number),
    String(student.balance),
    student.studentId,
    student.status,
    '',
  ]);

  return student;
}

export async function updateStudentDetails(store: SheetsStore, studentId: string, update: StudentUpdate): Promise<Student> {
  const record = await getStudentRecordById(store, studentId);

  if (!record) {
    throw new Error('학생을 찾을 수 없습니다.');
  }

  validateStudentUpdate(update);

  const name = update.name.trim();
  await store.updateCell('Students', record.rowNumber, 'name', name);
  await store.updateCell('Students', record.rowNumber, 'number', update.number);
  await store.updateCell('Students', record.rowNumber, 'balance', update.balance);
  await store.updateCell('Students', record.rowNumber, 'status', update.status);

  return { studentId, name, number: update.number, balance: update.balance, status: update.status };
}

export async function deleteStudent(store: SheetsStore, studentId: string): Promise<{ studentId: string }> {
  const record = await getStudentRecordById(store, studentId);
  if (!record) throw new Error('학생을 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');

  await store.deleteRow('Students', record.rowNumber);
  return { studentId };
}

export async function bulkAdjustStudentBalances(
  store: SheetsStore,
  update: StudentBulkBalanceUpdate,
): Promise<Array<{ studentId: string; balance: number }>> {
  validateStudentBulkBalanceUpdate(update);

  const uniqueIds = Array.from(new Set(update.studentIds.map((id) => id.trim()).filter(Boolean)));
  const records = await Promise.all(uniqueIds.map((studentId) => getStudentRecordById(store, studentId)));
  const missingIds = uniqueIds.filter((_, index) => !records[index]);
  if (missingIds.length > 0) throw new Error(`학생을 찾을 수 없습니다: ${missingIds.join(', ')}`);

  const results: Array<{ studentId: string; balance: number }> = [];
  for (const record of records) {
    if (!record) continue;
    const balance =
      update.mode === 'set'
        ? update.amount
        : update.mode === 'add'
          ? record.student.balance + update.amount
          : record.student.balance - update.amount;

    if (balance < 0) throw new Error(`${record.student.studentId} 학생의 잔액은 0보다 작아질 수 없습니다.`);
    await store.updateCell('Students', record.rowNumber, 'balance', balance);
    results.push({ studentId: record.student.studentId, balance });
  }

  return results;
}

export async function createProduct(store: SheetsStore, create: ProductCreate): Promise<Product> {
  const productId = create.productId.trim();
  validateProductId(productId);
  validateProductUpdate(create);

  if ((await getProductRecords(store)).some(({ product }) => product.productId === productId)) {
    throw new Error('이미 존재하는 상품 ID입니다.');
  }

  const category = create.category?.trim() || undefined;
  const product: Product = {
    productId,
    name: create.name.trim(),
    price: create.price,
    stock: create.stock,
    isActive: create.isActive,
    imageUrl: undefined,
    category,
    sortOrder: create.sortOrder,
  };

  await store.appendRow('Products', [
    product.productId,
    product.name,
    String(product.price),
    String(product.stock),
    product.isActive ? 'TRUE' : 'FALSE',
    '',
    product.category ?? '',
    String(product.sortOrder),
  ]);

  return product;
}

export async function updateProductDetails(store: SheetsStore, productId: string, update: ProductUpdate): Promise<Product> {
  const record = (await getProductRecords(store)).find(({ product }) => product.productId === productId);

  if (!record) {
    throw new Error('상품을 찾을 수 없습니다.');
  }

  validateProductUpdate(update);

  const name = update.name.trim();
  const category = update.category?.trim() || undefined;
  await store.updateCell('Products', record.rowNumber, 'name', name);
  await store.updateCell('Products', record.rowNumber, 'price', update.price);
  await store.updateCell('Products', record.rowNumber, 'stock', update.stock);
  await store.updateCell('Products', record.rowNumber, 'isActive', update.isActive ? 'TRUE' : 'FALSE');
  await store.updateCell('Products', record.rowNumber, 'category', category ?? '');
  await store.updateCell('Products', record.rowNumber, 'sortOrder', update.sortOrder);

  return {
    ...record.product,
    name,
    price: update.price,
    stock: update.stock,
    isActive: update.isActive,
    category,
    sortOrder: update.sortOrder,
  };
}

export async function deleteProduct(store: SheetsStore, productId: string): Promise<{ productId: string }> {
  const record = (await getProductRecords(store)).find(({ product }) => product.productId === productId);
  if (!record) throw new Error('상품을 찾을 수 없습니다.');
  if (!store.deleteRow) throw new Error('현재 Sheets 저장소가 행 삭제를 지원하지 않습니다.');

  await store.deleteRow('Products', record.rowNumber);
  return { productId };
}

function validateStudentId(studentId: string) {
  if (!studentId) throw new Error('학생 ID를 입력해 주세요.');
}

function validateStudentUpdate(update: StudentUpdate) {
  if (!update.name.trim()) throw new Error('학생 이름을 입력해 주세요.');
  if (!Number.isInteger(update.number) || update.number <= 0) throw new Error('학생 번호는 1 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.balance) || update.balance < 0) throw new Error('잔액은 0 이상의 정수여야 합니다.');
  if (update.status !== 'ACTIVE' && update.status !== 'INACTIVE') throw new Error('학생 상태가 올바르지 않습니다.');
}

function validateStudentBulkBalanceUpdate(update: StudentBulkBalanceUpdate) {
  if (!Array.isArray(update.studentIds) || update.studentIds.length === 0) throw new Error('선택된 학생이 없습니다.');
  if (update.mode !== 'set' && update.mode !== 'add' && update.mode !== 'subtract') throw new Error('일괄 작업 방식이 올바르지 않습니다.');
  if (!Number.isInteger(update.amount) || update.amount < 0) throw new Error('금액은 0 이상의 정수여야 합니다.');
}

function validateProductId(productId: string) {
  if (!productId) throw new Error('상품 ID를 입력해 주세요.');
}

function validateProductUpdate(update: ProductUpdate) {
  if (!update.name.trim()) throw new Error('상품명을 입력해 주세요.');
  if (!Number.isInteger(update.price) || update.price < 0) throw new Error('가격은 0 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.stock) || update.stock < 0) throw new Error('재고는 0 이상의 정수여야 합니다.');
  if (!Number.isInteger(update.sortOrder)) throw new Error('정렬 순서는 정수여야 합니다.');
}

function assertRequiredColumns(
  headerIndex: Map<string, number>,
  requiredColumns: string[],
  sheetName: SheetName,
) {
  const result = requireColumns(headerIndex, requiredColumns);

  if (result.ok === false) {
    throw new Error(`${sheetName} 시트에 필수 컬럼이 없습니다: ${result.missingColumns.join(', ')}`);
  }
}

function parseTransactionRow(row: string[], headerIndex: Map<string, number>): Transaction | null {
  const transactionId = getRowCell(row, headerIndex, 'transactionId');
  const timestamp = getRowCell(row, headerIndex, 'timestamp');
  const studentId = getRowCell(row, headerIndex, 'studentId');
  const studentName = getRowCell(row, headerIndex, 'studentName');
  const totalAmount = parseNumberValue(getRowCell(row, headerIndex, 'totalAmount'));
  const balanceBefore = parseNumberValue(getRowCell(row, headerIndex, 'balanceBefore'));
  const balanceAfter = parseNumberValue(getRowCell(row, headerIndex, 'balanceAfter'));

  if (!transactionId || !timestamp || !studentId || !studentName || totalAmount === null || balanceBefore === null || balanceAfter === null) {
    return null;
  }

  return {
    transactionId,
    timestamp,
    studentId,
    studentName,
    items: parseTransactionItems(getRowCell(row, headerIndex, 'items') || getRowCell(row, headerIndex, 'itemJson') || getRowCell(row, headerIndex, 'products')),
    totalAmount,
    balanceBefore,
    balanceAfter,
    status: getRowCell(row, headerIndex, 'status') || 'UNKNOWN',
    operator: getRowCell(row, headerIndex, 'operator') || 'unknown',
  };
}

function getRowCell(row: string[], headerIndex: Map<string, number>, column: string): string {
  const index = headerIndex.get(column);
  if (index === undefined) return '';
  return String(row[index] ?? '').trim();
}

function parseNumberValue(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTransactionItems(value: string): CheckoutLineItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CheckoutLineItem => Boolean(item && typeof item === 'object' && 'productId' in item));
  } catch {
    return [];
  }
}
