import 'server-only';

import {
  BULK_IMPORT_MAX_ROWS,
  BULK_IMPORT_TEXT_LIMITS,
  isCanonicalOperationId,
  type BulkImportCommitRequest,
  type BulkImportIssue,
  type ProductImportPreview,
  type ProductImportRow,
} from '@/lib/bulkImport';
import { checkPlainText, readInteger, readText, readYesNo, type Coerced } from './cells';
import { fileNotices, hasExactKeys, isPlainRecord, rowList, sortIssues } from './common';
import { BulkImportFileError } from './errors';
import { readImportSheet, type ImportColumn, type SheetRow } from './sheetReader';
import { buildTemplateWorkbook, type TemplateColumn, type TemplateSpec } from './template';

type ProductField = 'name' | 'price' | 'stock' | 'category' | 'imageUrl' | 'sortOrder' | 'isActive';

export const PRODUCT_IMPORT_SHEET_NAME = '상품 목록';
export const PRODUCT_TEMPLATE_FILE_NAME = '매점 상품 양식.xlsx';
export const PRODUCT_TEMPLATE_ASCII_FILE_NAME = 'product-import-template.xlsx';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const EXCEL_WHOLE_LIMIT = 999_999_999_999;

const LABEL = {
  name: '상품 이름', price: '가격', stock: '재고', category: '분류',
  imageUrl: '이미지 주소', sortOrder: '목록 순서', isActive: '판매 여부',
} as const;

const COLUMNS: ReadonlyArray<ImportColumn<ProductField> & TemplateColumn> = [
  {
    field: 'name', label: LABEL.name, required: true, width: 22,
    aliases: ['상품명', '상품', '이름', '품명', '물건 이름', 'name'],
    description: `매점 화면에 보일 상품 이름이에요. ${BULK_IMPORT_TEXT_LIMITS.productName}자까지 적을 수 있어요. `
      + '파일 안에서나 이미 있는 상품과 이름이 겹치면 추가되지 않아요.',
    examples: ['초코파이', '연필'],
    validation: {
      type: 'textLength', operator: 'between', allowBlank: true, formulae: [1, BULK_IMPORT_TEXT_LIMITS.productName],
      showErrorMessage: true, errorTitle: '상품 이름', error: `1~${BULK_IMPORT_TEXT_LIMITS.productName}자로 적어 주세요.`,
    },
  },
  {
    field: 'price', label: LABEL.price, required: true, width: 13, numFmt: '#,##0',
    aliases: ['판매가', '판매 가격', '금액', '단가', 'price'],
    description: '0 이상의 정수예요. 학급 화폐 단위로 적어요(단위 글자는 빼고 숫자만).',
    examples: [500, 300],
    validation: {
      type: 'whole', operator: 'between', allowBlank: true, formulae: [0, EXCEL_WHOLE_LIMIT],
      showErrorMessage: true, errorTitle: '가격', error: '0 이상의 정수로 적어 주세요.',
    },
  },
  {
    field: 'stock', label: LABEL.stock, required: false, width: 13, numFmt: '#,##0',
    aliases: ['재고 수량', '수량', '개수', '재고량', 'stock'],
    description: '0 이상의 정수예요. 비워 두면 0개로 시작해요. 0이 아니면 재고 기록에 관리자 조정으로 남아요.',
    examples: [20, 50],
    validation: {
      type: 'whole', operator: 'between', allowBlank: true, formulae: [0, EXCEL_WHOLE_LIMIT],
      showErrorMessage: true, errorTitle: '재고', error: '0 이상의 정수로 적어 주세요.',
    },
  },
  {
    field: 'category', label: LABEL.category, required: false, width: 14,
    aliases: ['카테고리', '종류', '상품 분류', 'category'],
    description: `매점 화면의 분류 탭이 돼요(예: 간식, 문구). ${BULK_IMPORT_TEXT_LIMITS.category}자까지 적을 수 있어요. 비워도 돼요.`,
    examples: ['간식', '문구'],
  },
  {
    field: 'imageUrl', label: LABEL.imageUrl, required: false, width: 36,
    aliases: ['이미지', '이미지 URL', '사진', '사진 주소', '그림 주소', 'imageUrl', 'URL'],
    description: "http:// 또는 https://로 시작하는 인터넷 이미지 주소예요. 이미지에서 마우스 오른쪽 버튼 → '이미지 주소 복사'로 "
      + '얻을 수 있어요. 비워도 돼요.',
    examples: [null, 'https://example.com/pencil.png'],
  },
  {
    field: 'sortOrder', label: LABEL.sortOrder, required: false, width: 17,
    aliases: ['정렬 순서', '순서', '정렬', '표시 순서', 'sortOrder'],
    description: '작은 숫자가 매점 화면 앞쪽에 보여요. 비워 두면 지금 있는 상품 뒤에 파일 순서대로 붙어요.',
    examples: [null, null],
    validation: {
      type: 'whole', operator: 'between', allowBlank: true, formulae: [INT32_MIN, INT32_MAX],
      showErrorMessage: true, errorTitle: '목록 순서', error: '정수로 적어 주세요.',
    },
  },
  {
    field: 'isActive', label: LABEL.isActive, required: false, width: 17,
    aliases: ['판매', '판매중', '판매 중', '판매 상태', '사용', 'isActive'],
    description: "'예'면 매점 화면에 바로 보이고, '아니오'면 숨겨져요. 비워 두면 '예'예요.",
    examples: ['예', '아니오'],
    validation: {
      type: 'list', allowBlank: true, formulae: ['"예,아니오"'],
      showInputMessage: true, promptTitle: '판매 여부', prompt: "목록에서 '예' 또는 '아니오'를 고르세요.",
      showErrorMessage: true, errorTitle: '판매 여부', error: "'예' 또는 '아니오'만 적을 수 있어요.",
    },
  },
];

