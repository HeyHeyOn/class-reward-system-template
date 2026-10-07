// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BulkImportFileError } from './errors';
import {
  allocateProductIds,
  buildProductImportPreview,
  createProductImportTemplate,
  parseProductImportCommitRequest,
  parseProductImportFile,
  type ExistingProducts,
} from './productImport';
import { assertSafeXlsxContainer } from './xlsxContainer';
import { loadWorkbook, workbookBytes, type FixtureCell } from './testing/workbookFixtures';

vi.mock('server-only', () => ({}));

const HEADER = ['상품 이름 (필수)', '가격 (필수)', '재고 (선택)', '분류 (선택)', '이미지 주소 (선택)', '목록 순서 (선택)', '판매 여부 (선택)'];
const EMPTY_STORE: ExistingProducts = { activeNames: new Map(), maxSortOrder: 0, usedProductIds: [] };

async function sheet(rows: FixtureCell[][], name = '상품 목록') {
  return workbookBytes([{ name, rows }]);
}

async function fileError(promise: Promise<unknown>): Promise<BulkImportFileError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BulkImportFileError) return error;
    throw error;
  }
  throw new Error('expected a file error');
}

describe('product template', () => {
  it('has every store field, the 예/아니오 list validation and a guide sheet', async () => {
    const bytes = await createProductImportTemplate();
    expect(() => assertSafeXlsxContainer(bytes)).not.toThrow();
    const workbook = await loadWorkbook(bytes);
    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(['상품 목록', '작성 방법']);
    const input = workbook.worksheets[0];
    expect(HEADER.map((_, index) => input.getRow(1).getCell(index + 1).value)).toEqual(HEADER);
    expect(input.getCell('G50').dataValidation).toMatchObject({ type: 'list', formulae: ['"예,아니오"'] });
    expect(input.getCell('B50').dataValidation).toMatchObject({ type: 'whole' });
    const guideText = workbook.worksheets[1].getSheetValues().flat().map(String).join(' ');
    expect(guideText).toContain('판매 여부');
    expect(guideText).toContain('P001');
  });

  it('skips the example rows of an untouched template', async () => {
    const error = await fileError(parseProductImportFile(await createProductImportTemplate()));
    expect(error.code).toBe('NO_ROWS');
  });
});

