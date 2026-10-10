import 'server-only';

import { createHash, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  DEFAULT_PET_SETTINGS,
  PET_COLORS,
  PET_DECOR_ITEMS,
  PET_LIMITS,
  PET_MAX_COMPANIONS,
  cleanPetName,
  isPetAccessory,
  isPetSpecies,
  koreaClock,
  normalizePetDecor,
  parsePetSettings,
  petDecorItem,
  petHoursOpen,
  petNextOpen,
  petShopForSale,
  petStageFor,
  petStageStarts,
  type PetDecor,
  type PetDecorSlot,
  type PetSettings,
  type PetSpecies,
  type PetStage,
} from '@/domain/pet';
import {
  PET_OPERATION_ID,
  type PetAdminBoardDto,
  type PetAdoptResultDto,
  type PetCareResultDto,
  type PetDecorResultDto,
  type PetDto,
  type PetGraduateResultDto,
  type PetStudentViewDto,
  type PetTaskGainsDto,
} from '@/lib/petApi';
import { appendOperationAudit } from './operationAudit';
import { givePetReward, readRewardProduct, storageItemShape } from './studentBag';

/*
 * Personal pets (migrations 0048–0049). Lock order, shared with every other money writer: the student's
 * student/account rows first, then the student's pet row. Hooks that run inside other writers
 * (task rewards, cancellation) check that the tables exist first, so those writers keep working on
 * databases without them.
 */

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type PetErrorCode =
  | 'PET_OFF' | 'PET_ASLEEP' | 'NO_PET' | 'HAS_PET' | 'DAILY_LIMIT' | 'FEED_OFF' | 'NOT_ENOUGH_MONEY' | 'NOT_GROWN'
  | 'STUDENT_INVALID' | 'SHOP_CLOSED' | 'DECOR_UNAVAILABLE' | 'DECOR_OWNED' | 'DECOR_NOT_OWNED' | 'PET_NOT_FOUND'
  | 'NO_COMPANY' | 'INVALID_INPUT' | 'OPERATION_CONFLICT' | 'OPERATION_PENDING' | 'UNSUPPORTED';

export class PetError extends Error {
  constructor(readonly code: PetErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'PetError';
  }
}

const KOREA_TODAY = sql`(clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date`;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type SettingsRow = {
  pet_enabled: boolean; target_weeks: number; goal_override: string | null; tasks_per_week: number; care_growth: number;
  task_growth: number; feed_price: string; feed_daily_limit: number; hours_enabled: boolean; hours: unknown; reward_amount: string;
  reward_product_id: string | null; shop_enabled: boolean; shop_prices: unknown;
};
type PetRow = {
  pet_id: string; student_id: string; species: string; color: string | null; name: string; stage: number; growth: string;
  status: string; adopted_at: Date | string; accessory: string | null;
};
type OperationRow = { operation_kind: string; payload_hash: string; status: string; result_snapshot: unknown };
type AccountRow = { name: string; status: string; deleted_at: unknown; balance: string };

const toNumber = (value: string | number | bigint | null | undefined): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Pet integer is out of range.');
  return parsed;
};
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const asStage = (value: number): PetStage => (value >= 3 ? 3 : value <= 0 ? 0 : value as PetStage);

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function requireOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !PET_OPERATION_ID.test(operationId)) {
    throw new PetError('INVALID_INPUT', '요청 번호가 올바르지 않아요. 다시 시도해 주세요.', 400);
  }
  return operationId;
}

/** Whether migration 0048 is installed; hooks shared with older paths check it first. */
async function petTablesPresent(tx: TenantTransaction): Promise<boolean> {
  const result = await tx.execute(sql`SELECT to_regclass('public.pet_growth') IS NOT NULL AS present`);
  return (result.rows[0] as { present?: unknown } | undefined)?.present === true;
}

export async function readPetSettings(tx: TenantTransaction, tenantId: string): Promise<PetSettings> {
  const result = await tx.execute(sql`
    SELECT pet_enabled, target_weeks, goal_override::text AS goal_override, tasks_per_week, care_growth, task_growth,
           feed_price::text AS feed_price, feed_daily_limit, hours_enabled, hours, reward_amount::text AS reward_amount,
           reward_product_id, shop_enabled, shop_prices
    FROM pet_settings WHERE tenant_id=${tenantId}`);
  const row = result.rows[0] as SettingsRow | undefined;
  if (!row) return DEFAULT_PET_SETTINGS;
  // goal_override holds the goal since 0049. A row an older deployment saved without one gets the goal its weeks gave.
  const careGrowth = toNumber(row.care_growth), taskGrowth = toNumber(row.task_growth);
  const goal = row.goal_override !== null ? toNumber(row.goal_override)
    : Math.min(PET_LIMITS.goal.max, Math.max(1, Math.max(1, careGrowth + taskGrowth) * 5 * toNumber(row.target_weeks)));
  // Stored values went through the same checks when they were saved; parse again so a bad row falls back safely.
  const parsed = parsePetSettings({
    enabled: row.pet_enabled === true,
    goal,
    tasksPerWeek: toNumber(row.tasks_per_week),
    careGrowth,
    taskGrowth,
    feedPrice: toNumber(row.feed_price),
    feedDailyLimit: toNumber(row.feed_daily_limit),
    hoursEnabled: row.hours_enabled === true,
    hours: Array.isArray(row.hours) ? row.hours : [],
    rewardAmount: toNumber(row.reward_amount),
    rewardProductId: row.reward_product_id,
    shopEnabled: row.shop_enabled === true,
    shopPrices: row.shop_prices && typeof row.shop_prices === 'object' ? row.shop_prices : {},
  });
  if (!parsed.ok) throw new Error(`Stored pet settings are invalid: ${parsed.error}`);
  return parsed.settings;
}

const PET_COLUMNS = sql`pet_id, student_id, species, color, name, stage, growth::text AS growth, status, adopted_at, accessory`;

async function readRaisingPet(tx: TenantTransaction, tenantId: string, studentId: string, lock: boolean): Promise<PetRow | undefined> {
  const statement = sql`SELECT ${PET_COLUMNS} FROM pets WHERE tenant_id=${tenantId} AND student_id=${studentId} AND status='RAISING'`;
  const result = await tx.execute(lock ? sql`${statement} FOR UPDATE` : statement);
  return result.rows[0] as PetRow | undefined;
}