const TEMPLATE: TemplateSpec = {
  sheetName: PRODUCT_IMPORT_SHEET_NAME,
  guideTitle: '매점 상품 양식 작성 방법',
  columns: COLUMNS,
  notes: [
    `'${PRODUCT_IMPORT_SHEET_NAME}' 시트의 첫 줄(제목 줄)은 지우지 마세요. 열 순서는 바꿔도 괜찮아요.`,
    '회색 예시 줄은 지우고 둘째 줄부터 상품을 한 줄에 하나씩 적어 주세요. 예시와 똑같은 줄은 자동으로 건너뛰어요.',
    `한 번에 ${BULK_IMPORT_MAX_ROWS}개까지, 2MB 이하의 엑셀(.xlsx) 파일만 올릴 수 있어요. CSV, .xls, 매크로 파일은 안 돼요.`,
    '상품 번호(P001 …)는 자동으로 붙어요.',
    '파일을 올리면 먼저 미리 보기가 나와요. 확인을 눌러야 상품이 추가되고, 오류가 있는 줄은 추가되지 않아요.',
    '이미 있는 상품의 가격이나 재고는 이 파일로 바뀌지 않아요. 상품 목록에서 직접 고쳐 주세요.',
  ],
};

export type ExistingProducts = Readonly<{
  /** Normalized product name → product ID, for products that are not deleted. */
  activeNames: ReadonlyMap<string, string>;
  /** Largest sort order among products that are not deleted (0 when there are none). */
  maxSortOrder: number;
  /** Every product ID ever used in the class, including deleted ones. */
  usedProductIds: ReadonlyArray<string>;
}>;

/** A data row after cell checks; sortOrder may still be "automatic". */
type ProductCandidate = Omit<ProductImportRow, 'sortOrder'> & { sortOrder: number | null };