describe('product file parsing', () => {
  it('reads every field, applies defaults and resolves automatic sort order after existing products', async () => {
    const parsed = await parseProductImportFile(await sheet([
      HEADER,
      ['새우깡', 800, 10, '간식', 'https://example.com/a.png', 3, '예'],
      ['지우개', '300', null, null, null, null, null],
      ['공책', '1,200원', '5개', ' 문구 ', null, null, '아니오'],
    ]));
    const existing: ExistingProducts = { activeNames: new Map(), maxSortOrder: 7, usedProductIds: ['P001'] };
    const preview = buildProductImportPreview(parsed, existing);
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toEqual([
      { rowNumber: 2, name: '새우깡', price: 800, stock: 10, category: '간식', imageUrl: 'https://example.com/a.png', sortOrder: 3, isActive: true },
      { rowNumber: 3, name: '지우개', price: 300, stock: 0, category: null, imageUrl: null, sortOrder: 8, isActive: true },
      { rowNumber: 4, name: '공책', price: 1200, stock: 5, category: '문구', imageUrl: null, sortOrder: 9, isActive: false },
    ]);
  });

  it('matches reordered and aliased headers and accepts O/X, TRUE/FALSE and hyperlinks', async () => {
    const parsed = await parseProductImportFile(await sheet([
      ['판매', '상품명', '카테고리', '단가', '수량', '이미지'],
      ['O', '사탕', '간식', 100, 3, { text: '사진 보기', hyperlink: 'https://example.com/candy.png' }],
      [false, '풍선', '', 200, 1, null],
    ], '시트1'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toEqual([
      { rowNumber: 2, name: '사탕', price: 100, stock: 3, category: '간식', imageUrl: 'https://example.com/candy.png', sortOrder: null, isActive: true },
      { rowNumber: 3, name: '풍선', price: 200, stock: 1, category: null, imageUrl: null, sortOrder: null, isActive: false },
    ]);
  });

  it('reports bad cells with row numbers', async () => {
    const parsed = await parseProductImportFile(await sheet([
      HEADER,
      [null, 100],
      ['가격 없음', null],
      ['음수 가격', -5],
      ['소수 재고', 100, 1.5],
      ['이상한 판매', 100, 1, null, null, null, '글쎄'],
      ['나쁜 주소', 100, 1, null, 'javascript:alert(1)'],
      ['순서 초과', 100, 1, null, null, 9999999999],
      ['날짜 가격', new Date(Date.UTC(2026, 0, 1))],
      ['정상', 100],
    ]));
    expect(parsed.candidates.map((row) => row.name)).toEqual(['정상']);
    expect(parsed.errors).toEqual([
      { rowNumber: 2, column: '상품 이름', message: '상품 이름을 적어 주세요.' },
      { rowNumber: 3, column: '가격', message: '가격을 적어 주세요.' },
      { rowNumber: 4, column: '가격', message: '0 이상의 숫자로 적어 주세요.' },
      { rowNumber: 5, column: '재고', message: '소수점 없이 정수로 적어 주세요.' },
      { rowNumber: 6, column: '판매 여부', message: "'예' 또는 '아니오'로 적어 주세요." },
      { rowNumber: 7, column: '이미지 주소', message: expect.stringContaining('http://') },
      { rowNumber: 8, column: '목록 순서', message: '숫자가 너무 커요.' },
      { rowNumber: 9, column: '가격', message: expect.stringContaining('날짜') },
    ]);
  });

  it('flags duplicate names in the file and names that already exist in the store', async () => {
    const parsed = await parseProductImportFile(await sheet([
      HEADER, ['초코 우유', 500], ['딸기우유', 500], ['초코우유', 600], ['바나나우유', 700],
    ]));
    const existing: ExistingProducts = {
      activeNames: new Map([['바나나우유', 'P004']]), maxSortOrder: 4, usedProductIds: ['P004'],
    };
    const preview = buildProductImportPreview(parsed, existing);
    expect(preview.rows.map((row) => row.name)).toEqual(['딸기우유']);
    expect(preview.errors).toEqual([
      { rowNumber: 2, column: '상품 이름', message: '4행과 상품 이름이 겹쳐요.' },
      { rowNumber: 4, column: '상품 이름', message: '2행과 상품 이름이 겹쳐요.' },
      { rowNumber: 5, column: '상품 이름', message: '이미 같은 이름의 상품이 있어요 (P004).' },
    ]);
  });

  it('refuses more than 200 rows and sheets without the required headers', async () => {
    const rows: FixtureCell[][] = [HEADER];
    for (let index = 1; index <= 201; index += 1) rows.push([`상품${index}`, 100]);
    expect((await fileError(parseProductImportFile(await sheet(rows)))).code).toBe('TOO_MANY_ROWS');
    const missing = await fileError(parseProductImportFile(await sheet([['상품 이름', '재고'], ['a', 1]])));
    expect(missing.code).toBe('NO_MATCHING_SHEET');
    expect(missing.message).toContain("'가격' 열을 찾지 못했어요");
  });

  it('builds a preview that passes validation with an empty store', async () => {
    const preview = buildProductImportPreview(await parseProductImportFile(await sheet([HEADER, ['a', 1]])), EMPTY_STORE);
    expect(preview.rows).toEqual([expect.objectContaining({ name: 'a', sortOrder: 1 })]);
  });
});

describe('product IDs', () => {
  it('allocates P-numbers after every ID ever used, case-insensitively', () => {
    expect(allocateProductIds([], 2)).toEqual(['P001', 'P002']);
    expect(allocateProductIds(['P001', 'p002', 'P004', 'custom'], 3)).toEqual(['P003', 'P005', 'P006']);
  });
});

describe('product commit request', () => {
  const operationId = '10000000-0000-4000-8000-000000000002';
  const row = { rowNumber: 2, name: '사탕', price: 100, stock: 0, category: null, imageUrl: null, sortOrder: 1, isActive: true };

  it('accepts the exact preview row shape', () => {
    expect(parseProductImportCommitRequest({ operationId, rows: [row] })).toEqual({ operationId, rows: [row] });
  });

  it.each([
    ['product IDs chosen by the client', { operationId, rows: [{ ...row, productId: 'P001' }] }],
    ['missing optional keys', { operationId, rows: [{ rowNumber: 2, name: 'a', price: 1, stock: 0, sortOrder: 1, isActive: true }] }],
    ['string price', { operationId, rows: [{ ...row, price: '100' }] }],
    ['non-boolean active flag', { operationId, rows: [{ ...row, isActive: 'Y' }] }],
  ])('rejects %s', (_label, body) => {
    expect(parseProductImportCommitRequest(body)).toBeNull();
  });
});
