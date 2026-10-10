import {
  DIGITAL_KINDS, type BagItemDto, type CheckoutVoucherDto, type DigitalKind, type DigitalProductDto, type StudentBagDto,
} from '@/lib/studentBagApi';
import { tenantFetch } from '@/lib/tenantApiPath';

/* Calls for the 보관함: the teacher's view of one student, item use, give and take back, digital product settings. */

export type BagResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string | null; status: number };

const NETWORK = '연결이 잠시 불안정해요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const isKind = (value: unknown): value is DigitalKind => typeof value === 'string' && (DIGITAL_KINDS as readonly string[]).includes(value);
const isNullableString = (value: unknown) => value === null || typeof value === 'string';

export function isBagItem(value: unknown): value is BagItemDto {
  return isRecord(value) && typeof value.itemId === 'string' && isKind(value.kind) && typeof value.title === 'string'
    && isNullableString(value.productId) && isNullableString(value.imageUrl) && typeof value.description === 'string'
    && isNullableString(value.voucherProductId) && isNullableString(value.voucherProductName)
    && (value.source === 'TREE_HARVEST' || value.source === 'STORE_PURCHASE' || value.source === 'TEACHER' || value.source === 'PET_GRADUATION') && typeof value.sourceRef === 'string'
    && typeof value.issuedAt === 'string' && isNullableString(value.usedAt) && typeof value.usedAtCheckout === 'boolean';
}

export function isStudentBag(value: unknown): value is StudentBagDto {
  return isRecord(value) && isRecord(value.student) && typeof value.student.studentId === 'string'
    && typeof value.student.name === 'string' && Array.isArray(value.items) && value.items.every(isBagItem);
}

function isDigitalProduct(value: unknown): value is DigitalProductDto {
  return isRecord(value) && typeof value.productId === 'string' && isKind(value.kind) && typeof value.description === 'string';
}

function isCheckoutVoucher(value: unknown): value is CheckoutVoucherDto {
  return isRecord(value) && typeof value.itemId === 'string' && typeof value.productId === 'string' && typeof value.title === 'string'
    && isNullableString(value.imageUrl) && typeof value.issuedAt === 'string';
}

async function request<T>(path: string, init: RequestInit, read: (value: unknown) => T | null): Promise<BagResult<T>> {
  let response: Response;
  try {
    response = await tenantFetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, error: NETWORK, code: null, status: 0 };
  }
  let payload: unknown = null;
  try { payload = JSON.parse(await response.text()); } catch { payload = null; }
  if (response.ok) {
    const data = read(payload);
    return data === null ? { ok: false, error: NETWORK, code: null, status: 0 } : { ok: true, data };
  }
  const record = isRecord(payload) ? payload : {};
  return {
    ok: false, status: response.status,
    error: typeof record.error === 'string' ? record.error : '처리하지 못했어요. 잠시 후 다시 눌러 주세요.',
    code: typeof record.code === 'string' ? record.code : null,
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const readProducts = (value: unknown) => (isRecord(value) && Array.isArray(value.products) && value.products.every(isDigitalProduct)
  ? value.products as DigitalProductDto[] : null);
const readBag = (value: unknown) => (isRecord(value) && isStudentBag(value.bag) ? value.bag : null);

export function fetchStudentBag(studentId: string): Promise<BagResult<StudentBagDto>> {
  return request(`/api/bag/students/${encodeURIComponent(studentId)}`, { method: 'GET' }, readBag);
}

export function setBagItemUsed(itemId: string, used: boolean): Promise<BagResult<BagItemDto>> {
  return request('/api/bag/items/use', post({ itemId, used }), (value) => (isRecord(value) && isBagItem(value.item) ? value.item : null));
}

/** Puts `count` units of a store product into one student's 보관함; returns the refreshed storage. */
export function giveBagItems(input: Readonly<{ studentId: string; productId: string; count: number; operationId: string }>): Promise<BagResult<StudentBagDto>> {
  const { studentId, ...rest } = input;
  return request('/api/bag/items/give', post({ ...rest, studentIds: [studentId] }), readBag);
}

/** Puts `count` units of a store product into the 보관함 of each student; returns how many items went in. */
export function giveBagItemsToStudents(input: Readonly<{ studentIds: readonly string[]; productId: string; count: number; operationId: string }>): Promise<BagResult<number>> {
  return request('/api/bag/items/give', post(input), (value) => (isRecord(value) && Number.isInteger(value.given) ? value.given as number : null));
}

export function revokeBagItem(itemId: string): Promise<BagResult<true>> {
  return request('/api/bag/items/revoke', post({ itemId }), (value) => (isRecord(value) && value.ok === true ? true : null));
}

export function fetchDigitalProducts(): Promise<BagResult<DigitalProductDto[]>> {
  return request('/api/bag/digital-products', { method: 'GET' }, readProducts);
}

export type DigitalProductSetting = Readonly<{ kind: DigitalKind; description: string }> | null;

/** Makes a product digital with its type, or physical again (null). Returns every digital product. */
export function saveDigitalProduct(productId: string, digital: DigitalProductSetting): Promise<BagResult<DigitalProductDto[]>> {
  return request('/api/bag/digital-products', post({ productId, digital }), readProducts);
}

/** The student's unused 교환권 for the cart products (kiosk, after the QR scan). */
export function fetchCheckoutVouchers(studentQr: string, productIds: readonly string[]): Promise<BagResult<CheckoutVoucherDto[]>> {
  return request('/api/checkout/vouchers', post({ studentId: studentQr, productIds }),
    (value) => (isRecord(value) && Array.isArray(value.vouchers) && value.vouchers.every(isCheckoutVoucher) ? value.vouchers as CheckoutVoucherDto[] : null));
}
