import {
  MigrationConflictError,
  SheetProviderError,
  type AdditiveSchemaMigrationStore,
  type OperationalSheetName,
} from '@/server/storage/tabularStore';

export const PROMOTIONS_HEADERS = [
  'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
  'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
] as const;

export const PROMOTION_PRODUCTS_HEADERS = [
  'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
] as const;

type PromotionSheet = {
  name: 'Promotions' | 'PromotionProducts';
  headers: readonly string[];
};

const PROMOTION_SHEETS: readonly PromotionSheet[] = [
  { name: 'Promotions', headers: PROMOTIONS_HEADERS },
  { name: 'PromotionProducts', headers: PROMOTION_PRODUCTS_HEADERS },
];

/** Explicit command. Ordinary reads never invoke promotion schema migration. */
export async function migratePromotionSchema(store: AdditiveSchemaMigrationStore): Promise<void> {
  const missing: PromotionSheet[] = [];

  for (const sheet of PROMOTION_SHEETS) {
    const lookup = await store.lookupSheet(sheet.name);
    if (!lookup.found) {
      missing.push(sheet);
      continue;
    }
    await assertCanonicalHeader(store, sheet, 'existing sheet is blank or noncanonical', false);
  }

  for (const sheet of missing) await createMissingSheet(store, sheet);
}

async function createMissingSheet(
  store: AdditiveSchemaMigrationStore,
  sheet: PromotionSheet,
): Promise<void> {
  let racedCreate = false;
  try {
    await store.createSheetWithHeader(sheet.name, sheet.headers);
  } catch (error) {
    if (!(error instanceof SheetProviderError) || error.reason !== 'SHEET_ALREADY_EXISTS') throw error;
    racedCreate = true;
  }

  const lookup = await store.lookupSheet(sheet.name);
  if (!lookup.found) {
    throw new MigrationConflictError(sheet.name, 'sheet is absent after create');
  }
  await assertCanonicalHeader(
    store,
    sheet,
    racedCreate ? 'concurrent create was not canonical' : 'created sheet was not canonical',
    false,
  );
}

async function assertCanonicalHeader(
  store: AdditiveSchemaMigrationStore,
  sheet: PromotionSheet,
  detail: string,
  retryable: boolean,
): Promise<void> {
  const header = (await store.getRows(sheet.name))[0] ?? [];
  if (!hasCanonicalPrefix(header, sheet.headers)) {
    throw new MigrationConflictError(sheet.name as OperationalSheetName, detail, { retryable });
  }
}

function hasCanonicalPrefix(header: readonly string[], canonical: readonly string[]): boolean {
  return header.length >= canonical.length
    && canonical.every((value, index) => header[index] === value);
}