export type ParsedProductFile = Readonly<{
  sheetName: string;
  candidates: ReadonlyArray<ProductCandidate>;
  errors: ReadonlyArray<BulkImportIssue>;
  notices: ReadonlyArray<string>;
  readRowCount: number;
}>;

let templateCache: Promise<Uint8Array> | undefined;

/** The downloadable template (.xlsx bytes); built once per server instance. */
export function createProductImportTemplate(): Promise<Uint8Array> {
  templateCache ??= buildTemplateWorkbook(TEMPLATE).catch((error: unknown) => {
    templateCache = undefined;
    throw error;
  });
  return templateCache;
}

/** Compares product names the way a teacher would: case, width and spacing do not matter. */
export function productNameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export async function parseProductImportFile(bytes: Uint8Array): Promise<ParsedProductFile> {
  const sheet = await readImportSheet(bytes, COLUMNS, PRODUCT_IMPORT_SHEET_NAME);
  const candidates: ProductCandidate[] = [];
  const errors: BulkImportIssue[] = [];
  let examples = 0;
  for (const row of sheet.rows) {
    const values = readProductCells(row);
    if (isExampleRow(values)) {
      examples += 1;
      continue;
    }
    const issues: BulkImportIssue[] = [];
    const take = <T>(field: ProductField, coerced: Coerced<T>): T | undefined => {
      if (coerced.ok) return coerced.value;
      issues.push({ rowNumber: row.rowNumber, column: LABEL[field], message: coerced.message });
      return undefined;
    };
    const name = take('name', values.name);
    const price = take('price', values.price);
    const stock = take('stock', values.stock);
    const category = take('category', values.category);
    const imageUrl = take('imageUrl', values.imageUrl);
    const sortOrder = take('sortOrder', values.sortOrder);
    const isActive = take('isActive', values.isActive);
    if (name === null) issues.push({ rowNumber: row.rowNumber, column: LABEL.name, message: '상품 이름을 적어 주세요.' });
    if (price === null) issues.push({ rowNumber: row.rowNumber, column: LABEL.price, message: '가격을 적어 주세요.' });
    if (issues.length || name == null || price == null || stock === undefined || category === undefined
      || imageUrl === undefined || sortOrder === undefined || isActive === undefined) {
      errors.push(...issues);
      continue;
    }
    candidates.push({
      rowNumber: row.rowNumber, name, price, stock: stock ?? 0, category, imageUrl, sortOrder, isActive: isActive ?? true,
    });
  }

  const readRowCount = sheet.rows.length - examples;
  if (readRowCount > BULK_IMPORT_MAX_ROWS) {
    throw new BulkImportFileError('TOO_MANY_ROWS',
      `한 번에 ${BULK_IMPORT_MAX_ROWS}개까지 올릴 수 있어요. 지금 파일에는 ${readRowCount}줄이 있어요. 파일을 나눠서 올려 주세요.`);
  }
  if (readRowCount === 0) {
    throw new BulkImportFileError('NO_ROWS', '추가할 상품이 없어요. 양식의 둘째 줄부터 상품 이름과 가격을 적어 주세요.');
  }
  return {
    sheetName: sheet.sheetName,
    candidates,
    errors,
    notices: fileNotices(sheet.sheetName, PRODUCT_IMPORT_SHEET_NAME, examples, sheet.ignoredHeaders),
    readRowCount,
  };
}

