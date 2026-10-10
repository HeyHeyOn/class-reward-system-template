import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  DIGITAL_DESCRIPTION_LENGTH, DIGITAL_KINDS, MAX_GIVE_STUDENTS, MAX_TEACHER_GIVE, VOUCHER_SUFFIX,
  type BagItemDto, type BagItemSource, type CheckoutVoucherDto, type DigitalKind, type DigitalProductDto, type StudentBagDto,
} from '@/lib/studentBagApi';

/*
 * The student bag, 보관함 on screen (migrations 0045–0046): items each student keeps. A store product
 * marked as a 디지털 상품 has a type — 소모품 (used up: the teacher marks it used) or 수집품 (kept,
 * never used). Buying one puts it into the buyer's storage, one item per unit. A 교환권 is a 소모품
 * that pays for one unit of a physical product at a store checkout; it is never sold, only given:
 * a reward or the teacher's gift of a physical product lands as its 교환권 (a digital product as
 * itself). The teacher can also take items back. Hooks that run inside other writers (checkout,
 * cancellation) check that the tables exist first, so the shared writers keep working on databases
 * without them. (coupon_products.voucher_product_id from 0046 is no longer used: always NULL.)
 */

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type StudentBagErrorCode =
  | 'STUDENT_NOT_FOUND' | 'ITEM_NOT_FOUND' | 'ITEM_REVOKED' | 'ITEM_USED' | 'USED_AT_CHECKOUT' | 'NOT_CONSUMABLE'
  | 'PRODUCT_NOT_FOUND' | 'INVALID_INPUT' | 'UNSUPPORTED';

export class StudentBagError extends Error {
  constructor(readonly code: StudentBagErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'StudentBagError';
  }
}

type ItemRow = {
  item_id: string; kind: string; title: string; source: string; source_ref: string; product_id: string | null;
  image_url: string | null; description: string | null; voucher_product_id: string | null; voucher_product_name: string | null;
  issued_at: Date | string; used_at: Date | string | null; used_transaction_id: string | null;
};
/*
 * Item columns with the current picture (the item's product, else the product a 교환권 pays for) and
 * the digital product's description. Aliases: i = student_items, p = its product, v = the 교환권's
 * product, c = the digital product settings.
 */
const ITEM_COLUMNS = sql`i.item_id, i.kind, i.title, i.source, i.source_ref, i.product_id,
  COALESCE(NULLIF(p.image_url, ''), NULLIF(v.image_url, '')) AS image_url, c.description,
  i.voucher_product_id, v.name AS voucher_product_name, i.issued_at, i.used_at, i.used_transaction_id`;
const ITEM_FROM = sql`student_items i
  LEFT JOIN products p ON p.tenant_id=i.tenant_id AND p.product_id=i.product_id
  LEFT JOIN products v ON v.tenant_id=i.tenant_id AND v.product_id=i.voucher_product_id
  LEFT JOIN coupon_products c ON c.tenant_id=i.tenant_id AND c.product_id=i.product_id`;
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
const KINDS: ReadonlySet<string> = new Set<string>(DIGITAL_KINDS);
const isKind = (value: unknown): value is DigitalKind => typeof value === 'string' && KINDS.has(value);

function itemDto(row: ItemRow): BagItemDto {
  return {
    // A 'COUPON' row (written by the app from before 0046) is a consumable.
    itemId: row.item_id, kind: row.kind === 'COLLECTIBLE' ? 'COLLECTIBLE' : 'CONSUMABLE', title: row.title,
    source: row.source as BagItemSource, sourceRef: row.source_ref, productId: row.product_id,
    imageUrl: row.image_url || null, description: row.description ?? '',
    voucherProductId: row.voucher_product_id, voucherProductName: row.voucher_product_name,
    issuedAt: iso(row.issued_at), usedAt: row.used_at === null ? null : iso(row.used_at),
    usedAtCheckout: row.used_transaction_id !== null,
  };
}

