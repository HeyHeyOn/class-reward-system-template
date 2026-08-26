import { randomUUID } from 'node:crypto';
import type { Promotion, PromotionProductLink } from '@/domain/types';
import {
  buildPromotionAppendRow,
  buildPromotionProductAppendRow,
  createHeaderIndex,
  parsePromotionProductRow,
  parsePromotionRow,
  requireColumns,
  REQUIRED_PROMOTION_COLUMNS,
  REQUIRED_PROMOTION_PRODUCT_COLUMNS,
} from '@/server/sheetsRows';
import type {
  AdditiveSchemaMigrationStore,
  SheetCellUpdate,
} from '@/server/storage/tabularStore';
import {
  getPromotionProductRecords,
  getPromotionRecords,
} from './promotionQueries';
import {
  migratePromotionSchema,
  PROMOTIONS_HEADERS,
} from './promotionSchemaMigrator';

type PromotionInputCommon = {
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: number;
};

export type PromotionDefinitionInput = PromotionInputCommon & (
  | { type: 'N_PLUS_ONE'; buyQuantity: number; freeQuantity: number }
  | { type: 'PROMOTIONAL_PRICE'; promotionalUnitPrice: number }
  | { type: 'PERCENT_DISCOUNT'; percent: number }
  | { type: 'FIXED_DISCOUNT'; discountAmount: number }
);

export type PromotionCreateInput = PromotionDefinitionInput & { promotionId: string };

export type PromotionCommandOptions = {
  /** Injectable server clock for deterministic command tests. */
  now?: () => string;
  /** Injectable ID source for deterministic PromotionProducts tests. */
  idFactory?: () => string;
};

export const PROMOTION_DELETE_PARTIAL_FAILURE_MESSAGE =
  '대상 상품 연결은 삭제되었지만 행사 삭제를 완료하지 못했습니다. 새로고침 후 재시도해 주세요.';

/** Metadata remains after this command successfully removed one or more target links. */
export class PromotionDeletePartialFailure extends Error {
  constructor() {
    super(PROMOTION_DELETE_PARTIAL_FAILURE_MESSAGE);
    this.name = 'PromotionDeletePartialFailure';
  }
}

/** Validates and normalizes promotion metadata without performing any I/O. */
export function validatePromotionDefinitionInput(
  input: PromotionDefinitionInput,
): PromotionDefinitionInput {
  return normalizeDefinition(input, false);
}

const COMMON_KEYS = ['name', 'description', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'type'] as const;
const TYPE_KEYS = {
  N_PLUS_ONE: ['buyQuantity', 'freeQuantity'],
  PROMOTIONAL_PRICE: ['promotionalUnitPrice'],
  PERCENT_DISCOUNT: ['percent'],
  FIXED_DISCOUNT: ['discountAmount'],
} as const;

let promotionCommandTail: Promise<void> = Promise.resolve();

/**
 * Creates promotion metadata after explicit additive schema migration.
 * Sheets operations are process-local and sequential, not provider-atomic or exactly-once.
 */
export async function createPromotion(
  store: AdditiveSchemaMigrationStore,
  input: PromotionCreateInput,
  options: PromotionCommandOptions = {},
): Promise<Promotion> {
  const normalized = normalizeDefinition(input, true);
  const promotionId = requiredTrimmedString((input as Record<string, unknown>).promotionId, 'promotionId');
  const timestamp = commandTimestamp(options);
  const candidate = toPromotion(normalized, promotionId, timestamp, timestamp, []);

  return enqueuePromotionCommand(async () => {
    await migratePromotionSchema(store);
    await assertWritablePromotionRows(store);
    const records = await getPromotionRecords(store);
    if (records.some(({ promotion }) => promotion.promotionId === promotionId)) {
      throw new Error(`중복된 promotionId입니다: ${promotionId}`);
    }
    const rows = await store.getRows('Promotions');
    await store.appendRow('Promotions', buildPromotionAppendRow(requireHeader(rows, 'Promotions'), candidate));
    return clonePromotion(candidate);
  });
}

/**
 * Replaces all editable metadata cells, preserving identity, creation time, targets, and unknown cells.
 * Cell writes are process-local/sequential and are not provider-atomic or exactly-once.
 */