/** Checks rows against each other and against the class's current products. */
export function validateProductRows(
  rows: ReadonlyArray<ProductImportRow>,
  existing: Pick<ExistingProducts, 'activeNames'>,
): { valid: ProductImportRow[]; errors: BulkImportIssue[] } {
  const rowsByName = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.name !== 'string') continue;
    const key = productNameKey(row.name);
    rowsByName.set(key, [...rowsByName.get(key) ?? [], row.rowNumber]);
  }
  const valid: ProductImportRow[] = [];
  const errors: BulkImportIssue[] = [];
  for (const row of rows) {
    const issues: BulkImportIssue[] = [];
    const issue = (column: string, message: string) => issues.push({ rowNumber: row.rowNumber, column, message });
    const nameProblem = checkPlainText(row.name, BULK_IMPORT_TEXT_LIMITS.productName);
    if (nameProblem) issue(LABEL.name, nameProblem);
    if (!Number.isSafeInteger(row.price) || row.price < 0) issue(LABEL.price, '0 이상의 정수로 적어 주세요.');
    if (!Number.isSafeInteger(row.stock) || row.stock < 0) issue(LABEL.stock, '0 이상의 정수로 적어 주세요.');
    if (row.category !== null) {
      const problem = checkPlainText(row.category, BULK_IMPORT_TEXT_LIMITS.category);
      if (problem) issue(LABEL.category, problem);
    }
    if (row.imageUrl !== null) {
      const problem = imageUrlProblem(row.imageUrl);
      if (problem) issue(LABEL.imageUrl, problem);
    }
    if (!Number.isInteger(row.sortOrder) || row.sortOrder < INT32_MIN || row.sortOrder > INT32_MAX) {
      issue(LABEL.sortOrder, '정수로 적어 주세요.');
    }
    if (typeof row.isActive !== 'boolean') issue(LABEL.isActive, "'예' 또는 '아니오'로 적어 주세요.");
    if (!nameProblem) {
      const key = productNameKey(row.name);
      const others = (rowsByName.get(key) ?? []).filter((rowNumber) => rowNumber !== row.rowNumber);
      if (others.length) issue(LABEL.name, `${rowList(others)}과 상품 이름이 겹쳐요.`);
      const existingId = existing.activeNames.get(key);
      if (existingId) issue(LABEL.name, `이미 같은 이름의 상품이 있어요 (${existingId}).`);
    }
    if (issues.length) errors.push(...issues);
    else valid.push(row);
  }
  return { valid, errors };
}

export function buildProductImportPreview(parsed: ParsedProductFile, existing: ExistingProducts): ProductImportPreview {
  let next = Math.max(0, Math.min(existing.maxSortOrder, INT32_MAX));
  const resolved = parsed.candidates.map((candidate): ProductImportRow => {
    if (candidate.sortOrder !== null) return { ...candidate, sortOrder: candidate.sortOrder };
    next = Math.min(next + 1, INT32_MAX);
    return { ...candidate, sortOrder: next };
  });
  const checked = validateProductRows(resolved, existing);
  return {
    ok: true,
    kind: 'products',
    sheetName: parsed.sheetName,
    rows: checked.valid,
    errors: sortIssues([...parsed.errors, ...checked.errors]),
    notices: parsed.notices,
    readRowCount: parsed.readRowCount,
  };
}

/** Next free "P001"-style IDs, skipping every ID ever used (case-insensitive, like the admin form). */
export function allocateProductIds(usedProductIds: ReadonlyArray<string>, count: number): string[] {
  const used = new Set(usedProductIds.map((id) => id.trim().toUpperCase()));
  const ids: string[] = [];
  for (let index = 1; ids.length < count; index += 1) {
    const candidate = `P${String(index).padStart(3, '0')}`;
    if (!used.has(candidate)) ids.push(candidate);
  }
  return ids;
}

const COMMIT_ROW_KEYS = ['category', 'imageUrl', 'isActive', 'name', 'price', 'rowNumber', 'sortOrder', 'stock'];