/** Whether the storage tables are there with their 0046 shape. */
async function bagTablesPresent(tx: TenantTransaction): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('public.student_items') AND attname = 'used_transaction_id' AND NOT attisdropped) AS present`);
  return (result.rows[0] as { present?: unknown } | undefined)?.present === true;
}

const ids = (values: readonly string[]) => sql.join([...new Set(values)].map((value) => sql`${value}`), sql`, `);
/** A title that fits the 60-character limit, with an optional suffix kept whole. */
function itemTitle(name: string, suffix = ''): string {
  const room = 60 - [...suffix].length;
  return `${[...name.trim()].slice(0, room).join('').trim() || '상품'}${suffix}`;
}

/** A store product as it lands in the storage. */
export type StorageProduct = Readonly<{
  productId: string;
  name: string;
  /** Its digital type, or null for a physical product (which lands as its 교환권). */
  digitalKind: DigitalKind | null;
}>;

/** What an item made from `product` looks like: a digital product as itself, any other as its 교환권. */
export function storageItemShape(product: StorageProduct): Readonly<{ kind: DigitalKind; title: string; voucherProductId: string | null }> {
  if (product.digitalKind === null) return { kind: 'CONSUMABLE', title: itemTitle(product.name, VOUCHER_SUFFIX), voucherProductId: product.productId };
  return { kind: product.digitalKind, title: itemTitle(product.name), voucherProductId: null };
}

async function readStorageProducts(tx: TenantTransaction, tenantId: string, productIds: readonly string[]): Promise<Map<string, StorageProduct>> {
  if (productIds.length === 0) return new Map();
  const rows = await tx.execute(sql`
    SELECT p.product_id, p.name, c.digital_kind
    FROM products p LEFT JOIN coupon_products c ON c.tenant_id=p.tenant_id AND c.product_id=p.product_id
    WHERE p.tenant_id=${tenantId} AND p.product_id IN (${ids(productIds)}) AND p.deleted_at IS NULL`);
  return new Map((rows.rows as Array<{ product_id: string; name: string; digital_kind: string | null }>)
    .map((row) => [row.product_id, { productId: row.product_id, name: row.name, digitalKind: isKind(row.digital_kind) ? row.digital_kind : null }]));
}

/** Reads a store product (deleted ones excluded) as a reward. */
export async function readRewardProduct(tx: TenantTransaction, tenantId: string, productId: string): Promise<StorageProduct | null> {
  if (!await bagTablesPresent(tx)) return null;
  return (await readStorageProducts(tx, tenantId, [productId])).get(productId) ?? null;
}

/** A harvest reward for one student (called by the class tree harvest, inside its transaction). */
export async function giveHarvestReward(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; product: StorageProduct; treeNo: number; operationId: string;
}>): Promise<void> {
  const shape = storageItemShape(input.product);
  await tx.execute(sql`
    INSERT INTO student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, product_id, voucher_product_id, operation_id)
    VALUES (${tenantId}, ${`reward:${input.operationId}:${input.studentId}`}, ${input.studentId}, ${shape.kind}, ${shape.title},
            'TREE_HARVEST', ${String(input.treeNo)}, ${input.product.productId}, ${shape.voucherProductId}, ${input.operationId})`);
}

/** A pet graduation reward (called by the pet graduation, inside its transaction). */
export async function givePetReward(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; product: StorageProduct; petId: string; operationId: string;
}>): Promise<void> {
  const shape = storageItemShape(input.product);
  await tx.execute(sql`
    INSERT INTO student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, product_id, voucher_product_id, operation_id)
    VALUES (${tenantId}, ${`pet-reward:${input.operationId}`}, ${input.studentId}, ${shape.kind}, ${shape.title},
            'PET_GRADUATION', ${input.petId}, ${input.product.productId}, ${shape.voucherProductId}, ${input.operationId})`);
}

/**
 * Items for the digital products in a checkout: one per unit (free units of a promotion included).
 * Runs inside the checkout transaction after its transaction row exists. Returns how many were given.
 */
export async function giveStoreDigitalItems(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; transactionId: string; operationId: string;
  lines: ReadonlyArray<Readonly<{ productId: string; quantity: number }>>;
}>): Promise<number> {
  if (input.lines.length === 0 || !await bagTablesPresent(tx)) return 0;
  const products = await readStorageProducts(tx, tenantId, input.lines.map((line) => line.productId));
  let given = 0;
  const counted = new Map<string, number>();
  for (const line of input.lines) {
    const product = products.get(line.productId);
    if (!product || product.digitalKind === null) continue;
    const shape = storageItemShape(product);
    for (let unit = 0; unit < line.quantity; unit++) {
      const n = (counted.get(line.productId) ?? 0) + 1;
      counted.set(line.productId, n);
      await tx.execute(sql`
        INSERT INTO student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, product_id, voucher_product_id,
                                   transaction_id, operation_id)
        VALUES (${tenantId}, ${`coupon:${input.transactionId}:${line.productId}:${n}`}, ${input.studentId}, ${shape.kind}, ${shape.title},
                'STORE_PURCHASE', ${line.productId}, ${line.productId}, ${shape.voucherProductId}, ${input.transactionId}, ${input.operationId})`);
      given += 1;
    }
  }
  return given;
}

/**
 * Before a checkout is cancelled: locks the items it gave and says whether any was already used
 * (then the purchase cannot be cancelled).
 */
export async function storeCouponsUsed(tx: TenantTransaction, tenantId: string, transactionId: string): Promise<boolean> {
  if (!await bagTablesPresent(tx)) return false;
  const rows = await tx.execute(sql`
    SELECT used_at FROM student_items
    WHERE tenant_id=${tenantId} AND transaction_id=${transactionId} AND revoked_at IS NULL
    ORDER BY item_id FOR UPDATE`);
  return (rows.rows as Array<{ used_at: unknown }>).some((row) => row.used_at !== null);
}

/** A cancelled checkout takes back the (unused) items it gave. */
export async function revokeStoreCoupons(tx: TenantTransaction, tenantId: string, transactionId: string): Promise<void> {
  if (!await bagTablesPresent(tx)) return;
  await tx.execute(sql`
    UPDATE student_items SET revoked_at=clock_timestamp()
    WHERE tenant_id=${tenantId} AND transaction_id=${transactionId} AND revoked_at IS NULL AND used_at IS NULL`);
}

/* ------------------------------------------------------------------ */
/* 교환권 at a store checkout                                          */
/* ------------------------------------------------------------------ */

/** The student's unused 교환권 for any of `productIds`, oldest first (what the kiosk offers). */
export async function readUsableVouchers(tx: TenantTransaction, tenantId: string, studentId: string,
  productIds: readonly string[]): Promise<CheckoutVoucherDto[]> {
  if (productIds.length === 0 || !await bagTablesPresent(tx)) return [];
  const rows = await tx.execute(sql`
    SELECT i.item_id, i.voucher_product_id, i.title, COALESCE(NULLIF(p.image_url, ''), NULLIF(v.image_url, '')) AS image_url, i.issued_at
    FROM student_items i
      JOIN products v ON v.tenant_id=i.tenant_id AND v.product_id=i.voucher_product_id
      LEFT JOIN products p ON p.tenant_id=i.tenant_id AND p.product_id=i.product_id
    WHERE i.tenant_id=${tenantId} AND i.student_id=${studentId}
      AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.voucher_product_id IN (${ids(productIds)})
    ORDER BY i.issued_at, i.item_id`);
  return (rows.rows as Array<{ item_id: string; voucher_product_id: string; title: string; image_url: string | null; issued_at: Date | string }>)
    .map((row) => ({ itemId: row.item_id, productId: row.voucher_product_id, title: row.title, imageUrl: row.image_url || null, issuedAt: iso(row.issued_at) }));
}

/**
 * Locks the 교환권 chosen for a checkout and counts them per product they pay for. Null when any of
 * them is not this student's unused 교환권 any more (the kiosk then asks again).
 */
export async function lockCheckoutVouchers(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; itemIds: readonly string[];
}>): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  if (input.itemIds.length === 0) return counts;
  if (!await bagTablesPresent(tx)) return null;
  const rows = await tx.execute(sql`
    SELECT item_id, voucher_product_id FROM student_items
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId} AND voucher_product_id IS NOT NULL
      AND used_at IS NULL AND revoked_at IS NULL AND item_id IN (${ids(input.itemIds)})
    ORDER BY item_id FOR UPDATE`);
  const found = rows.rows as Array<{ item_id: string; voucher_product_id: string }>;
  if (found.length !== new Set(input.itemIds).size) return null;
  for (const row of found) counts.set(row.voucher_product_id, (counts.get(row.voucher_product_id) ?? 0) + 1);
  return counts;
}

/** Marks the locked 교환권 used by this checkout. */
export async function spendCheckoutVouchers(tx: TenantTransaction, tenantId: string, input: Readonly<{
  itemIds: readonly string[]; transactionId: string;
}>): Promise<void> {
  if (input.itemIds.length === 0) return;
  await tx.execute(sql`
    UPDATE student_items SET used_at=clock_timestamp(), used_transaction_id=${input.transactionId}
    WHERE tenant_id=${tenantId} AND item_id IN (${ids(input.itemIds)})`);
}

/** A cancelled checkout gives back the 교환권 it used. */
export async function restoreCheckoutVouchers(tx: TenantTransaction, tenantId: string, transactionId: string): Promise<void> {
  if (!await bagTablesPresent(tx)) return;
  await tx.execute(sql`
    UPDATE student_items SET used_at=NULL, used_transaction_id=NULL
    WHERE tenant_id=${tenantId} AND used_transaction_id=${transactionId}`);
}

/** How many 교환권 a checkout used (for its receipt and history). */
export async function checkoutVoucherCount(tx: TenantTransaction, tenantId: string, transactionId: string): Promise<number> {
  if (!await bagTablesPresent(tx)) return 0;
  const row = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM student_items WHERE tenant_id=${tenantId} AND used_transaction_id=${transactionId}`)).rows[0] as
    { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* Teacher commands                                                    */
/* ------------------------------------------------------------------ */

const ID_LIMIT = 200;
const isId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= ID_LIMIT;

async function readDigitalProducts(tx: TenantTransaction, tenantId: string): Promise<DigitalProductDto[]> {
  const rows = await tx.execute(sql`
    SELECT product_id, digital_kind, description FROM coupon_products WHERE tenant_id=${tenantId} ORDER BY product_id`);
  return (rows.rows as Array<{ product_id: string; digital_kind: string; description: string }>)
    .map((row) => ({ productId: row.product_id, kind: isKind(row.digital_kind) ? row.digital_kind : 'CONSUMABLE', description: row.description }));
}

/** How the teacher wants a product treated: null for a physical product. */
export type DigitalProductSetting = Readonly<{ kind: DigitalKind; description: string }> | null;

export function parseDigitalProductSetting(value: unknown): DigitalProductSetting | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isKind(record.kind)) return undefined;
  const description = record.description ?? '';
  if (typeof description !== 'string' || [...description.trim()].length > DIGITAL_DESCRIPTION_LENGTH) return undefined;
  return { kind: record.kind, description: description.trim() };
}

