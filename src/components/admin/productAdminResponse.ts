import type { Product } from '@/domain/types';
import type { ProductDraft } from './adminTypes';
import { isRecord } from './adminResponse';

export type ProductAdminState = {
  products: ProductDraft[];
  mutationPreconditions: Map<string, number>;
};

const PRODUCT_REQUIRED_KEYS = ['productId', 'name', 'price', 'stock', 'isActive', 'sortOrder'] as const;

const PRODUCT_OPTIONAL_KEYS = ['imageUrl', 'category'] as const;

function strictDataDescriptors(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, PropertyDescriptor> | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true || descriptor.writable !== true
      || descriptor.configurable !== true) return null;
  }
  return descriptors;
}

function strictArrayValues(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.writable !== true || lengthDescriptor.configurable !== false) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== lengthDescriptor.value + 1 || keys[keys.length - 1] !== 'length') return null;
  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return null;
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true || descriptor.writable !== true
      || descriptor.configurable !== true) return null;
    result.push(descriptor.value);
  }
  return result;
}

function invalidProductEnvelope(): never {
  throw new Error('상품 관리자 응답 형식이 올바르지 않습니다.');
}

export function parseProductAdminEnvelope(value: unknown): ProductAdminState {
  const envelope = strictDataDescriptors(value, ['products', 'mutationPreconditions']);
  if (!envelope) return invalidProductEnvelope();
  const productValues = strictArrayValues(envelope.products.value);
  const preconditionValues = strictArrayValues(envelope.mutationPreconditions.value);
  if (!productValues || !preconditionValues || productValues.length !== preconditionValues.length) {
    return invalidProductEnvelope();
  }

  const products: Product[] = [];
  const mutationPreconditions = new Map<string, number>();
  const productIds = new Set<string>();
  for (let index = 0; index < productValues.length; index += 1) {
    const productValue = productValues[index];
    if (typeof productValue !== 'object' || productValue === null
      || Object.getPrototypeOf(productValue) !== Object.prototype) return invalidProductEnvelope();
    const ownKeys = Reflect.ownKeys(productValue);
    if (ownKeys.some((key) => typeof key !== 'string'
      || (![...PRODUCT_REQUIRED_KEYS, ...PRODUCT_OPTIONAL_KEYS].includes(key as never)))) return invalidProductEnvelope();
    const optionalKeys = PRODUCT_OPTIONAL_KEYS.filter((key) => ownKeys.includes(key));
    const productDescriptors = strictDataDescriptors(productValue, [...PRODUCT_REQUIRED_KEYS, ...optionalKeys]);
    if (!productDescriptors) return invalidProductEnvelope();
    const productId = productDescriptors.productId.value;
    const name = productDescriptors.name.value;
    const price = productDescriptors.price.value;
    const stock = productDescriptors.stock.value;
    const isActive = productDescriptors.isActive.value;
    const sortOrder = productDescriptors.sortOrder.value;
    if (typeof productId !== 'string' || !productId || productId.trim() !== productId
      || typeof name !== 'string' || !name || name.trim() !== name
      || !Number.isSafeInteger(price) || price < 0
      || !Number.isSafeInteger(stock) || stock < 0
      || typeof isActive !== 'boolean'
      || !Number.isInteger(sortOrder) || sortOrder < -2147483648 || sortOrder > 2147483647
      || (productDescriptors.imageUrl && typeof productDescriptors.imageUrl.value !== 'string')
      || (productDescriptors.category && typeof productDescriptors.category.value !== 'string')
      || productIds.has(productId)) return invalidProductEnvelope();

    const preconditionDescriptors = strictDataDescriptors(
      preconditionValues[index],
      ['productId', 'expectedVersion'],
    );
    if (!preconditionDescriptors) return invalidProductEnvelope();
    const preconditionProductId = preconditionDescriptors.productId.value;
    const expectedVersion = preconditionDescriptors.expectedVersion.value;
    if (preconditionProductId !== productId || mutationPreconditions.has(productId)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0
      || expectedVersion >= Number.MAX_SAFE_INTEGER) return invalidProductEnvelope();

    productIds.add(productId);
    products.push({
      productId,
      name,
      price,
      stock,
      isActive,
      sortOrder,
      ...(productDescriptors.imageUrl ? { imageUrl: productDescriptors.imageUrl.value } : {}),
      ...(productDescriptors.category ? { category: productDescriptors.category.value } : {}),
    });
    mutationPreconditions.set(productId, expectedVersion);
  }
  return { products, mutationPreconditions };
}

export function getProductExpectedVersion(state: ProductAdminState, productId: string): number | undefined {
  return state.mutationPreconditions.get(productId);
}

export function isCanonicalOperationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function parseProductDeleteResult(value: unknown, expectedProductId: string): { productId: string } | null {
  const descriptors = strictDataDescriptors(value, ['productId']);
  if (!descriptors || typeof descriptors.productId.value !== 'string'
    || descriptors.productId.value !== expectedProductId) return null;
  return { productId: descriptors.productId.value };
}

export function isCreatedProduct(value: unknown, expectedProductId: string): value is Product {
  if (!isRecord(value)) return false;
  return value.productId === expectedProductId
    && typeof value.name === 'string'
    && Boolean(value.name.trim())
    && Number.isSafeInteger(value.price)
    && (value.price as number) >= 0
    && Number.isSafeInteger(value.stock)
    && (value.stock as number) >= 0
    && typeof value.isActive === 'boolean'
    && (!Object.hasOwn(value, 'imageUrl') || typeof value.imageUrl === 'string')
    && (!Object.hasOwn(value, 'category') || typeof value.category === 'string')
    && Number.isInteger(value.sortOrder)
    && (value.sortOrder as number) >= -2147483648
    && (value.sortOrder as number) <= 2147483647;
}
