import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import {
  appendOperationAudit,
  assertOperationAudit,
  operationAuditEventId,
} from './operationAudit';

const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);
const OCCURRED_AT = new Date('2026-08-29T06:00:00.000Z');

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.query(
    `INSERT INTO operations
       (tenant_id, operation_id, operation_kind, payload_hash, status,
        result_snapshot, finished_at, started_at, created_at, updated_at)
     VALUES ($1, $2, 'CHECKOUT', $3, 'SUCCEEDED', '{}'::jsonb, $4, $4, $4, $4)`,
    [harness.tenantOneId, OPERATION_ID, HASH, OCCURRED_AT.toISOString()],
  );
});

afterEach(async () => harness?.close());

const input = {
  operationId: OPERATION_ID,
  eventType: 'CHECKOUT_COMPLETED',
  entityType: 'TRANSACTION',
  entityId: 'TX-1',
  redactedDetails: { itemCount: 2, studentId: 'S1' },
  occurredAt: OCCURRED_AT,
} as const;

describe('operation audit helper', () => {
  it('creates a deterministic immutable audit row and validates exact replay state', async () => {
    await harness.runTenantTransaction(harness.tenantOneId, async (transaction) => {
      await appendOperationAudit(transaction, harness.tenantOneId, input);
      await assertOperationAudit(transaction, harness.tenantOneId, input);
    });

    const result = await harness.database.query(
      `SELECT event_id, operation_id, event_type, entity_type, entity_id,
              redacted_details, occurred_at
       FROM audit_events WHERE tenant_id=$1`,
      [harness.tenantOneId],
    );
    expect(result.rows).toEqual([expect.objectContaining({
      event_id: operationAuditEventId(OPERATION_ID, 'CHECKOUT_COMPLETED'),
      operation_id: OPERATION_ID,
      event_type: 'CHECKOUT_COMPLETED',
      entity_type: 'TRANSACTION',
      entity_id: 'TX-1',
      redacted_details: { itemCount: 2, studentId: 'S1' },
    })]);
  });

  it('fails closed when replay audit metadata differs or is missing', async () => {
    await harness.runTenantTransaction(harness.tenantOneId, async (transaction) => {
      await appendOperationAudit(transaction, harness.tenantOneId, input);
      await expect(assertOperationAudit(transaction, harness.tenantOneId, {
        ...input,
        redactedDetails: { itemCount: 3, studentId: 'S1' },
      })).rejects.toThrow(/integrity/i);
    });

    await harness.runTenantTransaction(harness.tenantTwoId, async (transaction) => {
      await expect(assertOperationAudit(transaction, harness.tenantTwoId, input))
        .rejects.toThrow(/integrity/i);
    });
  });

  it('rejects accessor-backed audit details without invoking the accessor', async () => {
    let getterCalls = 0;
    const redactedDetails: Record<string, unknown> = {};
    Object.defineProperty(redactedDetails, 'status', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? 'safe' : { password: 'secret' };
      },
    });

    await harness.runTenantTransaction(harness.tenantOneId, async (transaction) => {
      await expect(appendOperationAudit(transaction, harness.tenantOneId, {
        ...input,
        redactedDetails,
      })).rejects.toThrow(/details/i);
    });
    expect(getterCalls).toBe(0);
  });

  it.each([
    [{ ...input, operationId: ' bad' }, /operation/i],
    [{ ...input, eventType: '' }, /event/i],
    [{ ...input, entityType: undefined }, /entity/i],
    [{ ...input, occurredAt: new Date('invalid') }, /timestamp/i],
    [{ ...input, redactedDetails: [] }, /details/i],
    [{ ...input, redactedDetails: { dropped: undefined } }, /details/i],
    [{ ...input, redactedDetails: { amount: Number.NaN } }, /details/i],
    [{ ...input, redactedDetails: { nested: { password: 'redacted?' } } }, /details/i],
  ])('rejects malformed audit input before SQL: %o', async (candidate, message) => {
    await harness.runTenantTransaction(harness.tenantOneId, async (transaction) => {
      await expect(appendOperationAudit(
        transaction,
        harness.tenantOneId,
        candidate as typeof input,
      )).rejects.toThrow(message);
    });
  });
});
