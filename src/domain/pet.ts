/*
 * Personal pets: what a teacher can set, how growth and stages follow from it, and the lists the
 * server and the screens share (species, colors, room decor, accessories). Each student raises one pet
 * at a time: a picked egg hatches, grows up, and graduates into the student's 도감 when the student
 * chooses. Graduated pets can come back to the room to keep the new one company.
 */

import { SCHOOL_DAYS_PER_WEEK } from './schoolDays';

export const PET_SPECIES = ['dog', 'cat', 'rabbit', 'hamster', 'canary', 'turtle', 'lizard'] as const;
export type PetSpecies = typeof PET_SPECIES[number];

export const PET_SPECIES_NAMES: Readonly<Record<PetSpecies, string>> = {
  dog: '강아지', cat: '고양이', rabbit: '토끼', hamster: '햄스터', canary: '카나리아', turtle: '거북이', lizard: '도마뱀',
};

/** Fur colors per species, in the order the pictures define them. A color is picked when the egg hatches. */
export const PET_COLORS: Readonly<Record<PetSpecies, ReadonlyArray<Readonly<{ id: string; name: string }>>>> = {
  dog: [{ id: 'brown', name: '갈색' }, { id: 'cream', name: '크림' }, { id: 'black', name: '검정' }, { id: 'spot', name: '바둑이' }],
  cat: [{ id: 'cheese', name: '치즈' }, { id: 'mackerel', name: '고등어' }, { id: 'black', name: '검정' }, { id: 'calico', name: '삼색' }],
  rabbit: [{ id: 'white', name: '흰색' }, { id: 'brown', name: '갈색' }, { id: 'gray', name: '회색' }, { id: 'dutch', name: '얼룩' }],
  hamster: [{ id: 'golden', name: '골든' }, { id: 'jungle', name: '정글리안' }, { id: 'cream', name: '크림' }, { id: 'panda', name: '판다' }],
  canary: [{ id: 'yellow', name: '노랑' }, { id: 'orange', name: '주황' }, { id: 'white', name: '흰색' }, { id: 'green', name: '초록' }],
  turtle: [{ id: 'green', name: '초록' }, { id: 'brown', name: '갈색' }, { id: 'redear', name: '붉은귀' }, { id: 'star', name: '별무늬' }],
  lizard: [{ id: 'leopard', name: '표범' }, { id: 'tangerine', name: '오렌지' }, { id: 'green', name: '초록' }, { id: 'snow', name: '흰색' }],
};

/** 알 → 아기 → 어린 → 다 자란. */
export const PET_STAGE_NAMES = ['알', '아기', '어린', '다 자란'] as const;
export type PetStage = 0 | 1 | 2 | 3;

export const PET_NAME_LENGTH = 8;

export function isPetSpecies(value: unknown): value is PetSpecies {
  return typeof value === 'string' && (PET_SPECIES as readonly string[]).includes(value);
}

export function isPetColor(species: PetSpecies, value: unknown): value is string {
  return typeof value === 'string' && PET_COLORS[species].some((color) => color.id === value);
}

export function petColorName(species: PetSpecies, color: string | null): string {
  return PET_COLORS[species].find((entry) => entry.id === color)?.name ?? '';
}

/** A pet name the student or the teacher typed: trimmed, single spaces, 1–8 characters. Null when it does not fit. */
export function cleanPetName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > PET_NAME_LENGTH || /[\p{Cc}<>]/u.test(name)) return null;
  return name;
}

/* ------------------------------------------------------------------ */
/* Room decor (the 꾸미기/상점)                                        */
/* ------------------------------------------------------------------ */

export const PET_DECOR_SLOTS = ['wall', 'rug', 'bed', 'plant', 'frame', 'toy'] as const;
export type PetDecorSlot = typeof PET_DECOR_SLOTS[number];
export type PetDecor = Readonly<Record<PetDecorSlot, string>>;

export const PET_DECOR_SLOT_NAMES: Readonly<Record<PetDecorSlot, string>> = {
  wall: '벽지', rug: '러그', bed: '침대', plant: '화분', frame: '액자', toy: '장난감',
};

/**
 * Every slot has one base item every student has from the start. The others have no price of their
 * own: class currencies differ too much, so the teacher prices each item, and only priced items sell.
 */
