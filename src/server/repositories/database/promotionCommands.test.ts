import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

async function snapshot() {
  const [promotions, links, operations, audits] = await Promise.all([
    harness.database.query(
      `SELECT promotion_id, name, description, type, n_plus_one_buy_quantity::text,
              n_plus_one_free_quantity::text, promotional_price::text,
              percent_discount::text, fixed_discount::text, starts_at, ends_at,
              is_active, sort_order, schema_version, version::text, deleted_at
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
});