export async function updatePromotion(
  store: AdditiveSchemaMigrationStore,
  promotionId: string,
  input: PromotionDefinitionInput,
  options: PromotionCommandOptions = {},
): Promise<Promotion> {
  const id = requiredTrimmedString(promotionId, 'promotionId');
  const normalized = validatePromotionDefinitionInput(input);
  const timestamp = commandTimestamp(options);

  return enqueuePromotionCommand(async () => {
    await migratePromotionSchema(store);
    await assertWritablePromotionRows(store);
    const records = await getPromotionRecords(store);
    const record = requirePromotion(records, id);
    const productIds = await getTargetIds(store, id);
    const rows = await store.getRows('Promotions');
    const headers = requireHeader(rows, 'Promotions');
    const candidate = toPromotion(
      normalized, id, record.promotion.createdAt, timestamp, productIds,
    );
    const serialized = buildPromotionAppendRow(headers, { ...candidate, productIds: [] }, rows[record.rowNumber - 1]);
    const updates = PROMOTIONS_HEADERS.map((columnName) => ({
      rowNumber: record.rowNumber,
      columnName,
      value: serialized[columnIndex(headers, columnName)],
    }));
    await writePromotionCells(store, updates);
    return clonePromotion(candidate);
  });
}

/** Updates only activation state and modification time after explicit migration. */
export async function setPromotionActive(
  store: AdditiveSchemaMigrationStore,
  promotionId: string,
  isActive: boolean,
  options: PromotionCommandOptions = {},
): Promise<Promotion> {
  const id = requiredTrimmedString(promotionId, 'promotionId');
  if (typeof isActive !== 'boolean') throw new Error('isActive must be a boolean');
  const timestamp = commandTimestamp(options);

  return enqueuePromotionCommand(async () => {
    await migratePromotionSchema(store);
    await assertWritablePromotionRows(store);
    const record = requirePromotion(await getPromotionRecords(store), id);
    const productIds = await getTargetIds(store, id);
    await writePromotionCells(store, [
      { rowNumber: record.rowNumber, columnName: 'isActive', value: isActive ? 'TRUE' : 'FALSE' },
      { rowNumber: record.rowNumber, columnName: 'updatedAt', value: timestamp },
    ]);
    return clonePromotion({ ...record.promotion, productIds, isActive, updatedAt: timestamp });
  });
}

/**
 * Replaces target links with prevalidated schema-v3 rows.
 * Delete/append operations are deliberately process-local and sequential: Sheets provides no
 * provider-atomic or exactly-once transaction here, and this command does not claim compensation.
 */
export async function replacePromotionProducts(
  store: AdditiveSchemaMigrationStore,
  promotionId: string,
  productIds: string[],
  options: PromotionCommandOptions = {},
): Promise<Promotion> {
  const id = requiredTrimmedString(promotionId, 'promotionId');
  const targets = normalizeProductIds(productIds);
  const timestamp = commandTimestamp(options);

  return enqueuePromotionCommand(async () => {
    await migratePromotionSchema(store);
    await assertWritablePromotionRows(store);
    const promotionRecord = requirePromotion(await getPromotionRecords(store), id);
    const linkRecords = await getPromotionProductRecords(store);
    const oldLinks = linkRecords.filter(({ link }) => link.promotionId === id);
    const oldTargets = sortedUnique(oldLinks.map(({ link }) => link.productId));
    if (equalStrings(oldTargets, targets)) {
      return clonePromotion({ ...promotionRecord.promotion, productIds: targets });
    }
    if (oldLinks.length > 0 && !store.deleteRows) {
      throw new Error('현재 Sheets 저장소가 deleteRows를 지원하지 않습니다.');
    }

    const rows = await store.getRows('PromotionProducts');
    const headers = requireHeader(rows, 'PromotionProducts');
    const idFactory = options.idFactory ?? randomUUID;
    const links: PromotionProductLink[] = targets.map((productId) => ({
      promotionProductId: requiredTrimmedString(idFactory(), 'promotionProductId'),
      promotionId: id,
      productId,
      createdAt: timestamp,
      schemaVersion: 3,
    }));
    rejectDuplicateGeneratedIds(links, linkRecords, new Set(oldLinks.map(({ link }) => link.promotionProductId)));
    const appendRows = links.map((link) => buildPromotionProductAppendRow(headers, link));

    if (oldLinks.length > 0) {
      await store.deleteRows!('PromotionProducts', oldLinks.map(({ rowNumber }) => rowNumber));
    }
    for (const row of appendRows) await store.appendRow('PromotionProducts', row);
    return clonePromotion({ ...promotionRecord.promotion, productIds: targets });
  });
}