function petDto(row: PetRow): PetDto {
  if (!isPetSpecies(row.species)) throw new Error('Stored pet species is invalid.');
  return {
    petId: row.pet_id, species: row.species, color: row.color, name: row.name, stage: asStage(row.stage),
    growth: toNumber(row.growth), adoptedAt: iso(row.adopted_at), accessory: row.stage > 0 && isPetAccessory(row.accessory) ? row.accessory : null,
  };
}

async function lockStudentAccount(tx: TenantTransaction, tenantId: string, studentId: string): Promise<AccountRow> {
  const result = await tx.execute(sql`
    SELECT s.name, s.status, s.deleted_at, a.balance::text AS balance
    FROM students s JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id=${studentId}
    FOR UPDATE OF s, a`);
  const account = result.rows[0] as AccountRow | undefined;
  if (!account || account.status !== 'ACTIVE' || account.deleted_at !== null) {
    throw new PetError('STUDENT_INVALID', '학생 정보를 확인하지 못했어요. 다시 로그인해 주세요.', 404);
  }
  return account;
}

async function koreaToday(tx: TenantTransaction): Promise<string> {
  const result = await tx.execute(sql`SELECT ${KOREA_TODAY}::text AS today`);
  return (result.rows[0] as { today: string }).today;
}

/** A purchase paid from the student's balance (feeding, decor). The account rows must be locked. */
async function spend(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; account: AccountRow; price: number; transactionId: string; status: 'PET_FEED' | 'PET_DECOR';
  operationId: string; payloadHash: string; now: Date;
}>): Promise<number> {
  const balance = toNumber(input.account.balance);
  const balanceAfter = balance - input.price;
  await tx.execute(sql`
    UPDATE accounts SET balance=${balanceAfter}, version=version+1, updated_at=${input.now}
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId}`);
  await tx.execute(sql`
    INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind, legacy_total_amount,
       balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, operation_id,
       operation_hash, schema_version)
    VALUES (${tenantId}, ${input.transactionId}, ${input.now}, ${input.studentId}, ${input.account.name}, 'GROWTH_SPEND',
            ${input.price}, ${-input.price}, ${balance}, ${balanceAfter}, 'bank-pet', ${input.status}, ${input.operationId},
            ${input.payloadHash}, 1)`);
  return balanceAfter;
}

/** A color for a hatching egg: one the student has not graduated yet in this species, else any. */
async function pickColor(tx: TenantTransaction, tenantId: string, studentId: string, species: PetSpecies): Promise<string> {
  const result = await tx.execute(sql`
    SELECT DISTINCT color FROM pets
    WHERE tenant_id=${tenantId} AND student_id=${studentId} AND species=${species} AND status='GRADUATED'`);
  const had = new Set((result.rows as Array<{ color: string | null }>).map((row) => row.color));
  const all = PET_COLORS[species].map((color) => color.id);
  const fresh = all.filter((color) => !had.has(color));
  const pool = fresh.length ? fresh : all;
  return pool[randomInt(pool.length)];
}

/**
 * Adds a growth row and moves the pet on. The stage only ever rises (a cancelled growth never shrinks
 * a pet); an egg that reaches its hatching point gets its color. The pet row must be locked.
 */
async function addGrowth(tx: TenantTransaction, tenantId: string, pet: PetRow, settings: PetSettings, entry: Readonly<{
  growthId: string; source: 'CARE' | 'TASK' | 'CANCEL'; amount: number; careDate: string | null;
  transactionId: string | null; operationId: string | null;
}>): Promise<PetRow> {
  const before = toNumber(pet.growth);
  const after = before + entry.amount;
  if (after < 0 || after > MAX_SAFE) throw new Error('Pet growth out of range.');
  await tx.execute(sql`
    INSERT INTO pet_growth (tenant_id, growth_id, pet_id, source, student_id, amount, care_date, transaction_id, operation_id)
    VALUES (${tenantId}, ${entry.growthId}, ${pet.pet_id}, ${entry.source}, ${pet.student_id}, ${entry.amount},
            ${entry.careDate}::date, ${entry.transactionId}, ${entry.operationId})`);
  const stage = Math.max(pet.stage, petStageFor(after, settings.goal));
  const hatching = pet.stage === 0 && stage > 0;
  const color = hatching && isPetSpecies(pet.species) ? await pickColor(tx, tenantId, pet.student_id, pet.species) : pet.color;
  const updated = await tx.execute(sql`
    UPDATE pets SET growth=${after}, stage=${stage}, color=${color},
           hatched_at=CASE WHEN ${hatching} THEN clock_timestamp() ELSE hatched_at END, version=version+1
    WHERE tenant_id=${tenantId} AND pet_id=${pet.pet_id}
    RETURNING ${PET_COLUMNS}`);
  return updated.rows[0] as PetRow;
}

/*
 * Idempotent operations: the first call stores its result under the client's operation ID; a
 * repeat with the same payload returns it, a different payload under the same ID is refused.
 * A failed command rolls back with its PENDING row, so retrying a refusal is always safe.
 */
async function runOperation<TResult extends object>(
  tx: TenantTransaction, tenantId: string, operationId: string, payloadHash: string, eventType: string,
  body: (now: Date) => Promise<{ result: TResult; entityId: string; details: Record<string, unknown> }>,
): Promise<TResult> {
  const existing = await tx.execute(sql`
    SELECT operation_kind, payload_hash, status, result_snapshot FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId} FOR UPDATE`);
  const found = existing.rows[0] as OperationRow | undefined;
  if (found) return resolveOperation<TResult>(found, payloadHash);
  const now = new Date();
  const inserted = await tx.execute(sql`
    INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count, started_at, created_at, updated_at)
    VALUES (${tenantId}, ${operationId}, 'GROWTH', ${payloadHash}, 'PENDING', 1, ${now}, ${now}, ${now})
    ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`);
  if (inserted.rows.length === 0) {
    const raced = await tx.execute(sql`
      SELECT operation_kind, payload_hash, status, result_snapshot FROM operations
      WHERE tenant_id=${tenantId} AND operation_id=${operationId} FOR UPDATE`);
    const row = raced.rows[0] as OperationRow | undefined;
    if (!row) throw new Error('Pet operation could not be read.');
    return resolveOperation<TResult>(row, payloadHash);
  }
  const { result, entityId, details } = await body(now);
  await appendOperationAudit(tx, tenantId, {
    operationId, eventType, entityType: 'pet', entityId, redactedDetails: details, occurredAt: now,
  });
  await tx.execute(sql`
    UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}`);
  return result;
}

