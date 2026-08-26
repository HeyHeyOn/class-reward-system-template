import type { Promotion } from '@/domain/types';
import { comparePromotionDisplayOrder, promotionBadgeLabel } from '@/lib/promotionClient';

type PromotionPillsProps = {
  promotions: Promotion[];
  currencyUnit: string;
  ariaLabel: string;
  className?: string;
  pillClassName: string;
};

export function PromotionPills({
  promotions,
  currencyUnit,
  ariaLabel,
  className = '',
  pillClassName,
}: PromotionPillsProps) {
  if (promotions.length === 0) return null;

  const nPlusOne = promotions
    .filter((promotion) => promotion.type === 'N_PLUS_ONE')
    .sort(comparePromotionDisplayOrder)
    .map((promotion) => ({
      key: `nplus:${promotion.promotionId}`,
      label: promotionBadgeLabel(promotion, currencyUnit),
      fullName: promotion.name,
    }));
  const discounts = promotions
    .filter((promotion) => promotion.type !== 'N_PLUS_ONE')
    .sort(comparePromotionDisplayOrder);
  const pills = discounts.length === 0 ? nPlusOne : [...nPlusOne, {
    key: 'discounts:aggregate',
    label: '할인',
    fullName: discounts.map((promotion) => promotion.name).join(' · '),
  }];

  return (
    <div role="list" aria-label={ariaLabel} className={`flex flex-wrap gap-1 ${className}`}>
      {pills.map((pill) => (
        <span
          key={pill.key}
          role="listitem"
          aria-label={`${pill.label}: ${pill.fullName}`}
          title={pill.fullName}
          className={`max-w-full whitespace-normal break-words rounded-full px-2.5 py-1 text-[clamp(0.62rem,2.4vw,1.125rem)] font-black leading-tight shadow-sm ${pillClassName}`}
        >
          {pill.label}
        </span>
      ))}
    </div>
  );
}
