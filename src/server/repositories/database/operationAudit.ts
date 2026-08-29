import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';

const SENSITIVE_KEY = /(^|_)(recovery|password|secret|token|plaintext|credential|raw)(_|$)/i;

export type OperationAuditInput = Readonly<{
  operationId: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  redactedDetails: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}>;

type CanonicalAuditInput = OperationAuditInput & { redactedDetailsJson: string };

export function operationAuditEventId(operationId: string, eventType: string): string {
  if (!isCanonicalText(operationId)) throw new Error('A canonical operation ID is required for audit.');
  if (!isCanonicalText(eventType)) throw new Error('A canonical audit event type is required.');
  const digest = createHash('sha256')
    .update(JSON.stringify({ operationId, eventType }), 'utf8')
    .digest('hex');
  return `audit:${digest}`;
}

export async function appendOperationAudit(
  transaction: TenantTransaction,
  tenantId: string,
  rawInput: OperationAuditInput,
): Promise<void> {
  const input = canonicalize(rawInput);
  await transaction.execute(sql`
    INSERT INTO audit_events
      (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at)
    VALUES
      (${tenantId}, ${operationAuditEventId(input.operationId, input.eventType)},
       ${input.operationId}, ${input.eventType}, ${input.entityType ?? null},
       ${input.entityId ?? null}, ${input.redactedDetailsJson}::jsonb, ${input.occurredAt})
  `);
}

export async function assertOperationAudit(
  transaction: TenantTransaction,
  tenantId: string,
  rawInput: OperationAuditInput,
): Promise<void> {
  const input = canonicalize(rawInput);
  const result = await transaction.execute(sql`
    SELECT event_id
    FROM audit_events
    WHERE tenant_id=${tenantId}
      AND event_id=${operationAuditEventId(input.operationId, input.eventType)}
      AND operation_id=${input.operationId}
      AND event_type=${input.eventType}
      AND entity_type IS NOT DISTINCT FROM ${input.entityType ?? null}
      AND entity_id IS NOT DISTINCT FROM ${input.entityId ?? null}
      AND redacted_details=${input.redactedDetailsJson}::jsonb
      AND occurred_at=${input.occurredAt}
  `);
  if (result.rows.length !== 1) throw new Error('Operation audit integrity check failed.');
}

function canonicalize(input: OperationAuditInput): CanonicalAuditInput {
  if (!input || typeof input !== 'object') throw new Error('A valid operation audit input is required.');
  operationAuditEventId(input.operationId, input.eventType);
  const hasEntityType = input.entityType !== undefined;
  const hasEntityId = input.entityId !== undefined;
  if (hasEntityType !== hasEntityId
    || (hasEntityType && (!isCanonicalText(input.entityType) || !isCanonicalText(input.entityId)))) {
    throw new Error('Canonical audit entity type and ID must be provided together.');
  }
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
    throw new Error('A valid audit timestamp is required.');
  }
  let redactedDetailsJson: string;
  try {
    const snapshot = canonicalJsonObject(input.redactedDetails, new WeakSet());
    redactedDetailsJson = JSON.stringify(snapshot);
  } catch {
    throw new Error('Redacted audit details must be a safe JSON object.');
  }
  return { ...input, redactedDetailsJson };
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonObject(value: unknown, stack: WeakSet<object>): Record<string, unknown> {
  if (!isPlainRecord(value) || stack.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('unsafe object');
  }
  stack.add(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor) || SENSITIVE_KEY.test(key)) {
      throw new Error('unsafe property');
    }
    snapshot[key] = canonicalJsonValue(descriptor.value, stack);
  }
  stack.delete(value);
  return snapshot;
}

function canonicalJsonValue(value: unknown, stack: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return canonicalJsonArray(value, stack);
  return canonicalJsonObject(value, stack);
}

function canonicalJsonArray(value: unknown[], stack: WeakSet<object>): unknown[] {
  if (stack.has(value) || Object.getOwnPropertySymbols(value).length > 0) throw new Error('unsafe array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== value.length) throw new Error('sparse or extended array');
  stack.add(value);
  const snapshot = keys.map((key, index) => {
    const descriptor = descriptors[key];
    if (key !== String(index) || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('unsafe array property');
    }
    return canonicalJsonValue(descriptor.value, stack);
  });
  stack.delete(value);
  return snapshot;
}
