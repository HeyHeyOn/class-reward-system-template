import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

export type PromotionAdminAction = 'CREATE' | 'UPDATE' | 'ACTIVATE' | 'DEACTIVATE' | 'DELETE';
export type PromotionAdminType = 'N_PLUS_ONE' | 'PROMOTIONAL_PRICE' | 'PERCENT_DISCOUNT' | 'FIXED_DISCOUNT';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

type PromotionAdminDefinitionCommon = Readonly<{
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: number;
}>;

type PromotionAdminDefinitionLike = PromotionAdminDefinitionCommon & Readonly<{
  type: PromotionAdminType;
  buyQuantity?: number;
  freeQuantity?: number;
  promotionalUnitPrice?: number;
  percent?: number;
  discountAmount?: number;
}>;

export type PromotionAdminDefinitionInput = PromotionAdminDefinitionCommon & (
  | Readonly<{ type: 'N_PLUS_ONE'; buyQuantity: number; freeQuantity: number }>
  | Readonly<{ type: 'PROMOTIONAL_PRICE'; promotionalUnitPrice: number }>
  | Readonly<{ type: 'PERCENT_DISCOUNT'; percent: number }>
  | Readonly<{ type: 'FIXED_DISCOUNT'; discountAmount: number }>
);

export type CreatePromotionAdminInput = Readonly<{
  operationId: string;
  promotionId: string;
  definition: PromotionAdminDefinitionInput;
  productIds: readonly string[];
}>;

export type UpdatePromotionAdminInput = Readonly<{
  operationId: string;
  promotionId: string;
  expectedPromotionVersion: number;
  definition: PromotionAdminDefinitionInput;
  productIds: readonly string[];
}>;

export type ActivatePromotionAdminInput = Readonly<{
  operationId: string;
  promotionId: string;
  expectedPromotionVersion: number;
}>;

export type DeactivatePromotionAdminInput = ActivatePromotionAdminInput;
export type DeletePromotionAdminInput = ActivatePromotionAdminInput;

export type DatabasePromotionCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

export type PromotionAdminPromotionResult = Readonly<{
  promotionId: string;
  name: string;
  description: string;
  type: PromotionAdminType;
  buyQuantity?: number;
  freeQuantity?: number;
  promotionalUnitPrice?: number;
  percent?: number;
  discountAmount?: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: number;
  schemaVersion: 3;
  productIds: readonly string[];
  promotionVersionBefore: number | null;
  promotionVersionAfter: number;
}>;

export type PromotionAdminSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: PromotionAdminAction;
  completedAt: string;
  promotions: readonly PromotionAdminPromotionResult[];
}>;

type CanonicalDefinition = Omit<PromotionAdminPromotionResult,
  'promotionId' | 'schemaVersion' | 'productIds' | 'promotionVersionBefore' | 'promotionVersionAfter'>;