/**
 * Deletes target links before metadata without touching historical transaction snapshots.
 * This is deliberately provider-non-atomic; metadata failure after link removal is classified.
 */
export async function deletePromotion(
  store: AdditiveSchemaMigrationStore,
  promotionId: string,
): Promise<{ promotionId: string }> {
  const id = requiredExactString(promotionId, 'promotionId');

  return enqueuePromotionCommand(async () => {
    await migratePromotionSchema(store);
    await assertWritablePromotionRows(store);
    const promotionRecord = requirePromotion(await getPromotionRecords(store), id);
    const links = (await getPromotionProductRecords(store))
      .filter(({ link }) => link.promotionId === id);

    if (!store.deleteRows) {
      throw new Error('현재 Sheets 저장소가 deleteRows를 지원하지 않습니다.');
    }

    if (links.length > 0) {
      const descendingRows = links.map(({ rowNumber }) => rowNumber).sort((left, right) => right - left);
      await store.deleteRows('PromotionProducts', descendingRows);
    }

    try {
      await store.deleteRows('Promotions', [promotionRecord.rowNumber]);
    } catch (error) {
      if (links.length > 0) throw new PromotionDeletePartialFailure();
      throw error;
    }
    return { promotionId: id };
  });
}

function enqueuePromotionCommand<T>(command: () => Promise<T>): Promise<T> {
  const run = promotionCommandTail.then(command, command);
  promotionCommandTail = run.then(() => undefined, () => undefined);
  return run;
}

async function assertWritablePromotionRows(store: AdditiveSchemaMigrationStore): Promise<void> {
  await assertPhysicalRowsValid(
    store,
    'Promotions',
    REQUIRED_PROMOTION_COLUMNS,
    parsePromotionRow,
  );
  await assertPhysicalRowsValid(
    store,
    'PromotionProducts',
    REQUIRED_PROMOTION_PRODUCT_COLUMNS,
    parsePromotionProductRow,
  );
}

async function assertPhysicalRowsValid(
  store: AdditiveSchemaMigrationStore,
  sheetName: 'Promotions' | 'PromotionProducts',
  requiredColumns: readonly string[],
  parse: (row: string[], headerIndex: ReturnType<typeof createHeaderIndex>) => unknown,
): Promise<void> {
  const rows = await store.getRows(sheetName);
  const header = requireHeader(rows, sheetName);
  const headerIndex = createHeaderIndex(header);
  const required = requireColumns(headerIndex, requiredColumns);
  if (required.ok === false) {
    throw new Error(`${sheetName} 시트에 필수 컬럼이 없습니다: ${required.missingColumns.join(', ')}`);
  }
  rows.slice(1).forEach((row, index) => {
    if (row.every((cell) => !String(cell ?? '').trim())) return;
    if (!parse(row, headerIndex)) {
      throw new Error(`${sheetName} 시트 ${index + 2}행이 올바르지 않습니다.`);
    }
  });
}

function normalizeDefinition(input: PromotionDefinitionInput | PromotionCreateInput, create: boolean): PromotionDefinitionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Promotion input must be an object');
  const candidate = input as unknown as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string' || !(type in TYPE_KEYS)) throw new Error('Invalid promotion type');
  const expected = [...COMMON_KEYS, ...TYPE_KEYS[type as keyof typeof TYPE_KEYS], ...(create ? ['promotionId'] : [])];
  const actual = Object.keys(candidate);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key as never))) {
    throw new Error('Promotion input must use the exact fields for its type');
  }
  const common = {
    name: requiredTrimmedString(candidate.name, 'name'),
    description: stringValue(candidate.description, 'description').trim(),
    startsAt: dateString(candidate.startsAt, 'startsAt'),
    endsAt: dateString(candidate.endsAt, 'endsAt'),
    isActive: booleanValue(candidate.isActive, 'isActive'),
    sortOrder: safeInteger(candidate.sortOrder, 'sortOrder'),
  };
  if (Date.parse(common.startsAt) >= Date.parse(common.endsAt)) throw new Error('startsAt must be before endsAt');
  if (type === 'N_PLUS_ONE') {
    return { ...common, type, buyQuantity: safePositiveInteger(candidate.buyQuantity, 'buyQuantity'), freeQuantity: safePositiveInteger(candidate.freeQuantity, 'freeQuantity') };
  }
  if (type === 'PROMOTIONAL_PRICE') {
    return { ...common, type, promotionalUnitPrice: safeNonNegativeInteger(candidate.promotionalUnitPrice, 'promotionalUnitPrice') };
  }
  if (type === 'PERCENT_DISCOUNT') {
    const percent = finiteNumber(candidate.percent, 'percent');
    if (percent <= 0 || percent > 100) throw new Error('percent must be greater than 0 and at most 100');
    return { ...common, type, percent };
  }
  return { ...common, type: 'FIXED_DISCOUNT', discountAmount: safePositiveInteger(candidate.discountAmount, 'discountAmount') };
}

