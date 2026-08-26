import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  it('renders accessible themed labels for every promotion type', () => {
    render(<PromotionPills promotions={promotions} currencyUnit="별" pillClassName="bg-theme text-theme" ariaLabel="연필 행사" />);
    const group = screen.getByLabelText('연필 행사');
    expect(group.className).toContain('flex');
    expect(screen.getByText('2+1')).toBeTruthy();
    expect(screen.getByText('-10%')).toBeTruthy();
    expect(screen.getByText('-30별')).toBeTruthy();
    expect(screen.getByText('250별')).toBeTruthy();
    expect(screen.getAllByText(/2\+1|-10%|-30별|250별/).every((pill) => pill.className.includes('bg-theme'))).toBe(true);
  });
});