type OperationRow = Record<string, unknown> & {
  operation_kind: string;
  payload_hash: string;
  status: string;
  result_snapshot: unknown;
  finished_at: Date | string | null;
  failure_code: string | null;
  attempt_count: number | string;
  started_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type PromotionAdminPayload = Readonly<{
  action: PromotionAdminAction;
  promotions: readonly Readonly<{
    promotionId: string;
    expectedPromotionVersion?: number;
    definition?: Partial<PromotionAdminPromotionResult>;
    productIds?: readonly string[];
  }>[];
}>;

export function createPromotionAdminLinkId(
  operationId: string,
  promotionId: string,
  productId: string,
): string {
  const digest = sha256({
    domain: 'promotion-admin-link-v1', operationId, promotionId, productId,
  });
  return `promotion-admin-link:${digest}`;
}

export function createPromotionAdminPayloadHash(payload: PromotionAdminPayload): string {
  const promotions = payload.promotions.map((promotion) => {
    const definition = promotion.definition;
    return {
      promotionId: canonicalText(promotion.promotionId, 'promotion ID'),
      ...(promotion.expectedPromotionVersion === undefined ? {} : {
        expectedPromotionVersion: positiveSafeInteger(
          promotion.expectedPromotionVersion,
          'expected promotion version',
        ),
      }),
      ...(definition ? { definition: canonicalDefinition(definition as PromotionAdminDefinitionInput) } : {}),
      ...(promotion.productIds ? { productIds: canonicalProductIds(promotion.productIds) } : {}),
    };
  }).sort(comparePromotionId);
  return sha256({ kind: 'PROMOTION_ADMIN', action: payload.action, promotions });
}

export function createPromotionAdminResultHash(result: PromotionAdminSuccess): string {
  return sha256({
    action: result.action,
    completedAt: result.completedAt,
    ok: result.ok,
    operationId: result.operationId,
    promotions: result.promotions.map((promotion) => canonicalResultPromotion(promotion)),
  });
}

export function createDatabasePromotionCommands(dependencies: DatabasePromotionCommandDependencies) {
  return {
    async create(rawInput: CreatePromotionAdminInput): Promise<PromotionAdminSuccess> {
      const input = canonicalCreate(rawInput);
      const payloadHash = createPromotionAdminPayloadHash({
        action: 'CREATE',
        promotions: [{
          promotionId: input.promotionId,
          definition: input.definition,
          productIds: input.productIds,
        }],
      });
      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExistingCreate(tx, dependencies.tenantId, existing, payloadHash, input);
        }
        const now = dependencies.now?.() ?? new Date();
        const claimed = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
             started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'PROMOTION_ADMIN', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (claimed.rows.length !== 1) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Promotion administration operation race integrity check failed.');
          return resolveExistingCreate(tx, dependencies.tenantId, winner, payloadHash, input);
        }
        if (input.productIds.length > 0) {
          const lockedProducts = await tx.execute(sql`
            SELECT product_id
            FROM products
            WHERE tenant_id=${dependencies.tenantId}
              AND product_id IN (${sql.join(input.productIds.map((productId) => sql`${productId}`), sql`, `)})
              AND deleted_at IS NULL
            ORDER BY product_id
            FOR UPDATE
          `);
          if (lockedProducts.rows.length !== input.productIds.length) {
            throw new Error('Promotion target product not found.');
          }
          const found = new Set(lockedProducts.rows.map((row) => (row as { product_id: string }).product_id));
          if (found.size !== input.productIds.length
            || input.productIds.some((productId) => !found.has(productId))) {
            throw new Error('Promotion target product integrity check failed.');
          }
        }
        const definition = input.definition;
        const insertedPromotion = await tx.execute(sql`
          INSERT INTO promotions
            (tenant_id, promotion_id, name, description, type,
             n_plus_one_buy_quantity, n_plus_one_free_quantity, promotional_price,
             percent_discount, fixed_discount, starts_at, ends_at, is_active,
             sort_order, schema_version, version, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.promotionId}, ${definition.name}, ${definition.description},
             ${definition.type}, ${definition.buyQuantity ?? null}, ${definition.freeQuantity ?? null},
             ${definition.promotionalUnitPrice ?? null}, ${definition.percent ?? null},
             ${definition.discountAmount ?? null}, ${definition.startsAt}, ${definition.endsAt},
             ${definition.isActive}, ${definition.sortOrder}, 3, 1, ${now}, ${now})
          RETURNING promotion_id
        `);
        if (insertedPromotion.rows.length !== 1
          || (insertedPromotion.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
          throw new Error('Promotion administration metadata insert integrity check failed.');
        }
        for (const productId of input.productIds) {
          const linkId = createPromotionAdminLinkId(input.operationId, input.promotionId, productId);
          const insertedLink = await tx.execute(sql`
            INSERT INTO promotion_products
              (tenant_id, promotion_product_id, promotion_id, product_id, created_at, schema_version)
            VALUES
              (${dependencies.tenantId}, ${linkId},
               ${input.promotionId}, ${productId}, ${now}, 3)
            RETURNING promotion_product_id
          `);
          if (insertedLink.rows.length !== 1
            || (insertedLink.rows[0] as { promotion_product_id?: unknown }).promotion_product_id !== linkId) {
            throw new Error('Promotion administration link insert integrity check failed.');
          }
        }
        const result: PromotionAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'CREATE',
          completedAt: now.toISOString(),
          promotions: [{
            promotionId: input.promotionId,
            ...definition,
            schemaVersion: 3,
            productIds: input.productIds,
            promotionVersionBefore: null,
            promotionVersionAfter: 1,
          }],
        };
        await appendOperationAudit(
          tx,
          dependencies.tenantId,
          promotionAdminAuditInput(result, now),
        );
        await assertOperationAudit(
          tx,
          dependencies.tenantId,
          promotionAdminAuditInput(result, now),
        );
        const terminal = await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id
        `);
        if (terminal.rows.length !== 1) {
          throw new Error('Promotion administration terminal operation integrity check failed.');
        }
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) {
          throw new Error('Promotion administration terminal operation integrity check failed.');
        }
        return resolveExistingCreate(
          tx,
          dependencies.tenantId,
          stored,
          payloadHash,
          input,
        );
      });
    },
    async update(rawInput: UpdatePromotionAdminInput): Promise<PromotionAdminSuccess> {
      const input = canonicalUpdate(rawInput);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) {
        throw new Error('Promotion administration current timestamp is invalid.');
      }
      const payloadHash = createPromotionAdminPayloadHash({
        action: 'UPDATE',
        promotions: [{
          promotionId: input.promotionId,
          expectedPromotionVersion: input.expectedPromotionVersion,
          definition: input.definition,
          productIds: input.productIds,
        }],
      });
      return runPromotionUpdate(dependencies, input, payloadHash, now);
    },
    async activate(rawInput: ActivatePromotionAdminInput): Promise<PromotionAdminSuccess> {
      return preparePromotionActivation(dependencies, rawInput, 'ACTIVATE', true);
    },
    async deactivate(rawInput: DeactivatePromotionAdminInput): Promise<PromotionAdminSuccess> {
      return preparePromotionActivation(dependencies, rawInput, 'DEACTIVATE', false);
    },
    async delete(rawInput: DeletePromotionAdminInput): Promise<PromotionAdminSuccess> {
      const input = canonicalDelete(rawInput);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) {
        throw new Error('Promotion administration current timestamp is invalid.');
      }
      const payloadHash = createPromotionAdminPayloadHash({
        action: 'DELETE',
        promotions: [{
          promotionId: input.promotionId,
          expectedPromotionVersion: input.expectedPromotionVersion,
        }],
      });
      return runPromotionDelete(dependencies, input, payloadHash, now);
    },
  };
}

function preparePromotionActivation(
  dependencies: DatabasePromotionCommandDependencies,
  rawInput: ActivatePromotionAdminInput,
  action: 'ACTIVATE' | 'DEACTIVATE',
  desiredActive: boolean,
): Promise<PromotionAdminSuccess> {
  const input = canonicalActivation(rawInput);
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Promotion administration current timestamp is invalid.');
  }
  const payloadHash = createPromotionAdminPayloadHash({
    action,
    promotions: [{
      promotionId: input.promotionId,
      expectedPromotionVersion: input.expectedPromotionVersion,
    }],
  });
  return runPromotionActivation(dependencies, input, action, desiredActive, payloadHash, now);
}

async function runPromotionUpdate(
  dependencies: DatabasePromotionCommandDependencies,
  input: ReturnType<typeof canonicalUpdate>,
  payloadHash: string,
  now: Date,
): Promise<PromotionAdminSuccess> {
  return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
    const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (existing) return resolveExistingUpdate(tx, dependencies.tenantId, existing, payloadHash, input);

    const claimed = await tx.execute(sql`
      INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
      VALUES
        (${dependencies.tenantId}, ${input.operationId}, 'PROMOTION_ADMIN', ${payloadHash},
         'PENDING', 1, ${now}, ${now}, ${now})
      ON CONFLICT (tenant_id, operation_id) DO NOTHING
      RETURNING operation_id
    `);
    if (claimed.rows.length !== 1) {
      const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!winner) throw new Error('Promotion administration operation race integrity check failed.');
      return resolveExistingUpdate(tx, dependencies.tenantId, winner, payloadHash, input);
    }

    const target = await tx.execute(sql`
      SELECT promotion_id, version
      FROM promotions
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL
      FOR UPDATE
    `);
    if (target.rows.length !== 1
      || (target.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
      throw new Error('Promotion administration target promotion not found.');
    }
    const storedVersion = dbPositiveSafeInteger((target.rows[0] as { version?: unknown }).version);
    if (storedVersion !== input.expectedPromotionVersion) {
      throw new Error('Promotion administration stale promotion version.');
    }

    if (input.productIds.length > 0) {
      const lockedProducts = await tx.execute(sql`
        SELECT product_id FROM products
        WHERE tenant_id=${dependencies.tenantId}
          AND product_id IN (${sql.join(input.productIds.map((id) => sql`${id}`), sql`, `)})
          AND deleted_at IS NULL
        ORDER BY product_id
        FOR UPDATE
      `);
      const found = lockedProducts.rows.map((row) => (row as { product_id?: unknown }).product_id);
      if (found.some((id) => typeof id !== 'string')) {
        throw new Error('Promotion target product not found.');
      }
      const canonicalFound = (found as string[]).sort(compareText);
      if (canonicalFound.length !== input.productIds.length
        || canonicalFound.some((id, index) => id !== input.productIds[index])) {
        throw new Error('Promotion target product not found.');
      }
    }

    const oldLinks = await tx.execute(sql`
      SELECT promotion_product_id, product_id
      FROM promotion_products
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
      ORDER BY product_id, promotion_product_id
      FOR UPDATE
    `);
    const oldIdentities = oldLinks.rows.map((row) => ({
      promotionProductId: (row as { promotion_product_id: string }).promotion_product_id,
      productId: (row as { product_id: string }).product_id,
    }));
    if (oldIdentities.some((row) => typeof row.promotionProductId !== 'string'
      || typeof row.productId !== 'string')) {
      throw new Error('Promotion administration existing link integrity check failed.');
    }

    const definition = input.definition;
    const updated = await tx.execute(sql`
      UPDATE promotions SET
        name=${definition.name}, description=${definition.description}, type=${definition.type},
        n_plus_one_buy_quantity=${definition.buyQuantity ?? null},
        n_plus_one_free_quantity=${definition.freeQuantity ?? null},
        promotional_price=${definition.promotionalUnitPrice ?? null},
        percent_discount=${definition.percent ?? null}, fixed_discount=${definition.discountAmount ?? null},
        starts_at=${definition.startsAt}, ends_at=${definition.endsAt}, is_active=${definition.isActive},
        sort_order=${definition.sortOrder}, schema_version=3,
        version=${input.expectedPromotionVersion + 1}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL AND version=${input.expectedPromotionVersion}
      RETURNING promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version
    `);
    assertUpdatedPromotionRow(updated.rows, input);

    const deleted = await tx.execute(sql`
      DELETE FROM promotion_products
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
      RETURNING promotion_product_id, product_id
    `);
    const deletedIdentities = deleted.rows.map((row) => ({
      promotionProductId: (row as { promotion_product_id: string }).promotion_product_id,
      productId: (row as { product_id: string }).product_id,
    })).sort(compareLinkIdentity);
    if (JSON.stringify(deletedIdentities) !== JSON.stringify([...oldIdentities].sort(compareLinkIdentity))) {
      throw new Error('Promotion administration link delete integrity check failed.');
    }

    for (const productId of input.productIds) {
      const linkId = createPromotionAdminLinkId(input.operationId, input.promotionId, productId);
      const inserted = await tx.execute(sql`
        INSERT INTO promotion_products
          (tenant_id, promotion_product_id, promotion_id, product_id, created_at, schema_version)
        VALUES (${dependencies.tenantId}, ${linkId}, ${input.promotionId}, ${productId}, ${now}, 3)
        RETURNING promotion_product_id, promotion_id, product_id, schema_version
      `);
      if (inserted.rows.length !== 1) throw new Error('Promotion administration link insert integrity check failed.');
      const row = inserted.rows[0] as Record<string, unknown>;
      if (row.promotion_product_id !== linkId || row.promotion_id !== input.promotionId
        || row.product_id !== productId || row.schema_version !== 3) {
        throw new Error('Promotion administration link insert integrity check failed.');
      }
    }
    const finalLinks = await tx.execute(sql`
      SELECT promotion_product_id, product_id, schema_version
      FROM promotion_products
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
      ORDER BY product_id, promotion_product_id
      FOR UPDATE
    `);
    const expectedLinks = input.productIds.map((productId) => ({
      promotion_product_id: createPromotionAdminLinkId(input.operationId, input.promotionId, productId),
      product_id: productId,
      schema_version: 3,
    }));
    const actualLinks = finalLinks.rows.map((row) => {
      if (!isExactRecord(row, ['promotion_product_id', 'product_id', 'schema_version'])
        || typeof row.promotion_product_id !== 'string' || typeof row.product_id !== 'string'
        || row.schema_version !== 3) {
        throw new Error('Promotion administration final link set integrity check failed.');
      }
      return {
        promotion_product_id: row.promotion_product_id,
        product_id: row.product_id,
        schema_version: row.schema_version,
      };
    }).sort(compareStoredLink);
    if (JSON.stringify(actualLinks) !== JSON.stringify([...expectedLinks].sort(compareStoredLink))) {
      throw new Error('Promotion administration final link set integrity check failed.');
    }

    const result: PromotionAdminSuccess = {
      ok: true, operationId: input.operationId, action: 'UPDATE', completedAt: now.toISOString(),
      promotions: [{
        promotionId: input.promotionId, ...definition, schemaVersion: 3,
        productIds: input.productIds, promotionVersionBefore: input.expectedPromotionVersion,
        promotionVersionAfter: input.expectedPromotionVersion + 1,
      }],
    };
    const auditInput = promotionAdminAuditInput(result, now);
    await appendOperationAudit(tx, dependencies.tenantId, auditInput);
    await assertOperationAudit(tx, dependencies.tenantId, auditInput);
    const terminal = await tx.execute(sql`
      UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
        finished_at=${now}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
      RETURNING operation_id
    `);
    if (terminal.rows.length !== 1
      || (terminal.rows[0] as { operation_id?: unknown }).operation_id !== input.operationId) {
      throw new Error('Promotion administration terminal operation integrity check failed.');
    }
    const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (!stored) throw new Error('Promotion administration terminal operation integrity check failed.');
    return resolveExistingUpdate(tx, dependencies.tenantId, stored, payloadHash, input);
  });
}

async function runPromotionActivation(
  dependencies: DatabasePromotionCommandDependencies,
  input: ReturnType<typeof canonicalActivation>,
  action: 'ACTIVATE' | 'DEACTIVATE',
  desiredActive: boolean,
  payloadHash: string,
  now: Date,
): Promise<PromotionAdminSuccess> {
  return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
    const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (existing) {
      return resolveExistingActivation(
        tx, dependencies.tenantId, existing, payloadHash, input, action, desiredActive,
      );
    }
    const claimed = await tx.execute(sql`
      INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
      VALUES
        (${dependencies.tenantId}, ${input.operationId}, 'PROMOTION_ADMIN', ${payloadHash},
         'PENDING', 1, ${now}, ${now}, ${now})
      ON CONFLICT (tenant_id, operation_id) DO NOTHING
      RETURNING operation_id
    `);
    if (claimed.rows.length !== 1
      || (claimed.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      if (claimed.rows.length !== 0) {
        throw new Error('Promotion administration operation claim integrity check failed.');
      }
      const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!winner) throw new Error('Promotion administration operation race integrity check failed.');
      return resolveExistingActivation(
        tx, dependencies.tenantId, winner, payloadHash, input, action, desiredActive,
      );
    }

    const target = await tx.execute(sql`
      SELECT promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
      FROM promotions
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL
      FOR UPDATE
    `);
    if (target.rows.length !== 1) {
      throw new Error('Promotion administration target promotion not found.');
    }
    const before = parseStoredPromotion(target.rows[0], input.promotionId, false);
    if (before.version !== input.expectedPromotionVersion) {
      throw new Error('Promotion administration stale promotion version.');
    }

    const links = await readActivationLinks(tx, dependencies.tenantId, input.promotionId);
    const productIds = canonicalProductIds(links.map((link) => link.productId));
    const updated = await tx.execute(sql`
      UPDATE promotions
      SET is_active=${desiredActive}, updated_at=${now}, schema_version=3,
          version=${input.expectedPromotionVersion + 1}
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL AND version=${input.expectedPromotionVersion}
      RETURNING promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
    `);
    if (updated.rows.length !== 1) {
      throw new Error('Promotion administration metadata update integrity check failed.');
    }
    const after = parseStoredPromotion(updated.rows[0], input.promotionId, false);
    const expectedAfter = {
      ...before,
      definition: { ...before.definition, isActive: desiredActive },
      schemaVersion: 3,
      version: input.expectedPromotionVersion + 1,
      updatedAt: now.toISOString(),
    };
    if (JSON.stringify(after) !== JSON.stringify(expectedAfter)) {
      throw new Error('Promotion administration metadata update integrity check failed.');
    }
    const storedAfter = await tx.execute(sql`
      SELECT promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
      FROM promotions
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL
      FOR UPDATE
    `);
    if (storedAfter.rows.length !== 1
      || JSON.stringify(parseStoredPromotion(storedAfter.rows[0], input.promotionId, false))
        !== JSON.stringify(expectedAfter)) {
      throw new Error('Promotion administration stored promotion integrity check failed.');
    }
    const linksAfter = await readActivationLinks(tx, dependencies.tenantId, input.promotionId);
    if (JSON.stringify(linksAfter) !== JSON.stringify(links)) {
      throw new Error('Promotion administration link preservation integrity check failed.');
    }

    const result: PromotionAdminSuccess = {
      ok: true,
      operationId: input.operationId,
      action,
      completedAt: now.toISOString(),
      promotions: [{
        promotionId: input.promotionId,
        ...after.definition,
        schemaVersion: 3,
        productIds,
        promotionVersionBefore: input.expectedPromotionVersion,
        promotionVersionAfter: input.expectedPromotionVersion + 1,
      }],
    };
    const auditInput = promotionAdminAuditInput(result, now);
    await appendOperationAudit(tx, dependencies.tenantId, auditInput);
    await assertOperationAudit(tx, dependencies.tenantId, auditInput);
    const terminal = await tx.execute(sql`
      UPDATE operations
      SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
          finished_at=${now}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        AND operation_kind='PROMOTION_ADMIN' AND payload_hash=${payloadHash} AND status='PENDING'
      RETURNING operation_id
    `);
    if (terminal.rows.length !== 1
      || (terminal.rows[0] as { operation_id?: unknown }).operation_id !== input.operationId) {
      throw new Error('Promotion administration terminal operation integrity check failed.');
    }
    const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (!stored) throw new Error('Promotion administration terminal operation integrity check failed.');
    return resolveExistingActivation(
      tx, dependencies.tenantId, stored, payloadHash, input, action, desiredActive,
    );
  });
}

async function runPromotionDelete(
  dependencies: DatabasePromotionCommandDependencies,
  input: ReturnType<typeof canonicalDelete>,
  payloadHash: string,
  now: Date,
): Promise<PromotionAdminSuccess> {
  return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
    const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (existing) return resolveExistingDelete(tx, dependencies.tenantId, existing, payloadHash, input);
    const claimed = await tx.execute(sql`
      INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
      VALUES (${dependencies.tenantId}, ${input.operationId}, 'PROMOTION_ADMIN', ${payloadHash},
        'PENDING', 1, ${now}, ${now}, ${now})
      ON CONFLICT (tenant_id, operation_id) DO NOTHING
      RETURNING operation_id
    `);
    if (claimed.rows.length !== 1
      || (claimed.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      if (claimed.rows.length !== 0) throw new Error('Promotion administration operation claim integrity check failed.');
      const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!winner) throw new Error('Promotion administration operation race integrity check failed.');
      return resolveExistingDelete(tx, dependencies.tenantId, winner, payloadHash, input);
    }

    const target = await tx.execute(sql`
      SELECT promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
      FROM promotions
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL
      FOR UPDATE
    `);
    if (target.rows.length !== 1) throw new Error('Promotion administration target promotion not found.');
    const before = parseStoredPromotion(target.rows[0], input.promotionId, false);
    if (before.version !== input.expectedPromotionVersion) {
      throw new Error('Promotion administration stale promotion version.');
    }
    const createdMs = Date.parse(before.createdAt);
    const updatedMs = Date.parse(before.updatedAt);
    const nowMs = now.getTime();
    if (!(createdMs <= updatedMs && updatedMs <= nowMs)) {
      throw new Error('Promotion administration delete chronology integrity check failed.');
    }
    const links = await readActivationLinks(tx, dependencies.tenantId, input.promotionId);
    const productIds = canonicalProductIds(links.map((link) => link.productId));
    const updated = await tx.execute(sql`
      UPDATE promotions
      SET is_active=false, deleted_at=${now}, updated_at=${now}, schema_version=3,
          version=${input.expectedPromotionVersion + 1}
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
        AND deleted_at IS NULL AND version=${input.expectedPromotionVersion}
      RETURNING promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
    `);
    if (updated.rows.length !== 1) throw new Error('Promotion administration metadata update integrity check failed.');
    const after = parseStoredPromotion(updated.rows[0], input.promotionId, true);
    const expectedAfter: ParsedStoredPromotion = {
      ...before,
      definition: { ...before.definition, isActive: false },
      schemaVersion: 3,
      version: input.expectedPromotionVersion + 1,
      updatedAt: now.toISOString(),
      deletedAt: now.toISOString(),
    };
    if (JSON.stringify(after) !== JSON.stringify(expectedAfter)) {
      throw new Error('Promotion administration metadata update integrity check failed.');
    }
    const storedAfter = await tx.execute(sql`
      SELECT promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, promotional_price, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order, schema_version, version,
        created_at, updated_at, deleted_at
      FROM promotions
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
      FOR UPDATE
    `);
    if (storedAfter.rows.length !== 1
      || JSON.stringify(parseStoredPromotion(storedAfter.rows[0], input.promotionId, true))
        !== JSON.stringify(expectedAfter)) {
      throw new Error('Promotion administration stored promotion integrity check failed.');
    }
    const deleted = await tx.execute(sql`
      DELETE FROM promotion_products
      WHERE tenant_id=${dependencies.tenantId} AND promotion_id=${input.promotionId}
      RETURNING promotion_product_id, promotion_id, product_id, created_at, schema_version
    `);
    const deletedLinks = parseDeletedLinks(deleted.rows, input.promotionId);
    if (JSON.stringify(deletedLinks) !== JSON.stringify(links)) {
      throw new Error('Promotion administration link delete integrity check failed.');
    }
    if ((await readActivationLinks(tx, dependencies.tenantId, input.promotionId)).length !== 0) {
      throw new Error('Promotion administration final link set integrity check failed.');
    }
    const result: PromotionAdminSuccess = {
      ok: true, operationId: input.operationId, action: 'DELETE', completedAt: now.toISOString(),
      promotions: [{
        promotionId: input.promotionId, ...after.definition, schemaVersion: 3, productIds,
        promotionVersionBefore: input.expectedPromotionVersion,
        promotionVersionAfter: input.expectedPromotionVersion + 1,
      }],
    };
    const auditInput = promotionAdminAuditInput(result, now);
    await appendOperationAudit(tx, dependencies.tenantId, auditInput);
    await assertOperationAudit(tx, dependencies.tenantId, auditInput);
    const terminal = await tx.execute(sql`
      UPDATE operations
      SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
          finished_at=${now}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        AND operation_kind='PROMOTION_ADMIN' AND payload_hash=${payloadHash} AND status='PENDING'
      RETURNING operation_id
    `);
    if (terminal.rows.length !== 1
      || (terminal.rows[0] as { operation_id?: unknown }).operation_id !== input.operationId) {
      throw new Error('Promotion administration terminal operation integrity check failed.');
    }
    const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (!stored) throw new Error('Promotion administration terminal operation integrity check failed.');
    return resolveExistingDelete(tx, dependencies.tenantId, stored, payloadHash, input);
  });
}

type ParsedStoredPromotion = Readonly<{
  definition: CanonicalDefinition;
  schemaVersion: 3;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}>;

function parseStoredPromotion(
  value: unknown,
  promotionId: string,
  allowDeleted: boolean,
): ParsedStoredPromotion {
  const keys = [
    'promotion_id', 'name', 'description', 'type', 'n_plus_one_buy_quantity',
    'n_plus_one_free_quantity', 'promotional_price', 'percent_discount', 'fixed_discount',
    'starts_at', 'ends_at', 'is_active', 'sort_order', 'schema_version', 'version',
    'created_at', 'updated_at', 'deleted_at',
  ];
  if (!isExactRecord(value, keys) || value.promotion_id !== promotionId
    || value.schema_version !== 3 || (!allowDeleted && value.deleted_at !== null)) {
    throw new Error('Promotion administration stored promotion integrity check failed.');
  }
  const type = value.type;
  const common = {
    name: value.name,
    description: value.description,
    type,
    startsAt: operationTimestamp(value.starts_at).toISOString(),
    endsAt: operationTimestamp(value.ends_at).toISOString(),
    isActive: value.is_active,
    sortOrder: value.sort_order,
  };
  let rawDefinition: PromotionAdminDefinitionLike;
  if (type === 'N_PLUS_ONE'
    && value.promotional_price === null && value.percent_discount === null && value.fixed_discount === null) {
    rawDefinition = {
      ...common, type, buyQuantity: storedNumber(value.n_plus_one_buy_quantity),
      freeQuantity: storedNumber(value.n_plus_one_free_quantity),
    } as PromotionAdminDefinitionLike;
  } else if (type === 'PROMOTIONAL_PRICE'
    && value.n_plus_one_buy_quantity === null && value.n_plus_one_free_quantity === null
    && value.percent_discount === null && value.fixed_discount === null) {
    rawDefinition = {
      ...common, type, promotionalUnitPrice: storedNumber(value.promotional_price),
    } as PromotionAdminDefinitionLike;
  } else if (type === 'PERCENT_DISCOUNT'
    && value.n_plus_one_buy_quantity === null && value.n_plus_one_free_quantity === null
    && value.promotional_price === null && value.fixed_discount === null) {
    rawDefinition = {
      ...common, type, percent: storedNumber(value.percent_discount),
    } as PromotionAdminDefinitionLike;
  } else if (type === 'FIXED_DISCOUNT'
    && value.n_plus_one_buy_quantity === null && value.n_plus_one_free_quantity === null
    && value.promotional_price === null && value.percent_discount === null) {
    rawDefinition = {
      ...common, type, discountAmount: storedNumber(value.fixed_discount),
    } as PromotionAdminDefinitionLike;
  } else {
    throw new Error('Promotion administration stored promotion integrity check failed.');
  }
  try {
    const definition = canonicalDefinition(rawDefinition);
    if (value.name !== definition.name || value.description !== definition.description
      || value.type !== definition.type || value.is_active !== definition.isActive
      || value.sort_order !== definition.sortOrder
      || operationTimestamp(value.starts_at).toISOString() !== definition.startsAt
      || operationTimestamp(value.ends_at).toISOString() !== definition.endsAt) {
      throw new Error('non-canonical stored definition');
    }
    return {
      definition,
      schemaVersion: 3,
      version: dbPositiveSafeInteger(value.version),
      createdAt: operationTimestamp(value.created_at).toISOString(),
      updatedAt: operationTimestamp(value.updated_at).toISOString(),
      deletedAt: value.deleted_at === null ? null : operationTimestamp(value.deleted_at).toISOString(),
    };
  } catch {
    throw new Error('Promotion administration stored promotion integrity check failed.');
  }
}

function storedNumber(value: unknown): number {
  const rawNumeric = canonicalFiniteNumeric(value);
  const number = typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)
    || rawNumeric === undefined || canonicalFiniteNumeric(number) !== rawNumeric) {
    throw new Error('Promotion administration stored promotion integrity check failed.');
  }
  return number;
}

type ActivationLink = Readonly<{
  promotionProductId: string;
  promotionId: string;
  productId: string;
  createdAt: string;
  schemaVersion: 3;
}>;

async function readActivationLinks(
  tx: TenantTransaction,
  tenantId: string,
  promotionId: string,
): Promise<ActivationLink[]> {
  const result = await tx.execute(sql`
    SELECT promotion_product_id, promotion_id, product_id, created_at, schema_version
    FROM promotion_products
    WHERE tenant_id=${tenantId} AND promotion_id=${promotionId}
    ORDER BY product_id, promotion_product_id
    FOR UPDATE
  `);
  const links = result.rows.map((value) => {
    if (!isExactRecord(value, [
      'promotion_product_id', 'promotion_id', 'product_id', 'created_at', 'schema_version',
    ]) || typeof value.promotion_product_id !== 'string'
      || !value.promotion_product_id.trim()
      || value.promotion_product_id !== value.promotion_product_id.trim()
      || value.promotion_id !== promotionId
      || typeof value.product_id !== 'string' || !value.product_id.trim()
      || value.product_id !== value.product_id.trim() || value.schema_version !== 3) {
      throw new Error('Promotion administration existing link integrity check failed.');
    }
    return {
      promotionProductId: value.promotion_product_id,
      promotionId: value.promotion_id,
      productId: value.product_id,
      createdAt: operationTimestamp(value.created_at).toISOString(),
      schemaVersion: 3 as const,
    };
  });
  const identities = new Set(links.map((link) => `${link.productId}\u0000${link.promotionProductId}`));
  if (identities.size !== links.length || new Set(links.map((link) => link.productId)).size !== links.length) {
    throw new Error('Promotion administration existing link integrity check failed.');
  }
  return links.sort((left, right) => compareText(left.productId, right.productId)
    || compareText(left.promotionProductId, right.promotionProductId));
}

function parseDeletedLinks(
  rows: readonly Record<string, unknown>[],
  promotionId: string,
): ActivationLink[] {
  const links = rows.map((value) => {
    if (!isExactRecord(value, [
      'promotion_product_id', 'promotion_id', 'product_id', 'created_at', 'schema_version',
    ]) || typeof value.promotion_product_id !== 'string' || !value.promotion_product_id.trim()
      || value.promotion_product_id !== value.promotion_product_id.trim()
      || value.promotion_id !== promotionId
      || typeof value.product_id !== 'string' || !value.product_id.trim()
      || value.product_id !== value.product_id.trim() || value.schema_version !== 3) {
      throw new Error('Promotion administration link delete integrity check failed.');
    }
    return {
      promotionProductId: value.promotion_product_id,
      promotionId,
      productId: value.product_id,
      createdAt: operationTimestamp(value.created_at).toISOString(),
      schemaVersion: 3 as const,
    };
  }).sort((left, right) => compareText(left.productId, right.productId)
    || compareText(left.promotionProductId, right.promotionProductId));
  if (new Set(links.map((link) => `${link.productId}\u0000${link.promotionProductId}`)).size
      !== links.length
    || new Set(links.map((link) => link.productId)).size !== links.length) {
    throw new Error('Promotion administration link delete integrity check failed.');
  }
  return links;
}

function compareLinkIdentity(
  left: { productId: string; promotionProductId: string },
  right: { productId: string; promotionProductId: string },
): number {
  return compareText(left.productId, right.productId)
    || compareText(left.promotionProductId, right.promotionProductId);
}

function compareStoredLink(
  left: { product_id: string; promotion_product_id: string },
  right: { product_id: string; promotion_product_id: string },
): number {
  return compareText(left.product_id, right.product_id)
    || compareText(left.promotion_product_id, right.promotion_product_id);
}

function canonicalFiniteNumeric(value: unknown): string | undefined {
  const text = typeof value === 'bigint' ? String(value)
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'string' ? value : undefined;
  if (text === undefined || !Number.isFinite(Number(text))) return undefined;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const fraction = match[3] ?? match[4] ?? '';
  let digits = `${match[2] ?? ''}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(match[5] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  const trailingZeroCount = digits.length - digits.replace(/0+$/, '').length;
  if (trailingZeroCount > 0) {
    digits = digits.slice(0, -trailingZeroCount);
    exponent += trailingZeroCount;
  }
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

function dbNumericEquals(
  actual: unknown,
  expected: number | null,
  requireSafeInteger: boolean,
): boolean {
  if (expected === null) return actual === null;
  const actualNumeric = canonicalFiniteNumeric(actual);
  return actualNumeric !== undefined
    && actualNumeric === canonicalFiniteNumeric(expected)
    && (!requireSafeInteger || Number.isSafeInteger(Number(actual)));
}

function assertUpdatedPromotionRow(
  rows: readonly Record<string, unknown>[],
  input: ReturnType<typeof canonicalUpdate>,
): void {
  if (rows.length !== 1) throw new Error('Promotion administration metadata update integrity check failed.');
  const row = rows[0];
  const expected = {
    promotion_id: input.promotionId,
    name: input.definition.name,
    description: input.definition.description,
    type: input.definition.type,
    n_plus_one_buy_quantity: input.definition.buyQuantity ?? null,
    n_plus_one_free_quantity: input.definition.freeQuantity ?? null,
    promotional_price: input.definition.promotionalUnitPrice ?? null,
    percent_discount: input.definition.percent ?? null,
    fixed_discount: input.definition.discountAmount ?? null,
    starts_at: input.definition.startsAt,
    ends_at: input.definition.endsAt,
    is_active: input.definition.isActive,
    sort_order: input.definition.sortOrder,
    schema_version: 3,
    version: input.expectedPromotionVersion + 1,
  };
  if (!isExactRecord(row, Object.keys(expected))) {
    throw new Error('Promotion administration metadata update integrity check failed.');
  }
  const actual = { ...row };
  for (const key of ['starts_at', 'ends_at'] as const) {
    actual[key] = operationTimestamp(actual[key]).toISOString();
  }
  for (const key of ['n_plus_one_buy_quantity', 'n_plus_one_free_quantity', 'promotional_price',
    'fixed_discount', 'version'] as const) {
    if (!dbNumericEquals(actual[key], expected[key], true)) {
      throw new Error('Promotion administration metadata update integrity check failed.');
    }
    actual[key] = expected[key];
  }
  if (!dbNumericEquals(actual.percent_discount, expected.percent_discount, false)) {
    throw new Error('Promotion administration metadata update integrity check failed.');
  }
  actual.percent_discount = expected.percent_discount;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Promotion administration metadata update integrity check failed.');
  }
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
): Promise<OperationRow | undefined> {
  const operation = await tx.execute(sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at,
           failure_code, attempt_count, started_at, created_at, updated_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  `);
  if (operation.rows.length > 1) throw new Error('Promotion administration operation integrity check failed.');
  return operation.rows[0] as OperationRow | undefined;
}

async function resolveExistingCreate(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: ReturnType<typeof canonicalCreate>,
): Promise<PromotionAdminSuccess> {
  if (operation.operation_kind !== 'PROMOTION_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Promotion administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Promotion administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const value = operation.result_snapshot;
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'promotions'])
    || value.ok !== true || value.operationId !== input.operationId || value.action !== 'CREATE'
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.promotions)
    || value.promotions.length !== 1) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const expectedPromotion: PromotionAdminPromotionResult = {
    promotionId: input.promotionId,
    ...input.definition,
    schemaVersion: 3,
    productIds: input.productIds,
    promotionVersionBefore: null,
    promotionVersionAfter: 1,
  };
  const rawPromotion = value.promotions[0];
  if (!isExactRecord(rawPromotion, Object.keys(expectedPromotion))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  let parsedPromotion: ReturnType<typeof canonicalResultPromotion>;
  try {
    parsedPromotion = canonicalResultPromotion(rawPromotion as PromotionAdminPromotionResult);
  } catch {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  if (JSON.stringify(parsedPromotion) !== JSON.stringify(canonicalResultPromotion(expectedPromotion))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const result: PromotionAdminSuccess = {
    ok: true,
    operationId: input.operationId,
    action: 'CREATE',
    completedAt: finishedAt.toISOString(),
    promotions: [expectedPromotion],
  };
  assertOperationEvidence(operation);
  const identity = await tx.execute(sql`
    SELECT promotion_id FROM promotions
    WHERE tenant_id=${tenantId} AND promotion_id=${input.promotionId}
    FOR UPDATE
  `);
  if (identity.rows.length !== 1
    || (identity.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
    throw new Error('Promotion administration identity integrity check failed.');
  }
  await assertOperationAudit(tx, tenantId, promotionAdminAuditInput(result, finishedAt));
  const auditCount = await tx.execute(sql`
    SELECT count(*)::text AS audit_count
    FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}
  `);
  if (auditCount.rows.length !== 1
    || (auditCount.rows[0] as { audit_count?: unknown }).audit_count !== '1') {
    throw new Error('Promotion administration audit integrity check failed.');
  }
  return result;
}

async function resolveExistingUpdate(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: ReturnType<typeof canonicalUpdate>,
): Promise<PromotionAdminSuccess> {
  if (operation.operation_kind !== 'PROMOTION_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Promotion administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Promotion administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const expectedPromotion: PromotionAdminPromotionResult = {
    promotionId: input.promotionId,
    ...input.definition,
    schemaVersion: 3,
    productIds: input.productIds,
    promotionVersionBefore: input.expectedPromotionVersion,
    promotionVersionAfter: input.expectedPromotionVersion + 1,
  };
  const value = operation.result_snapshot;
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'promotions'])
    || value.ok !== true || value.operationId !== input.operationId || value.action !== 'UPDATE'
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.promotions)
    || value.promotions.length !== 1) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const rawPromotion = value.promotions[0];
  if (!isExactRecord(rawPromotion, Object.keys(expectedPromotion))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  let parsedPromotion: ReturnType<typeof canonicalResultPromotion>;
  try {
    parsedPromotion = canonicalResultPromotion(rawPromotion as PromotionAdminPromotionResult);
  } catch {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  if (JSON.stringify(parsedPromotion) !== JSON.stringify(canonicalResultPromotion(expectedPromotion))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const result: PromotionAdminSuccess = {
    ok: true,
    operationId: input.operationId,
    action: 'UPDATE',
    completedAt: finishedAt.toISOString(),
    promotions: [expectedPromotion],
  };
  assertOperationEvidence(operation);
  const identity = await tx.execute(sql`
    SELECT promotion_id FROM promotions
    WHERE tenant_id=${tenantId} AND promotion_id=${input.promotionId}
    FOR UPDATE
  `);
  if (identity.rows.length !== 1
    || (identity.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
    throw new Error('Promotion administration identity integrity check failed.');
  }
  await assertOperationAudit(tx, tenantId, promotionAdminAuditInput(result, finishedAt));
  const auditCount = await tx.execute(sql`
    SELECT count(*)::text AS audit_count FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}
  `);
  if (auditCount.rows.length !== 1
    || (auditCount.rows[0] as { audit_count?: unknown }).audit_count !== '1') {
    throw new Error('Promotion administration audit integrity check failed.');
  }
  return result;
}

async function resolveExistingActivation(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: ReturnType<typeof canonicalActivation>,
  action: 'ACTIVATE' | 'DEACTIVATE',
  desiredActive: boolean,
): Promise<PromotionAdminSuccess> {
  if (operation.operation_kind !== 'PROMOTION_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Promotion administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Promotion administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const value = operation.result_snapshot;
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'promotions'])
    || value.ok !== true || value.operationId !== input.operationId || value.action !== action
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.promotions)
    || value.promotions.length !== 1) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const rawPromotion = value.promotions[0];
  if (!rawPromotion || typeof rawPromotion !== 'object' || Array.isArray(rawPromotion)) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  let parsedPromotion: ReturnType<typeof canonicalResultPromotion>;
  try {
    parsedPromotion = canonicalResultPromotion(rawPromotion as PromotionAdminPromotionResult);
  } catch {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  if (!isExactRecord(rawPromotion, Object.keys(parsedPromotion))
    || parsedPromotion.promotionId !== input.promotionId
    || parsedPromotion.isActive !== desiredActive
    || parsedPromotion.schemaVersion !== 3
    || parsedPromotion.promotionVersionBefore !== input.expectedPromotionVersion
    || parsedPromotion.promotionVersionAfter !== input.expectedPromotionVersion + 1
    || !Object.keys(parsedPromotion).every((key) => JSON.stringify(parsedPromotion[key as keyof typeof parsedPromotion])
      === JSON.stringify(rawPromotion[key]))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const result: PromotionAdminSuccess = {
    ok: true,
    operationId: input.operationId,
    action,
    completedAt: finishedAt.toISOString(),
    promotions: [parsedPromotion],
  };
  assertOperationEvidence(operation);
  const identity = await tx.execute(sql`
    SELECT promotion_id FROM promotions
    WHERE tenant_id=${tenantId} AND promotion_id=${input.promotionId}
    FOR UPDATE
  `);
  if (identity.rows.length !== 1
    || (identity.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
    throw new Error('Promotion administration identity integrity check failed.');
  }
  await assertOperationAudit(tx, tenantId, promotionAdminAuditInput(result, finishedAt));
  const auditCount = await tx.execute(sql`
    SELECT count(*)::text AS audit_count FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}
  `);
  if (auditCount.rows.length !== 1
    || (auditCount.rows[0] as { audit_count?: unknown }).audit_count !== '1') {
    throw new Error('Promotion administration audit integrity check failed.');
  }
  return result;
}

async function resolveExistingDelete(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: ReturnType<typeof canonicalDelete>,
): Promise<PromotionAdminSuccess> {
  if (operation.operation_kind !== 'PROMOTION_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Promotion administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Promotion administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const value = operation.result_snapshot;
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'promotions'])
    || value.ok !== true || value.operationId !== input.operationId || value.action !== 'DELETE'
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.promotions)
    || value.promotions.length !== 1) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const rawPromotion = value.promotions[0];
  if (!rawPromotion || typeof rawPromotion !== 'object' || Array.isArray(rawPromotion)) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  let parsedPromotion: ReturnType<typeof canonicalResultPromotion>;
  try {
    parsedPromotion = canonicalResultPromotion(rawPromotion as PromotionAdminPromotionResult);
  } catch {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  if (!isExactRecord(rawPromotion, Object.keys(parsedPromotion))
    || parsedPromotion.promotionId !== input.promotionId
    || parsedPromotion.isActive !== false
    || parsedPromotion.schemaVersion !== 3
    || parsedPromotion.promotionVersionBefore !== input.expectedPromotionVersion
    || parsedPromotion.promotionVersionAfter !== input.expectedPromotionVersion + 1
    || !Object.keys(parsedPromotion).every((key) => JSON.stringify(parsedPromotion[key as keyof typeof parsedPromotion])
      === JSON.stringify(rawPromotion[key]))) {
    throw new Error('Promotion administration stored result integrity check failed.');
  }
  const result: PromotionAdminSuccess = {
    ok: true, operationId: input.operationId, action: 'DELETE',
    completedAt: finishedAt.toISOString(), promotions: [parsedPromotion],
  };
  assertOperationEvidence(operation);
  const identity = await tx.execute(sql`
    SELECT promotion_id FROM promotions
    WHERE tenant_id=${tenantId} AND promotion_id=${input.promotionId}
    FOR UPDATE
  `);
  if (identity.rows.length !== 1
    || (identity.rows[0] as { promotion_id?: unknown }).promotion_id !== input.promotionId) {
    throw new Error('Promotion administration identity integrity check failed.');
  }
  await assertOperationAudit(tx, tenantId, promotionAdminAuditInput(result, finishedAt));
  const auditCount = await tx.execute(sql`
    SELECT count(*)::text AS audit_count FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}
  `);
  if (auditCount.rows.length !== 1
    || (auditCount.rows[0] as { audit_count?: unknown }).audit_count !== '1') {
    throw new Error('Promotion administration audit integrity check failed.');
  }
  return result;
}

function assertOperationEvidence(operation: OperationRow): void {
  const finishedAt = operationTimestamp(operation.finished_at);
  if (operation.status !== 'SUCCEEDED'
    || operation.failure_code !== null
    || dbPositiveSafeInteger(operation.attempt_count) !== 1
    || operationTimestamp(operation.started_at).getTime() !== operationTimestamp(operation.created_at).getTime()
    || operationTimestamp(operation.started_at).getTime() > finishedAt.getTime()
    || operationTimestamp(operation.updated_at).getTime() !== finishedAt.getTime()) {
    throw new Error('Promotion administration operation integrity check failed.');
  }
}

function promotionAdminAuditInput(result: PromotionAdminSuccess, occurredAt: Date) {
  return {
    operationId: result.operationId,
    eventType: 'PROMOTION_ADMIN_COMPLETED',
    entityType: 'OPERATION',
    entityId: result.operationId,
    occurredAt,
    redactedDetails: {
      action: result.action,
      changedPromotionCount: result.promotions.length,
      targetProductCount: result.promotions.reduce(
        (count, promotion) => count + promotion.productIds.length,
        0,
      ),
      resultHash: createPromotionAdminResultHash(result),
    },
  } as const;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function operationTimestamp(value: unknown): Date {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) {
    throw new Error('Promotion administration timestamp integrity check failed.');
  }
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Promotion administration timestamp integrity check failed.');
  }
  return timestamp;
}

function dbPositiveSafeInteger(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
      : value;
  return positiveSafeInteger(parsed, 'stored positive integer');
}

function canonicalCreate(input: CreatePromotionAdminInput) {
  assertExactDefinitionFields(input.definition);
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    promotionId: canonicalText(input.promotionId, 'promotion ID'),
    definition: canonicalDefinition(input.definition),
    productIds: canonicalProductIds(input.productIds),
  } as const;
}

function canonicalUpdate(input: UpdatePromotionAdminInput) {
  assertExactDefinitionFields(input.definition);
  const expectedPromotionVersion = positiveSafeInteger(
    input.expectedPromotionVersion,
    'expected promotion version',
  );
  positiveSafeInteger(expectedPromotionVersion + 1, 'next promotion version');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    promotionId: canonicalText(input.promotionId, 'promotion ID'),
    expectedPromotionVersion,
    definition: canonicalDefinition(input.definition),
    productIds: canonicalProductIds(input.productIds),
  } as const;
}

function canonicalActivation(input: ActivatePromotionAdminInput) {
  if (!isExactRecord(input, ['operationId', 'promotionId', 'expectedPromotionVersion'])) {
    throw new Error('Promotion activation input fields are invalid.');
  }
  const expectedPromotionVersion = positiveSafeInteger(
    input.expectedPromotionVersion,
    'expected promotion version',
  );
  positiveSafeInteger(expectedPromotionVersion + 1, 'next promotion version');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    promotionId: canonicalText(input.promotionId, 'promotion ID'),
    expectedPromotionVersion,
  } as const;
}

function canonicalDelete(input: DeletePromotionAdminInput) {
  if (!isExactRecord(input, ['operationId', 'promotionId', 'expectedPromotionVersion'])) {
    throw new Error('Promotion delete input fields are invalid.');
  }
  const expectedPromotionVersion = positiveSafeInteger(
    input.expectedPromotionVersion,
    'expected promotion version',
  );
  positiveSafeInteger(expectedPromotionVersion + 1, 'next promotion version');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    promotionId: canonicalText(input.promotionId, 'promotion ID'),
    expectedPromotionVersion,
  } as const;
}

function assertExactDefinitionFields(input: PromotionAdminDefinitionInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Promotion definition is required.');
  }
  const variantFields: Record<PromotionAdminType, readonly string[]> = {
    N_PLUS_ONE: ['buyQuantity', 'freeQuantity'],
    PROMOTIONAL_PRICE: ['promotionalUnitPrice'],
    PERCENT_DISCOUNT: ['percent'],
    FIXED_DISCOUNT: ['discountAmount'],
  };
  const expected = [
    'description', 'endsAt', 'isActive', 'name', 'sortOrder', 'startsAt', 'type',
    ...(variantFields[input.type] ?? []),
  ].sort(compareText);
  const actual = Object.keys(input).sort(compareText);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Promotion definition fields do not match its type.');
  }
}

function canonicalDefinition(input: PromotionAdminDefinitionLike): CanonicalDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Promotion definition is required.');
  }
  const common = {
    name: canonicalText(input.name, 'promotion name'),
    description: stringValue(input.description, 'promotion description').trim(),
    type: input.type,
    startsAt: isoString(input.startsAt, 'promotion start'),
    endsAt: isoString(input.endsAt, 'promotion end'),
    isActive: booleanValue(input.isActive, 'promotion active'),
    sortOrder: int32(input.sortOrder, 'promotion sort order'),
  };
  if (Date.parse(common.startsAt) >= Date.parse(common.endsAt)) {
    throw new Error('Promotion start must be before end.');
  }
  if (input.type === 'N_PLUS_ONE') {
    return {
      ...common,
      type: input.type,
      buyQuantity: positiveSafeInteger(input.buyQuantity, 'buy quantity'),
      freeQuantity: positiveSafeInteger(input.freeQuantity, 'free quantity'),
    };
  }
  if (input.type === 'PROMOTIONAL_PRICE') {
    return {
      ...common,
      type: input.type,
      promotionalUnitPrice: nonnegativeSafeInteger(input.promotionalUnitPrice, 'promotional price'),
    };
  }
  if (input.type === 'PERCENT_DISCOUNT') {
    if (typeof input.percent !== 'number' || !Number.isFinite(input.percent)
      || input.percent <= 0 || input.percent > 100) {
      throw new Error('Promotion percent must be greater than zero and at most 100.');
    }
    return { ...common, type: input.type, percent: input.percent };
  }
  if (input.type === 'FIXED_DISCOUNT') {
    return {
      ...common,
      type: input.type,
      discountAmount: positiveSafeInteger(input.discountAmount, 'discount amount'),
    };
  }
  throw new Error('Promotion type is invalid.');
}

function canonicalProductIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) throw new Error('Promotion product IDs must be an array.');
  const ids = value.map((productId) => canonicalText(productId, 'product ID')).sort(compareText);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate promotion product ID.');
  return ids;
}

function canonicalResultPromotion(promotion: PromotionAdminPromotionResult) {
  const definition = canonicalDefinition(promotion);
  return {
    promotionId: canonicalText(promotion.promotionId, 'promotion ID'),
    ...definition,
    schemaVersion: promotion.schemaVersion,
    productIds: canonicalProductIds(promotion.productIds),
    promotionVersionBefore: promotion.promotionVersionBefore,
    promotionVersionAfter: promotion.promotionVersionAfter,
  };
}

function canonicalText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`A ${label} is required.`);
  return value.trim();
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`The ${label} must be a string.`);
  return value;
}

function isoString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`A ${label} is required.`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`The ${label} must be a timestamp.`);
  return timestamp.toISOString();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`The ${label} must be a nonnegative safe integer.`);
  }
  return value as number;
}

function int32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < -2147483648 || (value as number) > 2147483647) {
    throw new Error(`The ${label} must be a 32-bit integer.`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`The ${label} must be a boolean.`);
  return value;
}

function comparePromotionId(
  left: { promotionId: string },
  right: { promotionId: string },
): number {
  return compareText(left.promotionId, right.promotionId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