function toPromotion(
  input: PromotionDefinitionInput,
  promotionId: string,
  createdAt: string,
  updatedAt: string,
  productIds: string[],
): Promotion {
  return { ...input, promotionId, productIds: [...productIds], createdAt, updatedAt, schemaVersion: 3 } as Promotion;
}

function commandTimestamp(options: PromotionCommandOptions): string {
  return dateString(options.now?.() ?? new Date().toISOString(), 'now');
}

function normalizeProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('productIds must be an array');
  const normalized = value.map((entry) => requiredTrimmedString(entry, 'productId'));
  return sortedUnique(normalized);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareUtf16);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireHeader(rows: string[][], sheetName: string): string[] {
  const header = rows[0];
  if (!header) throw new Error(`${sheetName} sheet has no header`);
  return header;
}

function columnIndex(headers: string[], columnName: string): number {
  const matches = headers.flatMap((header, index) => header.trim() === columnName ? [index] : []);
  if (matches.length !== 1) throw new Error(`Promotions 시트에 ${columnName} 컬럼이 없거나 중복되었습니다.`);
  return matches[0];
}

async function writePromotionCells(store: AdditiveSchemaMigrationStore, updates: SheetCellUpdate[]): Promise<void> {
  if (store.updateCells) {
    await store.updateCells('Promotions', updates);
    return;
  }
  for (const update of updates) {
    await store.updateCell('Promotions', update.rowNumber, update.columnName, update.value);
  }
}

function requirePromotion(
  records: Awaited<ReturnType<typeof getPromotionRecords>>,
  promotionId: string,
) {
  const record = records.find(({ promotion }) => promotion.promotionId === promotionId);
  if (!record) throw new Error(`Promotion을 찾을 수 없습니다: ${promotionId}`);
  return record;
}

async function getTargetIds(store: AdditiveSchemaMigrationStore, promotionId: string): Promise<string[]> {
  const records = await getPromotionProductRecords(store);
  return sortedUnique(records.filter(({ link }) => link.promotionId === promotionId).map(({ link }) => link.productId));
}

function rejectDuplicateGeneratedIds(
  links: PromotionProductLink[],
  existing: Awaited<ReturnType<typeof getPromotionProductRecords>>,
  removedIds: Set<string>,
): void {
  const seen = new Set<string>();
  const retainedIds = new Set(existing.map(({ link }) => link.promotionProductId).filter((id) => !removedIds.has(id)));
  for (const { promotionProductId } of links) {
    if (seen.has(promotionProductId) || retainedIds.has(promotionProductId)) {
      throw new Error(`중복된 promotionProductId입니다: ${promotionProductId}`);
    }
    seen.add(promotionProductId);
  }
}

function clonePromotion(value: Promotion): Promotion {
  return { ...value, productIds: [...value.productIds] } as Promotion;
}

function requiredTrimmedString(value: unknown, name: string): string {
  const result = stringValue(value, name).trim();
  if (!result) throw new Error(`${name} must not be blank`);
  return result;
}

function requiredExactString(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!result) throw new Error(`${name} must not be blank`);
  return result;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function dateString(value: unknown, name: string): string {
  const result = stringValue(value, name);
  const timestamp = Date.parse(result);
  if (!result || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) {
    throw new Error(`${name} must be a canonical millisecond UTC timestamp`);
  }
  return result;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function safePositiveInteger(value: unknown, name: string): number {
  const result = safeInteger(value, name);
  if (result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
  const result = safeInteger(value, name);
  if (result < 0) throw new Error(`${name} must be non-negative`);
  return result;
}