export const PET_DECOR_ITEMS: Readonly<Record<PetDecorSlot, ReadonlyArray<Readonly<{ id: string; name: string; base?: true }>>>> = {
  wall: [{ id: 'cream', name: '크림 벽지', base: true }, { id: 'mint', name: '민트 줄무늬' }, { id: 'sky', name: '하늘 물방울' }, { id: 'pink', name: '분홍 체크' }, { id: 'night', name: '밤하늘' }],
  rug: [{ id: 'pink', name: '분홍 러그', base: true }, { id: 'blue', name: '파랑 동그라미' }, { id: 'leaf', name: '풀잎 러그' }, { id: 'rainbow', name: '무지개 러그' }],
  bed: [{ id: 'basic', name: '나무 방석 침대', base: true }, { id: 'cloud', name: '구름 방석' }, { id: 'mint', name: '민트 방석' }, { id: 'royal', name: '왕실 방석' }],
  plant: [{ id: 'pot', name: '초록 화분', base: true }, { id: 'cactus', name: '선인장' }, { id: 'sunflower', name: '해바라기' }],
  frame: [{ id: 'tree', name: '나무 그림', base: true }, { id: 'heart', name: '하트 그림' }, { id: 'star', name: '별 그림' }],
  toy: [{ id: 'none', name: '장난감 없음', base: true }, { id: 'yarn', name: '털실 뭉치' }, { id: 'duck', name: '고무 오리' }, { id: 'blocks', name: '쌓기 블록' }],
};

export const DEFAULT_PET_DECOR: PetDecor = Object.freeze({ wall: 'cream', rug: 'pink', bed: 'basic', plant: 'pot', frame: 'tree', toy: 'none' });

/**
 * Accessories a pet wears (one at a time). They fit every species: the picture puts each one on the
 * head or around the neck of whichever animal wears it. A student buys one once and can put it on
 * any of their pets.
 */
export const PET_ACCESSORIES: ReadonlyArray<Readonly<{ id: string; name: string; base?: true }>> = [
  { id: 'none', name: '장식 없음', base: true },
  { id: 'ribbon', name: '빨간 리본' },
  { id: 'flower', name: '꽃 핀' },
  { id: 'crown', name: '작은 왕관' },
  { id: 'pearl', name: '진주 목걸이' },
  { id: 'bell', name: '방울 목걸이' },
  { id: 'bowtie', name: '나비넥타이' },
  { id: 'scarf', name: '목도리' },
];

/** What the 꾸미기/상점 sells: the room's slots and the pets' accessories ('acc'). */
export const PET_SHOP_SLOTS = [...PET_DECOR_SLOTS, 'acc'] as const;
export type PetShopSlot = typeof PET_SHOP_SLOTS[number];
export const PET_SHOP_SLOT_NAMES: Readonly<Record<PetShopSlot, string>> = { ...PET_DECOR_SLOT_NAMES, acc: '펫 장식' };
export const PET_SHOP_ITEMS: Readonly<Record<PetShopSlot, ReadonlyArray<Readonly<{ id: string; name: string; base?: true }>>>> = {
  ...PET_DECOR_ITEMS, acc: PET_ACCESSORIES,
};

export function isPetAccessory(value: unknown): value is string {
  return typeof value === 'string' && PET_ACCESSORIES.some((item) => item.id === value && !item.base);
}

export function petDecorKey(slot: PetShopSlot, id: string): string {
  return `${slot}:${id}`;
}

export type PetDecorItem = Readonly<{ key: string; slot: PetShopSlot; id: string; name: string; base: boolean }>;

/** The shop item a key ('wall:mint', 'acc:ribbon') names, or null. */
export function petDecorItem(key: unknown): PetDecorItem | null {
  if (typeof key !== 'string') return null;
  const [slot, id, extra] = key.split(':');
  if (extra !== undefined || !(PET_SHOP_SLOTS as readonly string[]).includes(slot)) return null;
  const item = PET_SHOP_ITEMS[slot as PetShopSlot].find((entry) => entry.id === id);
  return item ? { key, slot: slot as PetShopSlot, id: item.id, name: item.name, base: item.base === true } : null;
}

