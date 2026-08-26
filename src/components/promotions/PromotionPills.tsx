import type { Promotion } from '@/domain/types';
import { promotionBadgeLabel } from '@/lib/promotionClient';

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

  return (
    <div aria-label={ariaLabel} className={`flex flex-wrap gap-1 ${className}`}>
      {promotions.map((promotion) => (
        <span
          key={promotion.promotionId}
          className={`rounded-full px-1.5 py-0.5 text-[clamp(0.5rem,1.6vw,0.7rem)] font-black shadow-sm ${pillClassName}`}
        >
          {promotionBadgeLabel(promotion, currencyUnit)}
        </span>
      ))}
    </div>
  );
}