export type StudentBagDependencies = Readonly<{ tenantId: string; runTenantTransaction: RunTenantTransaction }>;

export function createStudentBagCommands(dependencies: StudentBagDependencies) {
  const { tenantId, runTenantTransaction } = dependencies;

  async function readStudent(tx: TenantTransaction, studentId: string) {
    const student = (await tx.execute(sql`
      SELECT student_id, name FROM students WHERE tenant_id=${tenantId} AND student_id=${studentId} AND deleted_at IS NULL`)).rows[0] as
      { student_id: string; name: string } | undefined;
    if (!student) throw new StudentBagError('STUDENT_NOT_FOUND', '학생을 찾지 못했어요. 목록을 새로 불러와 주세요.', 404);
    return student;
  }

  async function readItem(tx: TenantTransaction, itemId: string): Promise<BagItemDto> {
    const row = (await tx.execute(sql`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.tenant_id=${tenantId} AND i.item_id=${itemId}`)).rows[0];
    return itemDto(row as ItemRow);
  }

  async function lockItem(tx: TenantTransaction, itemId: unknown) {
    if (!isId(itemId)) throw new StudentBagError('INVALID_INPUT', '아이템을 다시 골라 주세요.', 400);
    const current = (await tx.execute(sql`
      SELECT kind, used_at, revoked_at, used_transaction_id FROM student_items
      WHERE tenant_id=${tenantId} AND item_id=${itemId} FOR UPDATE`)).rows[0] as
      { kind: string; used_at: unknown; revoked_at: unknown; used_transaction_id: string | null } | undefined;
    if (!current) throw new StudentBagError('ITEM_NOT_FOUND', '아이템을 찾지 못했어요. 보관함을 새로 열어 주세요.', 404);
    if (current.revoked_at !== null) throw new StudentBagError('ITEM_REVOKED', '이미 회수된 아이템이에요. 보관함을 새로 열어 주세요.', 409);
    return current;
  }

  return {
    /**
     * One student's storage, newest first. Items taken back are left out; used items only when asked
     * (the teacher's view keeps them so a use can be taken back).
     */
    async studentBag(studentId: string, options: Readonly<{ includeUsed: boolean }>): Promise<StudentBagDto> {
      return runTenantTransaction(tenantId, async (tx) => {
        const student = await readStudent(tx, studentId);
        const items = await tx.execute(sql`
          SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
          WHERE i.tenant_id=${tenantId} AND i.student_id=${studentId} AND i.revoked_at IS NULL
            AND (${options.includeUsed} OR i.used_at IS NULL)
          ORDER BY i.used_at DESC NULLS FIRST, i.issued_at DESC, i.item_id LIMIT 1000`);
        return { student: { studentId: student.student_id, name: student.name }, items: (items.rows as ItemRow[]).map(itemDto) };
      });
    },

    /** The teacher marks a 소모품 used, or takes the mark back after a mistake. */
    async setItemUsed(input: Readonly<{ itemId: string; used: boolean }>): Promise<BagItemDto> {
      if (typeof input.used !== 'boolean') throw new StudentBagError('INVALID_INPUT', '아이템을 다시 골라 주세요.', 400);
      return runTenantTransaction(tenantId, async (tx) => {
        const current = await lockItem(tx, input.itemId);
        if (current.used_transaction_id !== null) {
          throw new StudentBagError('USED_AT_CHECKOUT', '매점 결제에 쓴 교환권이에요. 되돌리려면 거래 내역에서 그 결제를 취소해 주세요.', 409);
        }
        if (current.kind === 'COLLECTIBLE') {
          throw new StudentBagError('NOT_CONSUMABLE', '수집품은 사용하지 않고 모아 두는 아이템이에요.', 409);
        }
        await tx.execute(sql`
          UPDATE student_items SET used_at = CASE WHEN ${input.used} THEN COALESCE(used_at, clock_timestamp()) ELSE NULL END
          WHERE tenant_id=${tenantId} AND item_id=${input.itemId}`);
        return readItem(tx, input.itemId);
      });
    },

    /**
     * The teacher puts `count` units of a store product into the storage of each student given: a
     * digital product as itself, any other product as its 교환권. Retry-safe by operation ID.
     * Returns how many items went in.
     */
    async giveItems(input: Readonly<{ studentIds: unknown; productId: unknown; count: unknown; operationId: unknown }>): Promise<number> {
      const { studentIds, productId, count, operationId } = input;
      const students = Array.isArray(studentIds) ? [...new Set(studentIds)] : [];
      if (students.length === 0 || students.length > MAX_GIVE_STUDENTS || !students.every((id) => isId(id) && id.length <= 100)
        || !isId(productId) || !isId(operationId) || operationId.length > 80
        || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_TEACHER_GIVE) {
        throw new StudentBagError('INVALID_INPUT', `넣을 상품과 개수(1~${MAX_TEACHER_GIVE}개)를 다시 골라 주세요.`, 400);
      }
      return runTenantTransaction(tenantId, async (tx) => {
        const found = await tx.execute(sql`
          SELECT student_id FROM students WHERE tenant_id=${tenantId} AND student_id IN (${ids(students as string[])}) AND deleted_at IS NULL`);
        if (found.rows.length !== students.length) throw new StudentBagError('STUDENT_NOT_FOUND', '학생을 찾지 못했어요. 목록을 새로 불러와 주세요.', 404);
        const product = (await readStorageProducts(tx, tenantId, [productId])).get(productId);
        if (!product) throw new StudentBagError('PRODUCT_NOT_FOUND', '상품을 찾지 못했어요. 목록을 새로 불러와 주세요.', 404);
        const shape = storageItemShape(product);
        let given = 0;
        for (const studentId of (students as string[]).sort()) {
          for (let n = 1; n <= count; n++) {
            const result = await tx.execute(sql`
              INSERT INTO student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, product_id, voucher_product_id, operation_id)
              VALUES (${tenantId}, ${`give:${operationId}:${studentId}:${n}`}, ${studentId}, ${shape.kind}, ${shape.title},
                      'TEACHER', ${productId}, ${productId}, ${shape.voucherProductId}, ${operationId})
              ON CONFLICT (tenant_id, item_id) DO NOTHING RETURNING item_id`);
            given += result.rows.length;
          }
        }
        return given;
      });
    },

    /** The teacher takes an unused item back out of a student's storage. */
    async revokeItem(input: Readonly<{ itemId: unknown }>): Promise<void> {
      return runTenantTransaction(tenantId, async (tx) => {
        const current = await lockItem(tx, input.itemId);
        if (current.used_at !== null) throw new StudentBagError('ITEM_USED', '이미 사용한 아이템은 회수할 수 없어요. 사용 표시를 먼저 되돌려 주세요.', 409);
        await tx.execute(sql`
          UPDATE student_items SET revoked_at=clock_timestamp() WHERE tenant_id=${tenantId} AND item_id=${input.itemId as string}`);
      });
    },

    /** A student's unused 교환권 for the products in a kiosk cart (an inactive student has none to use). */
    async checkoutVouchers(studentId: string, productIds: readonly string[]): Promise<CheckoutVoucherDto[]> {
      if (!isId(studentId) || productIds.length === 0 || productIds.length > 100 || !productIds.every(isId)) return [];
      return runTenantTransaction(tenantId, async (tx) => {
        const student = (await tx.execute(sql`
          SELECT 1 FROM students WHERE tenant_id=${tenantId} AND student_id=${studentId} AND status='ACTIVE' AND deleted_at IS NULL`)).rows[0];
        return student ? readUsableVouchers(tx, tenantId, studentId, productIds) : [];
      });
    },

    /** How each store product marked digital is treated (shown in the store list and the kiosk). */
    async digitalProducts(): Promise<DigitalProductDto[]> {
      return runTenantTransaction(tenantId, (tx) => readDigitalProducts(tx, tenantId));
    },

    /** Marks a store product digital with its type, or makes it a physical product again. */
    async setDigitalProduct(input: Readonly<{ productId: unknown; digital: unknown }>): Promise<DigitalProductDto[]> {
      const setting = parseDigitalProductSetting(input.digital);
      if (!isId(input.productId) || setting === undefined) {
        throw new StudentBagError('INVALID_INPUT', `디지털 상품 설정을 다시 확인해 주세요. 설명은 ${DIGITAL_DESCRIPTION_LENGTH}자까지 쓸 수 있어요.`, 400);
      }
      const productId = input.productId;
      return runTenantTransaction(tenantId, async (tx) => {
        const product = (await tx.execute(sql`
          SELECT product_id FROM products WHERE tenant_id=${tenantId} AND product_id=${productId} AND deleted_at IS NULL FOR UPDATE`)).rows[0];
        if (!product) throw new StudentBagError('PRODUCT_NOT_FOUND', '상품을 찾지 못했어요. 목록을 새로 불러와 주세요.', 404);
        if (setting === null) {
          await tx.execute(sql`DELETE FROM coupon_products WHERE tenant_id=${tenantId} AND product_id=${productId}`);
          return readDigitalProducts(tx, tenantId);
        }
        await tx.execute(sql`
          INSERT INTO coupon_products (tenant_id, product_id, digital_kind, voucher_product_id, description)
          VALUES (${tenantId}, ${productId}, ${setting.kind}, NULL, ${setting.description})
          ON CONFLICT (tenant_id, product_id) DO UPDATE SET digital_kind=EXCLUDED.digital_kind,
            voucher_product_id=EXCLUDED.voucher_product_id, description=EXCLUDED.description, updated_at=clock_timestamp()`);
        return readDigitalProducts(tx, tenantId);
      });
    },
  };
}
