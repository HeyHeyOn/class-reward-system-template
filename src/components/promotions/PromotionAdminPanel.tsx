'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { Product, Promotion } from '@/domain/types';
import {
  comparePromotionDisplayOrder,
  parsePromotionListResponse,
  parsePromotionResponse,
} from '@/lib/promotionClient';

export { parsePromotionResponse } from '@/lib/promotionClient';
export const comparePromotions = comparePromotionDisplayOrder;

type PromotionType = Promotion['type'];
type Draft = {
  name: string;
  description: string;
  type: PromotionType;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: number;
  productIds: string[];
  buyQuantity: number;
  freeQuantity: number;
  promotionalUnitPrice: number;
  percent: number;
  discountAmount: number;
};

type Props = { products: Product[]; currencyUnit: string; timeZone: string };

const EMPTY_DRAFT: Draft = {
  name: '', description: '', type: 'N_PLUS_ONE', startsAt: '', endsAt: '', isActive: true, sortOrder: 1, productIds: [],
  buyQuantity: 2, freeQuantity: 1, promotionalUnitPrice: 0, percent: 10, discountAmount: 1,
};
const TYPE_LABELS: Record<PromotionType, string> = {
  N_PLUS_ONE: 'N+1', PROMOTIONAL_PRICE: '행사 가격', PERCENT_DISCOUNT: '퍼센트 할인', FIXED_DISCOUNT: '정액 할인',
};
const DRAFT_ID = '__PROMOTION_ADMIN_DRAFT__';

type WallClockParts = { year: number; month: number; day: number; hour: number; minute: number };
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function utcEpoch(parts: WallClockParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, 0, 0);
  return date.getTime();
}

function parseWallClock(value: string): WallClockParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const date = new Date(utcEpoch(parts));
  return date.getUTCFullYear() === parts.year && date.getUTCMonth() + 1 === parts.month
    && date.getUTCDate() === parts.day && date.getUTCHours() === parts.hour
    && date.getUTCMinutes() === parts.minute ? parts : null;
}

function zonedParts(epochMs: number, timeZone: string): WallClockParts | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const values = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
    const parts = {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      hour: Number(values.hour), minute: Number(values.minute),
    };
    return Object.values(parts).every(Number.isFinite) ? parts : null;
  } catch {
    return null;
  }
}

