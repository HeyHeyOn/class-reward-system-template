import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROMOTION_ADMIN_BATCH_SIZE,
  MAX_PROMOTION_ADMIN_BATCH_LINK_COUNT,
  createDatabasePromotionCommands,
  createPromotionAdminLinkId,
  createPromotionAdminPayloadHash,
  createPromotionAdminResultHash,
} from './promotionCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

import { appendOperationAudit } from './operationAudit';
import type { TenantTransaction } from '@/server/db/transaction';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-30T01:00:00.000Z');

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const productId of ['P001', 'P002']) {
    await harness.database.query(
      `INSERT INTO products
        (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
         created_at, updated_at)
       VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
      [harness.tenantOneId, productId, NOW.toISOString()],
    );
  }
});

afterEach(async () => {
  await harness.close();
});

const commands = () => createDatabasePromotionCommands({
  tenantId: harness.tenantOneId,
  runTenantTransaction: harness.runTenantTransaction,
  now: () => NOW,
});

async function withOperationAuditTampering<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
  await harness.database.exec(`
    ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
    ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
  `);
  try {
    return await callback();
  } finally {
    await harness.database.exec(`
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;
    `);
  }
}

const createInput = () => ({
  operationId: 'promotion-create-operation',
  promotionId: 'PROMO-001',
  definition: {
    name: ' 하나 더 ',
    description: ' 설명 ',
    type: 'N_PLUS_ONE' as const,
    buyQuantity: 2,
    freeQuantity: 1,
    startsAt: '2026-08-30T00:00:00.000Z',
    endsAt: '2026-09-30T00:00:00.000Z',
    isActive: true,
    sortOrder: 3,
  },
  productIds: ['P002', ' P001 '],
});

const createBatchInput = () => ({
  operationId: 'promotion-create-batch-operation',
  promotions: [
    {
      promotionId: ' PROMO-002 ',
      definition: {
        name: ' 둘째 행사 ',
        description: ' 설명 ',
        type: 'PROMOTIONAL_PRICE' as const,
        promotionalUnitPrice: 80,
        startsAt: '2026-08-30T00:00:00.000Z',
        endsAt: '2026-09-30T00:00:00.000Z',
        isActive: true,
        sortOrder: 4,
      },
      productIds: ['P002'],
    },
    {
      promotionId: 'PROMO-001',
      definition: createInput().definition,
      productIds: ['P002', ' P001 '],
    },
  ],
});

const updateInput = () => ({
  operationId: 'promotion-update-operation',
  promotionId: 'PROMO-001',
  expectedPromotionVersion: 1,
  definition: {
    name: ' 할인 가격 ',
    description: ' 변경 설명 ',
    type: 'PROMOTIONAL_PRICE' as const,
    promotionalUnitPrice: 75,
    startsAt: '2026-08-31T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    isActive: false,
    sortOrder: 7,
  },
  productIds: [' P002 '],
});

const updateBatchInput = () => ({
  operationId: 'promotion-update-batch-operation',
  promotions: [
    {
      promotionId: ' PROMO-002 ',
      expectedPromotionVersion: 1,
      definition: {
        name: ' 고정 할인 ',
        description: ' 둘째 변경 ',
        type: 'FIXED_DISCOUNT' as const,
        discountAmount: 15,
        startsAt: '2026-08-31T00:00:00.000Z',
        endsAt: '2026-10-01T00:00:00.000Z',
        isActive: true,
        sortOrder: 8,
      },
      productIds: [],
    },
    {
      promotionId: 'PROMO-001',
      expectedPromotionVersion: 1,
      definition: updateInput().definition,
      productIds: [' P002 '],
    },
  ],
});

async function seedUpdateBatchTargets() {
  await commands().createBatch(createBatchInput());
}

const activateInput = () => ({
  operationId: 'promotion-activate-operation',
  promotionId: ' PROMO-001 ',
  expectedPromotionVersion: 1,
});

const deactivateInput = () => ({
  operationId: 'promotion-deactivate-operation',
  promotionId: ' PROMO-001 ',
  expectedPromotionVersion: 1,
});

const deleteInput = () => ({
  operationId: 'promotion-delete-operation',
  promotionId: ' PROMO-001 ',
  expectedPromotionVersion: 1,
});

const deleteBatchInput = () => ({
  operationId: 'promotion-delete-batch-operation',
  promotions: [
    { promotionId: ' PROMO-002 ', expectedPromotionVersion: 1 },
    { promotionId: 'PROMO-001', expectedPromotionVersion: 1 },
  ],
});

async function snapshot() {
  const [promotions, links, operations, audits] = await Promise.all([
    harness.database.query(
      `SELECT promotion_id, name, description, type, n_plus_one_buy_quantity::text,
              n_plus_one_free_quantity::text, promotional_price::text,
              percent_discount::text, fixed_discount::text, starts_at, ends_at,
              is_active, sort_order, schema_version, version::text,
              created_at, updated_at, deleted_at
       FROM promotions WHERE tenant_id=$1 ORDER BY promotion_id`,
      [harness.tenantOneId],
    ),
    harness.database.query(
      `SELECT promotion_product_id, promotion_id, product_id, schema_version
       FROM promotion_products WHERE tenant_id=$1 ORDER BY product_id`,
      [harness.tenantOneId],
    ),
    harness.database.query(
      `SELECT operation_id, operation_kind, payload_hash, status, result_snapshot
       FROM operations WHERE tenant_id=$1 ORDER BY operation_id`,
      [harness.tenantOneId],
    ),
    harness.database.query(
      `SELECT operation_id, event_type, entity_type, entity_id, redacted_details
       FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`,
      [harness.tenantOneId],
    ),
  ]);
  return { promotions: promotions.rows, links: links.rows, operations: operations.rows, audits: audits.rows };
}

describe('PostgreSQL promotion administration commands', () => {
  it('exports the bounded create batch API', async () => {
    expect(MAX_PROMOTION_ADMIN_BATCH_SIZE).toBe(100);
    await expect(commands().createBatch(createBatchInput())).resolves.toMatchObject({
      action: 'CREATE',
      promotions: [{ promotionId: 'PROMO-001' }, { promotionId: 'PROMO-002' }],
    });
  });

  it('rejects malformed create batches and invalid clocks before opening a transaction', async () => {
    let transactionCallCount = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: (tenantId, callback) => {
        transactionCallCount += 1;
        return harness.runTenantTransaction(tenantId, callback);
      },
      now: () => new Date(Number.NaN),
    });
    const valid = createBatchInput().promotions[0];
    const invalidInputs = [
      { operationId: 'empty', promotions: [] },
      { operationId: 'large', promotions: Array.from({ length: 101 }, (_, index) => ({
        ...valid, promotionId: `PROMO-${index}`,
      })) },
      { operationId: 'duplicate', promotions: [
        { ...valid, promotionId: ' DUPLICATE ' }, { ...valid, promotionId: 'DUPLICATE' },
      ] },
      { operationId: 'malformed', promotions: [valid, {
        ...valid,
        promotionId: 'PROMO-LATER',
        definition: { ...valid.definition, surprise: true },
      }] },
      { operationId: 'nested-operation', promotions: [{ ...valid, operationId: 'forbidden' }] },
    ];
    for (const input of invalidInputs) {
      await expect(batchCommands.createBatch(input as never)).rejects.toThrow();
    }
    await expect(batchCommands.createBatch({
      operationId: 'invalid-now', promotions: [valid],
    })).rejects.toThrow(/timestamp.*invalid/i);
    expect(transactionCallCount).toBe(0);
  });

  it('accepts exactly one hundred creates in one transaction', async () => {
    let transactionCallCount = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: (tenantId, callback) => {
        transactionCallCount += 1;
        return harness.runTenantTransaction(tenantId, callback);
      },
      now: () => NOW,
    });
    const definition = createBatchInput().promotions[0].definition;
    const result = await batchCommands.createBatch({
      operationId: 'promotion-create-batch-100',
      promotions: Array.from({ length: 100 }, (_, index) => ({
        promotionId: `BATCH-${String(index).padStart(3, '0')}`,
        definition,
        productIds: [],
      })),
    });
    expect(result.promotions).toHaveLength(100);
    expect(transactionCallCount).toBe(1);
    expect((await snapshot()).operations).toHaveLength(1);
    expect((await snapshot()).audits).toHaveLength(1);
  });

  it('rejects more than one thousand canonical create batch links before opening a transaction', async () => {
    let transactionCallCount = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => {
        transactionCallCount += 1;
        throw new Error('transaction sentinel');
      },
      now: () => NOW,
    });
    const definition = createBatchInput().promotions[0].definition;
    const promotions = Array.from({ length: 100 }, (_, promotionIndex) => ({
      promotionId: `BATCH-${String(promotionIndex).padStart(3, '0')}`,
      definition,
      productIds: Array.from(
        { length: promotionIndex === 0 ? 11 : 10 },
        (_, productIndex) => ` P-${promotionIndex}-${productIndex} `,
      ),
    }));

    expect(MAX_PROMOTION_ADMIN_BATCH_LINK_COUNT).toBe(1000);
    await expect(batchCommands.createBatch({
      operationId: 'promotion-create-batch-1001-links', promotions,
    })).rejects.toThrow(/link count.*1000/i);
    expect(transactionCallCount).toBe(0);
  });

  it('accepts exactly one thousand canonical create batch links far enough to open a transaction', async () => {
    const transactionSentinel = new Error('transaction sentinel');
    let transactionCallCount = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => {
        transactionCallCount += 1;
        throw transactionSentinel;
      },
      now: () => NOW,
    });
    const definition = createBatchInput().promotions[0].definition;
    const promotions = Array.from({ length: 100 }, (_, promotionIndex) => ({
      promotionId: `BATCH-${String(promotionIndex).padStart(3, '0')}`,
      definition,
      productIds: Array.from(
        { length: 10 },
        (_, productIndex) => ` P-${promotionIndex}-${productIndex} `,
      ),
    }));

    await expect(batchCommands.createBatch({
      operationId: 'promotion-create-batch-1000-links', promotions,
    })).rejects.toBe(transactionSentinel);
    expect(transactionCallCount).toBe(1);
  });

  it('atomically creates an ordered batch with one timestamp, exact links, operation, and audit', async () => {
    const input = createBatchInput();
    const result = await commands().createBatch(input);
    expect(result.promotions.map((promotion) => promotion.promotionId)).toEqual(['PROMO-001', 'PROMO-002']);
    expect(result.completedAt).toBe(NOW.toISOString());
    expect(result.promotions).toEqual([
      expect.objectContaining({
        promotionId: 'PROMO-001', productIds: ['P001', 'P002'], schemaVersion: 3,
        promotionVersionBefore: null, promotionVersionAfter: 1,
      }),
      expect.objectContaining({
        promotionId: 'PROMO-002', productIds: ['P002'], schemaVersion: 3,
        promotionVersionBefore: null, promotionVersionAfter: 1,
      }),
    ]);
    const state = await snapshot();
    expect(state.promotions).toHaveLength(2);
    expect(state.promotions.every((value) => {
      const row = value as Record<string, unknown>;
      return row.created_at instanceof Date
        && row.created_at.getTime() === NOW.getTime()
        && row.updated_at instanceof Date && row.updated_at.getTime() === NOW.getTime()
        && row.version === '1' && row.schema_version === 3;
    })).toBe(true);
    expect(state.links).toEqual([
      { promotion_product_id: createPromotionAdminLinkId(input.operationId, 'PROMO-001', 'P001'), promotion_id: 'PROMO-001', product_id: 'P001', schema_version: 3 },
      { promotion_product_id: createPromotionAdminLinkId(input.operationId, 'PROMO-001', 'P002'), promotion_id: 'PROMO-001', product_id: 'P002', schema_version: 3 },
      { promotion_product_id: createPromotionAdminLinkId(input.operationId, 'PROMO-002', 'P002'), promotion_id: 'PROMO-002', product_id: 'P002', schema_version: 3 },
    ]);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toEqual([expect.objectContaining({
      redacted_details: expect.objectContaining({ changedPromotionCount: 2, targetProductCount: 3 }),
    })]);
  });

  it.each([
    ['missing later product', async () => ({
      ...createBatchInput(), promotions: [createBatchInput().promotions[0], {
        ...createBatchInput().promotions[1], productIds: ['P404'],
      }],
    })],
    ['deleted later product', async () => {
      await harness.database.query(
        'UPDATE products SET deleted_at=$3, is_active=false WHERE tenant_id=$1 AND product_id=$2',
        [harness.tenantOneId, 'P001', NOW.toISOString()],
      );
      return createBatchInput();
    }],
    ['existing later promotion', async () => {
      await commands().create({
        ...createInput(),
        operationId: 'promotion-create-existing-batch-target',
        promotionId: 'PROMO-002',
      });
      return createBatchInput();
    }],
  ] as const)('rolls back the complete batch for a %s', async (_label, prepare) => {
    const before = await snapshot();
    const input = await prepare();
    const prepared = await snapshot();
    await expect(commands().createBatch(input)).rejects.toThrow(/not found|duplicate|unique|integrity|failed query/i);
    expect(await snapshot()).toEqual(prepared);
    if (_label === 'missing later product') expect(prepared).toEqual(before);
  });

  it.each([
    ['later promotion', 'promotions', "NEW.promotion_id='PROMO-002'"],
    ['later link', 'promotion_products', "NEW.promotion_id='PROMO-002'"],
  ] as const)('rolls back the complete batch when the %s insert is suppressed', async (_label, table, condition) => {
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_promotion_batch_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_required_promotion_batch_insert BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_promotion_batch_insert();
    `);
    await expect(commands().createBatch(createBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ promotions: [], links: [], operations: [], audits: [] });
  });

  it('rolls back when a later promotion trigger mutates an earlier created promotion', async () => {
    await harness.database.exec(`
      CREATE FUNCTION mutate_earlier_promotion_after_later_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.promotion_id = 'PROMO-002' THEN
          UPDATE promotions SET name = 'trigger-mutated'
          WHERE tenant_id = NEW.tenant_id AND promotion_id = 'PROMO-001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mutate_earlier_promotion_after_later_insert
      AFTER INSERT ON promotions
      FOR EACH ROW EXECUTE FUNCTION mutate_earlier_promotion_after_later_insert();
    `);

    await expect(commands().createBatch(createBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ promotions: [], links: [], operations: [], audits: [] });
  });

  it('rolls back when the batch audit insert mutates a completely verified promotion', async () => {
    await harness.database.exec(`
      CREATE FUNCTION mutate_batch_promotion_after_audit_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id = 'promotion-create-batch-operation' THEN
          UPDATE promotions SET schema_version = 2
          WHERE tenant_id = NEW.tenant_id AND promotion_id = 'PROMO-001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mutate_batch_promotion_after_audit_insert
      AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION mutate_batch_promotion_after_audit_insert();
    `);

    await expect(commands().createBatch(createBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ promotions: [], links: [], operations: [], audits: [] });
  });

  it('rolls back when the terminal operation update deletes a completely verified link', async () => {
    await harness.database.exec(`
      CREATE FUNCTION delete_batch_link_after_operation_success() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id = 'promotion-create-batch-operation' AND NEW.status = 'SUCCEEDED' THEN
          DELETE FROM promotion_products
          WHERE tenant_id = NEW.tenant_id AND promotion_id = 'PROMO-001' AND product_id = 'P001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delete_batch_link_after_operation_success
      AFTER UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION delete_batch_link_after_operation_success();
    `);

    await expect(commands().createBatch(createBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ promotions: [], links: [], operations: [], audits: [] });
  });

  it('rejects duplicate physical rows returned by the batch product-union lock', async () => {
    const malformedCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        const malformedTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            const result = await tx.execute(query);
            if (result.rows.length > 0 && result.rows.every((row) => (
              Object.keys(row as object).length === 1 && 'product_id' in (row as object)
            ))) {
              return { ...result, rows: [...result.rows, result.rows[0]] } as never;
            }
            return result;
          },
        } as unknown as typeof tx;
        return callback(malformedTx);
      }),
    });

    await expect(malformedCommands.createBatch(createBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ promotions: [], links: [], operations: [], audits: [] });
  });

  it('rejects duplicate physical promotion identity rows during batch replay', async () => {
    const input = createBatchInput();
    await commands().createBatch(input);
    const before = await snapshot();
    const malformedCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        const malformedTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            const result = await tx.execute(query);
            if (result.rows.length > 0 && result.rows.every((row) => (
              Object.keys(row as object).length === 1 && 'promotion_id' in (row as object)
            ))) {
              return { ...result, rows: [...result.rows, result.rows[0]] } as never;
            }
            return result;
          },
        } as unknown as typeof tx;
        return callback(malformedTx);
      }),
    });

    await expect(malformedCommands.createBatch(input)).rejects.toThrow(/identity integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('validates a batch product union independent of database collation', async () => {
    const javascriptFirst = 'P\u{10000}';
    const databaseFirst = 'P\uE000';
    for (const productId of [javascriptFirst, databaseFirst]) {
      await harness.database.query(
        `INSERT INTO products
          (tenant_id, product_id, name, price, stock, is_active, sort_order, version, created_at, updated_at)
         VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
        [harness.tenantOneId, productId, NOW.toISOString()],
      );
    }
    const input = createBatchInput();
    input.promotions[0].productIds = [databaseFirst] as never;
    input.promotions[1].productIds = [javascriptFirst] as never;
    await expect(commands().createBatch(input)).resolves.toMatchObject({
      promotions: [
        { promotionId: 'PROMO-001', productIds: [javascriptFirst] },
        { promotionId: 'PROMO-002', productIds: [databaseFirst] },
      ],
    });
  });

  it('replays a reversed create batch exactly and rejects a changed item', async () => {
    const input = createBatchInput();
    const first = await commands().createBatch(input);
    await expect(commands().createBatch({
      ...input, promotions: [...input.promotions].reverse(),
    })).resolves.toEqual(first);
    await expect(commands().createBatch({
      ...input,
      promotions: [input.promotions[0], {
        ...input.promotions[1], definition: { ...input.promotions[1].definition, name: 'changed' },
      }],
    })).rejects.toThrow(/conflict/i);
    expect((await snapshot()).operations).toHaveLength(1);
    expect((await snapshot()).audits).toHaveLength(1);
  });

  it('re-reads a winning batch operation after an insert race', async () => {
    const input = createBatchInput();
    const first = await commands().createBatch(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.createBatch({
      ...input, promotions: [...input.promotions].reverse(),
    })).resolves.toEqual(first);
  });

  it('replays frozen batch evidence after mutation and tombstone but rejects a hard-missing identity', async () => {
    const input = createBatchInput();
    const first = await commands().createBatch(input);
    await harness.database.query(
      `UPDATE promotions SET name='later', version=2, deleted_at=$3, updated_at=$3
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', '2026-08-30T02:00:00.000Z'],
    );
    await expect(commands().createBatch(input)).resolves.toEqual(first);
    await harness.database.query(
      'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await harness.database.query(
      'DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await expect(commands().createBatch(input)).rejects.toThrow(/identity integrity/i);
  });

  it('fails closed on reordered stored batch results', async () => {
    const input = createBatchInput();
    await commands().createBatch(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions}',
          jsonb_build_array(result_snapshot->'promotions'->1, result_snapshot->'promotions'->0))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().createBatch(input)).rejects.toThrow(/stored result integrity/i);
  });

  it.each([
    ['whitespace-padded promotion name',
      "jsonb_set(result_snapshot, '{promotions,0,name}', to_jsonb(concat(' ', result_snapshot #>> '{promotions,0,name}', ' ')))"],
    ['equivalent noncanonical startsAt timestamp',
      "jsonb_set(result_snapshot, '{promotions,0,startsAt}', to_jsonb('2026-08-30T09:00:00+09:00'::text))"],
  ] as const)('rejects a stored create batch result with a %s', async (_label, tamperedResult) => {
    const input = createBatchInput();
    await commands().createBatch(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=${tamperedResult}
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });

    await expect(commands().createBatch(input)).rejects.toThrow(/stored result integrity/i);
  });

  it('rejects a stored singleton create result with a whitespace-padded product ID', async () => {
    const input = createInput();
    await commands().create(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(
           result_snapshot, '{promotions,0,productIds,0}',
           to_jsonb(concat(' ', result_snapshot #>> '{promotions,0,productIds,0}', ' '))
         ) WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });

    await expect(commands().create(input)).rejects.toThrow(/stored result integrity/i);
  });

  it('atomically creates promotion metadata, canonical target links, one operation, and one audit', async () => {
    const input = createInput();
    const result = await commands().create(input);
    const productIds = ['P001', 'P002'];
    expect(result).toEqual({
      ok: true,
      operationId: input.operationId,
      action: 'CREATE',
      completedAt: NOW.toISOString(),
      promotions: [{
        promotionId: 'PROMO-001',
        name: '하나 더',
        description: '설명',
        type: 'N_PLUS_ONE',
        buyQuantity: 2,
        freeQuantity: 1,
        startsAt: '2026-08-30T00:00:00.000Z',
        endsAt: '2026-09-30T00:00:00.000Z',
        isActive: true,
        sortOrder: 3,
        schemaVersion: 3,
        productIds,
        promotionVersionBefore: null,
        promotionVersionAfter: 1,
      }],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([expect.objectContaining({
      promotion_id: 'PROMO-001', name: '하나 더', description: '설명', type: 'N_PLUS_ONE',
      n_plus_one_buy_quantity: '2', n_plus_one_free_quantity: '1', schema_version: 3,
      version: '1', deleted_at: null,
    })]);
    expect(state.links).toEqual(productIds.map((productId) => ({
      promotion_product_id: createPromotionAdminLinkId(input.operationId, 'PROMO-001', productId),
      promotion_id: 'PROMO-001', product_id: productId, schema_version: 3,
    })));
    const payloadHash = createPromotionAdminPayloadHash({
      action: 'CREATE', promotions: [{
        promotionId: 'PROMO-001', definition: result.promotions[0], productIds,
      }],
    });
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: input.operationId, operation_kind: 'PROMOTION_ADMIN', payload_hash: payloadHash,
      status: 'SUCCEEDED', result_snapshot: result,
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: input.operationId,
      event_type: 'PROMOTION_ADMIN_COMPLETED', entity_type: 'OPERATION', entity_id: input.operationId,
      redacted_details: {
        action: 'CREATE', changedPromotionCount: 1, targetProductCount: 2,
        resultHash: createPromotionAdminResultHash(result),
      },
    })]);
  });

  it('re-reads the winning operation when the initial lookup misses an insert race', async () => {
    const input = createInput();
    const first = await commands().create(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.create(input)).resolves.toEqual(first);
    const state = await snapshot();
    expect(state.promotions).toHaveLength(1);
    expect(state.links).toHaveLength(2);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('rejects a conflicting payload after losing the operation insert race', async () => {
    const input = createInput();
    await commands().create(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.create({
      ...input,
      definition: { ...input.definition, name: '경쟁 변경' },
    })).rejects.toThrow(/conflict/i);
  });

  it('returns the exact stored create result on retry without duplicating metadata or links', async () => {
    const input = createInput();
    const first = await commands().create(input);
    const second = await commands().create({
      ...input,
      productIds: ['P001', 'P002'],
    });
    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.promotions).toHaveLength(1);
    expect(state.links).toHaveLength(2);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('replays historical create evidence after legitimate metadata and link replacement', async () => {
    const input = createInput();
    const first = await commands().create(input);
    await harness.database.query(
      `UPDATE promotions SET name='나중 이름', version=2, updated_at='2026-08-30T02:00:00Z'
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, input.promotionId],
    );
    await harness.database.query(
      'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2 AND product_id=$3',
      [harness.tenantOneId, input.promotionId, 'P002'],
    );
    await expect(commands().create(input)).resolves.toEqual(first);
  });

  it('rejects mixed promotion variant fields instead of silently discarding them', async () => {
    const input = createInput();
    await expect(commands().create({
      ...input,
      definition: {
        ...input.definition,
        promotionalUnitPrice: 50,
      } as unknown as ReturnType<typeof createInput>['definition'],
    })).rejects.toThrow(/definition fields/i);
    expect((await snapshot()).promotions).toEqual([]);
  });

  it('rejects operation reuse with a different promotion payload', async () => {
    const input = createInput();
    await commands().create(input);
    await expect(commands().create({
      ...input,
      definition: { ...input.definition, name: '다른 행사' },
    })).rejects.toThrow(/conflict/i);
  });

  it.each([
    ['promotion', 'promotions', "NEW.promotion_id='PROMO-001'"],
    ['link', 'promotion_products', "NEW.product_id='P002'"],
    ['audit', 'audit_events', "NEW.operation_id='promotion-create-operation'"],
  ] as const)('rolls back when the required %s insert is suppressed', async (target, table, condition) => {
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_promotion_create_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_promotion_create_insert
      BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_promotion_create_insert();
    `);
    const input = target === 'promotion'
      ? { ...createInput(), productIds: [] }
      : createInput();
    await expect(commands().create(input)).rejects.toThrow(/integrity/i);
    const state = await snapshot();
    expect(state.promotions).toEqual([]);
    expect(state.links).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('fails closed when nullable stored operation timestamps mimic valid chronology', async () => {
    const input = createInput();
    await commands().create(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET started_at=NULL, created_at='1970-01-01T00:00:00.000Z'
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().create(input)).rejects.toThrow(/timestamp integrity/i);
  });

  it('fails closed on malformed stored results and extra promotion audit rows', async () => {
    const input = createInput();
    await commands().create(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,promotionVersionAfter}', '2'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().create(input)).rejects.toThrow(/stored result integrity/i);
  });

  it('fails closed when an extra audit is attached to the create operation', async () => {
    const input = createInput();
    await commands().create(input);
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId,
        eventType: 'PROMOTION_ADMIN_EXTRA',
        entityType: 'OPERATION',
        entityId: input.operationId,
        occurredAt: NOW,
        redactedDetails: { action: 'CREATE' },
      });
    });
    await expect(commands().create(input)).rejects.toThrow(/audit integrity/i);
  });

  it('rolls back creation when the terminal update returns the old pending row', async () => {
    await harness.database.exec(`
      CREATE FUNCTION preserve_pending_promotion_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-create-old-terminal' AND NEW.status='SUCCEEDED' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER preserve_pending_promotion_terminal
      BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION preserve_pending_promotion_terminal();
    `);
    await expect(commands().create({
      ...createInput(), operationId: 'promotion-create-old-terminal', promotionId: 'PROMO-OLD-TERMINAL',
    })).rejects.toThrow(/not replayable|operation integrity/i);
    const state = await snapshot();
    expect(state.promotions).toEqual([]);
    expect(state.links).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('rolls back creation for missing target products or a suppressed terminal transition', async () => {
    const missing = { ...createInput(), operationId: 'promotion-create-missing', productIds: ['P404'] };
    await expect(commands().create(missing)).rejects.toThrow(/target product not found/i);
    let state = await snapshot();
    expect(state.promotions).toEqual([]);
    expect(state.operations).toEqual([]);

    await harness.database.exec(`
      CREATE FUNCTION suppress_promotion_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-create-terminal' AND NEW.status='SUCCEEDED' THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_promotion_terminal
      BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_promotion_terminal();
    `);
    await expect(commands().create({
      ...createInput(), operationId: 'promotion-create-terminal', promotionId: 'PROMO-TERMINAL',
    })).rejects.toThrow(/terminal operation integrity/i);
    state = await snapshot();
    expect(state.promotions).toEqual([]);
    expect(state.links).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('exports updateBatch and atomically updates canonical targets with one operation and audit', async () => {
    await seedUpdateBatchTargets();
    const input = updateBatchInput();
    const result = await commands().updateBatch(input);
    expect(result).toEqual({
      ok: true,
      operationId: input.operationId,
      action: 'UPDATE',
      completedAt: NOW.toISOString(),
      promotions: [
        expect.objectContaining({
          promotionId: 'PROMO-001', type: 'PROMOTIONAL_PRICE', productIds: ['P002'],
          promotionVersionBefore: 1, promotionVersionAfter: 2,
        }),
        expect.objectContaining({
          promotionId: 'PROMO-002', type: 'FIXED_DISCOUNT', productIds: [],
          promotionVersionBefore: 1, promotionVersionAfter: 2,
        }),
      ],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([
      expect.objectContaining({ promotion_id: 'PROMO-001', type: 'PROMOTIONAL_PRICE', version: '2' }),
      expect.objectContaining({ promotion_id: 'PROMO-002', type: 'FIXED_DISCOUNT', version: '2' }),
    ]);
    expect(state.links).toEqual([{
      promotion_product_id: createPromotionAdminLinkId(input.operationId, 'PROMO-001', 'P002'),
      promotion_id: 'PROMO-001', product_id: 'P002', schema_version: 3,
    }]);
    expect(state.operations).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
    expect(state.audits[1]).toEqual(expect.objectContaining({
      redacted_details: expect.objectContaining({ changedPromotionCount: 2, targetProductCount: 1 }),
    }));
  });

  it('rejects malformed and over-limit update batches before transaction entry', async () => {
    let calls = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => NOW,
    });
    const valid = updateBatchInput().promotions[0];
    const invalid = [
      { operationId: 'empty', promotions: [] },
      { operationId: 'large', promotions: Array.from({ length: 101 }, (_, index) => ({
        ...valid, promotionId: `PROMO-${index}`,
      })) },
      { operationId: 'duplicate', promotions: [
        { ...valid, promotionId: ' SAME ' }, { ...valid, promotionId: 'SAME' },
      ] },
      { operationId: 'nested', promotions: [{ ...valid, operationId: 'forbidden' }] },
      { operationId: 'later-malformed', promotions: [valid, { ...valid, promotionId: 'LATER', extra: true }] },
      { operationId: 'overflow', promotions: [{ ...valid, expectedPromotionVersion: Number.MAX_SAFE_INTEGER }] },
    ];
    for (const value of invalid) await expect(batchCommands.updateBatch(value as never)).rejects.toThrow();
    const products = Array.from({ length: 1001 }, (_, index) => `P-${index}`);
    await expect(batchCommands.updateBatch({
      operationId: 'links', promotions: [{ ...valid, productIds: products }],
    })).rejects.toThrow(/link count.*1000/i);
    const invalidClockCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClockCommands.updateBatch({
      operationId: 'invalid-now', promotions: [valid],
    })).rejects.toThrow(/timestamp.*invalid/i);
    expect(calls).toBe(0);

    const transactionSentinel = new Error('sentinel');
    const boundaryCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw transactionSentinel; },
      now: () => NOW,
    });
    await expect(boundaryCommands.updateBatch({
      operationId: 'size-100', promotions: Array.from({ length: 100 }, (_, index) => ({
        ...valid, promotionId: `B-${index}`, productIds: [],
      })),
    })).rejects.toBe(transactionSentinel);
    await expect(boundaryCommands.updateBatch({
      operationId: 'links-1000', promotions: [{ ...valid, productIds: products.slice(0, 1000) }],
    })).rejects.toBe(transactionSentinel);
    expect(calls).toBe(2);
  });

  it('rolls back the whole update batch for a stale later target or malformed chronology', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    const stale = updateBatchInput();
    stale.promotions[0].expectedPromotionVersion = 2;
    await expect(commands().updateBatch(stale)).rejects.toThrow(/stale|version/i);
    expect(await snapshot()).toEqual(before);

    await harness.database.query(
      'UPDATE promotions SET updated_at=$3 WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002', '2026-08-30T02:00:00.000Z'],
    );
    const malformed = await snapshot();
    await expect(commands().updateBatch(updateBatchInput())).rejects.toThrow(/chronology|timestamp/i);
    expect(await snapshot()).toEqual(malformed);
  });

  it('replays a reversed update batch exactly and conflicts on changed payload', async () => {
    await seedUpdateBatchTargets();
    const input = updateBatchInput();
    const first = await commands().updateBatch(input);
    await expect(commands().updateBatch({ ...input, promotions: [...input.promotions].reverse() }))
      .resolves.toEqual(first);
    await expect(commands().updateBatch({
      ...input,
      promotions: [input.promotions[0], {
        ...input.promotions[1], definition: { ...input.promotions[1].definition, name: 'changed' },
      }],
    })).rejects.toThrow(/conflict/i);
  });

  it('re-reads a winning updateBatch operation after an insert race', async () => {
    await seedUpdateBatchTargets();
    const input = updateBatchInput();
    const first = await commands().updateBatch(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.updateBatch({
      ...input, promotions: [...input.promotions].reverse(),
    })).resolves.toEqual(first);
  });

  it('replays frozen update-batch evidence after mutation but rejects a hard-missing identity', async () => {
    await seedUpdateBatchTargets();
    const input = updateBatchInput();
    const first = await commands().updateBatch(input);
    await harness.database.query(
      `UPDATE promotions SET name='later', version=3, deleted_at=$3, updated_at=$3
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', '2026-08-30T02:00:00.000Z'],
    );
    await expect(commands().updateBatch(input)).resolves.toEqual(first);
    await harness.database.query(
      'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await harness.database.query(
      'DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await expect(commands().updateBatch(input)).rejects.toThrow(/identity integrity/i);
  });

  it('rolls back updateBatch when a later metadata write is suppressed', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_later_promotion_batch_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.promotion_id='PROMO-002' THEN RETURN OLD; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_later_promotion_batch_update BEFORE UPDATE ON promotions
      FOR EACH ROW EXECUTE FUNCTION suppress_later_promotion_batch_update();
    `);
    await expect(commands().updateBatch(updateBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['metadata update', 'promotions', "OLD.promotion_id='PROMO-002'", 'RETURN OLD'],
    ['old link delete', 'promotion_products', "OLD.promotion_id='PROMO-002'", 'RETURN NULL'],
    ['new link insert', 'promotion_products', "NEW.promotion_id='PROMO-001'", 'RETURN NULL'],
    ['audit insert', 'audit_events', "NEW.operation_id='promotion-update-batch-operation'", 'RETURN NULL'],
    ['terminal update', 'operations', "NEW.operation_id='promotion-update-batch-operation' AND NEW.status='SUCCEEDED'", 'RETURN NULL'],
  ] as const)('rolls back updateBatch when required %s evidence is suppressed', async (
    _label, table, condition, triggerResult,
  ) => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_update_batch_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN ${triggerResult}; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_update_batch_write
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_update_batch_write();
    `);
    await expect(commands().updateBatch(updateBatchInput())).rejects.toThrow(/integrity|replayable/i);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back updateBatch when a later update mutates an earlier target', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION mutate_earlier_after_later_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.promotion_id='PROMO-002' THEN
          UPDATE promotions SET name='trigger-mutated'
          WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER mutate_earlier_after_later_update AFTER UPDATE ON promotions
      FOR EACH ROW EXECUTE FUNCTION mutate_earlier_after_later_update();
    `);
    await expect(commands().updateBatch(updateBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['audit', `CREATE FUNCTION mutate_update_batch_after_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-update-batch-operation' THEN
          UPDATE promotions SET schema_version=2
          WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER mutate_update_batch_after_audit AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION mutate_update_batch_after_audit();`],
    ['terminal', `CREATE FUNCTION mutate_update_batch_after_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-update-batch-operation' AND NEW.status='SUCCEEDED' THEN
          DELETE FROM promotion_products
          WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER mutate_update_batch_after_terminal AFTER UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION mutate_update_batch_after_terminal();`],
  ] as const)('rolls back updateBatch when the %s write mutates verified state', async (_label, ddl) => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(ddl);
    await expect(commands().updateBatch(updateBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('fails closed on reordered stored updateBatch results and extra audits', async () => {
    await seedUpdateBatchTargets();
    const input = updateBatchInput();
    await commands().updateBatch(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions}',
          jsonb_build_array(result_snapshot->'promotions'->1, result_snapshot->'promotions'->0))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().updateBatch(input)).rejects.toThrow(/stored result integrity/i);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions}',
          jsonb_build_array(result_snapshot->'promotions'->1, result_snapshot->'promotions'->0))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId, eventType: 'PROMOTION_ADMIN_EXTRA',
        entityType: 'OPERATION', entityId: input.operationId, occurredAt: NOW,
        redactedDetails: { action: 'UPDATE' },
      });
    });
    await expect(commands().updateBatch(input)).rejects.toThrow(/audit integrity/i);
  });

  it('accepts target sets whose database collation differs from JavaScript order', async () => {
    const javascriptFirst = 'PROMO-\u{10000}';
    const databaseFirst = 'PROMO-\uE000';
    await commands().createBatch({
      operationId: 'collation-create',
      promotions: [
        { ...createBatchInput().promotions[0], promotionId: javascriptFirst, productIds: ['P001'] },
        { ...createBatchInput().promotions[1], promotionId: databaseFirst, productIds: ['P002'] },
      ],
    });
    const base = updateBatchInput().promotions;
    await expect(commands().updateBatch({
      operationId: 'collation-update',
      promotions: [
        { ...base[0], promotionId: databaseFirst, productIds: ['P001'] },
        { ...base[1], promotionId: javascriptFirst, productIds: ['P002'] },
      ],
    })).resolves.toMatchObject({
      promotions: [{ promotionId: javascriptFirst }, { promotionId: databaseFirst }],
    });
  });

  it('accepts target and final-link rows in database collation order', async () => {
    await commands().create(createInput());
    const javascriptFirst = 'P\u{10000}';
    const databaseFirst = 'P\uE000';
    for (const productId of [javascriptFirst, databaseFirst]) {
      await harness.database.query(
        `INSERT INTO products
          (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
           created_at, updated_at)
         VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
        [harness.tenantOneId, productId, NOW.toISOString()],
      );
    }
    const databaseOrder = await harness.database.query(
      'SELECT product_id FROM products WHERE tenant_id=$1 AND product_id IN ($2, $3) ORDER BY product_id',
      [harness.tenantOneId, javascriptFirst, databaseFirst],
    );
    expect([javascriptFirst, databaseFirst].sort()).toEqual([javascriptFirst, databaseFirst]);
    expect(databaseOrder.rows.map(
      (row) => (row as { product_id?: unknown }).product_id,
    )).toEqual([databaseFirst, javascriptFirst]);

    const input = { ...updateInput(), productIds: [databaseFirst, javascriptFirst] };
    await expect(commands().update(input)).resolves.toMatchObject({
      promotions: [{ productIds: [javascriptFirst, databaseFirst] }],
    });
    const stored = await harness.database.query(
      'SELECT result_snapshot FROM operations WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, input.operationId],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      result_snapshot: expect.objectContaining({
        promotions: [expect.objectContaining({ productIds: [javascriptFirst, databaseFirst] })],
      }),
    })]);
  });

  it('atomically updates metadata, nulls old variant columns, and replaces targets', async () => {
    await commands().create(createInput());
    const input = updateInput();
    const result = await commands().update(input);
    expect(result).toEqual({
      ok: true, operationId: input.operationId, action: 'UPDATE', completedAt: NOW.toISOString(),
      promotions: [{
        promotionId: input.promotionId, name: '할인 가격', description: '변경 설명',
        type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 75,
        startsAt: '2026-08-31T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z',
        isActive: false, sortOrder: 7, schemaVersion: 3, productIds: ['P002'],
        promotionVersionBefore: 1, promotionVersionAfter: 2,
      }],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([expect.objectContaining({
      promotion_id: input.promotionId, name: '할인 가격', description: '변경 설명',
      type: 'PROMOTIONAL_PRICE', n_plus_one_buy_quantity: null, n_plus_one_free_quantity: null,
      promotional_price: '75', percent_discount: null, fixed_discount: null,
      schema_version: 3, version: '2', deleted_at: null,
    })]);
    expect(state.links).toEqual([{
      promotion_product_id: createPromotionAdminLinkId(input.operationId, input.promotionId, 'P002'),
      promotion_id: input.promotionId, product_id: 'P002', schema_version: 3,
    }]);
    expect(state.operations).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
  });

  it('accepts PostgreSQL decimal text for an exponential percent discount update', async () => {
    await commands().create(createInput());
    const input = {
      ...updateInput(),
      definition: {
        name: updateInput().definition.name,
        description: updateInput().definition.description,
        type: 'PERCENT_DISCOUNT' as const,
        percent: 1e-7,
        startsAt: updateInput().definition.startsAt,
        endsAt: updateInput().definition.endsAt,
        isActive: updateInput().definition.isActive,
        sortOrder: updateInput().definition.sortOrder,
      },
    };

    await expect(commands().update(input)).resolves.toMatchObject({
      promotions: [{ type: 'PERCENT_DISCOUNT', percent: 1e-7 }],
    });
    expect((await snapshot()).promotions).toEqual([expect.objectContaining({
      type: 'PERCENT_DISCOUNT', promotional_price: null, percent_discount: '0.0000001',
    })]);
  });

  it('rolls back stale-version and missing or deleted target updates', async () => {
    await commands().create(createInput());
    const before = await snapshot();
    await expect(commands().update({ ...updateInput(), expectedPromotionVersion: 2 }))
      .rejects.toThrow(/stale|version/i);
    await expect(commands().update({ ...updateInput(), operationId: 'update-missing', productIds: ['P404'] }))
      .rejects.toThrow(/target product not found/i);
    await harness.database.query(
      'UPDATE products SET deleted_at=$3, is_active=false WHERE tenant_id=$1 AND product_id=$2',
      [harness.tenantOneId, 'P002', NOW.toISOString()],
    );
    await expect(commands().update({ ...updateInput(), operationId: 'update-deleted' }))
      .rejects.toThrow(/target product not found/i);
    await harness.database.query(
      'UPDATE products SET deleted_at=NULL, is_active=true WHERE tenant_id=$1 AND product_id=$2',
      [harness.tenantOneId, 'P002'],
    );
    expect(await snapshot()).toEqual(before);
  });

  it('replays historical update after later state changes and rejects payload conflicts', async () => {
    await commands().create(createInput());
    const input = updateInput();
    const first = await commands().update(input);
    await harness.database.query(
      `UPDATE promotions
       SET name='나중 이름', version=3, is_active=false, deleted_at='2026-08-30T02:00:00Z',
           updated_at='2026-08-30T02:00:00Z'
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, input.promotionId],
    );
    await harness.database.query(
      'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, input.promotionId],
    );
    await expect(commands().update(input)).resolves.toEqual(first);
    await expect(commands().update({ ...input, definition: { ...input.definition, name: '충돌' } }))
      .rejects.toThrow(/conflict/i);
  });

  it.each([
    ['metadata update', 'promotions', "OLD.promotion_id='PROMO-001'", 'RETURN OLD'],
    ['old-link delete', 'promotion_products', "OLD.product_id='P001'", 'RETURN NULL'],
    ['new-link insert', 'promotion_products', "NEW.product_id='P002'", 'RETURN NULL'],
    ['audit insert', 'audit_events', "NEW.operation_id='promotion-update-operation'", 'RETURN NULL'],
    ['terminal update', 'operations', "NEW.operation_id='promotion-update-operation' AND NEW.status='SUCCEEDED'", 'RETURN NULL'],
  ] as const)('rolls back update when the required %s write is suppressed', async (_target, table, condition, triggerResult) => {
    await commands().create(createInput());
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_promotion_update_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN ${triggerResult}; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_promotion_update_write
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_promotion_update_write();
    `);
    await expect(commands().update(updateInput())).rejects.toThrow(/integrity|not replayable/i);
    expect(await snapshot()).toEqual(before);
  });

  it('re-reads the winning update operation when the initial lookup misses an insert race', async () => {
    await commands().create(createInput());
    const input = updateInput();
    const first = await commands().update(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.update(input)).resolves.toEqual(first);
  });

  it('fails closed on malformed stored update results and extra update audits', async () => {
    await commands().create(createInput());
    const input = updateInput();
    await commands().update(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,promotionVersionAfter}', '99'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().update(input)).rejects.toThrow(/stored result integrity/i);

    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,promotionVersionAfter}', '2'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId,
        eventType: 'PROMOTION_ADMIN_EXTRA',
        entityType: 'OPERATION',
        entityId: input.operationId,
        occurredAt: NOW,
        redactedDetails: { action: 'UPDATE' },
      });
    });
    await expect(commands().update(input)).rejects.toThrow(/audit integrity/i);
  });

  it('accepts an empty replacement target set and rejects a non-finite clock before transaction', async () => {
    await commands().create(createInput());
    await expect(commands().update({ ...updateInput(), productIds: [] })).resolves.toMatchObject({
      action: 'UPDATE', promotions: [{ productIds: [] }],
    });
    expect((await snapshot()).links).toEqual([]);

    let transactionCallCount = 0;
    const runTenantTransaction = <TResult>(
      tenantId: string,
      callback: (transaction: TenantTransaction) => Promise<TResult>,
    ) => {
      transactionCallCount += 1;
      return harness.runTenantTransaction(tenantId, callback);
    };
    const invalidClockCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction,
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClockCommands.update({
      ...updateInput(), operationId: 'invalid-clock', expectedPromotionVersion: 2,
    })).rejects.toThrow(/timestamp.*invalid/i);
    expect(transactionCallCount).toBe(0);
  });

  it('activates a promotion while preserving its definition and exact target link identities', async () => {
    const created = await commands().create({
      ...createInput(),
      definition: { ...createInput().definition, isActive: false },
    });
    const linksBefore = (await snapshot()).links;
    const result = await commands().activate(activateInput());
    expect(result).toEqual({
      ...created,
      operationId: 'promotion-activate-operation',
      action: 'ACTIVATE',
      promotions: [{
        ...created.promotions[0],
        isActive: true,
        promotionVersionBefore: 1,
        promotionVersionAfter: 2,
      }],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([expect.objectContaining({
      promotion_id: 'PROMO-001', name: '하나 더', description: '설명', type: 'N_PLUS_ONE',
      n_plus_one_buy_quantity: '2', n_plus_one_free_quantity: '1', is_active: true,
      version: '2', deleted_at: null,
    })]);
    expect(state.links).toEqual(linksBefore);
    expect(state.operations).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
  });

  it('deactivates a promotion and increments even when it is already in the desired state', async () => {
    const created = await commands().create(createInput());
    const linksBefore = (await snapshot()).links;
    const first = await commands().deactivate(deactivateInput());
    expect(first).toEqual({
      ...created,
      operationId: 'promotion-deactivate-operation',
      action: 'DEACTIVATE',
      promotions: [{
        ...created.promotions[0], isActive: false,
        promotionVersionBefore: 1, promotionVersionAfter: 2,
      }],
    });
    const second = await commands().deactivate({
      ...deactivateInput(), operationId: 'promotion-deactivate-again', expectedPromotionVersion: 2,
    });
    expect(second).toMatchObject({
      action: 'DEACTIVATE',
      promotions: [{ isActive: false, promotionVersionBefore: 2, promotionVersionAfter: 3 }],
    });
    expect((await snapshot()).links).toEqual(linksBefore);
  });

  it('rolls back activation for stale, missing, or tombstoned promotions', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const before = await snapshot();
    await expect(commands().activate({ ...activateInput(), expectedPromotionVersion: 2 }))
      .rejects.toThrow(/stale|version/i);
    await expect(commands().activate({
      ...activateInput(), operationId: 'activate-missing', promotionId: 'PROMO-404',
    })).rejects.toThrow(/not found/i);
    await harness.database.query(
      `UPDATE promotions SET deleted_at=$3 WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', NOW.toISOString()],
    );
    const tombstoned = await snapshot();
    await expect(commands().activate({ ...activateInput(), operationId: 'activate-tombstoned' }))
      .rejects.toThrow(/not found/i);
    expect(await snapshot()).toEqual(tombstoned);
    expect(before.operations).toHaveLength(1);
  });

  it('replays a frozen activation result after opposite state, link, and tombstone changes and rejects action conflicts', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const input = activateInput();
    const first = await commands().activate(input);
    await harness.database.query(
      `UPDATE promotions SET is_active=false, version=3, deleted_at=$3, updated_at=$3
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', '2026-08-30T02:00:00.000Z'],
    );
    await harness.database.query(
      `DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2 AND product_id=$3`,
      [harness.tenantOneId, 'PROMO-001', 'P002'],
    );
    await expect(commands().activate(input)).resolves.toEqual(first);
    await expect(commands().deactivate(input)).rejects.toThrow(/conflict/i);
    await expect(commands().activate({ ...input, expectedPromotionVersion: 2 }))
      .rejects.toThrow(/conflict/i);
  });

  it('rejects activation replay after the physical promotion identity is hard-deleted', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const input = activateInput();
    await commands().activate(input);
    await harness.database.query(
      `DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001'],
    );
    await harness.database.query(
      `DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001'],
    );

    await expect(commands().activate(input)).rejects.toThrow(/identity integrity/i);
  });

  it('rejects activation replay when operation evidence finishes before it starts', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const input = activateInput();
    await commands().activate(input);
    await harness.database.exec(
      'ALTER TABLE operations DROP CONSTRAINT operations_chronology_check',
    );
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET started_at=$3, created_at=$3
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId, '2026-08-30T02:00:00.000Z'],
      );
    });

    await expect(commands().activate(input)).rejects.toThrow(/operation integrity/i);
  });

  it('re-reads the winning activation operation after an insert race', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const input = activateInput();
    const first = await commands().activate(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.activate(input)).resolves.toEqual(first);
  });

  it('fails closed on malformed activation evidence and extra audits', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const input = activateInput();
    await commands().activate(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,isActive}', 'false'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().activate(input)).rejects.toThrow(/stored result integrity/i);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,isActive}', 'true'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId,
        eventType: 'PROMOTION_ADMIN_EXTRA', entityType: 'OPERATION', entityId: input.operationId,
        occurredAt: NOW, redactedDetails: { action: 'ACTIVATE' },
      });
    });
    await expect(commands().activate(input)).rejects.toThrow(/audit integrity/i);
  });

  it('rejects an invalid activation clock before opening a transaction', async () => {
    let transactionCallCount = 0;
    const invalidClockCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: (tenantId, callback) => {
        transactionCallCount += 1;
        return harness.runTenantTransaction(tenantId, callback);
      },
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClockCommands.activate(activateInput())).rejects.toThrow(/timestamp.*invalid/i);
    expect(transactionCallCount).toBe(0);
  });

  it('rejects malformed stored promotion definitions and rolls back the operation claim', async () => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    await harness.database.query(
      `UPDATE promotions SET name=' 하나 더 ' WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001'],
    );
    const before = await snapshot();
    await expect(commands().activate(activateInput())).rejects.toThrow(/stored promotion integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('returns activation targets in JavaScript UTF-16 order independent of database collation', async () => {
    const javascriptFirst = 'P\u{10000}';
    const databaseFirst = 'P\uE000';
    for (const productId of [javascriptFirst, databaseFirst]) {
      await harness.database.query(
        `INSERT INTO products
          (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
           created_at, updated_at)
         VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
        [harness.tenantOneId, productId, NOW.toISOString()],
      );
    }
    await commands().create({
      ...createInput(),
      definition: { ...createInput().definition, isActive: false },
      productIds: [databaseFirst, javascriptFirst],
    });
    await expect(commands().activate(activateInput())).resolves.toMatchObject({
      promotions: [{ productIds: [javascriptFirst, databaseFirst] }],
    });
  });

  it('rolls back activation when a trigger mutates percent to a lossy arbitrary-precision decimal', async () => {
    await commands().create({
      ...createInput(),
      definition: {
        name: ' 정밀 할인 ',
        description: ' 설명 ',
        type: 'PERCENT_DISCOUNT',
        percent: 0.1,
        startsAt: '2026-08-30T00:00:00.000Z',
        endsAt: '2026-09-30T00:00:00.000Z',
        isActive: false,
        sortOrder: 3,
      },
    });
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION mutate_activation_percent_precision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        NEW.percent_discount := 0.10000000000000001;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mutate_activation_percent_precision
      BEFORE UPDATE ON promotions
      FOR EACH ROW EXECUTE FUNCTION mutate_activation_percent_precision();
    `);

    await expect(commands().activate(activateInput())).rejects.toThrow(/stored promotion|metadata.*integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['metadata', 'promotions', "OLD.promotion_id='PROMO-001'", 'RETURN OLD'],
    ['audit', 'audit_events', "NEW.operation_id='promotion-activate-operation'", 'RETURN NULL'],
    ['terminal', 'operations', "NEW.operation_id='promotion-activate-operation' AND NEW.status='SUCCEEDED'", 'RETURN NULL'],
  ] as const)('rolls back activation when required %s evidence is suppressed', async (_target, table, condition, triggerResult) => {
    await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_promotion_activation_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN ${triggerResult}; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_promotion_activation_write
      BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_promotion_activation_write();
    `);
    await expect(commands().activate(activateInput())).rejects.toThrow(/integrity|not replayable/i);
    expect(await snapshot()).toEqual(before);
  });

  it('tombstones an active promotion, preserves its definition, and atomically removes all links', async () => {
    const created = await commands().create(createInput());
    const result = await commands().delete(deleteInput());
    expect(result).toEqual({
      ...created,
      operationId: 'promotion-delete-operation',
      action: 'DELETE',
      promotions: [{
        ...created.promotions[0], isActive: false,
        promotionVersionBefore: 1, promotionVersionAfter: 2,
      }],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([expect.objectContaining({
      promotion_id: 'PROMO-001', name: '하나 더', description: '설명', type: 'N_PLUS_ONE',
      n_plus_one_buy_quantity: '2', n_plus_one_free_quantity: '1', is_active: false,
      schema_version: 3, version: '2', deleted_at: NOW,
    })]);
    expect(state.links).toEqual([]);
    expect(state.operations).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
  });

  it('deletes an already-inactive promotion and still increments its version', async () => {
    const created = await commands().create({
      ...createInput(), definition: { ...createInput().definition, isActive: false },
    });
    await expect(commands().delete(deleteInput())).resolves.toEqual({
      ...created, operationId: deleteInput().operationId, action: 'DELETE',
      promotions: [{
        ...created.promotions[0], promotionVersionBefore: 1, promotionVersionAfter: 2,
      }],
    });
    expect((await snapshot()).links).toEqual([]);
  });

  it('rolls back delete for stale, missing, or already-tombstoned promotions', async () => {
    await commands().create(createInput());
    const before = await snapshot();
    await expect(commands().delete({ ...deleteInput(), expectedPromotionVersion: 2 }))
      .rejects.toThrow(/stale|version/i);
    await expect(commands().delete({
      ...deleteInput(), operationId: 'delete-missing', promotionId: 'PROMO-404',
    })).rejects.toThrow(/not found/i);
    expect(await snapshot()).toEqual(before);
    await harness.database.query(
      `UPDATE promotions SET is_active=false, deleted_at=$3, updated_at=$3
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', NOW.toISOString()],
    );
    const tombstoned = await snapshot();
    await expect(commands().delete({ ...deleteInput(), operationId: 'delete-tombstoned' }))
      .rejects.toThrow(/not found/i);
    expect(await snapshot()).toEqual(tombstoned);
  });

  it('rejects delete when the clock precedes promotion creation', async () => {
    await commands().create(createInput());
    const before = await snapshot();
    const early = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-29T23:59:59.999Z'),
    });
    await expect(early.delete(deleteInput())).rejects.toThrow(/created|chronology|timestamp/i);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects delete when the clock precedes the latest promotion update and fully rolls back', async () => {
    await commands().create(createInput());
    await harness.database.query(
      `UPDATE promotions SET updated_at=$3
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001', '2026-08-30T02:00:00.000Z'],
    );
    const before = await snapshot();

    await expect(commands().delete(deleteInput())).rejects.toThrow(/chronology|timestamp/i);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects delete for a live promotion updated before it was created and fully rolls back', async () => {
    await commands().create(createInput());
    await harness.database.query(
      `UPDATE promotions SET created_at=$3, updated_at=$4
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [
        harness.tenantOneId,
        'PROMO-001',
        '2026-08-30T00:30:00.000Z',
        '2026-08-30T00:29:59.999Z',
      ],
    );
    const before = await snapshot();

    await expect(commands().delete(deleteInput())).rejects.toThrow(/chronology|timestamp/i);
    expect(await snapshot()).toEqual(before);
  });

  it('replays frozen delete evidence after later direct tombstone mutation and rejects action or version conflicts', async () => {
    await commands().create(createInput());
    const input = deleteInput();
    const first = await commands().delete(input);
    await harness.database.query(
      `UPDATE promotions SET name='나중 이름', version=3, updated_at='2026-08-30T02:00:00Z'
       WHERE tenant_id=$1 AND promotion_id=$2`,
      [harness.tenantOneId, 'PROMO-001'],
    );
    await expect(commands().delete(input)).resolves.toEqual(first);
    await expect(commands().delete({ ...input, expectedPromotionVersion: 2 }))
      .rejects.toThrow(/conflict/i);
    await expect(commands().activate(input)).rejects.toThrow(/conflict/i);
  });

  it('rejects delete replay after the physical promotion identity is hard-deleted', async () => {
    await commands().create(createInput());
    const input = deleteInput();
    await commands().delete(input);
    await harness.database.query(
      'DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-001'],
    );
    await expect(commands().delete(input)).rejects.toThrow(/identity integrity/i);
  });

  it('re-reads the winning delete operation after an insert race', async () => {
    await commands().create(createInput());
    const input = deleteInput();
    const first = await commands().delete(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missedInitialRead = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missedInitialRead) {
              missedInitialRead = true;
              return { rows: [] } as never;
            }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.delete(input)).resolves.toEqual(first);
  });

  it('fails closed on malformed delete result evidence, extra audits, and reverse chronology', async () => {
    await commands().create(createInput());
    const input = deleteInput();
    await commands().delete(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,isActive}', 'true'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().delete(input)).rejects.toThrow(/stored result integrity/i);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations
         SET result_snapshot=jsonb_set(result_snapshot, '{promotions,0,isActive}', 'false'::jsonb)
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId,
        eventType: 'PROMOTION_ADMIN_EXTRA', entityType: 'OPERATION', entityId: input.operationId,
        occurredAt: NOW, redactedDetails: { action: 'DELETE' },
      });
    });
    await expect(commands().delete(input)).rejects.toThrow(/audit integrity/i);
    await harness.database.exec('ALTER TABLE operations DROP CONSTRAINT operations_chronology_check');
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2 AND event_type='PROMOTION_ADMIN_EXTRA'`,
        [harness.tenantOneId, input.operationId],
      );
      await harness.database.query(
        `UPDATE operations SET started_at=$3, created_at=$3
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId, '2026-08-30T02:00:00.000Z'],
      );
    });
    await expect(commands().delete(input)).rejects.toThrow(/operation integrity/i);
  });

  it.each([
    ['metadata', 'promotions', "OLD.promotion_id='PROMO-001'", 'RETURN OLD'],
    ['link delete', 'promotion_products', "OLD.product_id='P001'", 'RETURN NULL'],
    ['audit', 'audit_events', "NEW.operation_id='promotion-delete-operation'", 'RETURN NULL'],
    ['terminal', 'operations', "NEW.operation_id='promotion-delete-operation' AND NEW.status='SUCCEEDED'", 'RETURN NULL'],
  ] as const)('rolls back delete when required %s evidence is suppressed', async (_target, table, condition, triggerResult) => {
    await commands().create(createInput());
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_promotion_delete_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN ${triggerResult}; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_promotion_delete_write
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_promotion_delete_write();
    `);
    await expect(commands().delete(deleteInput())).rejects.toThrow(/integrity|not replayable/i);
    expect(await snapshot()).toEqual(before);
  });

  it('returns removed delete targets in JavaScript UTF-16 order independent of database collation', async () => {
    const javascriptFirst = 'P\u{10000}';
    const databaseFirst = 'P\uE000';
    for (const productId of [javascriptFirst, databaseFirst]) {
      await harness.database.query(
        `INSERT INTO products
          (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
           created_at, updated_at)
         VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
        [harness.tenantOneId, productId, NOW.toISOString()],
      );
    }
    await commands().create({ ...createInput(), productIds: [databaseFirst, javascriptFirst] });
    await expect(commands().delete(deleteInput())).resolves.toMatchObject({
      promotions: [{ productIds: [javascriptFirst, databaseFirst] }],
    });
  });

  it('rejects invalid delete versions and clocks before opening a transaction', async () => {
    let transactionCallCount = 0;
    const invalidClockCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: (tenantId, callback) => {
        transactionCallCount += 1;
        return harness.runTenantTransaction(tenantId, callback);
      },
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClockCommands.delete(deleteInput())).rejects.toThrow(/timestamp.*invalid/i);
    await expect(commands().delete({
      ...deleteInput(), expectedPromotionVersion: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/next promotion version/i);
    expect(transactionCallCount).toBe(0);
  });

  it('exports deleteBatch and atomically tombstones canonical targets with one operation and audit', async () => {
    await seedUpdateBatchTargets();
    await harness.database.query(
      'UPDATE promotions SET is_active=false WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await harness.database.query(
      'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    const input = deleteBatchInput();
    const result = await commands().deleteBatch(input);
    expect(result).toEqual({
      ok: true,
      operationId: input.operationId,
      action: 'DELETE',
      completedAt: NOW.toISOString(),
      promotions: [
        expect.objectContaining({
          promotionId: 'PROMO-001', isActive: false, productIds: ['P001', 'P002'],
          promotionVersionBefore: 1, promotionVersionAfter: 2,
        }),
        expect.objectContaining({
          promotionId: 'PROMO-002', isActive: false, productIds: [],
          promotionVersionBefore: 1, promotionVersionAfter: 2,
        }),
      ],
    });
    const state = await snapshot();
    expect(state.promotions).toEqual([
      expect.objectContaining({ promotion_id: 'PROMO-001', is_active: false, version: '2', deleted_at: NOW }),
      expect.objectContaining({ promotion_id: 'PROMO-002', is_active: false, version: '2', deleted_at: NOW }),
    ]);
    expect(state.links).toEqual([]);
    expect(state.operations).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
    expect(state.audits[1]).toEqual(expect.objectContaining({
      redacted_details: expect.objectContaining({ changedPromotionCount: 2, targetProductCount: 2 }),
    }));
  });

  it('rejects malformed delete batches and invalid clocks before opening a transaction', async () => {
    let calls = 0;
    const batchCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => NOW,
    });
    const valid = deleteBatchInput().promotions[0];
    const invalid = [
      { operationId: 'empty', promotions: [] },
      { operationId: 'large', promotions: Array.from({ length: 101 }, (_, index) => ({
        ...valid, promotionId: `PROMO-${index}`,
      })) },
      { operationId: 'duplicate', promotions: [
        { ...valid, promotionId: ' SAME ' }, { ...valid, promotionId: 'SAME' },
      ] },
      { operationId: 'nested', promotions: [{ ...valid, operationId: 'forbidden' }] },
      { operationId: 'later-malformed', promotions: [valid, { ...valid, promotionId: 'LATER', extra: true }] },
      { operationId: 'later-version', promotions: [valid, { ...valid, promotionId: 'LATER', expectedPromotionVersion: 0 }] },
      { operationId: 'overflow', promotions: [{ ...valid, expectedPromotionVersion: Number.MAX_SAFE_INTEGER }] },
    ];
    for (const value of invalid) await expect(batchCommands.deleteBatch(value as never)).rejects.toThrow();
    const invalidClock = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClock.deleteBatch(deleteBatchInput())).rejects.toThrow(/timestamp.*invalid/i);
    expect(calls).toBe(0);

    const sentinel = new Error('sentinel');
    const boundary = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw sentinel; },
      now: () => NOW,
    });
    await expect(boundary.deleteBatch({
      operationId: 'size-100',
      promotions: Array.from({ length: 100 }, (_, index) => ({
        promotionId: `B-${index}`, expectedPromotionVersion: 1,
      })),
    })).rejects.toBe(sentinel);
    expect(calls).toBe(1);
  });

  it.each([
    ['stale later target', async () => {
      const input = deleteBatchInput();
      input.promotions[0].expectedPromotionVersion = 2;
      return input;
    }],
    ['missing later target', async () => {
      await harness.database.query(
        'DELETE FROM promotion_products WHERE tenant_id=$1 AND promotion_id=$2',
        [harness.tenantOneId, 'PROMO-002'],
      );
      await harness.database.query(
        'DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2',
        [harness.tenantOneId, 'PROMO-002'],
      );
      return deleteBatchInput();
    }],
    ['already tombstoned later target', async () => {
      await harness.database.query(
        'UPDATE promotions SET is_active=false, deleted_at=$3 WHERE tenant_id=$1 AND promotion_id=$2',
        [harness.tenantOneId, 'PROMO-002', NOW.toISOString()],
      );
      return deleteBatchInput();
    }],
    ['malformed later chronology', async () => {
      await harness.database.query(
        'UPDATE promotions SET updated_at=$3 WHERE tenant_id=$1 AND promotion_id=$2',
        [harness.tenantOneId, 'PROMO-002', '2026-08-30T02:00:00.000Z'],
      );
      return deleteBatchInput();
    }],
  ] as const)('rolls back deleteBatch before writes for a %s', async (_label, prepare) => {
    await seedUpdateBatchTargets();
    const input = await prepare();
    const before = await snapshot();
    await expect(commands().deleteBatch(input)).rejects.toThrow(/not found|stale|version|chronology/i);
    expect(await snapshot()).toEqual(before);
  });

  it('replays a reversed delete batch, conflicts on changed payload, and requires every physical identity', async () => {
    await seedUpdateBatchTargets();
    const input = deleteBatchInput();
    const first = await commands().deleteBatch(input);
    await expect(commands().deleteBatch({ ...input, promotions: [...input.promotions].reverse() }))
      .resolves.toEqual(first);
    await expect(commands().deleteBatch({
      ...input,
      promotions: [input.promotions[0], { ...input.promotions[1], expectedPromotionVersion: 2 }],
    })).rejects.toThrow(/conflict/i);
    await harness.database.query(
      "UPDATE promotions SET name='later', version=3 WHERE tenant_id=$1 AND promotion_id=$2",
      [harness.tenantOneId, 'PROMO-001'],
    );
    await expect(commands().deleteBatch(input)).resolves.toEqual(first);
    await harness.database.query(
      'DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id=$2',
      [harness.tenantOneId, 'PROMO-002'],
    );
    await expect(commands().deleteBatch(input)).rejects.toThrow(/identity integrity/i);
  });

  it('re-reads the winning deleteBatch operation after an insert race', async () => {
    await seedUpdateBatchTargets();
    const input = deleteBatchInput();
    const first = await commands().deleteBatch(input);
    const raceCommands = createDatabasePromotionCommands({
      tenantId: harness.tenantOneId,
      now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let missed = false;
        const raceTx = {
          execute: async (query: Parameters<typeof tx.execute>[0]) => {
            if (!missed) { missed = true; return { rows: [] } as never; }
            return tx.execute(query);
          },
        } as unknown as typeof tx;
        return callback(raceTx);
      }),
    });
    await expect(raceCommands.deleteBatch({ ...input, promotions: [...input.promotions].reverse() }))
      .resolves.toEqual(first);
  });

  it.each([
    ['later metadata update', 'promotions', "OLD.promotion_id='PROMO-002'", 'RETURN OLD'],
    ['audit insert', 'audit_events', "NEW.operation_id='promotion-delete-batch-operation'", 'RETURN NULL'],
    ['terminal update', 'operations', "NEW.operation_id='promotion-delete-batch-operation' AND NEW.status='SUCCEEDED'", 'RETURN NULL'],
  ] as const)('rolls back deleteBatch when required %s evidence is suppressed', async (
    _label, table, condition, triggerResult,
  ) => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION suppress_required_delete_batch_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN ${triggerResult}; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER suppress_required_delete_batch_write
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_required_delete_batch_write();
    `);
    await expect(commands().deleteBatch(deleteBatchInput())).rejects.toThrow(/integrity|replayable/i);
    expect(await snapshot()).toEqual(before);
  });

  it('reaches a later deleteBatch link deletion failure before rolling back', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION fail_later_delete_batch_link() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.promotion_id='PROMO-002' THEN
          RAISE EXCEPTION 'PROMO_002_DELETE_REACHED';
        END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER fail_later_delete_batch_link
      BEFORE DELETE ON promotion_products
      FOR EACH ROW EXECUTE FUNCTION fail_later_delete_batch_link();
    `);
    let failure: unknown;
    try {
      await commands().deleteBatch(deleteBatchInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current = failure;
    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      if ('message' in current && typeof current.message === 'string') messages.push(current.message);
      current = 'cause' in current ? current.cause : undefined;
    }
    expect(messages.join('\n')).toContain('PROMO_002_DELETE_REACHED');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['later item', `CREATE FUNCTION mutate_delete_batch_earlier() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.promotion_id='PROMO-002' THEN
          UPDATE promotions SET name='mutated' WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER mutate_delete_batch_earlier AFTER UPDATE ON promotions
      FOR EACH ROW EXECUTE FUNCTION mutate_delete_batch_earlier();`],
    ['audit', `CREATE FUNCTION mutate_delete_batch_after_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-delete-batch-operation' THEN
          UPDATE promotions SET schema_version=2 WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER mutate_delete_batch_after_audit AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION mutate_delete_batch_after_audit();`],
    ['terminal', `CREATE FUNCTION mutate_delete_batch_after_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id='promotion-delete-batch-operation' AND NEW.status='SUCCEEDED' THEN
          UPDATE promotions SET name='mutated' WHERE tenant_id=NEW.tenant_id AND promotion_id='PROMO-001';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER mutate_delete_batch_after_terminal AFTER UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION mutate_delete_batch_after_terminal();`],
  ] as const)('rolls back deleteBatch for an AFTER mutation on %s', async (_label, ddl) => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(ddl);
    await expect(commands().deleteBatch(deleteBatchInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects duplicate promotion and link rows returned by deleteBatch adapters', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    for (const duplicateKind of ['promotion', 'link'] as const) {
      const malformed = createDatabasePromotionCommands({
        tenantId: harness.tenantOneId,
        now: () => NOW,
        runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
          let duplicated = false;
          const malformedTx = {
            execute: async (query: Parameters<typeof tx.execute>[0]) => {
              const result = await tx.execute(query);
              if (!duplicated && result.rows.length > 0) {
                const row = result.rows[0] as Record<string, unknown>;
                const matches = duplicateKind === 'promotion'
                  ? Object.keys(row).length === 18 && 'promotion_id' in row
                  : Object.keys(row).length === 5 && 'promotion_product_id' in row;
                if (matches) {
                  duplicated = true;
                  return { ...result, rows: [...result.rows, result.rows[0]] } as never;
                }
              }
              return result;
            },
          } as unknown as typeof tx;
          return callback(malformedTx);
        }),
      });
      await expect(malformed.deleteBatch({
        ...deleteBatchInput(), operationId: `duplicate-${duplicateKind}`,
      })).rejects.toThrow(/integrity|not found/i);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('fails closed on reordered deleteBatch results, extra audits, and reverse chronology', async () => {
    await seedUpdateBatchTargets();
    const input = deleteBatchInput();
    await commands().deleteBatch(input);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions}',
          jsonb_build_array(result_snapshot->'promotions'->1, result_snapshot->'promotions'->0))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await expect(commands().deleteBatch(input)).rejects.toThrow(/stored result integrity/i);
    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{promotions}',
          jsonb_build_array(result_snapshot->'promotions'->1, result_snapshot->'promotions'->0))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId],
      );
    });
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: input.operationId, eventType: 'PROMOTION_ADMIN_EXTRA',
        entityType: 'OPERATION', entityId: input.operationId, occurredAt: NOW,
        redactedDetails: { action: 'DELETE' },
      });
    });
    await expect(commands().deleteBatch(input)).rejects.toThrow(/audit integrity/i);
  });

  it('returns deleteBatch promotions and removed links in JavaScript order across database collation', async () => {
    const javascriptFirstPromotion = 'PROMO-\u{10000}';
    const databaseFirstPromotion = 'PROMO-\uE000';
    const javascriptFirstProduct = 'P\u{10000}';
    const databaseFirstProduct = 'P\uE000';
    for (const productId of [javascriptFirstProduct, databaseFirstProduct]) {
      await harness.database.query(
        `INSERT INTO products
          (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
           created_at, updated_at)
         VALUES ($1, $2, $2, 100, 10, true, 0, 1, $3, $3)`,
        [harness.tenantOneId, productId, NOW.toISOString()],
      );
    }
    const source = createBatchInput().promotions;
    await commands().createBatch({
      operationId: 'delete-collation-create',
      promotions: [
        { ...source[0], promotionId: databaseFirstPromotion,
          productIds: [databaseFirstProduct, javascriptFirstProduct] },
        { ...source[1], promotionId: javascriptFirstPromotion,
          productIds: [databaseFirstProduct, javascriptFirstProduct] },
      ],
    });
    await expect(commands().deleteBatch({
      operationId: 'delete-collation',
      promotions: [
        { promotionId: databaseFirstPromotion, expectedPromotionVersion: 1 },
        { promotionId: javascriptFirstPromotion, expectedPromotionVersion: 1 },
      ],
    })).resolves.toMatchObject({ promotions: [
      { promotionId: javascriptFirstPromotion,
        productIds: [javascriptFirstProduct, databaseFirstProduct] },
      { promotionId: databaseFirstPromotion,
        productIds: [javascriptFirstProduct, databaseFirstProduct] },
    ] });
  });

  it('rolls back deleteBatch when a trigger leaves a final link behind', async () => {
    await seedUpdateBatchTargets();
    const before = await snapshot();
    await harness.database.exec(`
      CREATE FUNCTION restore_deleted_batch_link() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.promotion_id='PROMO-002' THEN
          INSERT INTO promotion_products
            (tenant_id, promotion_product_id, promotion_id, product_id, created_at, schema_version)
          VALUES (OLD.tenant_id, OLD.promotion_product_id, OLD.promotion_id,
            OLD.product_id, OLD.created_at, OLD.schema_version);
        END IF; RETURN OLD; END $$;
      CREATE TRIGGER restore_deleted_batch_link AFTER DELETE ON promotion_products
      FOR EACH ROW EXECUTE FUNCTION restore_deleted_batch_link();
    `);
    await expect(commands().deleteBatch(deleteBatchInput())).rejects.toThrow(/final link set integrity/i);
    expect(await snapshot()).toEqual(before);
  });
});
