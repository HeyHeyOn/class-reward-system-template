import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Promotion } from '@/domain/types';
import { PromotionPills } from './PromotionPills';

const base = {
  name: '행사', description: '', productIds: ['P1'], startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2027-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
};
const promotions: Promotion[] = [
  { ...base, promotionId: 'N', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1 },
  { ...base, promotionId: 'P', type: 'PERCENT_DISCOUNT', percent: 10 },
  { ...base, promotionId: 'F', type: 'FIXED_DISCOUNT', discountAmount: 30 },
  { ...base, promotionId: 'PRICE', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 250 },
];

describe('PromotionPills', () => {
  afterEach(cleanup);
  it('keeps N+1 labels, collapses all discounts to one label, and preserves full names accessibly', () => {
    render(<PromotionPills promotions={promotions} currencyUnit="별" pillClassName="bg-theme text-theme" ariaLabel="연필 행사" />);
    const group = screen.getByLabelText('연필 행사');
    expect(group.className).toContain('flex');
    expect(screen.getByText('2+1')).toBeTruthy();
    expect(screen.getAllByText('할인')).toHaveLength(1);
    expect(screen.queryByText('-10%')).toBeNull();
    expect(screen.getByTitle('행사').className).toContain('bg-theme');
    expect(screen.getByTitle('행사 · 행사 · 행사')).toBeTruthy();
  });

  it('sorts N+1 pills deterministically before the single discount pill', () => {
    const secondN: Promotion = { ...base, promotionId: 'A', name: '먼저 1+1', type: 'N_PLUS_ONE', buyQuantity: 1, freeQuantity: 1, sortOrder: 0 };
    render(<PromotionPills promotions={[promotions[1], promotions[0], secondN]} currencyUnit="별" pillClassName="theme" ariaLabel="정렬 행사" />);
    expect(screen.getByLabelText('정렬 행사').textContent).toBe('1+12+1할인');
  });

  it('exposes promotion labels and full names as a semantic list', () => {
    render(<PromotionPills promotions={promotions} currencyUnit="별" pillClassName="theme" ariaLabel="연필 행사" />);
    const list = screen.getByRole('list', { name: '연필 행사' });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByRole('listitem', { name: '2+1: 행사' })).toBeTruthy();
    expect(within(list).getByRole('listitem', { name: '할인: 행사 · 행사 · 행사' })).toBeTruthy();
  });

  it('namespaces React keys when a promotion id is discounts', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const colliding: Promotion = { ...base, promotionId: 'discounts', type: 'N_PLUS_ONE', buyQuantity: 1, freeQuantity: 1 };
    render(<PromotionPills promotions={[colliding, promotions[1]]} currencyUnit="별" pillClassName="theme" ariaLabel="키 행사" />);
    expect(error.mock.calls.flat().join(' ')).not.toContain('same key');
    error.mockRestore();
  });
});
