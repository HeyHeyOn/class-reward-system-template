import { PET_DECOR_SLOTS, isPetSpecies } from '@/domain/pet';
import type {
  PetAdoptResultDto,
  PetCareResultDto,
  PetDecorResultDto,
  PetDto,
  PetGraduateResultDto,
  PetStudentViewDto,
} from '@/lib/petApi';
import { bankRequest, type BankResult } from '../bank/bankClient';

/* Calls for the student's pet screen. Commands carry an operation ID, so a resend after a lost answer is safe. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function isPet(value: unknown): value is PetDto {
  return isRecord(value) && typeof value.petId === 'string' && isPetSpecies(value.species)
    && (value.color === null || typeof value.color === 'string') && typeof value.name === 'string'
    && isInt(value.stage) && value.stage >= 0 && value.stage <= 3 && isInt(value.growth) && typeof value.adoptedAt === 'string'
    && (value.accessory === null || typeof value.accessory === 'string');
}

function isRoom(value: unknown): boolean {
  return isRecord(value) && PET_DECOR_SLOTS.every((slot) => typeof value[slot] === 'string');
}

export function isPetView(value: unknown): value is PetStudentViewDto {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isInt(value.goal) || !isRecord(value.stageStarts)
    || !isInt(value.feedPrice) || !isInt(value.feedDailyLimit) || typeof value.awake !== 'boolean'
    || !(value.nextOpen === null || typeof value.nextOpen === 'string') || !(value.pet === null || isPet(value.pet))
    || !Array.isArray(value.companions) || typeof value.warmedToday !== 'boolean' || !isInt(value.feedsToday)
    || !(value.lastFedAt === null || typeof value.lastFedAt === 'string')
    || !isInt(value.rewardAmount) || typeof value.rewardItem !== 'string' || !isRoom(value.room)
    || !Array.isArray(value.owned) || !Array.isArray(value.shop) || !Array.isArray(value.dex) || typeof value.shopEnabled !== 'boolean') return false;
  return value.companions.every(isPet) && value.owned.every((key) => typeof key === 'string')
    && value.shop.every((item) => isRecord(item) && typeof item.key === 'string' && typeof item.name === 'string' && isInt(item.price))
    && value.dex.every((entry) => isRecord(entry) && typeof entry.petId === 'string' && isPetSpecies(entry.species)
      && typeof entry.color === 'string' && typeof entry.name === 'string');
}

export type PetPayload = { balance: number; pet: PetStudentViewDto };
const isPetPayload = (value: unknown): value is PetPayload => isRecord(value) && isInt(value.balance) && isPetView(value.pet);

type Command<T> = { result: T; balance: number; pet: PetStudentViewDto };
const isCommand = <T,>(check: (result: Record<string, unknown>) => boolean) => (value: unknown): value is Command<T> =>
  isRecord(value) && isRecord(value.result) && value.result.ok === true && check(value.result) && isInt(value.balance) && isPetView(value.pet);

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The pet screen. 404 UNSUPPORTED means a Sheets class without pets. */
export function fetchPet(): Promise<BankResult<PetPayload>> {
  return bankRequest('/api/bank/me/pet', { method: 'GET' }, isPetPayload);
}

export function adoptPet(input: { operationId: string; species: string; name: string }): Promise<BankResult<Command<PetAdoptResultDto>>> {
  return bankRequest('/api/bank/me/pet/adopt', post(input), isCommand<PetAdoptResultDto>((result) => isPet(result.pet)));
}

/** Warming the egg or feeding the room. */
export function carePet(operationId: string, kind: 'WARM' | 'FEED'): Promise<BankResult<Command<PetCareResultDto>>> {
  return bankRequest('/api/bank/me/pet/care', post({ operationId, kind }), isCommand<PetCareResultDto>((result) => isPet(result.pet) && isInt(result.grew)));
}

export function graduatePet(operationId: string): Promise<BankResult<Command<PetGraduateResultDto>>> {
  return bankRequest('/api/bank/me/pet/graduate', post({ operationId }), isCommand<PetGraduateResultDto>((result) => typeof result.name === 'string'));
}

/** Buys an item; an accessory goes on `petId` when one is given. */
export function buyPetDecor(input: { operationId: string; itemKey: string; petId?: string }): Promise<BankResult<Command<PetDecorResultDto>>> {
  return bankRequest('/api/bank/me/pet/decor/buy', post(input), isCommand<PetDecorResultDto>((result) => isRoom(result.room)));
}

/** Places an owned item in the room, or puts an accessory on `petId`. */
export function placePetDecor(itemKey: string, petId?: string): Promise<BankResult<Command<PetDecorResultDto>>> {
  return bankRequest('/api/bank/me/pet/decor/place', post(petId === undefined ? { itemKey } : { itemKey, petId }),
    isCommand<PetDecorResultDto>((result) => isRoom(result.room)));
}

/** Calls graduated pets to the room (the list replaces the one before). */
export function setPetCompanions(petIds: ReadonlyArray<string>): Promise<BankResult<Command<{ ok: true }>>> {
  return bankRequest('/api/bank/me/pet/companions', post({ petIds }), isCommand<{ ok: true }>(() => true));
}