function sameWallClock(left: WallClockParts, right: WallClockParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

export function zonedDatetimeLocalToIso(value: string, timeZone: string): string | null {
  const wanted = parseWallClock(value);
  if (!wanted) return null;
  const wantedEpoch = utcEpoch(wanted);
  let candidate = wantedEpoch;
  let matched = false;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const observed = zonedParts(candidate, timeZone);
    if (!observed) return null;
    if (sameWallClock(observed, wanted)) {
      matched = true;
      break;
    }
    candidate += wantedEpoch - utcEpoch(observed);
  }
  if (!matched) return null;

  const possibleInstants = new Set<number>();
  for (const sample of [candidate - 86_400_000, candidate, candidate + 86_400_000]) {
    const sampleParts = zonedParts(sample, timeZone);
    if (!sampleParts) return null;
    const offset = utcEpoch(sampleParts) - sample;
    const alternative = wantedEpoch - offset;
    const alternativeParts = zonedParts(alternative, timeZone);
    if (alternativeParts && sameWallClock(alternativeParts, wanted)) possibleInstants.add(alternative);
  }
  return possibleInstants.size === 1 ? new Date([...possibleInstants][0]).toISOString() : null;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_ISO.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function isoToZonedDatetimeLocal(value: string, timeZone: string): string {
  if (!isCanonicalIso(value)) return '';
  const parts = zonedParts(Date.parse(value), timeZone);
  return parts
    ? `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
    : '';
}

function canonicalPromotionOrder(promotions: Promotion[]): Promotion[] {
  return [...promotions].sort(comparePromotions);
}

function draftFromPromotion(promotion: Promotion): Draft {
  return {
    ...EMPTY_DRAFT,
    name: promotion.name,
    description: promotion.description,
    type: promotion.type,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isActive: promotion.isActive,
    sortOrder: promotion.sortOrder,
    productIds: [...promotion.productIds],
    ...promotion.type === 'N_PLUS_ONE' ? { buyQuantity: promotion.buyQuantity, freeQuantity: promotion.freeQuantity } : {},
    ...promotion.type === 'PROMOTIONAL_PRICE' ? { promotionalUnitPrice: promotion.promotionalUnitPrice } : {},
    ...promotion.type === 'PERCENT_DISCOUNT' ? { percent: promotion.percent } : {},
    ...promotion.type === 'FIXED_DISCOUNT' ? { discountAmount: promotion.discountAmount } : {},
  };
}

function exactPayload(draft: Draft) {
  const common = {
    name: draft.name.trim(), description: draft.description, startsAt: draft.startsAt, endsAt: draft.endsAt,
    isActive: draft.isActive, sortOrder: draft.sortOrder, type: draft.type, productIds: draft.productIds,
  };
  switch (draft.type) {
    case 'N_PLUS_ONE': return { ...common, buyQuantity: draft.buyQuantity, freeQuantity: draft.freeQuantity };
    case 'PROMOTIONAL_PRICE': return { ...common, promotionalUnitPrice: draft.promotionalUnitPrice };
    case 'PERCENT_DISCOUNT': return { ...common, percent: draft.percent };
    case 'FIXED_DISCOUNT': return { ...common, discountAmount: draft.discountAmount };
  }
}

function draftPromotion(draft: Draft, promotionId: string): Promotion {
  const metadata = { promotionId, createdAt: draft.startsAt, updatedAt: draft.startsAt, schemaVersion: 3 };
  return { ...exactPayload(draft), ...metadata } as Promotion;
}

function validateDraft(draft: Draft): string | null {
  if (!draft.name.trim()) return '행사명을 입력해 주세요.';
  if (!draft.startsAt || !draft.endsAt) return '시작 일시와 종료 일시를 입력해 주세요.';
  if (!isCanonicalIso(draft.startsAt) || !isCanonicalIso(draft.endsAt)) return '행사 기간이 올바르지 않습니다.';
  const starts = Date.parse(draft.startsAt);
  const ends = Date.parse(draft.endsAt);
  if (starts >= ends) return '시작 일시는 종료 일시보다 빨라야 합니다.';
  if (!Number.isSafeInteger(draft.sortOrder)) return '정렬 우선순위는 정수여야 합니다.';
  if (draft.productIds.length === 0) return '대상 상품을 하나 이상 선택해 주세요.';
  if (draft.type === 'N_PLUS_ONE' && (!Number.isSafeInteger(draft.buyQuantity) || draft.buyQuantity < 1 || !Number.isSafeInteger(draft.freeQuantity) || draft.freeQuantity < 1)) return '구매/무료 수량은 1 이상의 정수여야 합니다.';
  if (draft.type === 'PROMOTIONAL_PRICE' && (!Number.isSafeInteger(draft.promotionalUnitPrice) || draft.promotionalUnitPrice < 0)) return '행사 단가는 0 이상의 정수여야 합니다.';
  if (draft.type === 'PERCENT_DISCOUNT' && (!Number.isFinite(draft.percent) || draft.percent <= 0 || draft.percent > 100)) return '할인율은 0 초과 100 이하여야 합니다.';
  if (draft.type === 'FIXED_DISCOUNT' && (!Number.isSafeInteger(draft.discountAmount) || draft.discountAmount < 1)) return '할인액은 1 이상의 정수여야 합니다.';
  return null;
}

export function PromotionAdminPanel({ products, currencyUnit, timeZone }: Props) {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [previewProductId, setPreviewProductId] = useState('');
  const [previewQuantity, setPreviewQuantity] = useState(1);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const promotionsRef = useRef<Promotion[]>([]);

  const loadPromotions = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetch('/api/promotions', { cache: 'no-store' });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, '행사 목록을 불러오지 못했습니다.'));
      const parsed = parsePromotionListResponse(payload);
      if (!parsed) throw new Error('행사 목록 형식이 올바르지 않습니다.');
      if (mountedRef.current && loadGenerationRef.current === generation) {
        const ordered = canonicalPromotionOrder(parsed);
        promotionsRef.current = ordered;
        setPromotions(ordered);
      }
    } catch (error) {
      if (mountedRef.current && loadGenerationRef.current === generation) {
        setLoadError(error instanceof Error ? error.message : '행사 목록을 불러오지 못했습니다.');
      }
    } finally {
      if (mountedRef.current && loadGenerationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(loadPromotions);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      mutationInFlightRef.current = false;
    };
  }, [loadPromotions]);

  const preview = useMemo(() => {
    if (!previewProductId) return null;
    const product = products.find((item) => item.productId === previewProductId);
    if (!product) return { ok: false as const, message: '미리보기 상품을 찾을 수 없습니다.' };
    const error = validateDraft(draft);
    if (error) return { ok: false as const, message: error };
    const currentId = editingId ?? DRAFT_ID;
    const combined = editingId
      ? promotions.map((promotion) => promotion.promotionId === editingId ? draftPromotion(draft, currentId) : promotion)
      : [...promotions, draftPromotion(draft, currentId)];
    return calculatePromotionPrice({
      productId: product.productId,
      quantity: previewQuantity,
      regularUnitPrice: product.price,
      now: new Date(draft.startsAt),
      promotions: combined,
    });
  }, [draft, editingId, previewProductId, previewQuantity, products, promotions]);

  function changeDate(field: 'startsAt' | 'endsAt', value: string) {
    setDraft((current) => ({ ...current, [field]: value ? (zonedDatetimeLocalToIso(value, timeZone) ?? value) : '' }));
  }

  function toggleProduct(productId: string) {
    setDraft((current) => ({
      ...current,
      productIds: current.productIds.includes(productId)
        ? current.productIds.filter((id) => id !== productId)
        : [...current.productIds, productId],
    }));
  }

  function edit(promotion: Promotion) {
    setEditingId(promotion.promotionId);
    setDraft(draftFromPromotion(promotion));
    setFormError('');
    setMessage('');
  }

  function resetForm() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mountedRef.current || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setMessage('');
    const error = validateDraft(draft);
    if (error) {
      setFormError(error);
      if (mutationGenerationRef.current === mutationGeneration) mutationInFlightRef.current = false;
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const response = await fetch(editingId ? `/api/promotions/${encodeURIComponent(editingId)}` : '/api/promotions', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exactPayload(draft)),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, editingId ? '행사를 수정하지 못했습니다.' : '행사를 추가하지 못했습니다.'));
      const returned = parsePromotionResponse(payload);
      if (!returned) throw new Error('행사 응답 형식이 올바르지 않습니다.');
      if (editingId ? returned.promotionId !== editingId : promotionsRef.current.some((promotion) => promotion.promotionId === returned.promotionId)) {
        throw new Error('행사 응답 ID가 올바르지 않습니다.');
      }
      if (!mountedRef.current || mutationGenerationRef.current !== mutationGeneration) return;
      const nextPromotions = canonicalPromotionOrder(editingId
        ? promotionsRef.current.map((promotion) => promotion.promotionId === editingId ? returned : promotion)
        : [...promotionsRef.current, returned]);
      loadGenerationRef.current += 1;
      promotionsRef.current = nextPromotions;
      setPromotions(nextPromotions);
      setLoading(false);
      setLoadError('');
      setMessage(editingId ? '행사를 수정했습니다.' : '행사를 추가했습니다.');
      resetForm();
    } catch (caught) {
      if (mountedRef.current && mutationGenerationRef.current === mutationGeneration) {
        setFormError(caught instanceof Error ? caught.message : '행사를 저장하지 못했습니다.');
      }
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    }
  }

  async function toggleActivation(promotion: Promotion) {
    if (!mountedRef.current || mutationInFlightRef.current) return;
    const next = !promotion.isActive;
    if (!next && !window.confirm(`${promotion.name} 행사를 비활성화할까요?`)) return;
    mutationInFlightRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setSaving(true);
    setMessage('');
    setFormError('');
    try {
      const response = await fetch(`/api/promotions/${encodeURIComponent(promotion.promotionId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: next }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, '행사 활성 상태를 변경하지 못했습니다.'));
      const returned = parsePromotionResponse(payload);
      if (!returned) throw new Error('행사 응답 형식이 올바르지 않습니다.');
      if (returned.promotionId !== promotion.promotionId) throw new Error('행사 응답 ID가 올바르지 않습니다.');
      if (!mountedRef.current || mutationGenerationRef.current !== mutationGeneration) return;
      const nextPromotions = canonicalPromotionOrder(promotionsRef.current.map((item) => item.promotionId === promotion.promotionId ? returned : item));
      loadGenerationRef.current += 1;
      promotionsRef.current = nextPromotions;
      setPromotions(nextPromotions);
      setLoading(false);
      setLoadError('');
      setMessage(next ? '행사를 재활성화했습니다.' : '행사를 비활성화했습니다.');
    } catch (caught) {
      if (mountedRef.current && mutationGenerationRef.current === mutationGeneration) {
        setFormError(caught instanceof Error ? caught.message : '행사 활성 상태를 변경하지 못했습니다.');
      }
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    }
  }

  const productNames = new Map(products.map((product) => [product.productId, product.name]));
  const promotionNames = new Map(promotions.map((promotion) => [promotion.promotionId, promotion.name]));
  if (editingId) promotionNames.set(editingId, draft.name);
  promotionNames.set(DRAFT_ID, draft.name || '작성 중 행사');

  return (
    <section aria-label="행사 관리" className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-black">{editingId ? '행사 편집' : '행사 만들기'}</h2>
        <form className="mt-3" onSubmit={submit}>
          <fieldset aria-label="행사 편집 입력" className="space-y-2" disabled={saving}>
          <TextField label="행사명" value={draft.name} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} />
          <label className="block text-xs font-bold">행사 설명<textarea aria-label="행사 설명" className="mt-1 min-h-16 w-full rounded-lg border p-2" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="block text-xs font-bold">행사 유형<select aria-label="행사 유형" className="mt-1 w-full rounded-lg border p-2" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as PromotionType }))}>
            {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <div className="grid grid-cols-2 gap-2">
            {draft.type === 'N_PLUS_ONE' ? <><NumberField label="구매 수량" value={draft.buyQuantity} min={1} onChange={(value) => setDraft((current) => ({ ...current, buyQuantity: value }))} /><NumberField label="무료 수량" value={draft.freeQuantity} min={1} onChange={(value) => setDraft((current) => ({ ...current, freeQuantity: value }))} /></> : null}
            {draft.type === 'PROMOTIONAL_PRICE' ? <NumberField label="행사 단가" value={draft.promotionalUnitPrice} min={0} onChange={(value) => setDraft((current) => ({ ...current, promotionalUnitPrice: value }))} /> : null}
            {draft.type === 'PERCENT_DISCOUNT' ? <NumberField label="할인율" value={draft.percent} min={0} step="any" onChange={(value) => setDraft((current) => ({ ...current, percent: value }))} /> : null}
            {draft.type === 'FIXED_DISCOUNT' ? <NumberField label="유료 수량당 할인액" value={draft.discountAmount} min={1} onChange={(value) => setDraft((current) => ({ ...current, discountAmount: value }))} /> : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <DateField label="시작 일시" value={isoToZonedDatetimeLocal(draft.startsAt, timeZone)} onChange={(value) => changeDate('startsAt', value)} />
            <DateField label="종료 일시" value={isoToZonedDatetimeLocal(draft.endsAt, timeZone)} onChange={(value) => changeDate('endsAt', value)} />
          </div>
          <NumberField label="정렬 우선순위" value={draft.sortOrder} onChange={(value) => setDraft((current) => ({ ...current, sortOrder: value }))} />
          <label className="flex gap-2 text-sm font-bold"><input aria-label="행사 활성" type="checkbox" checked={draft.isActive} onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} />활성</label>
          <fieldset className="rounded-lg border p-2"><legend className="px-1 text-xs font-black">대상 상품</legend>
            <div className="grid gap-1 sm:grid-cols-2">{products.map((product) => <label key={product.productId} className="flex gap-2 text-xs"><input aria-label={`${product.name} (${product.productId}) 대상`} type="checkbox" checked={draft.productIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} />{product.name} ({product.productId})</label>)}</div>
          </fieldset>
          {formError ? <p role="alert" className="rounded-lg bg-rose-100 p-2 text-sm font-bold text-rose-700">{formError}</p> : null}
          {message ? <p role="status" className="rounded-lg bg-emerald-100 p-2 text-sm font-bold text-emerald-800">{message}</p> : null}
          {saving ? <p role="status" aria-label="행사 저장 중" className="text-sm font-bold">저장 중…</p> : null}
          <div className="flex gap-2"><button disabled={saving} className="flex-1 rounded-lg bg-slate-950 p-2 font-black text-white disabled:opacity-50" type="submit">{editingId ? '행사 수정 저장' : '행사 추가'}</button>{editingId ? <button disabled={saving} className="rounded-lg bg-slate-200 px-3 font-bold disabled:opacity-50" type="button" onClick={resetForm}>편집 취소</button> : null}</div>
          </fieldset>
        </form>

        <div className="mt-4 border-t pt-3">
          <h3 className="font-black">가격 미리보기</h3>
          <fieldset aria-label="가격 미리보기 입력" className="mt-2 grid grid-cols-2 gap-2" disabled={saving}><label className="text-xs font-bold">미리보기 상품<select aria-label="미리보기 상품" className="mt-1 w-full rounded-lg border p-2" value={previewProductId} onChange={(event) => setPreviewProductId(event.target.value)}><option value="">선택</option>{products.map((product) => <option key={product.productId} value={product.productId}>{product.name}</option>)}</select></label><NumberField label="총 수령 수량" value={previewQuantity} min={1} onChange={setPreviewQuantity} /></fieldset>
          {preview ? <PreviewResult preview={preview} names={promotionNames} currencyUnit={currencyUnit} /> : <p className="mt-2 text-xs text-slate-500">상품과 행사 설정을 입력하면 예상 가격을 계산합니다.</p>}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-black">행사 목록</h2><button type="button" aria-label="행사 목록 새로고침" className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-black" onClick={() => void loadPromotions()}>새로고침</button></div>
        {loading ? <p role="status" aria-label="행사 목록 불러오는 중" className="mt-3">행사 목록을 불러오는 중입니다.</p> : null}
        {!loading && loadError ? <div role="alert" className="mt-3 rounded-lg bg-rose-100 p-3 text-rose-700"><p>{loadError}</p><button type="button" className="mt-2 rounded bg-white px-3 py-1 font-bold" onClick={() => void loadPromotions()}>다시 시도</button></div> : null}
        {!loading && !loadError && promotions.length === 0 ? <p className="mt-3 rounded-lg bg-slate-50 p-3">등록된 행사가 없습니다.</p> : null}
        {!loading && !loadError ? <div className="mt-3 space-y-2">{promotions.map((promotion) => <article data-testid="promotion-row" key={promotion.promotionId} className="rounded-xl border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-black">{promotion.name} <span className="text-xs text-slate-500">{promotion.promotionId}</span></h3><p>{TYPE_LABELS[promotion.type]} · {promotion.isActive ? '활성' : '비활성'} · 우선순위 {promotion.sortOrder}</p></div><div className="flex gap-1"><button disabled={saving} type="button" aria-label={`${promotion.name} 편집`} className="rounded bg-sky-100 px-2 py-1 font-bold disabled:opacity-50" onClick={() => edit(promotion)}>편집</button><button disabled={saving} type="button" aria-label={`${promotion.name} ${promotion.isActive ? '비활성화' : '재활성화'}`} className="rounded bg-amber-100 px-2 py-1 font-bold disabled:opacity-50" onClick={() => void toggleActivation(promotion)}>{promotion.isActive ? '비활성화' : '재활성화'}</button></div></div>
          <p className="mt-1">{formatPeriod(promotion.startsAt, promotion.endsAt)}</p><p>{promotion.productIds.map((id) => productNames.get(id) ?? id).join(', ') || '대상 상품 없음'}</p><p className="font-bold">{ruleSummary(promotion, currencyUnit)}</p>{promotion.description ? <p className="text-slate-600">{promotion.description}</p> : null}
        </article>)}</div> : null}
      </div>
    </section>
  );
}