function resolveOperation<TResult>(row: OperationRow, payloadHash: string): TResult {
  if (row.operation_kind !== 'GROWTH' || row.payload_hash !== payloadHash) {
    throw new PetError('OPERATION_CONFLICT', '같은 요청 번호로 다른 내용이 이미 처리됐어요. 화면을 새로고침해 주세요.', 409);
  }
  if (row.status !== 'SUCCEEDED' || !row.result_snapshot || typeof row.result_snapshot !== 'object') {
    throw new PetError('OPERATION_PENDING', '앞서 보낸 요청을 아직 처리하고 있어요. 잠시 후 다시 확인해 주세요.', 409);
  }
  return row.result_snapshot as TResult;
}

function requireAwake(settings: PetSettings, now: Date, what: string): void {
  if (!settings.enabled) throw new PetError('PET_OFF', '선생님이 아직 펫 키우기를 열지 않았어요.', 409);
  if (!petHoursOpen(settings, koreaClock(now))) {
    const next = petNextOpen(settings, koreaClock(now));
    throw new PetError('PET_ASLEEP', `이용 시간이 아니라 펫이 자고 있어요.${next ? ` ${next}에 일어나요.` : ''} 그동안은 ${what} 수 없어요.`, 409);
  }
}

async function readRoom(tx: TenantTransaction, tenantId: string, studentId: string): Promise<PetDecor> {
  const result = await tx.execute(sql`SELECT decor FROM pet_rooms WHERE tenant_id=${tenantId} AND student_id=${studentId}`);
  return normalizePetDecor((result.rows[0] as { decor?: unknown } | undefined)?.decor);
}

/** The graduated pets the student has called back to the room, in the order they came. */
async function readCompanions(tx: TenantTransaction, tenantId: string, studentId: string): Promise<PetRow[]> {
  const result = await tx.execute(sql`
    SELECT p.pet_id, p.student_id, p.species, p.color, p.name, p.stage, p.growth::text AS growth, p.status, p.adopted_at, p.accessory
    FROM pet_rooms r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.companions) WITH ORDINALITY AS c(pet_id, place)
    JOIN pets p ON p.tenant_id=r.tenant_id AND p.pet_id=c.pet_id AND p.student_id=r.student_id AND p.status='GRADUATED'
    WHERE r.tenant_id=${tenantId} AND r.student_id=${studentId}
    ORDER BY c.place`);
  return result.rows as PetRow[];
}

async function saveRoom(tx: TenantTransaction, tenantId: string, studentId: string, decor: PetDecor): Promise<void> {
  await tx.execute(sql`
    INSERT INTO pet_rooms (tenant_id, student_id, decor) VALUES (${tenantId}, ${studentId}, ${JSON.stringify(decor)}::jsonb)
    ON CONFLICT (tenant_id, student_id) DO UPDATE SET decor=EXCLUDED.decor, version=pet_rooms.version+1, updated_at=clock_timestamp()`);
}

async function saveCompanions(tx: TenantTransaction, tenantId: string, studentId: string, petIds: readonly string[]): Promise<void> {
  await tx.execute(sql`
    INSERT INTO pet_rooms (tenant_id, student_id, companions) VALUES (${tenantId}, ${studentId}, ${JSON.stringify(petIds)}::jsonb)
    ON CONFLICT (tenant_id, student_id) DO UPDATE SET companions=EXCLUDED.companions, version=pet_rooms.version+1, updated_at=clock_timestamp()`);
}

/* ------------------------------------------------------------------ */
/* Hooks used inside other money writers                               */
/* ------------------------------------------------------------------ */

/** A paid task completion adds the class's task growth to the student's pet (when pets are on). */
export async function addTaskPetGrowth(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; transactionId: string; operationId: string;
}>): Promise<void> {
  if (!await petTablesPresent(tx)) return;
  const settings = await readPetSettings(tx, tenantId);
  if (!settings.enabled || settings.taskGrowth === 0) return;
  const pet = await readRaisingPet(tx, tenantId, input.studentId, true);
  if (!pet) return;
  await addGrowth(tx, tenantId, pet, settings, {
    growthId: `pet-task:${input.transactionId}`, source: 'TASK', amount: settings.taskGrowth, careDate: null,
    transactionId: input.transactionId, operationId: input.operationId,
  });
}

/**
 * When a feeding, a decor purchase or a task reward is cancelled: the growth it gave leaves a pet that
 * is still being raised (a graduated pet keeps what it had), and the decor it bought is taken back
 * (its slot in the room goes back to the base item).
 */
