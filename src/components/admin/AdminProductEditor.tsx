'use client';

/* eslint-disable @next/next/no-img-element */
import { Field, Icon, Input, Switch } from '../ui';
import type { ReactNode } from 'react';
import type { NewProductDraft } from './adminTypes';

export function ProductThumb({ name, imageUrl }: { name: string; imageUrl?: string }) {
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[var(--crs-line)] bg-[var(--crs-subtle)] text-[var(--theme-muted-text)]">
      {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span aria-hidden="true" className="text-sm font-black">{name.trim().slice(0, 1) || '?'}</span>}
    </span>
  );
}

export function ProductFields({ idPrefix, labelPrefix, values, categories, unit, onChange, digital }: {
  idPrefix: string;
  labelPrefix: string;
  values: NewProductDraft;
  categories: string[];
  unit: string;
  onChange: (patch: Partial<NewProductDraft>) => void;
  /** PostgreSQL classes: the 디지털 상품 settings (buying one puts it into the buyer's 보관함). */
  digital?: ReactNode;
}) {
  const isNew = labelPrefix === '새 상품';
  const label = (field: string) => isNew ? `새 상품 ${field}` : `${labelPrefix} ${field}`;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[16px] border border-[var(--crs-line)] bg-[var(--crs-subtle)] text-[var(--theme-muted-text)]">
          {values.imageUrl ? <img src={values.imageUrl} alt="상품 이미지 미리보기" className="h-full w-full object-cover" /> : <Icon name="box" size={26} />}
        </span>
        <Field label="이미지 주소" htmlFor={`${idPrefix}-image`} optional className="flex-1"
          hint="인터넷 이미지에서 마우스 오른쪽 버튼 → '이미지 주소 복사' 후 붙여 넣으세요.">
          <Input id={`${idPrefix}-image`} aria-label={isNew ? '새 상품 이미지 주소' : `${labelPrefix} 이미지 주소`} placeholder="https://" value={values.imageUrl} onChange={(event) => onChange({ imageUrl: event.target.value })} />
        </Field>
      </div>
      <Field label="상품 이름" htmlFor={`${idPrefix}-name`}>
        <Input id={`${idPrefix}-name`} aria-label={isNew ? '새 상품명' : `${labelPrefix} 상품명`} data-autofocus required value={values.name} onChange={(event) => onChange({ name: event.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="가격" htmlFor={`${idPrefix}-price`}>
          <Input id={`${idPrefix}-price`} aria-label={label('가격')} type="number" inputMode="numeric" min="0" suffix={unit} value={Number.isFinite(values.price) ? values.price : 0} onChange={(event) => onChange({ price: Number(event.target.value) })} />
        </Field>
        <Field label="재고" htmlFor={`${idPrefix}-stock`}>
          <Input id={`${idPrefix}-stock`} aria-label={label('재고')} type="number" inputMode="numeric" min="0" suffix="개" value={Number.isFinite(values.stock) ? values.stock : 0} onChange={(event) => onChange({ stock: Number(event.target.value) })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="분류" htmlFor={`${idPrefix}-category`} optional hint="매점 화면의 분류 탭이 됩니다.">
          <Input id={`${idPrefix}-category`} aria-label={label('카테고리')} list={`${idPrefix}-categories`} placeholder="간식" value={values.category} onChange={(event) => onChange({ category: event.target.value })} />
          <datalist id={`${idPrefix}-categories`}>{categories.map((category) => <option key={category} value={category} />)}</datalist>
        </Field>
        <Field label="목록 순서" htmlFor={`${idPrefix}-order`} hint="작은 숫자가 앞에 보입니다.">
          <Input id={`${idPrefix}-order`} aria-label={label('정렬')} type="number" inputMode="numeric" value={Number.isFinite(values.sortOrder) ? values.sortOrder : 0} onChange={(event) => onChange({ sortOrder: Number(event.target.value) })} />
        </Field>
      </div>
      <Switch checked={Boolean(values.isActive)} ariaLabel={isNew ? '새 상품 판매중' : `${labelPrefix} 판매중`} onChange={(checked) => onChange({ isActive: checked })}
        label="판매 중" description="끄면 매점 화면에서 이 상품이 숨겨집니다." />
      {digital ?? null}
    </div>
  );
}