function PreviewResult({ preview, names, currencyUnit }: { preview: ReturnType<typeof calculatePromotionPrice> | { ok: false; message: string }; names: Map<string, string>; currencyUnit: string }) {
  if (!preview.ok) return <div role="region" aria-label="가격 미리보기 결과" className="mt-2 rounded-lg bg-rose-50 p-2"><p role="alert">가격 계산 오류: {preview.message}</p></div>;
  return <div role="region" aria-label="가격 미리보기 결과" className="mt-2 rounded-lg bg-slate-50 p-2 text-xs"><p>정상 합계 {money(preview.regularTotal, currencyUnit)}</p><p className="font-black">최종 합계 {money(preview.finalAmount, currencyUnit)}</p><p>유료 {preview.paidQuantity}개 · 무료 {preview.freeQuantity}개 · 할인 합계 {money(preview.totalDiscount, currencyUnit)}</p><ol className="mt-1 list-decimal pl-4">{preview.adjustments.map((adjustment) => <li data-testid="preview-adjustment" key={`${adjustment.promotionId}-${adjustment.type}`}>{names.get(adjustment.promotionId) ?? adjustment.promotionId} ({TYPE_LABELS[adjustment.type]}): {money(adjustment.beforeAmount, currencyUnit)} → {money(adjustment.afterAmount, currencyUnit)}{adjustment.freeQuantity ? ` · 무료 ${adjustment.freeQuantity}개` : ''}</li>)}</ol></div>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="block text-xs font-bold">{label}<input aria-label={label} className="mt-1 w-full rounded-lg border p-2" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function NumberField({ label, value, min, step = 1, onChange }: { label: string; value: number; min?: number; step?: number | 'any'; onChange: (value: number) => void }) { return <label className="block text-xs font-bold">{label}<input aria-label={label} className="mt-1 w-full rounded-lg border p-2" type="number" step={step} min={min} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="block text-xs font-bold">{label}<input aria-label={label} className="mt-1 w-full rounded-lg border p-2" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function readError(payload: unknown, fallback: string) { return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : fallback; }
function money(value: number, currencyUnit: string) { return `${value.toLocaleString('ko-KR')}${currencyUnit}`; }
function formatPeriod(startsAt: string, endsAt: string) { return `${startsAt} ~ ${endsAt}`; }
function ruleSummary(promotion: Promotion, currencyUnit: string) {
  switch (promotion.type) {
    case 'N_PLUS_ONE': return `${promotion.buyQuantity}개 구매 + ${promotion.freeQuantity}개 무료`;
    case 'PROMOTIONAL_PRICE': return `개당 ${money(promotion.promotionalUnitPrice, currencyUnit)}`;
    case 'PERCENT_DISCOUNT': return `${promotion.percent}% 할인`;
    case 'FIXED_DISCOUNT': return `유료 1개당 ${money(promotion.discountAmount, currencyUnit)} 할인`;
  }
}
