/* What the student storage API sends to the student bank and to the teacher's screen. On screen the
   storage is called 보관함. A 디지털 상품 has a type:
     CONSUMABLE   소모품 — used up: the teacher marks it used
     COLLECTIBLE  수집품 — kept, never used (badges, certificates)
   A 교환권 is a consumable with a product to exchange (voucherProductId), used when the student pays
   for that physical product. It is not sold: the teacher gives it, or it is a reward.
   An earlier free-text harvest coupon is a consumable without a product. */

export type DigitalKind = 'CONSUMABLE' | 'COLLECTIBLE';
export type BagItemKind = DigitalKind;
export type BagItemSource = 'TREE_HARVEST' | 'STORE_PURCHASE' | 'TEACHER';

export const DIGITAL_KINDS: readonly DigitalKind[] = ['CONSUMABLE', 'COLLECTIBLE'];
export const DIGITAL_KIND_LABELS: Readonly<Record<DigitalKind, string>> = { CONSUMABLE: '소모품', COLLECTIBLE: '수집품' };
export const DIGITAL_DESCRIPTION_LENGTH = 500;
export const VOUCHER_SUFFIX = ' 교환권';
export const MAX_TEACHER_GIVE = 20;
/** Students one give can reach (the whole class at once). */
export const MAX_GIVE_STUDENTS = 200;

export type BagItemDto = Readonly<{
  itemId: string;
  kind: BagItemKind;
  title: string;
  source: BagItemSource;
  /** Tree number for a harvest (not shown), product ID for a purchase or a teacher's gift. */
  sourceRef: string;
  /** The digital product (or, for a reward 교환권, the product it pays for); none for a free-text coupon. */
  productId: string | null;
  imageUrl: string | null;
  /** The digital product's description (shown for a 수집품). */
  description: string;
  /** For a 교환권 (a consumable with a product to exchange): the store product it pays for. */
  voucherProductId: string | null;
  voucherProductName: string | null;
  issuedAt: string;
  usedAt: string | null;
  /** A 교환권 used at a store checkout (taken back only by cancelling that checkout). */
  usedAtCheckout: boolean;
}>;

export type StudentBagDto = Readonly<{
  student: Readonly<{ studentId: string; name: string }>;
  items: ReadonlyArray<BagItemDto>;
}>;

/** How a store product is treated as a 디지털 상품. */
export type DigitalProductDto = Readonly<{
  productId: string;
  kind: DigitalKind;
  description: string;
}>;

/** A 교환권 the student can use for a product in the cart. */
export type CheckoutVoucherDto = Readonly<{
  itemId: string;
  /** The product it pays for. */
  productId: string;
  title: string;
  imageUrl: string | null;
  issuedAt: string;
}>;

/** Where an item came from, in the words students and teachers see. */
export function bagItemOrigin(item: Pick<BagItemDto, 'source' | 'sourceRef'>): string {
  if (item.source === 'TREE_HARVEST') return '학급 나무 수확';
  if (item.source === 'TEACHER') return '선생님이 넣어 줌';
  return '매점에서 구입';
}

/** A consumable with a product to exchange: the student can pay with it at the store. */
export function isVoucherItem(item: Pick<BagItemDto, 'kind' | 'voucherProductId'>): boolean {
  return item.kind === 'CONSUMABLE' && item.voucherProductId !== null;
}

/** How the item is used, shown under its name. */
export function bagItemUse(item: Pick<BagItemDto, 'kind' | 'voucherProductId' | 'voucherProductName'>): string {
  if (item.kind === 'COLLECTIBLE') return '모아 두는 소장품이에요.';
  if (isVoucherItem(item)) return `교환권이에요. 매점에서 ${item.voucherProductName ?? '그 상품'} 1개를 살 때 그 값을 결제 금액에서 빼 줘요.`;
  return '쓰고 싶으면 선생님께 보여 주세요.';
}

/**
 * Items shown as one stack (×N): same type, same name and the same product to exchange. Where each
 * came from does not matter (a harvest coupon and a bought one of the same name stack together).
 */
export function bagItemStackKey(item: Pick<BagItemDto, 'kind' | 'title' | 'voucherProductId'>): string {
  return [item.kind, item.title, item.voucherProductId ?? ''].join('\u0000');
}

export type BagItemStack = Readonly<{ key: string; first: BagItemDto; items: ReadonlyArray<BagItemDto> }>;

/** Groups items into stacks, keeping the order in which each stack first appears. */
export function stackBagItems(items: readonly BagItemDto[]): BagItemStack[] {
  const stacks = new Map<string, { key: string; first: BagItemDto; items: BagItemDto[] }>();
  for (const item of items) {
    const key = bagItemStackKey(item);
    const stack = stacks.get(key) ?? { key, first: item, items: [] };
    stack.items.push(item);
    stacks.set(key, stack);
  }
  return [...stacks.values()];
}

/** A stack's picture: the first of its items that has one. */
export const bagStackImage = (stack: BagItemStack): string | null => stack.items.find((item) => item.imageUrl)?.imageUrl ?? null;

/** Where a stack came from: one origin, or the first one and '외' when they differ. */
export function bagStackOrigin(stack: BagItemStack): string {
  const origins = new Set(stack.items.map(bagItemOrigin));
  const first = bagItemOrigin(stack.first);
  return origins.size > 1 ? `${first} 외` : first;
}
