'use client';

import {
  DIGITAL_DESCRIPTION_LENGTH, DIGITAL_KIND_LABELS, DIGITAL_KINDS, type DigitalKind, type DigitalProductDto,
} from '@/lib/studentBagApi';
import { Field, Select, Switch, Textarea } from '../ui';
import type { DigitalProductSetting } from './bagClient';

/* The 디지털 상품 settings inside the store product editor (PostgreSQL classes). */

export type DigitalDraft = Readonly<{ enabled: boolean; kind: DigitalKind; description: string }>;
export const EMPTY_DIGITAL_DRAFT: DigitalDraft = { enabled: false, kind: 'CONSUMABLE', description: '' };

const KIND_HINTS: Readonly<Record<DigitalKind, string>> = {
  CONSUMABLE: '쓰면 없어지는 아이템이에요(쿠폰 등). 학생이 쓰겠다고 하면 학생 정보의 보관함에서 \'사용함\'을 눌러 주세요.',
  COLLECTIBLE: '쓰지 않고 모아 두는 소장품이에요(배지, 상장 등). 학생이 보관함에서 누르면 큰 그림과 설명을 볼 수 있어요.',
};

export function digitalDraftOf(product: DigitalProductDto | undefined): DigitalDraft {
  return product
    ? { enabled: true, kind: product.kind, description: product.description }
    : EMPTY_DIGITAL_DRAFT;
}

/** The setting to save, or an error message to show. */
export function digitalSettingOf(draft: DigitalDraft): { ok: true; setting: DigitalProductSetting } | { ok: false; error: string } {
  if (!draft.enabled) return { ok: true, setting: null };
  if ([...draft.description.trim()].length > DIGITAL_DESCRIPTION_LENGTH) return { ok: false, error: `설명은 ${DIGITAL_DESCRIPTION_LENGTH}자까지 쓸 수 있어요.` };
  return { ok: true, setting: { kind: draft.kind, description: draft.description.trim() } };
}

export const sameDigitalDraft = (left: DigitalDraft, right: DigitalDraft) => left.enabled === right.enabled && (!left.enabled
  || (left.kind === right.kind && left.description.trim() === right.description.trim()));

export function DigitalProductFields({ idPrefix, ariaPrefix, value, onChange, disabled = false }: Readonly<{
  idPrefix: string; ariaPrefix: string; value: DigitalDraft; onChange: (patch: Partial<DigitalDraft>) => void; disabled?: boolean;
}>) {
  const length = [...value.description].length;
  return (
    <div className="space-y-4">
      <Switch checked={value.enabled} disabled={disabled} ariaLabel={`${ariaPrefix} 디지털 상품`} onChange={(enabled) => onChange({ enabled })}
        label="디지털 상품" description="구입하면 개인 보관함에 저장돼요." />
      <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">
        교환권은 매점에서 팔지 않아요. 실물 상품의 교환권은 학생 정보의 보관함에서 넣어 주거나 학급 나무 수확 보상으로 줄 수 있어요.
      </p>
      {value.enabled ? (
        <>
          <Field label="디지털 상품 유형" htmlFor={`${idPrefix}-digital-kind`} hint={KIND_HINTS[value.kind]}>
            <Select id={`${idPrefix}-digital-kind`} value={value.kind} disabled={disabled}
              onChange={(event) => onChange({ kind: event.target.value as DigitalKind })}>
              {DIGITAL_KINDS.map((kind) => <option key={kind} value={kind}>{DIGITAL_KIND_LABELS[kind]}</option>)}
            </Select>
          </Field>
          <Field label="보관함 설명" htmlFor={`${idPrefix}-digital-description`} optional
            hint={`학생이 보관함에서 이 아이템을 누르면 보여요. ${length}/${DIGITAL_DESCRIPTION_LENGTH}자`}>
            <Textarea id={`${idPrefix}-digital-description`} rows={3} value={value.description} disabled={disabled} maxLength={DIGITAL_DESCRIPTION_LENGTH}
              placeholder={value.kind === 'COLLECTIBLE' ? '예) 1학기 동안 과제를 모두 해낸 친구에게 주는 배지예요.' : '예) 원하는 자리로 일주일 동안 옮길 수 있어요.'}
              onChange={(event) => onChange({ description: event.target.value })} />
          </Field>
        </>
      ) : null}
    </div>
  );
}
