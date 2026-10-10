'use client';

import { DIGITAL_KIND_LABELS, MAX_TEACHER_GIVE, VOUCHER_SUFFIX, type DigitalKind } from '@/lib/studentBagApi';
import { Field, Select } from '../ui';

/** A store product the teacher can put into a 보관함: a digital product as itself, any other as its 교환권. */
export type GiveOption = Readonly<{ productId: string; name: string; kind: DigitalKind | null; isActive: boolean }>;

/** What lands in the 보관함 for this product, in the teacher's words. */
export function giveOptionItemName(option: GiveOption): string {
  return option.kind === null ? `${option.name}${VOUCHER_SUFFIX}` : option.name;
}

/** The product and count pickers shared by one student's 보관함 and the class list's bulk give. */
export function GiveProductFields({ idPrefix, options, productId, count, onProductChange, onCountChange, disabled = false }: Readonly<{
  idPrefix: string; options: readonly GiveOption[]; productId: string; count: number;
  onProductChange: (productId: string) => void; onCountChange: (count: number) => void; disabled?: boolean;
}>) {
  const digital = options.filter((option) => option.kind !== null);
  const physical = options.filter((option) => option.kind === null);
  const label = (option: GiveOption) => `${option.kind === null ? giveOptionItemName(option) : `${option.name} (${DIGITAL_KIND_LABELS[option.kind]})`}${option.isActive ? '' : ' · 판매 중지'}`;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="넣을 아이템" htmlFor={`${idPrefix}-product`} className="min-w-[180px] flex-1">
        <Select id={`${idPrefix}-product`} value={productId} onChange={(event) => onProductChange(event.target.value)} disabled={disabled}>
          <option value="">상품 고르기</option>
          {digital.length > 0 ? (
            <optgroup label="디지털 상품 (그대로 넣어요)">
              {digital.map((option) => <option key={option.productId} value={option.productId}>{label(option)}</option>)}
            </optgroup>
          ) : null}
          {physical.length > 0 ? (
            <optgroup label="실물 상품 (교환권으로 넣어요)">
              {physical.map((option) => <option key={option.productId} value={option.productId}>{label(option)}</option>)}
            </optgroup>
          ) : null}
        </Select>
      </Field>
      <Field label="개수" htmlFor={`${idPrefix}-count`} className="w-24">
        <Select id={`${idPrefix}-count`} value={count} onChange={(event) => onCountChange(Number(event.target.value))} disabled={disabled}>
          {Array.from({ length: MAX_TEACHER_GIVE }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}개</option>)}
        </Select>
      </Field>
    </div>
  );
}
