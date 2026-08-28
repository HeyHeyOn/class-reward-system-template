import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, numeric, pgTable,
  primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const promotionTypes = [
  'N_PLUS_ONE', 'PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT',
] as const;

export const products = pgTable('products', {
  tenantId: uuid('tenant_id').notNull(),
  productId: text('product_id').notNull(),
  name: text('name').notNull(),
  price: bigint('price', { mode: 'bigint' }).notNull(),
  stock: bigint('stock', { mode: 'bigint' }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  imageUrl: text('image_url'),
  category: text('category'),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'products_pkey', columns: [table.tenantId, table.productId] }),
  foreignKey({ name: 'products_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  check('products_id_check', sql`${table.productId} = btrim(${table.productId}) AND length(${table.productId}) > 0`),
  check('products_name_check', sql`length(btrim(${table.name})) > 0`),
  check('products_price_check', sql`${table.price} BETWEEN 0 AND 9007199254740991`),
  check('products_stock_check', sql`${table.stock} BETWEEN 0 AND 9007199254740991`),
  check('products_deleted_chronology_check', sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`),
  index('products_active_sort_idx').on(table.tenantId, table.sortOrder, table.productId)
    .where(sql`${table.isActive} AND ${table.deletedAt} IS NULL`),
]);

export const promotions = pgTable('promotions', {
  tenantId: uuid('tenant_id').notNull(),
  promotionId: text('promotion_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  type: text('type').$type<(typeof promotionTypes)[number]>().notNull(),
  nPlusOneBuyQuantity: bigint('n_plus_one_buy_quantity', { mode: 'bigint' }),
  nPlusOneFreeQuantity: bigint('n_plus_one_free_quantity', { mode: 'bigint' }),
  promotionalPrice: bigint('promotional_price', { mode: 'bigint' }),
  percentDiscount: numeric('percent_discount'),
  fixedDiscount: bigint('fixed_discount', { mode: 'bigint' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  schemaVersion: integer('schema_version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'promotions_pkey', columns: [table.tenantId, table.promotionId] }),
  foreignKey({ name: 'promotions_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  check('promotions_id_check', sql`${table.promotionId} = btrim(${table.promotionId}) AND length(${table.promotionId}) > 0`),
  check('promotions_name_check', sql`length(btrim(${table.name})) > 0`),
  check('promotions_type_check', sql`${table.type} IN ('N_PLUS_ONE', 'PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT')`),
  check('promotions_variant_check', sql`COALESCE((
    (${table.type} = 'N_PLUS_ONE' AND ${table.nPlusOneBuyQuantity} BETWEEN 1 AND 9007199254740991 AND ${table.nPlusOneFreeQuantity} BETWEEN 1 AND 9007199254740991 AND ${table.promotionalPrice} IS NULL AND ${table.percentDiscount} IS NULL AND ${table.fixedDiscount} IS NULL)
    OR (${table.type} = 'PROMOTIONAL_PRICE' AND ${table.promotionalPrice} BETWEEN 0 AND 9007199254740991 AND ${table.nPlusOneBuyQuantity} IS NULL AND ${table.nPlusOneFreeQuantity} IS NULL AND ${table.percentDiscount} IS NULL AND ${table.fixedDiscount} IS NULL)
    OR (${table.type} = 'PERCENT_DISCOUNT' AND ${table.percentDiscount} > 0 AND ${table.percentDiscount} <= 100 AND ${table.nPlusOneBuyQuantity} IS NULL AND ${table.nPlusOneFreeQuantity} IS NULL AND ${table.promotionalPrice} IS NULL AND ${table.fixedDiscount} IS NULL)
    OR (${table.type} = 'FIXED_DISCOUNT' AND ${table.fixedDiscount} BETWEEN 1 AND 9007199254740991 AND ${table.nPlusOneBuyQuantity} IS NULL AND ${table.nPlusOneFreeQuantity} IS NULL AND ${table.promotionalPrice} IS NULL AND ${table.percentDiscount} IS NULL)), false)`),
  check('promotions_window_check', sql`${table.endsAt} > ${table.startsAt}`),
  check('promotions_schema_version_check', sql`${table.schemaVersion} >= 1`),
  check('promotions_deleted_chronology_check', sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`),
  index('promotions_active_sort_idx').on(table.tenantId, table.sortOrder, table.promotionId)
    .where(sql`${table.isActive} AND ${table.deletedAt} IS NULL`),
]);

export const promotionProducts = pgTable('promotion_products', {
  tenantId: uuid('tenant_id').notNull(),
  promotionProductId: text('promotion_product_id').notNull(),
  promotionId: text('promotion_id').notNull(),
  productId: text('product_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  schemaVersion: integer('schema_version').default(1).notNull(),
}, (table) => [
  primaryKey({ name: 'promotion_products_pkey', columns: [table.tenantId, table.promotionProductId] }),
  unique('promotion_products_link_unique').on(table.tenantId, table.promotionId, table.productId),
  foreignKey({
    name: 'promotion_products_promotion_fk', columns: [table.tenantId, table.promotionId],
    foreignColumns: [promotions.tenantId, promotions.promotionId],
  }),
  foreignKey({
    name: 'promotion_products_product_fk', columns: [table.tenantId, table.productId],
    foreignColumns: [products.tenantId, products.productId],
  }),
  check('promotion_products_id_check', sql`${table.promotionProductId} = btrim(${table.promotionProductId}) AND length(${table.promotionProductId}) > 0`),
  check('promotion_products_schema_version_check', sql`${table.schemaVersion} >= 1`),
]);
