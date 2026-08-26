import {
  validatePromotionDefinitionInput,
  type PromotionDefinitionInput,
} from '@/server/repositories/sheets/promotionCommands';

const COMMON_KEYS = [
  'name',
  'description',
  'startsAt',
  'endsAt',
  'isActive',
  'sortOrder',
  'type',
] as const;

const RULE_KEYS = {
  N_PLUS_ONE: ['buyQuantity', 'freeQuantity'],
  PROMOTIONAL_PRICE: ['promotionalUnitPrice'],
  PERCENT_DISCOUNT: ['percent'],
  FIXED_DISCOUNT: ['discountAmount'],
} as const;

type ParsedDefinitionPayload = {
  definition: PromotionDefinitionInput;
  productIds: string[];
};

export type ParsedCreatePromotionPayload = ParsedDefinitionPayload & {
  promotionId?: string;
};

export type ParsedPatchPromotionPayload =
  | { kind: 'activation'; isActive: boolean }
  | ({ kind: 'definition' } & ParsedDefinitionPayload);

export class PromotionPayloadError extends Error {
  constructor(message = 'Promotion payload is invalid', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PromotionPayloadError';
  }
}

export function parseCreatePromotionPayload(value: unknown): ParsedCreatePromotionPayload {
  return asPayloadError(() => {
    const candidate = exactObject(value);
    const parsed = parseDefinition(candidate, true);
    const promotionId = Object.hasOwn(candidate, 'promotionId')
      ? parseNonBlankId(candidate.promotionId, 'promotionId')
      : undefined;
    return {
      ...parsed,
      ...(promotionId === undefined ? {} : { promotionId }),
    };
  });
}

export function parsePatchPromotionPayload(value: unknown): ParsedPatchPromotionPayload {
  return asPayloadError(() => {
    const candidate = exactObject(value);
    if (Object.keys(candidate).length === 1 && Object.hasOwn(candidate, 'isActive')) {
      if (typeof candidate.isActive !== 'boolean') throw new Error('isActive must be a boolean');
      return { kind: 'activation', isActive: candidate.isActive };
    }
    return { kind: 'definition', ...parseDefinition(candidate, false) };
  });
}

function parseDefinition(
  candidate: Record<string, unknown>,
  allowPromotionId: boolean,
): ParsedDefinitionPayload {
  const type = candidate.type;
  if (typeof type !== 'string' || !(type in RULE_KEYS)) throw invalidPayload();

  const common = {
    name: stringField(candidate.name, 'name'),
    description: stringField(candidate.description, 'description'),
    startsAt: stringField(candidate.startsAt, 'startsAt'),
    endsAt: stringField(candidate.endsAt, 'endsAt'),
    isActive: booleanField(candidate.isActive, 'isActive'),
    sortOrder: numberField(candidate.sortOrder, 'sortOrder'),
  };
  if (!Array.isArray(candidate.productIds)) throw new Error('productIds must be an array');
  const productIds = candidate.productIds.map((value) => parseNonBlankId(value, 'productIds'));
  if (new Set(productIds).size !== productIds.length) {
    throw new Error('productIds must not contain duplicate IDs');
  }

  const ruleKeys = RULE_KEYS[type as keyof typeof RULE_KEYS];
  const expectedKeys = new Set<string>([
    ...COMMON_KEYS,
    ...ruleKeys,
    'productIds',
    ...(allowPromotionId && Object.hasOwn(candidate, 'promotionId') ? ['promotionId'] : []),
  ]);
  const actualKeys = Object.keys(candidate);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw invalidPayload();
  }

  let definition: PromotionDefinitionInput;
  if (type === 'N_PLUS_ONE') {
    definition = {
      ...common,
      type,
      buyQuantity: numberField(candidate.buyQuantity, 'buyQuantity'),
      freeQuantity: numberField(candidate.freeQuantity, 'freeQuantity'),
    };
  } else if (type === 'PROMOTIONAL_PRICE') {
    definition = {
      ...common,
      type,
      promotionalUnitPrice: numberField(candidate.promotionalUnitPrice, 'promotionalUnitPrice'),
    };
  } else if (type === 'PERCENT_DISCOUNT') {
    definition = { ...common, type, percent: numberField(candidate.percent, 'percent') };
  } else {
    definition = {
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: numberField(candidate.discountAmount, 'discountAmount'),
    };
  }

  return { definition: validatePromotionDefinitionInput(definition), productIds };
}

export function haveSameProductIds(left: string[], right: string[]): boolean {
  const normalize = (values: string[]): string[] | null => {
    if (values.some((value) => typeof value !== 'string')) return null;
    return [...new Set(values.map((value) => value.trim()))].sort();
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft !== null && normalizedRight !== null
    && normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function exactObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPayload();
  return value as Record<string, unknown>;
}

function parseNonBlankId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must contain nonblank string IDs`);
  }
  return value.trim();
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function asPayloadError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PromotionPayloadError) throw error;
    throw new PromotionPayloadError(undefined, { cause: error });
  }
}

function invalidPayload(): PromotionPayloadError {
  return new PromotionPayloadError();
}
