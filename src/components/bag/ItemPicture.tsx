'use client';

/* eslint-disable @next/next/no-img-element */
import type { BagItemKind } from '@/lib/studentBagApi';
import { Icon } from '../ui';

/** A storage item's picture: the product's image when it has one, otherwise an icon; 교환권 and 수집품 get a small tag. */
export function ItemPicture({ imageUrl, kind, voucher = false, size = 44, dimmed = false }: Readonly<{
  imageUrl: string | null; kind: BagItemKind; voucher?: boolean; size?: number; dimmed?: boolean;
}>) {
  const tag = kind === 'COLLECTIBLE' ? '수집품' : voucher ? '교환권' : '';
  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[var(--crs-line)] bg-[var(--crs-subtle)] ${dimmed ? 'opacity-60 grayscale' : ''}`}
      style={{ width: size, height: size }}>
      {imageUrl
        ? <img src={imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        : <Icon name={kind === 'COLLECTIBLE' ? 'sparkle' : 'ticket'} size={Math.round(size * 0.5)} className="text-[var(--theme-accent-text)]" />}
      {tag && size >= 40 ? (
        <span className="absolute inset-x-0 bottom-0 bg-[var(--theme-accent-solid)] py-px text-center text-[10px] font-black leading-tight text-[var(--theme-accent-on-solid)]">
          {tag}
        </span>
      ) : null}
    </span>
  );
}
