import type { CartItem } from '@/domain/types';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, type CheckoutPreviewPayload } from './checkoutSnapshotClient';
import { tenantApiPath } from './tenantApiPath';

/** No QR credential, student name, balance, or success response belongs in this journal. */
export type CheckoutIntent = Readonly<{
  operationId: string;
  studentId: string;
  items: CartItem[];
  expectedPricing: CheckoutPreviewPayload;
  voucherItemIds: string[];
}>;

export const CHECKOUT_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOURNAL_LENGTH = 128 * 1024;
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{7,127}$/;
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Recovery = { state: 'none' } | { state: 'blocked' } | { state: 'ready'; intent: CheckoutIntent };

export function checkoutRecoveryKey(pathname?: string): string {
  return `crs:pending-checkout:v1:${tenantApiPath('/api/checkout', pathname)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
function parseIntent(value: unknown): CheckoutIntent | null {
  if (!record(value) || typeof value.operationId !== 'string' || !OPERATION_ID.test(value.operationId)
    || !identifier(value.studentId) || !Array.isArray(value.items) || value.items.length === 0 || value.items.length > 1000
    || !value.items.every((item) => record(item) && identifier(item.productId)
      && Number.isSafeInteger(item.quantity) && (item.quantity as number) > 0)
    || !Array.isArray(value.voucherItemIds) || value.voucherItemIds.length > 100
    || !value.voucherItemIds.every(identifier) || new Set(value.voucherItemIds).size !== value.voucherItemIds.length) return null;
  const pricing = parseCheckoutPreviewResponse(value.expectedPricing);
  const items = value.items as CartItem[];
  if (!pricing || !checkoutPreviewMatchesCart(pricing, items)) return null;
  return {
    operationId: value.operationId, studentId: value.studentId,
    items: items.map(({ productId, quantity }) => ({ productId, quantity })),
    expectedPricing: pricing, voucherItemIds: [...value.voucherItemIds],
  };
}

export function readCheckoutRecovery(key: string, now = Date.now(), providedStorage?: StorageAccess): Recovery {
  try {
    const storage = providedStorage ?? window.sessionStorage;
    const raw = storage.getItem(key);
    if (raw === null) return { state: 'none' };
    if (raw.length > MAX_JOURNAL_LENGTH) return { state: 'blocked' };
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || value.scope !== key
      || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) > now + 60_000
      || now - (value.createdAt as number) > CHECKOUT_RECOVERY_MAX_AGE_MS) return { state: 'blocked' };
    const intent = parseIntent(value.intent);
    return intent ? { state: 'ready', intent } : { state: 'blocked' };
  } catch {
    // Never erase an unreadable/expired record: an earlier request may have committed.
    return { state: 'blocked' };
  }
}

/** Must succeed before sending the first request. Existing uncertain records cannot be replaced. */
export function saveCheckoutRecovery(key: string, intent: CheckoutIntent, now = Date.now(), providedStorage?: StorageAccess): boolean {
  try {
    const storage = providedStorage ?? window.sessionStorage;
    if (storage.getItem(key) !== null) return false;
    const safeIntent = parseIntent(intent);
    if (!safeIntent) return false;
    const raw = JSON.stringify({ version: 1, scope: key, createdAt: now, intent: safeIntent });
    if (raw.length > MAX_JOURNAL_LENGTH) return false;
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}

export function clearCheckoutRecovery(key: string, providedStorage?: StorageAccess): boolean {
  try {
    const storage = providedStorage ?? window.sessionStorage;
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

/** The only field reconstructed on recovery is the fresh, same-student QR credential. */
export function checkoutIntentBody(intent: CheckoutIntent, qrValue: string): string {
  return JSON.stringify({
    operationId: intent.operationId, studentId: qrValue, items: intent.items, expectedPricing: intent.expectedPricing,
    ...(intent.voucherItemIds.length > 0 ? { voucherItemIds: intent.voucherItemIds } : {}),
  });
}