export async function revokePetForTransaction(tx: TenantTransaction, tenantId: string, input: Readonly<{
  originalTransactionId: string; reversalTransactionId: string; operationId: string;
}>): Promise<void> {
  if (!await petTablesPresent(tx)) return;
  const given = await tx.execute(sql`
    SELECT pet_id, sum(amount)::text AS amount FROM pet_growth
    WHERE tenant_id=${tenantId} AND transaction_id=${input.originalTransactionId} AND source IN ('CARE', 'TASK')
    GROUP BY pet_id ORDER BY pet_id`);
  const rows = given.rows as Array<{ pet_id: string; amount: string }>;
  const settings = rows.length ? await readPetSettings(tx, tenantId) : DEFAULT_PET_SETTINGS;
  for (const row of rows) {
    const petResult = await tx.execute(sql`SELECT ${PET_COLUMNS} FROM pets WHERE tenant_id=${tenantId} AND pet_id=${row.pet_id} FOR UPDATE`);
    const pet = petResult.rows[0] as PetRow | undefined;
    if (!pet || pet.status !== 'RAISING') continue;
    const amount = Math.min(toNumber(row.amount), toNumber(pet.growth));
    if (amount <= 0) continue;
    await addGrowth(tx, tenantId, pet, settings, {
      growthId: `pet-cancel:${input.reversalTransactionId}:${pet.pet_id}`, source: 'CANCEL', amount: -amount, careDate: null,
      transactionId: input.reversalTransactionId, operationId: input.operationId,
    });
  }
  const decor = await tx.execute(sql`
    UPDATE pet_decor SET revoked_at=clock_timestamp()
    WHERE tenant_id=${tenantId} AND transaction_id=${input.originalTransactionId} AND revoked_at IS NULL
    RETURNING student_id, item_key`);
  for (const row of decor.rows as Array<{ student_id: string; item_key: string }>) {
    const item = petDecorItem(row.item_key);
    if (!item) continue;
    if (item.slot === 'acc') {
      await tx.execute(sql`
        UPDATE pets SET accessory=NULL, version=version+1
        WHERE tenant_id=${tenantId} AND student_id=${row.student_id} AND accessory=${item.id}`);
      continue;
    }
    const room = await readRoom(tx, tenantId, row.student_id);
    if (room[item.slot] === item.id) {
      const base = PET_DECOR_ITEMS[item.slot].find((entry) => entry.base)?.id ?? room[item.slot];
      await saveRoom(tx, tenantId, row.student_id, { ...room, [item.slot]: base });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Commands and reads                                                  */
/* ------------------------------------------------------------------ */

export type PetDependencies = Readonly<{ tenantId: string; runTenantTransaction: RunTenantTransaction; now?: () => Date }>;

export function createPetCommands(dependencies: PetDependencies) {
  const { tenantId, runTenantTransaction } = dependencies;
  const clockNow = dependencies.now ?? (() => new Date());

  async function rewardItemTitle(tx: TenantTransaction, settings: PetSettings): Promise<string> {
    if (settings.rewardProductId === null) return '';
    const product = await readRewardProduct(tx, tenantId, settings.rewardProductId);
    return product ? storageItemShape(product).title : '';
  }

  async function view(tx: TenantTransaction, studentId: string): Promise<PetStudentViewDto> {
    const settings = await readPetSettings(tx, tenantId);
    const now = clockNow();
    const clock = koreaClock(now);
    const goal = settings.goal;
    const pet = await readRaisingPet(tx, tenantId, studentId, false);
    let warmedToday = false, lastFedAt: string | null = null;
    // Feeding is for the whole room (the pet and the graduated pets with it): the limit and hunger count the student's feedings.
    const counts = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM pet_cares WHERE tenant_id=${tenantId} AND student_id=${studentId} AND care_date=${KOREA_TODAY}
           AND kind='FEED') AS feeds,
        (SELECT count(*)::int FROM pet_cares WHERE tenant_id=${tenantId} AND pet_id=${pet?.pet_id ?? ''} AND care_date=${KOREA_TODAY}
           AND kind='WARM') AS warms,
        (SELECT max(created_at) FROM pet_cares WHERE tenant_id=${tenantId} AND student_id=${studentId} AND kind='FEED') AS fed`);
    const row = counts.rows[0] as { feeds: number; warms: number; fed: Date | string | null };
    const feedsToday = toNumber(row.feeds);
    if (pet) {
      warmedToday = toNumber(row.warms) > 0;
      lastFedAt = row.fed === null ? iso(pet.adopted_at) : iso(row.fed);
    }
    const owned = await tx.execute(sql`
      SELECT item_key FROM pet_decor WHERE tenant_id=${tenantId} AND student_id=${studentId} AND revoked_at IS NULL ORDER BY item_key`);
    const dex = await tx.execute(sql`
      SELECT pet_id, species, color, name, graduated_at, accessory FROM pets
      WHERE tenant_id=${tenantId} AND student_id=${studentId} AND status='GRADUATED' ORDER BY graduated_at, pet_id`);
    return {
      enabled: settings.enabled,
      goal,
      stageStarts: petStageStarts(goal),
      careGrowth: settings.careGrowth,
      taskGrowth: settings.taskGrowth,
      feedPrice: settings.feedPrice,
      feedDailyLimit: settings.feedDailyLimit,
      hoursEnabled: settings.hoursEnabled,
      hours: settings.hours,
      awake: petHoursOpen(settings, clock),
      nextOpen: petNextOpen(settings, clock),
      pet: pet ? petDto(pet) : null,
      companions: pet ? (await readCompanions(tx, tenantId, studentId)).map(petDto) : [],
      warmedToday,
      feedsToday,
      lastFedAt,
      rewardAmount: settings.rewardAmount,
      rewardItem: await rewardItemTitle(tx, settings),
      room: await readRoom(tx, tenantId, studentId),
      owned: (owned.rows as Array<{ item_key: string }>).map((entry) => entry.item_key),
      shopEnabled: settings.shopEnabled,
      shop: petShopForSale(settings).map(({ key, slot, id, name, price }) => ({ key, slot, id, name, price })),
      dex: (dex.rows as Array<{ pet_id: string; species: string; color: string; name: string; graduated_at: Date | string; accessory: string | null }>)
        .filter((entry) => isPetSpecies(entry.species))
        .map((entry) => ({
          petId: entry.pet_id, species: entry.species as PetSpecies, color: entry.color, name: entry.name, graduatedAt: iso(entry.graduated_at),
          accessory: isPetAccessory(entry.accessory) ? entry.accessory : null,
        })),
    };
  }

  /** One of the student's hatched pets (being raised or graduated), locked, to put an accessory on. */
  async function readWearer(tx: TenantTransaction, studentId: string, petId: unknown): Promise<PetRow> {
    if (typeof petId !== 'string' || !petId || petId.length > 200) throw new PetError('INVALID_INPUT', '장식을 할 펫을 다시 골라 주세요.', 400);
    const result = await tx.execute(sql`
      SELECT ${PET_COLUMNS} FROM pets WHERE tenant_id=${tenantId} AND pet_id=${petId} AND student_id=${studentId} FOR UPDATE`);
    const pet = result.rows[0] as PetRow | undefined;
    if (!pet) throw new PetError('PET_NOT_FOUND', '펫을 찾지 못했어요. 화면을 새로고침해 주세요.', 404);
    if (pet.stage === 0) throw new PetError('INVALID_INPUT', '알은 장식을 할 수 없어요. 부화하면 해 줄 수 있어요.', 409);
    return pet;
  }

  async function wear(tx: TenantTransaction, pet: PetRow, accessory: string | null): Promise<void> {
    await tx.execute(sql`UPDATE pets SET accessory=${accessory}, version=version+1 WHERE tenant_id=${tenantId} AND pet_id=${pet.pet_id}`);
  }

  const commands = {
    /** The pet screen for one student. */
    async studentView(studentId: string): Promise<PetStudentViewDto> {
      return runTenantTransaction(tenantId, (tx) => view(tx, studentId));
    },

    /** The student picks an egg of a species and names it. */
    async adopt(input: Readonly<{ studentId: string; operationId: string; species: unknown; name: unknown }>): Promise<PetAdoptResultDto> {
      const operationId = requireOperationId(input.operationId);
      if (!isPetSpecies(input.species)) throw new PetError('INVALID_INPUT', '키울 동물을 다시 골라 주세요.', 400);
      const name = cleanPetName(input.name);
      if (name === null) throw new PetError('INVALID_INPUT', '이름은 1~8자로 지어 주세요.', 400);
      const species = input.species;
      const studentId = input.studentId;
      const payloadHash = hashOf({ kind: 'PET_ADOPT', studentId, species, name, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'PET_ADOPTED', async (now) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '알을 고를');
        await lockStudentAccount(tx, tenantId, studentId);
        if (await readRaisingPet(tx, tenantId, studentId, true)) {
          throw new PetError('HAS_PET', '이미 키우는 펫이 있어요. 다 키워 졸업시키면 새 알을 고를 수 있어요.', 409);
        }
        const petId = `pet:${operationId}`;
        const inserted = await tx.execute(sql`
          INSERT INTO pets (tenant_id, pet_id, student_id, species, name, adopted_at)
          VALUES (${tenantId}, ${petId}, ${studentId}, ${species}, ${name}, ${now})
          RETURNING ${PET_COLUMNS}`);
        const pet = petDto(inserted.rows[0] as PetRow);
        return { result: { ok: true, operationId, pet }, entityId: petId, details: { studentId, species } };
      }));
    },

    /**
     * Caring for the room: warming the egg (free, once a day) or feeding (the class price, up to the
     * daily limit). Feeding fills the bowl for every animal in the room; each feeding adds the care
     * growth to a hatched pet being raised, and the daily warming adds it to an egg. While the pet is
     * still an egg, feeding is for the graduated pets keeping it company (no growth).
     */
    async care(input: Readonly<{ studentId: string; operationId: string; kind?: unknown }>): Promise<PetCareResultDto> {
      const operationId = requireOperationId(input.operationId);
      const studentId = input.studentId;
      if (input.kind !== undefined && input.kind !== 'WARM' && input.kind !== 'FEED') {
        throw new PetError('INVALID_INPUT', '돌봐 줄 방법을 다시 골라 주세요.', 400);
      }
      const asked = input.kind as 'WARM' | 'FEED' | undefined;
      const payloadHash = hashOf(asked ? { kind: 'PET_CARE', care: asked, studentId, schemaVersion: 2 } : { kind: 'PET_CARE', studentId, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'PET_CARED', async (now) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '돌봐 줄');
        const account = await lockStudentAccount(tx, tenantId, studentId);
        const pet = await readRaisingPet(tx, tenantId, studentId, true);
        if (!pet) throw new PetError('NO_PET', '아직 키우는 펫이 없어요. 먼저 알을 골라 주세요.', 409);
        const today = await koreaToday(tx);
        const kind = asked ?? (pet.stage === 0 ? 'WARM' : 'FEED');
        if (kind === 'WARM' && pet.stage > 0) throw new PetError('INVALID_INPUT', '알이 이미 부화했어요. 먹이를 주세요.', 409);
        if (kind === 'FEED') {
          if (settings.feedDailyLimit === 0) throw new PetError('FEED_OFF', '지금은 먹이 주기를 쉬고 있어요.', 409);
          if (pet.stage === 0 && (await readCompanions(tx, tenantId, studentId)).length === 0) {
            throw new PetError('NO_COMPANY', '알은 먹이를 먹지 않아요. 알을 품어 주세요.', 409);
          }
        }
        const done = await tx.execute(kind === 'WARM'
          ? sql`SELECT count(*)::int AS count FROM pet_cares WHERE tenant_id=${tenantId} AND pet_id=${pet.pet_id} AND kind='WARM' AND care_date=${today}::date`
          : sql`SELECT count(*)::int AS count FROM pet_cares WHERE tenant_id=${tenantId} AND student_id=${studentId} AND kind='FEED' AND care_date=${today}::date`);
        const caresBefore = toNumber((done.rows[0] as { count: number }).count);
        if (caresBefore >= (kind === 'WARM' ? 1 : settings.feedDailyLimit)) {
          throw new PetError('DAILY_LIMIT', kind === 'WARM' ? '오늘은 알을 품어 줬어요. 내일 또 품어 줄 수 있어요.' : '오늘 먹이는 다 줬어요. 내일 또 줄 수 있어요.', 409);
        }
        const price = kind === 'FEED' ? settings.feedPrice : 0;
        if (toNumber(account.balance) < price) throw new PetError('NOT_ENOUGH_MONEY', '잔액이 부족해서 먹이를 줄 수 없어요.', 409);
        let balanceAfter = toNumber(account.balance);
        let transactionId: string | null = null;
        if (price > 0) {
          transactionId = `pet-feed:${operationId}`;
          balanceAfter = await spend(tx, tenantId, { studentId, account, price, transactionId, status: 'PET_FEED', operationId, payloadHash, now });
        }
        await tx.execute(sql`
          INSERT INTO pet_cares (tenant_id, care_id, pet_id, student_id, kind, care_date, transaction_id, operation_id, created_at)
          VALUES (${tenantId}, ${`pet-care:${operationId}`}, ${pet.pet_id}, ${studentId}, ${kind}, ${today}::date, ${transactionId},
                  ${operationId}, ${now})`);
        let after = pet;
        let grew = 0;
        // An egg grows from its warming; feeding the company of an egg adds nothing to it.
        if (settings.careGrowth > 0 && (kind === 'WARM' || pet.stage > 0)) {
          grew = settings.careGrowth;
          after = await addGrowth(tx, tenantId, pet, settings, {
            growthId: `pet-care:${operationId}`, source: 'CARE', amount: grew, careDate: today, transactionId, operationId,
          });
        }
        const result: PetCareResultDto = {
          ok: true, operationId, kind, price, balanceAfter, grew, pet: petDto(after), stageBefore: asStage(pet.stage),
          caresToday: caresBefore + 1,
        };
        return { result, entityId: pet.pet_id, details: { studentId, kind, price, grew } };
      }));
    },

    /** The student graduates a grown pet: it goes into the 도감 and the student gets the reward. */
    async graduate(input: Readonly<{ studentId: string; operationId: string }>): Promise<PetGraduateResultDto> {
      const operationId = requireOperationId(input.operationId);
      const studentId = input.studentId;
      const payloadHash = hashOf({ kind: 'PET_GRADUATE', studentId, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'PET_GRADUATED', async (now) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '졸업시킬');
        const account = await lockStudentAccount(tx, tenantId, studentId);
        const pet = await readRaisingPet(tx, tenantId, studentId, true);
        if (!pet) throw new PetError('NO_PET', '졸업시킬 펫이 없어요.', 409);
        if (pet.stage < 3 || toNumber(pet.growth) < settings.goal) {
          throw new PetError('NOT_GROWN', '아직 다 자라지 않았어요. 다 자라면 졸업시킬 수 있어요.', 409);
        }
        const rewardAmount = settings.rewardAmount;
        let balanceAfter = toNumber(account.balance);
        if (rewardAmount > 0) {
          const balance = balanceAfter;
          balanceAfter = balance + rewardAmount;
          if (!Number.isSafeInteger(balanceAfter)) throw new Error('Pet reward balance out of range.');
          await tx.execute(sql`
            UPDATE accounts SET balance=${balanceAfter}, version=version+1, updated_at=${now}
            WHERE tenant_id=${tenantId} AND student_id=${studentId}`);
          await tx.execute(sql`
            INSERT INTO transactions
              (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind, legacy_total_amount,
               balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, operation_id,
               operation_hash, schema_version)
            VALUES (${tenantId}, ${`pet-graduate:${operationId}`}, ${now}, ${studentId}, ${account.name}, 'GROWTH_REWARD',
                    ${rewardAmount}, ${rewardAmount}, ${balance}, ${balanceAfter}, 'bank-pet', 'PET_GRADUATE', ${operationId},
                    ${payloadHash}, 1)`);
        }
        // A reward product deleted since it was picked gives nothing.
        const product = settings.rewardProductId === null ? null : await readRewardProduct(tx, tenantId, settings.rewardProductId);
        if (product) await givePetReward(tx, tenantId, { studentId, product, petId: pet.pet_id, operationId });
        const rewardItem = product ? storageItemShape(product).title : '';
        await tx.execute(sql`
          UPDATE pets SET status='GRADUATED', graduated_at=clock_timestamp(), graduate_operation_id=${operationId},
                 graduate_reward_amount=${rewardAmount}, graduate_reward_item=${rewardItem}, version=version+1
          WHERE tenant_id=${tenantId} AND pet_id=${pet.pet_id}`);
        // The graduate stays in the room to keep the next egg company, while there is space.
        const company = (await readCompanions(tx, tenantId, studentId)).map((row) => row.pet_id);
        if (company.length < PET_MAX_COMPANIONS) await saveCompanions(tx, tenantId, studentId, [...company, pet.pet_id]);
        const result: PetGraduateResultDto = { ok: true, operationId, petId: pet.pet_id, name: pet.name, rewardAmount, rewardItem, balanceAfter };
        return { result, entityId: pet.pet_id, details: { studentId, rewardAmount, rewardProduct: product?.productId ?? null } };
      }));
    },

    /**
     * The student buys an item in the 꾸미기/상점. Room decor is placed right away; an accessory is put
     * on `petId` when one is given (a hatched pet of theirs).
     */
    async buyDecor(input: Readonly<{ studentId: string; operationId: string; itemKey: unknown; petId?: unknown }>): Promise<PetDecorResultDto> {
      const operationId = requireOperationId(input.operationId);
      const item = petDecorItem(input.itemKey);
      if (!item || item.base) throw new PetError('INVALID_INPUT', '살 물건을 다시 골라 주세요.', 400);
      if (input.petId !== undefined && (item.slot !== 'acc' || typeof input.petId !== 'string')) {
        throw new PetError('INVALID_INPUT', '살 물건을 다시 골라 주세요.', 400);
      }
      const studentId = input.studentId;
      const wearer = typeof input.petId === 'string' ? input.petId : null;
      const payloadHash = hashOf(wearer === null
        ? { kind: 'PET_DECOR_BUY', studentId, itemKey: item.key, schemaVersion: 1 }
        : { kind: 'PET_DECOR_BUY', studentId, itemKey: item.key, petId: wearer, schemaVersion: 2 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'PET_DECOR_BOUGHT', async (now) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '상점을 쓸');
        if (!settings.shopEnabled) throw new PetError('SHOP_CLOSED', '선생님이 상점을 닫아 두었어요. 가지고 있는 물건으로만 꾸밀 수 있어요.', 409);
        const forSale = petShopForSale(settings).find((entry) => entry.key === item.key);
        if (!forSale) throw new PetError('DECOR_UNAVAILABLE', '지금은 팔지 않는 물건이에요. 화면을 새로고침해 주세요.', 409);
        const account = await lockStudentAccount(tx, tenantId, studentId);
        const pet = wearer === null ? null : await readWearer(tx, studentId, wearer);
        const owned = await tx.execute(sql`
          SELECT 1 FROM pet_decor WHERE tenant_id=${tenantId} AND student_id=${studentId} AND item_key=${item.key} AND revoked_at IS NULL`);
        if (owned.rows.length > 0) throw new PetError('DECOR_OWNED', '이미 가지고 있는 물건이에요.', 409);
        const price = forSale.price;
        if (toNumber(account.balance) < price) throw new PetError('NOT_ENOUGH_MONEY', '잔액이 부족해서 살 수 없어요.', 409);
        let balanceAfter = toNumber(account.balance);
        let transactionId: string | null = null;
        if (price > 0) {
          transactionId = `pet-decor:${operationId}`;
          balanceAfter = await spend(tx, tenantId, { studentId, account, price, transactionId, status: 'PET_DECOR', operationId, payloadHash, now });
        }
        await tx.execute(sql`
          INSERT INTO pet_decor (tenant_id, decor_id, student_id, item_key, price, transaction_id, operation_id, bought_at)
          VALUES (${tenantId}, ${`decor:${operationId}`}, ${studentId}, ${item.key}, ${price}, ${transactionId}, ${operationId}, ${now})`);
        let room = await readRoom(tx, tenantId, studentId);
        if (item.slot === 'acc') {
          if (pet) await wear(tx, pet, item.id);
        } else {
          room = { ...room, [item.slot]: item.id };
          await saveRoom(tx, tenantId, studentId, room);
        }
        const result: PetDecorResultDto = { ok: true, operationId, itemKey: item.key, price, balanceAfter, room };
        return { result, entityId: item.key, details: { studentId, itemKey: item.key, price } };
      }));
    },

    /**
     * The student places an item they own (or a base item) in the room, or puts an accessory they own
     * on one of their hatched pets ('acc:none' takes it off).
     */
    async placeDecor(input: Readonly<{ studentId: string; itemKey: unknown; petId?: unknown }>): Promise<PetDecorResultDto> {
      const item = petDecorItem(input.itemKey);
      if (!item) throw new PetError('INVALID_INPUT', '놓을 물건을 다시 골라 주세요.', 400);
      if ((item.slot === 'acc') !== (input.petId !== undefined)) throw new PetError('INVALID_INPUT', '놓을 물건을 다시 골라 주세요.', 400);
      return runTenantTransaction(tenantId, async (tx) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '꾸밀');
        await lockStudentAccount(tx, tenantId, input.studentId);
        const pet = item.slot === 'acc' ? await readWearer(tx, input.studentId, input.petId) : null;
        if (!item.base) {
          const owned = await tx.execute(sql`
            SELECT 1 FROM pet_decor WHERE tenant_id=${tenantId} AND student_id=${input.studentId} AND item_key=${item.key} AND revoked_at IS NULL`);
          if (owned.rows.length === 0) throw new PetError('DECOR_NOT_OWNED', '가지고 있지 않은 물건이에요. 화면을 새로고침해 주세요.', 409);
        }
        let room = await readRoom(tx, tenantId, input.studentId);
        if (pet) {
          await wear(tx, pet, item.base ? null : item.id);
        } else {
          room = { ...room, [item.slot as PetDecorSlot]: item.id };
          await saveRoom(tx, tenantId, input.studentId, room);
        }
        return { ok: true, operationId: null, itemKey: item.key, price: 0, balanceAfter: null, room };
      });
    },

    /** The student calls graduated pets back to the room (or sends them back to the 도감): up to two, with the pet being raised. */
    async setCompanions(input: Readonly<{ studentId: string; petIds: unknown }>): Promise<void> {
      const ids = input.petIds;
      if (!Array.isArray(ids) || ids.length > PET_MAX_COMPANIONS || ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
        || new Set(ids).size !== ids.length) {
        throw new PetError('INVALID_INPUT', `함께 지낼 펫은 ${PET_MAX_COMPANIONS}마리까지 고를 수 있어요.`, 400);
      }
      const petIds = ids as string[];
      await runTenantTransaction(tenantId, async (tx) => {
        const settings = await readPetSettings(tx, tenantId);
        requireAwake(settings, clockNow(), '펫을 부를');
        await lockStudentAccount(tx, tenantId, input.studentId);
        if (petIds.length) {
          const found = await tx.execute(sql`
            SELECT pet_id FROM pets WHERE tenant_id=${tenantId} AND student_id=${input.studentId} AND status='GRADUATED'
              AND pet_id IN (${sql.join(petIds.map((id) => sql`${id}`), sql`, `)})`);
          if (found.rows.length !== petIds.length) throw new PetError('PET_NOT_FOUND', '도감에서 펫을 찾지 못했어요. 화면을 새로고침해 주세요.', 404);
        }
        await saveCompanions(tx, tenantId, input.studentId, petIds);
      });
    },

    /** The tree drops and pet growth a task reward added, for the completion message. */
    async taskGains(transactionId: string): Promise<PetTaskGainsDto> {
      return runTenantTransaction(tenantId, async (tx) => {
        const tables = await tx.execute(sql`
          SELECT to_regclass('public.tree_drops') IS NOT NULL AS tree, to_regclass('public.pet_growth') IS NOT NULL AS pet`);
        const present = tables.rows[0] as { tree: boolean; pet: boolean };
        const tree = present.tree ? await tx.execute(sql`
          SELECT COALESCE(sum(amount), 0)::text AS amount FROM tree_drops
          WHERE tenant_id=${tenantId} AND transaction_id=${transactionId} AND source='TASK'`) : null;
        const pet = present.pet ? await tx.execute(sql`
          SELECT COALESCE(sum(amount), 0)::text AS amount FROM pet_growth
          WHERE tenant_id=${tenantId} AND transaction_id=${transactionId} AND source='TASK'`) : null;
        return {
          tree: tree ? toNumber((tree.rows[0] as { amount: string }).amount) : 0,
          pet: pet ? toNumber((pet.rows[0] as { amount: string }).amount) : 0,
        };
      });
    },

    /** Everything the teacher's 펫 키우기 screen shows. */
    async adminBoard(): Promise<PetAdminBoardDto> {
      return runTenantTransaction(tenantId, async (tx) => {
        const settings = await readPetSettings(tx, tenantId);
        const goal = settings.goal;
        const students = await tx.execute(sql`
          SELECT s.student_id, s.name,
                 p.pet_id, p.species, p.color, p.name AS pet_name, p.stage, p.growth::text AS growth, p.accessory,
                 (SELECT count(*)::int FROM pet_cares c WHERE c.tenant_id=s.tenant_id AND c.student_id=s.student_id
                    AND c.care_date=${KOREA_TODAY}) AS cares_today,
                 (SELECT count(DISTINCT c.care_date)::int FROM pet_cares c WHERE c.tenant_id=s.tenant_id AND c.student_id=s.student_id
                    AND c.care_date > ${KOREA_TODAY} - 7) AS cared_days,
                 (SELECT count(*)::int FROM pets g WHERE g.tenant_id=s.tenant_id AND g.student_id=s.student_id
                    AND g.status='GRADUATED') AS graduations
          FROM students s
          LEFT JOIN pets p ON p.tenant_id=s.tenant_id AND p.student_id=s.student_id AND p.status='RAISING'
          WHERE s.tenant_id=${tenantId} AND s.status='ACTIVE' AND s.deleted_at IS NULL
          ORDER BY s.student_id`);
        const rewardProducts = await tx.execute(sql`
          SELECT p.product_id, p.name, p.image_url, p.is_active, c.digital_kind
          FROM products p LEFT JOIN coupon_products c ON c.tenant_id=p.tenant_id AND c.product_id=p.product_id
          WHERE p.tenant_id=${tenantId} AND p.deleted_at IS NULL
          ORDER BY p.sort_order, p.name, p.product_id`);
        type StudentRow = {
          student_id: string; name: string; pet_id: string | null; species: string | null; color: string | null; pet_name: string | null;
          stage: number | null; growth: string | null; accessory: string | null; cares_today: number; cared_days: number; graduations: number;
        };
        return {
          settings,
          goal,
          stageStarts: petStageStarts(goal),
          rewardProducts: (rewardProducts.rows as Array<{ product_id: string; name: string; image_url: string | null; is_active: boolean; digital_kind: string | null }>)
            .map((row) => ({
              productId: row.product_id, name: row.name, imageUrl: row.image_url || null, isActive: row.is_active === true,
              digitalKind: row.digital_kind === 'CONSUMABLE' || row.digital_kind === 'COLLECTIBLE' ? row.digital_kind : null,
            })),
          students: (students.rows as StudentRow[]).map((row) => ({
            studentId: row.student_id,
            name: row.name,
            pet: row.pet_id !== null && isPetSpecies(row.species) ? {
              petId: row.pet_id, species: row.species, color: row.color, name: row.pet_name ?? '', stage: asStage(toNumber(row.stage)),
              growth: toNumber(row.growth), accessory: toNumber(row.stage) > 0 && isPetAccessory(row.accessory) ? row.accessory : null,
            } : null,
            caresToday: toNumber(row.cares_today),
            caredDays7: toNumber(row.cared_days),
            graduations: toNumber(row.graduations),
          })),
        };
      });
    },

    /** Saves the teacher's settings. */
    async saveSettings(settings: PetSettings): Promise<PetAdminBoardDto> {
      await runTenantTransaction(tenantId, async (tx) => {
        if (settings.rewardProductId !== null && !await readRewardProduct(tx, tenantId, settings.rewardProductId)) {
          throw new PetError('INVALID_INPUT', '졸업 보상 상품을 찾지 못했어요. 상품 목록을 새로 불러와 주세요.', 400);
        }
        await tx.execute(sql`
          INSERT INTO pet_settings (tenant_id, pet_enabled, goal_override, tasks_per_week, care_growth, task_growth, feed_price,
                                    feed_daily_limit, hours_enabled, hours, reward_amount, reward_product_id, shop_enabled, shop_prices)
          VALUES (${tenantId}, ${settings.enabled}, ${settings.goal}, ${settings.tasksPerWeek}, ${settings.careGrowth},
                  ${settings.taskGrowth}, ${settings.feedPrice}, ${settings.feedDailyLimit}, ${settings.hoursEnabled},
                  ${JSON.stringify(settings.hours)}::jsonb, ${settings.rewardAmount}, ${settings.rewardProductId}, ${settings.shopEnabled},
                  ${JSON.stringify(settings.shopPrices)}::jsonb)
          ON CONFLICT (tenant_id) DO UPDATE SET
            pet_enabled=EXCLUDED.pet_enabled, goal_override=EXCLUDED.goal_override, tasks_per_week=EXCLUDED.tasks_per_week,
            care_growth=EXCLUDED.care_growth, task_growth=EXCLUDED.task_growth, feed_price=EXCLUDED.feed_price,
            feed_daily_limit=EXCLUDED.feed_daily_limit, hours_enabled=EXCLUDED.hours_enabled, hours=EXCLUDED.hours,
            reward_amount=EXCLUDED.reward_amount, reward_product_id=EXCLUDED.reward_product_id,
            shop_enabled=EXCLUDED.shop_enabled, shop_prices=EXCLUDED.shop_prices,
            version=pet_settings.version+1, updated_at=clock_timestamp()`);
      });
      return commands.adminBoard();
    },

    /** The teacher corrects a pet's name. */
    async renamePet(input: Readonly<{ petId: unknown; name: unknown }>): Promise<PetAdminBoardDto> {
      if (typeof input.petId !== 'string' || !input.petId || input.petId.length > 200) {
        throw new PetError('INVALID_INPUT', '이름을 고칠 펫을 다시 골라 주세요.', 400);
      }
      const name = cleanPetName(input.name);
      if (name === null) throw new PetError('INVALID_INPUT', '이름은 1~8자로 적어 주세요.', 400);
      const petId = input.petId;
      await runTenantTransaction(tenantId, async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE pets SET name=${name}, version=version+1 WHERE tenant_id=${tenantId} AND pet_id=${petId} RETURNING pet_id`);
        if (updated.rows.length === 0) throw new PetError('PET_NOT_FOUND', '펫을 찾지 못했어요. 화면을 새로고침해 주세요.', 404);
      });
      return commands.adminBoard();
    },
  };
  return commands;
}
