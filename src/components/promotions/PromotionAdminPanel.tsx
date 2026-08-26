'use client';

import { FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { Product, Promotion } from '@/domain/types';
import {
  comparePromotionDisplayOrder,
  parsePromotionListResponse,
  parsePromotionResponse,
} from '@/lib/promotionClient';
import { normalizeThemeColor, themeStyles, type ThemeColor } from '../uiTheme';

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

type Props = { products: Product[]; currencyUnit: string; timeZone: string; themeColor?: ThemeColor };

const EMPTY_DRAFT: Draft = {
  name: '', description: '', type: 'N_PLUS_ONE', startsAt: '', endsAt: '', isActive: true, sortOrder: 1, productIds: [],
  buyQuantity: 2, freeQuantity: 1, promotionalUnitPrice: 0, percent: 10, discountAmount: 1,
};
const TYPE_LABELS: Record<PromotionType, string> = {
  N_PLUS_ONE: 'N+1', PROMOTIONAL_PRICE: '행사 가격', PERCENT_DISCOUNT: '퍼센트 할인', FIXED_DISCOUNT: '정액 할인',
};
const DRAFT_ID = '__PROMOTION_ADMIN_DRAFT__';
const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

function trapDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

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

const UNKNOWN_PRODUCT_LABEL = '알 수 없는 상품';

function summarizeProductTargets(productIds: string[], productNames: Map<string, string>) {
  const labels = [...new Set(productIds.map((productId) => productNames.get(productId) ?? UNKNOWN_PRODUCT_LABEL))];
  const visibleLabels = labels.slice(0, 2);
  const remainingTargetCount = productIds.length - visibleLabels.length;
  const summary = visibleLabels.length === 1 && remainingTargetCount > 0
    ? `${visibleLabels[0]} 외 ${remainingTargetCount}개`
    : `${visibleLabels.join(', ')}${remainingTargetCount > 0 ? ` +${remainingTargetCount}` : ''}`;
  const title = `${labels.join(', ')}${labels.length < productIds.length ? ` (총 ${productIds.length}개)` : ''}`;
  return { summary, title };
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

export function PromotionAdminPanel({ products, currencyUnit, timeZone, themeColor = 'white' }: Props) {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [editError, setEditError] = useState('');
  const [previewProductId, setPreviewProductId] = useState('');
  const [previewQuantity, setPreviewQuantity] = useState(1);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const promotionsRef = useRef<Promotion[]>([]);
  const editGenerationRef = useRef(0);
  const editOpenerRef = useRef<HTMLButtonElement | null>(null);
  const editNameRef = useRef<HTMLInputElement | null>(null);
  const editSaveRef = useRef<HTMLButtonElement | null>(null);
  const editDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const normalizedTheme = normalizeThemeColor(themeColor);
  const theme = themeStyles(normalizedTheme);

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
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void loadPromotions();
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      mutationInFlightRef.current = false;
    };
  }, [loadPromotions]);

  useEffect(() => {
    if (editingId) {
      editNameRef.current?.focus();
      return;
    }
    const opener = editOpenerRef.current;
    editOpenerRef.current = null;
    opener?.focus();
  }, [editingId]);

  useEffect(() => {
    if (deleteTarget) {
      deleteConfirmRef.current?.focus();
      return;
    }
    const opener = deleteOpenerRef.current;
    deleteOpenerRef.current = null;
    if (opener?.isConnected) opener.focus();
    else if (opener) refreshButtonRef.current?.focus();
  }, [deleteTarget]);

  const preview = useMemo(() => {
    if (!previewProductId) return null;
    const product = products.find((item) => item.productId === previewProductId);
    if (!product) return { ok: false as const, message: '미리보기 상품을 찾을 수 없습니다.' };
    const error = validateDraft(draft);
    if (error) return { ok: false as const, message: error };
    const combined = [...promotions, draftPromotion(draft, DRAFT_ID)];
    return calculatePromotionPrice({
      productId: product.productId,
      quantity: previewQuantity,
      regularUnitPrice: product.price,
      now: new Date(draft.startsAt),
      promotions: combined,
    });
  }, [draft, previewProductId, previewQuantity, products, promotions]);


  function edit(promotion: Promotion, opener: HTMLButtonElement) {
    if (editingId || deleteTarget || saving) return;
    editGenerationRef.current += 1;
    editOpenerRef.current = opener;
    setEditingId(promotion.promotionId);
    setEditDraft(draftFromPromotion(promotion));
    setEditError('');
    setMessage('');
  }

  function closeEdit() {
    if (saving) return;
    editGenerationRef.current += 1;
    setEditingId(null);
    setEditDraft(null);
    setEditError('');
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
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
      const response = await fetch('/api/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exactPayload(draft)),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, '행사를 추가하지 못했습니다.'));
      const returned = parsePromotionResponse(payload);
      if (!returned) throw new Error('행사 응답 형식이 올바르지 않습니다.');
      if (promotionsRef.current.some((promotion) => promotion.promotionId === returned.promotionId)) {
        throw new Error('행사 응답 ID가 올바르지 않습니다.');
      }
      if (!mountedRef.current || mutationGenerationRef.current !== mutationGeneration) return;
      const nextPromotions = canonicalPromotionOrder([...promotionsRef.current, returned]);
      loadGenerationRef.current += 1;
      promotionsRef.current = nextPromotions;
      setPromotions(nextPromotions);
      setLoading(false);
      setLoadError('');
      setMessage('행사를 추가했습니다.');
      setDraft(EMPTY_DRAFT);
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

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingId || !editDraft || !mountedRef.current || mutationInFlightRef.current) return;
    const id = editingId;
    const draftToSave = editDraft;
    const editGeneration = editGenerationRef.current;
    const error = validateDraft(draftToSave);
    if (error) {
      setEditError(error);
      return;
    }
    mutationInFlightRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setEditError('');
    setMessage('');
    setSaving(true);
    try {
      const response = await fetch(`/api/promotions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exactPayload(draftToSave)),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, '행사를 수정하지 못했습니다.'));
      const returned = parsePromotionResponse(payload);
      if (!returned) throw new Error('행사 응답 형식이 올바르지 않습니다.');
      if (returned.promotionId !== id) throw new Error('행사 응답 ID가 올바르지 않습니다.');
      if (!mountedRef.current || mutationGenerationRef.current !== mutationGeneration || editGenerationRef.current !== editGeneration) return;
      const nextPromotions = canonicalPromotionOrder(promotionsRef.current.map((promotion) => promotion.promotionId === id ? returned : promotion));
      loadGenerationRef.current += 1;
      promotionsRef.current = nextPromotions;
      setPromotions(nextPromotions);
      setLoading(false);
      setLoadError('');
      setMessage('행사를 수정했습니다.');
      setEditingId(null);
      setEditDraft(null);
    } catch (caught) {
      if (mountedRef.current && mutationGenerationRef.current === mutationGeneration && editGenerationRef.current === editGeneration) {
        setEditError(caught instanceof Error ? caught.message : '행사를 수정하지 못했습니다.');
      }
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    }
  }

  function requestDelete(promotion: Promotion, opener: HTMLButtonElement) {
    if (editingId || deleteTarget || saving) return;
    deleteOpenerRef.current = opener;
    setDeleteTarget(promotion);
    setFormError('');
    setMessage('');
  }

  function closeDelete() {
    if (saving) return;
    setDeleteTarget(null);
  }

  async function confirmDelete() {
    if (!deleteTarget || !mountedRef.current || mutationInFlightRef.current) return;
    const target = deleteTarget;
    mutationInFlightRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setSaving(true);
    setFormError('');
    try {
      const response = await fetch(`/api/promotions/${encodeURIComponent(target.promotionId)}`, { method: 'DELETE' });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const safeMessage = readError(payload, '행사를 삭제하지 못했습니다.');
        if (mountedRef.current && mutationGenerationRef.current === mutationGeneration) {
          setDeleteTarget(null);
          setFormError(safeMessage);
          if (safeMessage.includes('대상 상품 연결은 삭제되었지만')) void loadPromotions();
        }
        return;
      }
      if (!payload || typeof payload !== 'object' || !('promotionId' in payload) || payload.promotionId !== target.promotionId) {
        throw new Error('행사 삭제 응답 형식이 올바르지 않습니다.');
      }
      if (!mountedRef.current || mutationGenerationRef.current !== mutationGeneration) return;
      const nextPromotions = promotionsRef.current.filter((promotion) => promotion.promotionId !== target.promotionId);
      loadGenerationRef.current += 1;
      promotionsRef.current = nextPromotions;
      setPromotions(nextPromotions);
      setDeleteTarget(null);
      setMessage('행사를 삭제했습니다.');
    } catch (caught) {
      if (mountedRef.current && mutationGenerationRef.current === mutationGeneration) {
        setDeleteTarget(null);
        setFormError(caught instanceof Error ? caught.message : '행사를 삭제하지 못했습니다.');
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
  promotionNames.set(DRAFT_ID, draft.name || '작성 중 행사');
  const modalOpen = Boolean(editingId || deleteTarget);

  function refocusActiveDialog() {
    const dialog = editingId ? editDialogRef.current : deleteDialogRef.current;
    dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
  }

  return (
    <section aria-label="행사 관리" data-theme={normalizedTheme} style={theme.variables} className={`${theme.shell} ${theme.text} rounded-2xl p-2`}>
      <div
        data-testid="promotion-panel-content"
        className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]"
        inert={modalOpen ? true : undefined}
        aria-hidden={modalOpen ? true : undefined}
        onFocusCapture={(event) => { if (modalOpen) { event.stopPropagation(); refocusActiveDialog(); } }}
        onClickCapture={(event) => { if (modalOpen) { event.preventDefault(); event.stopPropagation(); refocusActiveDialog(); } }}
      >
      <div className={`${theme.surface} ${theme.border} rounded-2xl border p-4 shadow-sm`}>
        <h2 className="text-lg font-black">행사 만들기</h2>
        <form className="mt-3" onSubmit={submitCreate}>
          <fieldset aria-label="행사 편집 입력" className="space-y-2" disabled={saving}>
          <DraftFields draft={draft} setDraft={(next) => setDraft(next)} products={products} timeZone={timeZone} />
          {formError ? <p role="alert" className="rounded-lg bg-rose-100 p-2 text-sm font-bold text-rose-800">{formError}</p> : null}
          {message ? <p role="status" className="rounded-lg bg-emerald-100 p-2 text-sm font-bold text-emerald-900">{message}</p> : null}
          {saving && !editingId && !deleteTarget ? <p role="status" aria-label="행사 저장 중" className="text-sm font-bold">저장 중…</p> : null}
          <button disabled={saving} className={`${theme.accentSolid} ${theme.accentOnSolid} ${theme.ring} w-full rounded-lg p-2 font-black focus:ring-2 disabled:opacity-50`} type="submit">행사 추가</button>
          </fieldset>
        </form>

        <div className={`${theme.border} mt-4 border-t pt-3`}>
          <h3 className="font-black">가격 미리보기</h3>
          <fieldset aria-label="가격 미리보기 입력" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2" disabled={saving}><label className="text-xs font-bold">미리보기 상품<select aria-label="미리보기 상품" className={inputClass} value={previewProductId} onChange={(event) => setPreviewProductId(event.target.value)}><option value="">선택</option>{products.map((product) => <option key={product.productId} value={product.productId}>{product.name}</option>)}</select></label><NumberField label="총 수령 수량" value={previewQuantity} min={1} onChange={setPreviewQuantity} /></fieldset>
          {preview ? <PreviewResult preview={preview} names={promotionNames} currencyUnit={currencyUnit} /> : <p className={`${theme.mutedText} mt-2 text-xs`}>상품과 행사 설정을 입력하면 예상 가격을 계산합니다.</p>}
        </div>
      </div>

      <div className={`${theme.surface} ${theme.border} rounded-2xl border p-4 shadow-sm`}>
        <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-black">행사 목록</h2><button ref={refreshButtonRef} type="button" aria-label="행사 목록 새로고침" className={`${theme.accentSoft} ${theme.accentText} ${theme.ring} rounded-lg px-3 py-2 text-xs font-black focus:ring-2`} onClick={() => void loadPromotions()}>새로고침</button></div>
        {loading ? <p role="status" aria-label="행사 목록 불러오는 중" className="mt-3">행사 목록을 불러오는 중입니다.</p> : null}
        {!loading && loadError ? <div role="alert" className="mt-3 rounded-lg bg-rose-100 p-3 text-rose-800"><p>{loadError}</p><button type="button" className={`${theme.surface} mt-2 rounded px-3 py-1 font-bold text-rose-900`} onClick={() => void loadPromotions()}>다시 시도</button></div> : null}
        {!loading && !loadError && promotions.length === 0 ? <p className={`${theme.surfaceRaised} mt-3 rounded-lg p-3`}>등록된 행사가 없습니다.</p> : null}
        {!loading && !loadError ? <div className="mt-3 space-y-2">{promotions.map((promotion) => {
          const productTargets = summarizeProductTargets(promotion.productIds, productNames);
          return <article data-testid="promotion-row" key={promotion.promotionId} className={`${theme.contentCard} ${theme.border} rounded-xl border p-3 text-sm`}>
          <div className="flex flex-wrap items-start justify-between gap-2"><dl className="grid min-w-0 gap-1"><div><dt className={`${theme.mutedText} inline font-bold`}>행사명</dt><dd className="ml-2 inline font-black">{promotion.name}</dd></div><div><dt className={`${theme.mutedText} inline font-bold`}>행사 설명</dt><dd className="ml-2 inline">{promotion.description || '설명 없음'}</dd></div><div><dt className={`${theme.mutedText} inline font-bold`}>행사 내용</dt><dd className="ml-2 inline font-bold">{formatPromotionContent(promotion, currencyUnit)}</dd></div><div><dt className={`${theme.mutedText} inline font-bold`}>대상 상품</dt><dd className="ml-2 inline" title={productTargets.title}>{productTargets.summary || '대상 상품 없음'}</dd></div><div><dt className={`${theme.mutedText} inline font-bold`}>행사 기간</dt><dd className="ml-2 inline">{formatPromotionPeriod(promotion.startsAt, promotion.endsAt)}</dd></div></dl><div className="flex flex-wrap gap-1"><button disabled={saving} type="button" aria-label={`${promotion.name} 편집`} className={`${theme.accentSoft} ${theme.accentText} ${theme.border} rounded border px-2 py-1 font-bold outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-content-card)] disabled:opacity-50`} onClick={(event) => edit(promotion, event.currentTarget)}>편집</button><button disabled={saving} type="button" aria-label={`${promotion.name} ${promotion.isActive ? '비활성화' : '재활성화'}`} className={`${theme.accentSolid} ${theme.accentOnSolid} ${theme.border} rounded border px-2 py-1 font-bold outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-content-card)] disabled:opacity-50`} onClick={() => void toggleActivation(promotion)}>{promotion.isActive ? '비활성화' : '재활성화'}</button><button disabled={saving} type="button" aria-label={`${promotion.name} 삭제`} className="rounded bg-red-700 px-2 py-1 font-bold text-white disabled:opacity-50" onClick={(event) => requestDelete(promotion, event.currentTarget)}>삭제</button></div></div>
        </article>;
        })}</div> : null}
      </div>
      </div>

      {editingId && editDraft ? <div ref={editDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="promotion-edit-title" className={`${theme.text} fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeEdit(); }} onKeyDown={(event) => { if (event.key === 'Tab' && !event.shiftKey && event.target === editSaveRef.current) { event.preventDefault(); editNameRef.current?.focus(); } else if (event.key === 'Tab' && event.shiftKey && event.target === editNameRef.current) { event.preventDefault(); editSaveRef.current?.focus(); } else trapDialogFocus(event); if (event.key === 'Escape') closeEdit(); }}>
        <div className={`${theme.surface} ${theme.border} max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-2xl`}>
          <h2 id="promotion-edit-title" className="text-lg font-black">{promotions.find((item) => item.promotionId === editingId)?.name ?? editDraft.name} 행사 편집</h2>
          <form className="mt-3" onSubmit={submitEdit}><fieldset className="space-y-2" disabled={saving}>
            <DraftFields draft={editDraft} setDraft={(next) => setEditDraft(next)} products={products} timeZone={timeZone} labelPrefix="수정 " firstInputRef={(node) => { editNameRef.current = node; }} />
            {editError ? <p role="alert" className="rounded-lg bg-rose-100 p-2 text-sm font-bold text-rose-800">{editError}</p> : null}
            {saving ? <p role="status" aria-label="행사 저장 중" className="text-sm font-bold">저장 중…</p> : null}
            <div className="flex justify-end gap-2"><button type="button" disabled={saving} className={`${theme.accentSoft} ${theme.accentText} rounded-lg px-4 py-2 font-bold disabled:opacity-50`} onClick={closeEdit}>편집 취소</button><button ref={editSaveRef} type="submit" disabled={saving} className={`${theme.accentSolid} ${theme.accentOnSolid} rounded-lg px-4 py-2 font-black disabled:opacity-50`}>행사 수정 저장</button></div>
          </fieldset></form>
        </div>
      </div> : null}

      {deleteTarget ? <div ref={deleteDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="promotion-delete-title" className={`${theme.text} fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDelete(); }} onKeyDown={(event) => { if (event.key === 'Tab' && !event.shiftKey && event.target === deleteConfirmRef.current) { event.preventDefault(); deleteCancelRef.current?.focus(); } else if (event.key === 'Tab' && event.shiftKey && event.target === deleteCancelRef.current) { event.preventDefault(); deleteConfirmRef.current?.focus(); } else trapDialogFocus(event); if (event.key === 'Escape') closeDelete(); }}>
        <div className={`${theme.surface} ${theme.border} w-full max-w-md rounded-2xl border p-5 shadow-2xl`}><h2 id="promotion-delete-title" className="text-lg font-black">{deleteTarget.name} 행사 삭제</h2><p className={`${theme.mutedText} mt-2`}>이 행사를 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.</p>{saving ? <p role="status" className="mt-2 font-bold">삭제 중…</p> : null}<div className="mt-4 flex justify-end gap-2"><button ref={deleteCancelRef} type="button" disabled={saving} className={`${theme.accentSoft} ${theme.accentText} rounded-lg px-4 py-2 font-bold disabled:opacity-50`} onClick={closeDelete}>취소</button><button ref={deleteConfirmRef} type="button" disabled={saving} className="rounded-lg bg-red-700 px-4 py-2 font-black text-white disabled:opacity-50" onClick={() => void confirmDelete()}>삭제 확인</button></div></div>
      </div> : null}
    </section>
  );
}

function PreviewResult({ preview, names, currencyUnit }: { preview: ReturnType<typeof calculatePromotionPrice> | { ok: false; message: string }; names: Map<string, string>; currencyUnit: string }) {
  if (!preview.ok) return <div role="region" aria-label="가격 미리보기 결과" className="mt-2 rounded-lg bg-rose-50 p-2"><p role="alert">가격 계산 오류: {preview.message}</p></div>;
  return <div role="region" aria-label="가격 미리보기 결과" className="mt-2 rounded-lg bg-[var(--theme-surface-raised)] p-2 text-xs"><p>정상 합계 {money(preview.regularTotal, currencyUnit)}</p><p className="font-black">최종 합계 {money(preview.finalAmount, currencyUnit)}</p><p>유료 {preview.paidQuantity}개 · 무료 {preview.freeQuantity}개 · 할인 합계 {money(preview.totalDiscount, currencyUnit)}</p><ol className="mt-1 list-decimal pl-4">{preview.adjustments.map((adjustment) => <li data-testid="preview-adjustment" key={`${adjustment.promotionId}-${adjustment.type}`}>{names.get(adjustment.promotionId) ?? adjustment.promotionId} ({TYPE_LABELS[adjustment.type]}): {money(adjustment.beforeAmount, currencyUnit)} → {money(adjustment.afterAmount, currencyUnit)}{adjustment.freeQuantity ? ` · 무료 ${adjustment.freeQuantity}개` : ''}</li>)}</ol></div>;
}

const inputClass = 'mt-1 w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-input)] p-2 text-[var(--theme-text)] focus:ring-2 focus:ring-[var(--theme-focus-ring)]';

function DraftFields({ draft, setDraft, products, timeZone, labelPrefix = '', firstInputRef }: { draft: Draft; setDraft: (draft: Draft) => void; products: Product[]; timeZone: string; labelPrefix?: string; firstInputRef?: (node: HTMLInputElement | null) => void }) {
  const label = (value: string) => `${labelPrefix}${value}`;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const changeDate = (key: 'startsAt' | 'endsAt', value: string) => set(key, value ? (zonedDatetimeLocalToIso(value, timeZone) ?? value) : '');
  const toggleProduct = (productId: string) => set('productIds', draft.productIds.includes(productId) ? draft.productIds.filter((id) => id !== productId) : [...draft.productIds, productId]);
  return <>
    <TextField label={label('행사명')} value={draft.name} onChange={(value) => set('name', value)} inputRef={firstInputRef} />
    <label className="block text-xs font-bold">{label('행사 설명')}<textarea aria-label={label('행사 설명')} className={`${inputClass} min-h-16`} value={draft.description} onChange={(event) => set('description', event.target.value)} /></label>
    <label className="block text-xs font-bold">{label('행사 유형')}<select aria-label={label('행사 유형')} className={inputClass} value={draft.type} onChange={(event) => set('type', event.target.value as PromotionType)}>{Object.entries(TYPE_LABELS).map(([value, typeLabel]) => <option key={value} value={value}>{typeLabel}</option>)}</select></label>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {draft.type === 'N_PLUS_ONE' ? <><NumberField label={label('구매 수량')} value={draft.buyQuantity} min={1} onChange={(value) => set('buyQuantity', value)} /><NumberField label={label('무료 수량')} value={draft.freeQuantity} min={1} onChange={(value) => set('freeQuantity', value)} /></> : null}
      {draft.type === 'PROMOTIONAL_PRICE' ? <NumberField label={label('행사 단가')} value={draft.promotionalUnitPrice} min={0} onChange={(value) => set('promotionalUnitPrice', value)} /> : null}
      {draft.type === 'PERCENT_DISCOUNT' ? <NumberField label={label('할인율')} value={draft.percent} min={0} step="any" onChange={(value) => set('percent', value)} /> : null}
      {draft.type === 'FIXED_DISCOUNT' ? <NumberField label={label('유료 수량당 할인액')} value={draft.discountAmount} min={1} onChange={(value) => set('discountAmount', value)} /> : null}
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><DateField label={label('시작 일시')} value={isoToZonedDatetimeLocal(draft.startsAt, timeZone)} onChange={(value) => changeDate('startsAt', value)} /><DateField label={label('종료 일시')} value={isoToZonedDatetimeLocal(draft.endsAt, timeZone)} onChange={(value) => changeDate('endsAt', value)} /></div>
    <NumberField label={label('정렬 우선순위')} value={draft.sortOrder} onChange={(value) => set('sortOrder', value)} />
    <label className="flex gap-2 text-sm font-bold"><input aria-label={label('행사 활성')} type="checkbox" checked={draft.isActive} onChange={(event) => set('isActive', event.target.checked)} />활성</label>
    <fieldset className="rounded-lg border border-[var(--theme-border)] p-2"><legend className="px-1 text-xs font-black">{label('대상 상품')}</legend><div className="grid gap-1 sm:grid-cols-2">{products.map((product) => <label key={product.productId} className="flex gap-2 text-xs"><input aria-label={label(`${product.name} (${product.productId}) 대상`)} type="checkbox" checked={draft.productIds.includes(product.productId)} onChange={() => toggleProduct(product.productId)} />{product.name} ({product.productId})</label>)}</div></fieldset>
  </>;
}

function TextField({ label, value, onChange, inputRef }: { label: string; value: string; onChange: (value: string) => void; inputRef?: (node: HTMLInputElement | null) => void }) { return <label className="block text-xs font-bold">{label}<input ref={inputRef} aria-label={label} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function NumberField({ label, value, min, step = 1, onChange }: { label: string; value: number; min?: number; step?: number | 'any'; onChange: (value: number) => void }) { return <label className="block text-xs font-bold">{label}<input aria-label={label} className={inputClass} type="number" step={step} min={min} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="min-w-0 text-xs font-bold">{label}<input aria-label={label} className={`${inputClass} min-w-0`} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function readError(payload: unknown, fallback: string) { return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : fallback; }
function money(value: number, currencyUnit: string) { return `${value.toLocaleString('ko-KR')}${currencyUnit}`; }
export function formatPromotionPeriod(startsAt: string, endsAt: string): string {
  const format = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(value)).reduce<Record<string, string>>((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const start = format(startsAt);
  const end = format(endsAt);
  const startText = `${start.year}/${start.month}/${start.day} ${start.hour}:${start.minute}:${start.second}`;
  const endText = start.year === end.year ? `${end.month}/${end.day} ${end.hour}:${end.minute}:${end.second}` : `${end.year}/${end.month}/${end.day} ${end.hour}:${end.minute}:${end.second}`;
  return `${startText} ~ ${endText}`;
}
export function formatPromotionContent(promotion: Promotion, currencyUnit: string): string {
  switch (promotion.type) {
    case 'N_PLUS_ONE': return `${promotion.buyQuantity}개 구매 시 ${promotion.freeQuantity}개 무료`;
    case 'PROMOTIONAL_PRICE': return `행사 가격 ${money(promotion.promotionalUnitPrice, currencyUnit)}`;
    case 'PERCENT_DISCOUNT': return `${promotion.percent}% 할인`;
    case 'FIXED_DISCOUNT': return `1개당 ${money(promotion.discountAmount, currencyUnit)} 할인`;
  }
}
