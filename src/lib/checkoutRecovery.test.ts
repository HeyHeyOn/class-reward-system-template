import { beforeEach, expect, it, vi } from 'vitest';
import { createCartPricingPreview } from '@/domain/checkout';
import { CHECKOUT_RECOVERY_MAX_AGE_MS, checkoutIntentBody, checkoutRecoveryKey, clearCheckoutRecovery, readCheckoutRecovery, saveCheckoutRecovery, type CheckoutIntent } from './checkoutRecovery';

const now = Date.parse('2026-10-11T00:00:00Z');
const key = checkoutRecoveryKey('/c/class-one');
function intent(): CheckoutIntent {
  const items = [{ productId: 'P001', quantity: 2 }];
  const expectedPricing = createCartPricingPreview({
    products: [{ productId: 'P001', name: 'Synthetic product', price: 100, stock: 20, isActive: true, sortOrder: 1 }], cartItems: items,
  });
  if (!expectedPricing.ok) throw new Error('Invalid test fixture');
  return { operationId: 'synthetic-operation', studentId: 'S001', items, expectedPricing, voucherItemIds: [] };
}
beforeEach(() => sessionStorage.clear());

it('recovers the exact payment intent only within its class, replacing only a fresh QR field', () => {
  const submitted = intent();
  expect(saveCheckoutRecovery(key, submitted, now)).toBe(true);
  expect(readCheckoutRecovery(checkoutRecoveryKey('/c/class-two'), now)).toEqual({ state: 'none' });
  const recovered = readCheckoutRecovery(key, now + 1000);
  expect(recovered).toEqual({ state: 'ready', intent: submitted });
  if (recovered.state !== 'ready') throw new Error('Expected a recovery');
  const original = JSON.parse(checkoutIntentBody(submitted, 'csq1.first-synthetic-credential'));
  expect(JSON.parse(checkoutIntentBody(recovered.intent, 'csq1.fresh-synthetic-credential')))
    .toEqual({ ...original, studentId: 'csq1.fresh-synthetic-credential' });
  expect(sessionStorage.getItem(key)).not.toContain('csq1.');
  expect(saveCheckoutRecovery(key, { ...submitted, operationId: 'another-operation' }, now)).toBe(false);
  expect(clearCheckoutRecovery(key)).toBe(true);
  expect(readCheckoutRecovery(key, now)).toEqual({ state: 'none' });
});

it.each(['malformed', 'oversized', 'expired', 'future', 'wrong-scope', 'invalid-quote', 'duplicate-voucher'])('blocks and retains an %s journal instead of permitting a fresh checkout', (kind) => {
  expect(saveCheckoutRecovery(key, intent(), now)).toBe(true);
  const value = JSON.parse(sessionStorage.getItem(key)!);
  if (kind === 'expired') value.createdAt = now - CHECKOUT_RECOVERY_MAX_AGE_MS - 1;
  if (kind === 'future') value.createdAt = now + 60_001;
  if (kind === 'wrong-scope') value.scope = checkoutRecoveryKey('/c/class-two');
  if (kind === 'invalid-quote') value.intent.expectedPricing.totalAmount += 1;
  if (kind === 'duplicate-voucher') value.intent.voucherItemIds = ['V1', 'V1'];
  const raw = kind === 'malformed' ? '{' : kind === 'oversized' ? ' '.repeat(128 * 1024 + 1) : JSON.stringify(value);
  sessionStorage.setItem(key, raw);
  expect(readCheckoutRecovery(key, now)).toEqual({ state: 'blocked' });
  expect(sessionStorage.getItem(key)).toBe(raw);
  expect(saveCheckoutRecovery(key, intent(), now)).toBe(false);
});

it('fails closed when browser storage cannot be read or written', () => {
  const unreadable = { getItem: vi.fn(() => { throw new Error('unavailable'); }), setItem: vi.fn(), removeItem: vi.fn() };
  expect(readCheckoutRecovery(key, now, unreadable)).toEqual({ state: 'blocked' });
  expect(saveCheckoutRecovery(key, intent(), now, unreadable)).toBe(false);
  const unwritable = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new Error('quota'); }), removeItem: vi.fn() };
  expect(saveCheckoutRecovery(key, intent(), now, unwritable)).toBe(false);
});