/** Every item that can be sold (all but the base ones), in display order. */
export const PET_SELLABLE_DECOR: ReadonlyArray<PetDecorItem> = PET_SHOP_SLOTS.flatMap((slot) => PET_SHOP_ITEMS[slot]
  .filter((item) => !item.base).map((item) => ({ key: petDecorKey(slot, item.id), slot, id: item.id, name: item.name, base: false })));

/** Graduated pets that can join the one being raised in the room (up to three animals in all). */
export const PET_MAX_COMPANIONS = 2;

/** A stored room, with anything unknown replaced by the base item. */
export function normalizePetDecor(value: unknown): PetDecor {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const decor = { ...DEFAULT_PET_DECOR } as Record<PetDecorSlot, string>;
  for (const slot of PET_DECOR_SLOTS) {
    const id = record[slot];
    if (typeof id === 'string' && PET_DECOR_ITEMS[slot].some((item) => item.id === id)) decor[slot] = id;
  }
  return decor;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** An opening span 'HH:MM'–'HH:MM' within one day (start before end). */
export type PetHourSpan = Readonly<{ start: string; end: string }>;
/** What the teacher set for one decor item: a price (null for none yet) and whether it sells now. */
export type PetShopPrice = Readonly<{ price: number | null; sell: boolean }>;

export type PetSettings = Readonly<{
  /** Whether students see their pet in the bank. */
  enabled: boolean;
  /** Growth a pet needs to grow up. The teacher sets it; the screen only estimates how long that takes. */
  goal: number;
  /** About how many tasks one student completes in a week. Only used for that estimate. */
  tasksPerWeek: number;
  /** Growth each feeding adds (and the daily warming, while it is an egg). */
  careGrowth: number;
  /** Growth a completed task with a reward adds. */
  taskGrowth: number;
  /** Price of one feeding, in the class currency. 0 makes it free. Warming an egg is always free. */
  feedPrice: number;
  /** Feedings per student per day (Korea time). 0 turns feeding off. */
  feedDailyLimit: number;
  /** When on, pets are awake (and can be cared for) only within `hours`; with no spans, never. */
  hoursEnabled: boolean;
  hours: ReadonlyArray<PetHourSpan>;
  /** Money a student receives when graduating a grown pet. */
  rewardAmount: number;
  /** A store product a graduating student receives (null for none), like the tree harvest. */
  rewardProductId: string | null;
  shopEnabled: boolean;
  /** Keyed by shop key ('wall:mint', 'acc:ribbon'); items missing here have no price. */
  shopPrices: Readonly<Record<string, PetShopPrice>>;
}>;

export const DEFAULT_PET_SETTINGS: PetSettings = Object.freeze({
  enabled: false,
  goal: 40,
  tasksPerWeek: 5,
  careGrowth: 1,
  taskGrowth: 1,
  feedPrice: 10,
  feedDailyLimit: 2,
  hoursEnabled: false,
  hours: [],
  rewardAmount: 100,
  rewardProductId: null,
  shopEnabled: true,
  shopPrices: {},
});

export const PET_LIMITS = Object.freeze({
  goal: { min: 1, max: 100_000 },
  tasksPerWeek: { min: 0, max: 100 },
  careGrowth: { min: 0, max: 10 },
  taskGrowth: { min: 0, max: 10 },
  feedPrice: { min: 0, max: 1_000_000 },
  feedDailyLimit: { min: 0, max: 3 },
  hourSpans: 8,
  rewardAmount: { min: 0, max: 1_000_000 },
  decorPrice: { min: 0, max: 1_000_000 },
});


/** Growth at which the egg hatches, the pet becomes young, and grows up. */
export function petStageStarts(goal: number): Readonly<{ hatch: number; young: number; adult: number }> {
  return { hatch: Math.max(1, Math.ceil(goal * 0.1)), young: Math.max(1, Math.ceil(goal * 0.45)), adult: Math.max(1, goal) };
}

/** The stage `growth` reaches. A stored stage never goes back down; callers keep the larger one. */
export function petStageFor(growth: number, goal: number): PetStage {
  const starts = petStageStarts(goal);
  if (growth >= starts.adult) return 3;
  if (growth >= starts.young) return 2;
  if (growth >= starts.hatch) return 1;
  return 0;
}

/**
 * How far the pet is toward its next stage (0–1), and which stage that is (null once grown). Students
 * see only this, never the whole way to the goal: the next step is close enough to feel their care.
 */
export function petStageProgress(growth: number, goal: number, stage: PetStage): Readonly<{ next: PetStage | null; fraction: number }> {
  if (stage >= 3) return { next: null, fraction: 1 };
  const starts = petStageStarts(goal);
  const bounds = [0, starts.hatch, starts.young, starts.adult];
  const from = bounds[stage], to = bounds[stage + 1];
  const fraction = to > from ? Math.min(1, Math.max(0, (growth - from) / (to - from))) : 1;
  return { next: (stage + 1) as PetStage, fraction };
}

/**
 * School days a pet takes to grow up when its student warms the egg every school day, then feeds it
 * as often as the class allows, and completes `tasksPerWeek` tasks a week. Null when it would never
 * grow up (nothing adds growth), or would take more than two school years.
 */
export function petEstimateDays(settings: Pick<PetSettings, 'goal' | 'tasksPerWeek' | 'careGrowth' | 'taskGrowth' | 'feedDailyLimit'>): number | null {
  const tasks = (settings.taskGrowth * settings.tasksPerWeek) / SCHOOL_DAYS_PER_WEEK;
  const egg = settings.careGrowth + tasks;
  const fed = settings.careGrowth * settings.feedDailyLimit + tasks;
  const hatch = petStageStarts(settings.goal).hatch;
  if (egg <= 0 || fed <= 0) return null;
  let growth = 0, days = 0;
  while (growth < settings.goal - 1e-9) {
    days += 1;
    if (days > 400) return null;
    growth += growth < hatch - 1e-9 ? egg : fed;
  }
  return days;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** 'HH:MM' of `date` in Korea time. */
export function koreaClock(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/** Whether pets are awake at `clock` ('HH:MM', Korea time). Off means always; on with no spans means never. */
export function petHoursOpen(settings: Pick<PetSettings, 'hoursEnabled' | 'hours'>, clock: string): boolean {
  if (!settings.hoursEnabled) return true;
  return settings.hours.some((span) => span.start <= clock && clock < span.end);
}

/** When pets wake next after `clock`: 'HH:MM' today, '내일 HH:MM', or null when no span is set. */
export function petNextOpen(settings: Pick<PetSettings, 'hoursEnabled' | 'hours'>, clock: string): string | null {
  const starts = settings.hours.map((span) => span.start).sort();
  if (!settings.hoursEnabled || starts.length === 0) return null;
  const later = starts.find((start) => start > clock);
  return later ?? `내일 ${starts[0]}`;
}

export type PetSettingsParse = { ok: true; settings: PetSettings } | { ok: false; error: string };

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** Checks settings sent by a teacher's screen; every field is required. */
export function parsePetSettings(value: unknown): PetSettingsParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '설정 값이 올바르지 않아요.' };
  const input = value as Record<string, unknown>;
  const L = PET_LIMITS;
  if (typeof input.enabled !== 'boolean') return { ok: false, error: '펫 키우기를 켤지 정해 주세요.' };
  const goal = wholeNumber(input.goal, L.goal.min, L.goal.max);
  if (goal === null) return { ok: false, error: `다 자람 목표는 ${L.goal.min}~${L.goal.max.toLocaleString('ko-KR')}점 사이로 적어 주세요.` };
  const tasksPerWeek = wholeNumber(input.tasksPerWeek, L.tasksPerWeek.min, L.tasksPerWeek.max);
  if (tasksPerWeek === null) return { ok: false, error: `일주일에 완료하는 과제 수는 0~${L.tasksPerWeek.max}개 사이로 적어 주세요.` };
  const careGrowth = wholeNumber(input.careGrowth, L.careGrowth.min, L.careGrowth.max);
  if (careGrowth === null) return { ok: false, error: `먹이 성장은 0~${L.careGrowth.max}점 사이로 정해 주세요.` };
  const taskGrowth = wholeNumber(input.taskGrowth, L.taskGrowth.min, L.taskGrowth.max);
  if (taskGrowth === null) return { ok: false, error: `과제 완료 성장은 0~${L.taskGrowth.max}점 사이로 정해 주세요.` };
  const feedPrice = wholeNumber(input.feedPrice, L.feedPrice.min, L.feedPrice.max);
  if (feedPrice === null) return { ok: false, error: `먹이 주기 가격은 0~${L.feedPrice.max.toLocaleString('ko-KR')} 사이의 정수로 적어 주세요.` };
  const feedDailyLimit = wholeNumber(input.feedDailyLimit, L.feedDailyLimit.min, L.feedDailyLimit.max);
  if (feedDailyLimit === null) return { ok: false, error: `하루에 먹이 줄 수 있는 횟수는 0~${L.feedDailyLimit.max}번 사이로 정해 주세요.` };
  if (typeof input.hoursEnabled !== 'boolean') return { ok: false, error: '이용 시간을 켤지 정해 주세요.' };
  if (!Array.isArray(input.hours) || input.hours.length > L.hourSpans) return { ok: false, error: `이용 시간대는 ${L.hourSpans}개까지 넣을 수 있어요.` };
  const hours: PetHourSpan[] = [];
  for (const span of input.hours) {
    const record = span && typeof span === 'object' && !Array.isArray(span) ? span as Record<string, unknown> : {};
    const start = record.start, end = record.end;
    if (typeof start !== 'string' || typeof end !== 'string' || !CLOCK.test(start) || !CLOCK.test(end)) {
      return { ok: false, error: '이용 시간대의 시작과 끝을 모두 넣어 주세요.' };
    }
    if (start >= end) return { ok: false, error: `이용 시간대 ${start}~${end}: 끝나는 시각이 시작보다 늦어야 해요.` };
    hours.push({ start, end });
  }
  hours.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const rewardAmount = wholeNumber(input.rewardAmount, L.rewardAmount.min, L.rewardAmount.max);
  if (rewardAmount === null) return { ok: false, error: `졸업 보상은 0~${L.rewardAmount.max.toLocaleString('ko-KR')} 사이의 정수로 적어 주세요.` };
  const rewardProductId = input.rewardProductId;
  if (rewardProductId !== null && (typeof rewardProductId !== 'string' || !rewardProductId || rewardProductId !== rewardProductId.trim()
    || rewardProductId.length > 200)) {
    return { ok: false, error: '졸업 보상 상품을 다시 골라 주세요.' };
  }
  if (typeof input.shopEnabled !== 'boolean') return { ok: false, error: '상점을 열지 정해 주세요.' };
  const pricesInput = input.shopPrices;
  if (!pricesInput || typeof pricesInput !== 'object' || Array.isArray(pricesInput)) return { ok: false, error: '꾸미기/상점 가격이 올바르지 않아요.' };
  const shopPrices: Record<string, PetShopPrice> = {};
  for (const [key, entry] of Object.entries(pricesInput as Record<string, unknown>)) {
    const item = petDecorItem(key);
    if (!item || item.base) return { ok: false, error: '꾸미기/상점에 없는 물건이 있어요. 화면을 새로고침해 주세요.' };
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (!record || typeof record.sell !== 'boolean') return { ok: false, error: `${item.name}: 팔지 정해 주세요.` };
    const price = record.price === null ? null : wholeNumber(record.price, L.decorPrice.min, L.decorPrice.max);
    if (record.price !== null && price === null) {
      return { ok: false, error: `${item.name}: 가격은 0~${L.decorPrice.max.toLocaleString('ko-KR')} 사이의 정수로 적어 주세요.` };
    }
    if (price === null && !record.sell) continue; // nothing set: leave it out
    shopPrices[key] = { price, sell: price !== null && record.sell };
  }
  return {
    ok: true,
    settings: {
      enabled: input.enabled, goal, tasksPerWeek, careGrowth, taskGrowth, feedPrice, feedDailyLimit,
      hoursEnabled: input.hoursEnabled, hours, rewardAmount, rewardProductId, shopEnabled: input.shopEnabled, shopPrices,
    },
  };
}

/** The decor items a student can buy now, with their prices. */
export function petShopForSale(settings: Pick<PetSettings, 'shopEnabled' | 'shopPrices'>): ReadonlyArray<PetDecorItem & { price: number }> {
  if (!settings.shopEnabled) return [];
  return PET_SELLABLE_DECOR.flatMap((item) => {
    const entry = settings.shopPrices[item.key];
    return entry && entry.sell && entry.price !== null ? [{ ...item, price: entry.price }] : [];
  });
}