/** Strict shape check of the confirm request; semantic checks run again inside the commit. */
export function parseProductImportCommitRequest(value: unknown): BulkImportCommitRequest<ProductImportRow> | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['operationId', 'rows'])) return null;
  if (!isCanonicalOperationId(value.operationId)) return null;
  const rows = value.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > BULK_IMPORT_MAX_ROWS) return null;
  const seen = new Set<number>();
  const parsed: ProductImportRow[] = [];
  for (const row of rows) {
    if (!isPlainRecord(row) || !hasExactKeys(row, COMMIT_ROW_KEYS)) return null;
    if (!Number.isSafeInteger(row.rowNumber) || (row.rowNumber as number) < 2 || seen.has(row.rowNumber as number)
      || typeof row.name !== 'string'
      || !Number.isSafeInteger(row.price) || !Number.isSafeInteger(row.stock)
      || (row.category !== null && typeof row.category !== 'string')
      || (row.imageUrl !== null && typeof row.imageUrl !== 'string')
      || !Number.isSafeInteger(row.sortOrder)
      || typeof row.isActive !== 'boolean') return null;
    seen.add(row.rowNumber as number);
    parsed.push({
      rowNumber: row.rowNumber as number,
      name: row.name,
      price: row.price as number,
      stock: row.stock as number,
      category: row.category as string | null,
      imageUrl: row.imageUrl as string | null,
      sortOrder: row.sortOrder as number,
      isActive: row.isActive,
    });
  }
  return { operationId: value.operationId, rows: parsed };
}

type ProductCells = Readonly<{
  name: Coerced<string | null>;
  price: Coerced<number | null>;
  stock: Coerced<number | null>;
  category: Coerced<string | null>;
  imageUrl: Coerced<string | null>;
  sortOrder: Coerced<number | null>;
  isActive: Coerced<boolean | null>;
}>;

function readProductCells(row: SheetRow<ProductField>): ProductCells {
  const linked = row.hyperlinks.imageUrl;
  const imageText = linked && /^https?:\/\//i.test(linked)
    ? readText({ kind: 'text', text: linked }, BULK_IMPORT_TEXT_LIMITS.imageUrl)
    : readText(row.cells.imageUrl, BULK_IMPORT_TEXT_LIMITS.imageUrl);
  const imageUrl: Coerced<string | null> = imageText.ok && imageText.value !== null && imageUrlProblem(imageText.value)
    ? { ok: false, message: imageUrlProblem(imageText.value)! }
    : imageText;
  const sortOrder = readInteger(row.cells.sortOrder);
  return {
    name: readText(row.cells.name, BULK_IMPORT_TEXT_LIMITS.productName),
    price: readInteger(row.cells.price, { min: 0 }),
    stock: readInteger(row.cells.stock, { min: 0 }),
    category: readText(row.cells.category, BULK_IMPORT_TEXT_LIMITS.category),
    imageUrl,
    sortOrder: sortOrder.ok && sortOrder.value !== null && (sortOrder.value < INT32_MIN || sortOrder.value > INT32_MAX)
      ? { ok: false, message: '숫자가 너무 커요.' }
      : sortOrder,
    isActive: readYesNo(row.cells.isActive),
  };
}

function isExampleRow(values: ProductCells): boolean {
  const fields: ProductField[] = ['name', 'price', 'stock', 'category', 'imageUrl', 'sortOrder'];
  if (!fields.every((field) => values[field].ok) || !values.isActive.ok) return false;
  return [0, 1].some((index) => fields.every((field) => {
    const column = COLUMNS.find((candidate) => candidate.field === field)!;
    const value = (values[field] as { value: unknown }).value;
    return value === (column.examples[index] ?? null);
  }) && values.isActive.ok && values.isActive.value === (index === 0));
}

function imageUrlProblem(value: string): string | null {
  if (Array.from(value).length > BULK_IMPORT_TEXT_LIMITS.imageUrl) {
    return `${BULK_IMPORT_TEXT_LIMITS.imageUrl}자 이하로 적어 주세요.`;
  }
  if (/\s/.test(value)) return '주소에 빈칸이 있어요. 이미지 주소를 다시 복사해 주세요.';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    if (!url.hostname) throw new Error('host');
  } catch {
    return 'http:// 또는 https://로 시작하는 이미지 주소를 적어 주세요.';
  }
  return null;
}
