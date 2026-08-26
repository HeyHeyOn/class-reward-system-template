import type { Promotion, PromotionProductLink } from '@/domain/types';
import {
  createHeaderIndex,
  parsePromotionProductRow,
  parsePromotionRow,
  requireColumns,
  REQUIRED_PROMOTION_COLUMNS,
  REQUIRED_PROMOTION_PRODUCT_COLUMNS,
} from '@/server/sheetsRows';
import type { OperationalSheetName, TabularReader } from '@/server/storage/tabularStore';

export type PromotionRecord = {
  promotion: Promotion;
  rowNumber: number;
};

export type PromotionProductRecord = {
  link: PromotionProductLink;
  rowNumber: number;
};

export async function getPromotionRecords(reader: TabularReader): Promise<PromotionRecord[]> {
  const rows = await reader.getRows('Promotions');
  const parsed = parseSheetRecords(
    rows,
    'Promotions',
    REQUIRED_PROMOTION_COLUMNS,
    (row, headerIndex, rowNumber) => {
      const promotion = parsePromotionRow(row, headerIndex);
      return promotion ? { promotion, rowNumber } : null;
    },
  );
  rejectDuplicateIds(parsed, ({ promotion }) => promotion.promotionId, 'Promotions', 'promotionId');
  return parsed;
}

export async function getPromotionProductRecords(
  reader: TabularReader,
): Promise<PromotionProductRecord[]> {
  const rows = await reader.getRows('PromotionProducts');
  const parsed = parseSheetRecords(
    rows,
    'PromotionProducts',
    REQUIRED_PROMOTION_PRODUCT_COLUMNS,
    (row, headerIndex, rowNumber) => {
      const link = parsePromotionProductRow(row, headerIndex);
      return link ? { link, rowNumber } : null;
    },
  );
  rejectDuplicateIds(
    parsed,
    ({ link }) => link.promotionProductId,
    'PromotionProducts',
    'promotionProductId',
  );
  return parsed;
}

export async function getPromotions(reader: TabularReader): Promise<Promotion[]> {
  const promotionRecords = await getPromotionRecords(reader);
  if (promotionRecords.length === 0) return [];

  const promotionProductRecords = await getPromotionProductRecords(reader);
  const promotionIds = new Set(promotionRecords.map(({ promotion }) => promotion.promotionId));
  const productIdsByPromotion = new Map<string, Set<string>>();
  for (const { link } of promotionProductRecords) {
    if (!promotionIds.has(link.promotionId)) continue;
    const productIds = productIdsByPromotion.get(link.promotionId) ?? new Set<string>();
    productIds.add(link.productId);
    productIdsByPromotion.set(link.promotionId, productIds);
  }

  return promotionRecords
    .map(({ promotion }) => ({
      ...promotion,
      productIds: [...(productIdsByPromotion.get(promotion.promotionId) ?? [])].sort(compareUtf16),
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder
      || compareUtf16(left.promotionId, right.promotionId));
}

export async function getActivePromotions(reader: TabularReader): Promise<Promotion[]> {
  return (await getPromotions(reader)).filter(({ isActive }) => isActive);
}

type HeaderIndex = ReturnType<typeof createHeaderIndex>;

function parseSheetRecords<T>(
  rows: string[][],
  sheetName: OperationalSheetName,
  requiredColumns: readonly string[],
  parse: (row: string[], headerIndex: HeaderIndex, rowNumber: number) => T | null,
): T[] {
  const [headers, ...dataRows] = rows;
  if (!headers || headers.every((header) => !String(header).trim())) return [];

  const headerIndex = createHeaderIndex(headers);
  const required = requireColumns(headerIndex, requiredColumns);
  if (required.ok === false) {
    throw new Error(`${sheetName} 시트에 필수 컬럼이 없습니다: ${required.missingColumns.join(', ')}`);
  }

  return dataRows.flatMap((row, index) => {
    const record = parse(row, headerIndex, index + 2);
    return record ? [record] : [];
  });
}

function rejectDuplicateIds<T>(
  records: T[],
  getId: (record: T) => string,
  sheetName: OperationalSheetName,
  idColumn: string,
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const id = getId(record);
    if (seen.has(id)) {
      throw new Error(`${sheetName} 시트에 중복된 ${idColumn}가 있습니다: ${id}`);
    }
    seen.add(id);
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
