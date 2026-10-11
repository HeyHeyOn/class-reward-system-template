import type { PetDecor, PetHourSpan, PetSettings, PetShopSlot, PetSpecies, PetStage } from '@/domain/pet';
import type { DigitalKind } from '@/lib/studentBagApi';

/* What the pet API sends to the student bank and to the teacher's screen. */

export type PetDto = Readonly<{
  petId: string;
  species: PetSpecies;
  /** Null while it is an egg (the color is picked when it hatches). */
  color: string | null;
  name: string;
  stage: PetStage;
  growth: number;
  adoptedAt: string;
  /** The accessory it wears (an id from PET_ACCESSORIES), or null. An egg wears none. */
  accessory: string | null;
}>;

/** A graduated pet in the student's 도감. */
export type PetDexEntryDto = Readonly<{
  petId: string;
  species: PetSpecies;
  color: string;
  name: string;
  graduatedAt: string;
  accessory: string | null;
}>;

export type PetDexPageDto = Readonly<{
  entries: ReadonlyArray<PetDexEntryDto>;
  /** One latest representative per collected species/color (at most 28). */
  collection: ReadonlyArray<PetDexEntryDto>;
  nextCursor: string | null;
}>;

export const PET_DEX_PAGE_SIZE = 24;

export type PetShopItemDto = Readonly<{ key: string; slot: PetShopSlot; id: string; name: string; price: number }>;

export type PetStageStartsDto = Readonly<{ hatch: number; young: number; adult: number }>;

/** The pet screen for one student. `pet` is null when the student has not picked an egg yet. */
export type PetStudentViewDto = Readonly<{
  enabled: boolean;
  goal: number;
  stageStarts: PetStageStartsDto;
  careGrowth: number;
  taskGrowth: number;
  feedPrice: number;
  feedDailyLimit: number;
  hoursEnabled: boolean;
  hours: ReadonlyArray<PetHourSpan>;
  /** Whether pets are awake now (always, when the teacher has not set opening hours). */
  awake: boolean;
  /** When they wake next ('HH:MM', '내일 HH:MM'), or null. */
  nextOpen: string | null;
  pet: PetDto | null;
  /** Graduated pets called back to keep `pet` company (at most two). */
  companions: ReadonlyArray<PetDto>;
  /** Whether this student has warmed any egg today (shared across new pets). */
  warmedToday: boolean;
  /** The student's own feedings today, for the daily limit (food from completed tasks is not counted). */
  feedsToday: number;
  /** The student's last feeding (or when the egg was picked), for how hungry the animals look. */
  lastFedAt: string | null;
  rewardAmount: number;
  /** The graduation reward item's title ('' for none). */
  rewardItem: string;
  room: PetDecor;
  /** Decor keys the student owns beyond the base items. */
  owned: ReadonlyArray<string>;
  shopEnabled: boolean;
  shop: ReadonlyArray<PetShopItemDto>;
  /** Compatibility field; current state leaves it empty. Load the dex page on demand. */
  dex: ReadonlyArray<PetDexEntryDto>;
}>;

export type PetAdoptResultDto = Readonly<{ ok: true; operationId: string; pet: PetDto }>;

export type PetCareResultDto = Readonly<{
  ok: true;
  operationId: string;
  kind: 'WARM' | 'FEED';
  price: number;
  balanceAfter: number;
  /** Growth this care added to the pet being raised (0 when it fed only the egg's company). */
  grew: number;
  pet: PetDto;
  /** The stage before this care, to tell a hatch or a growth spurt. */
  stageBefore: PetStage;
  caresToday: number;
}>;

export type PetGraduateResultDto = Readonly<{
  ok: true;
  operationId: string;
  petId: string;
  name: string;
  rewardAmount: number;
  rewardItem: string;
  balanceAfter: number;
}>;

export type PetDecorResultDto = Readonly<{
  ok: true;
  operationId: string | null;
  itemKey: string;
  price: number;
  balanceAfter: number | null;
  room: PetDecor;
}>;

export type PetRewardProductDto = Readonly<{
  productId: string;
  name: string;
  imageUrl: string | null;
  isActive: boolean;
  digitalKind: DigitalKind | null;
}>;

/** One student's row on the teacher's 펫 목록. */
export type PetAdminStudentDto = Readonly<{
  studentId: string;
  name: string;
  pet: Pick<PetDto, 'petId' | 'species' | 'color' | 'name' | 'stage' | 'growth' | 'accessory'> | null;
  /** Everything the pet got today: warming, the student's feedings and food from completed tasks. */
  caresToday: number;
  warmedToday: boolean;
  /** The student's own feedings today (these count toward the daily limit). */
  feedsToday: number;
  /** Food completed tasks gave today (no limit). */
  taskFeedsToday: number;
  /** Days with a care or a task's food in the last 7 days (today included). */
  caredDays7: number;
  graduations: number;
}>;

export type PetAdminBoardDto = Readonly<{
  settings: PetSettings;
  goal: number;
  stageStarts: PetStageStartsDto;
  rewardProducts: ReadonlyArray<PetRewardProductDto>;
  students: ReadonlyArray<PetAdminStudentDto>;
}>;

/** What a completed task added to the class tree (drops) and to the student's pet (growth). */
export type PetTaskGainsDto = Readonly<{ tree: number; pet: number }>;

export const PET_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
