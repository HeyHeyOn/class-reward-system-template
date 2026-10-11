import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PET_SETTINGS, PET_COLORS, type PetSettings } from '@/domain/pet';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { PetError, addTaskPetGrowth, createPetCommands, revokePetForTransaction } from './pets';
import { createStudentBagCommands } from './studentBag';
import { createDatabaseTransactionCommands } from './transactionCommands';
import { createDatabaseTransactionQueries } from './transactionQueries';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;
let sequence = 0;
const op = () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const lastOp = () => `60000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
// A tiny goal: hatch at 1, young at 2, grown up at 4.
const ON: PetSettings = { ...DEFAULT_PET_SETTINGS, enabled: true, goal: 4 };
/** Noon in Korea. */
let now = new Date('2026-10-12T03:00:00Z');

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const file of ['0044_class_tree.sql', '0045_student_bag.sql', '0046_vouchers.sql', '0047_tree_name.sql', '0048_pets.sql',
    '0049_growth_goals_and_pet_company.sql', '0050_teacher_growth_adjustments.sql', '0052_pet_history_indexes.sql']) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', file), 'utf8'));
  }
  await harness.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime');
  await harness.database.exec('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime');
  await seedStudent(harness.tenantOneId, 'S001', '김민준', 100);
  await seedStudent(harness.tenantOneId, 'S002', '이서준', 5);
  await seedStudent(harness.tenantTwoId, 'S001', '다른반', 900);
  await harness.database.query(`INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order) VALUES ($1, 'P010', '초코 과자', 500, 3, true, 1)`, [harness.tenantOneId]);
  now = new Date('2026-10-12T03:00:00Z');
});

afterEach(async () => harness?.close());

async function seedStudent(tenantId: string, studentId: string, name: string, balance: number) {
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, 'ACTIVE')`, [tenantId, studentId, name]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, $2, $3)`, [tenantId, studentId, balance]);
}

const pets = (tenantId = harness.tenantOneId) => createPetCommands({ tenantId, runTenantTransaction: harness.runTenantTransaction, now: () => now });

async function balance(studentId: string): Promise<number> {
  const result = await harness.database.query<{ balance: string }>(`SELECT balance::text AS balance FROM accounts WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, studentId]);
  return Number(result.rows[0].balance);
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PetError) return error.code;
    throw error;
  }
  throw new Error('expected a pet refusal');
}

/** Moves the cares of the student's pet to yesterday, as if a day had passed. */
async function nextDay() {
  await harness.database.exec('ALTER TABLE pet_cares DISABLE TRIGGER pet_cares_immutable');
  await harness.database.exec('ALTER TABLE pet_growth DISABLE TRIGGER pet_growth_immutable');
  await harness.database.exec(`UPDATE pet_cares SET care_date = care_date - 1; UPDATE pet_growth SET care_date = care_date - 1 WHERE care_date IS NOT NULL`);
  await harness.database.exec('ALTER TABLE pet_cares ENABLE TRIGGER pet_cares_immutable');
  await harness.database.exec('ALTER TABLE pet_growth ENABLE TRIGGER pet_growth_immutable');
}

describe('settings and adopting', () => {
  it('stays off until the teacher turns it on, then a student picks and names an egg once', async () => {
    expect(await failure(pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' }))).toBe('PET_OFF');
    expect((await pets().adminBoard()).goal).toBe(40);
    const board = await pets().saveSettings({ ...ON, tasksPerWeek: 8 });
    expect(board.settings).toMatchObject({ enabled: true, goal: 4, tasksPerWeek: 8 });
    expect(board.goal).toBe(4);

    expect(await failure(pets().adopt({ studentId: 'S001', operationId: op(), species: 'unicorn', name: '초코' }))).toBe('INVALID_INPUT');
    expect(await failure(pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '아주아주긴이름입니다' }))).toBe('INVALID_INPUT');
    const operationId = op();
    const adopted = await pets().adopt({ studentId: 'S001', operationId, species: 'dog', name: '  초코  ' });
    expect(adopted.pet).toMatchObject({ species: 'dog', name: '초코', stage: 0, growth: 0, color: null });
    expect(await pets().adopt({ studentId: 'S001', operationId, species: 'dog', name: '초코' })).toEqual(adopted);
    expect(await failure(pets().adopt({ studentId: 'S001', operationId: op(), species: 'cat', name: '나비' }))).toBe('HAS_PET');

    const view = await pets().studentView('S001');
    expect(view.pet).toMatchObject({ name: '초코', stage: 0 });
    expect(view.stageStarts).toEqual({ hatch: 1, young: 2, adult: 4 });
    expect((await pets().studentView('S002')).pet).toBeNull();
    expect((await pets(harness.tenantTwoId).studentView('S001')).enabled).toBe(false);
  });

  it('sleeps outside the opening hours, and with the hours on but none set, all the time', async () => {
    await pets().saveSettings({ ...ON, hoursEnabled: true, hours: [{ start: '08:00', end: '09:00' }, { start: '14:30', end: '21:00' }] });
    let view = await pets().studentView('S001');
    expect(view).toMatchObject({ awake: false, nextOpen: '14:30' });
    expect(await failure(pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' }))).toBe('PET_ASLEEP');
    now = new Date('2026-10-12T06:00:00Z'); // 15:00 in Korea
    view = await pets().studentView('S001');
    expect(view).toMatchObject({ awake: true, nextOpen: '내일 08:00' });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });

    await pets().saveSettings({ ...ON, hoursEnabled: true, hours: [] });
    expect(await pets().studentView('S001')).toMatchObject({ awake: false, nextOpen: null });
    expect(await failure(pets().care({ studentId: 'S001', operationId: op() }))).toBe('PET_ASLEEP');
    await pets().saveSettings({ ...ON, hoursEnabled: false, hours: [] });
    expect((await pets().studentView('S001')).awake).toBe(true);
  });
});

describe('daily care', () => {
  it('shares the free warming limit across new eggs on the same Korean date', async () => {
    await pets().saveSettings({ ...ON, goal: 1, careGrowth: 1, feedDailyLimit: 0, rewardAmount: 100 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '첫째' });
    await pets().care({ studentId: 'S001', operationId: op(), kind: 'WARM' });
    await pets().graduate({ studentId: 'S001', operationId: op() });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'cat', name: '둘째' });
    expect((await pets().studentView('S001')).warmedToday).toBe(true);
    expect(await failure(pets().care({ studentId: 'S001', operationId: op(), kind: 'WARM' }))).toBe('DAILY_LIMIT');
    expect(await balance('S001')).toBe(200);
    await nextDay();
    expect((await pets().studentView('S001')).warmedToday).toBe(false);
    expect(await pets().care({ studentId: 'S001', operationId: op(), kind: 'WARM' })).toMatchObject({ grew: 1, caresToday: 1 });
  });

  it('warms an egg once a day for free, and the first care of a day adds growth until it hatches', async () => {
    await pets().saveSettings(ON);
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'cat', name: '나비' });
    const warmed = await pets().care({ studentId: 'S001', operationId: op() });
    expect(warmed).toMatchObject({ kind: 'WARM', price: 0, grew: 1, stageBefore: 0, caresToday: 1, balanceAfter: 100 });
    // Growth 1 reaches the hatching point: the egg hatches with one of the cat colors.
    expect(warmed.pet.stage).toBe(1);
    expect(PET_COLORS.cat.map((color) => color.id)).toContain(warmed.pet.color);
    expect(await balance('S001')).toBe(100);
    const transactions = await harness.database.query(`SELECT 1 FROM transactions WHERE tenant_id=$1`, [harness.tenantOneId]);
    expect(transactions.rows).toHaveLength(0);
  });

  it('charges each feeding, adds growth with every one, and stops at the daily limit', async () => {
    await pets().saveSettings({ ...ON, goal: 20 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    await pets().care({ studentId: 'S001', operationId: op() });
    expect(await failure(pets().care({ studentId: 'S001', operationId: op() }))).toBe('DAILY_LIMIT');
    await harness.database.query(`UPDATE pets SET stage=1, color='brown', hatched_at=now() WHERE tenant_id=$1`, [harness.tenantOneId]);
    await nextDay();

    const first = await pets().care({ studentId: 'S001', operationId: op() });
    expect(first).toMatchObject({ kind: 'FEED', price: 10, grew: 1, balanceAfter: 90, caresToday: 1 });
    expect(first.pet.growth).toBe(2);
    const second = await pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' });
    expect(second).toMatchObject({ kind: 'FEED', price: 10, grew: 1, balanceAfter: 80, caresToday: 2 });
    expect(second.pet.growth).toBe(3);
    expect(await failure(pets().care({ studentId: 'S001', operationId: op() }))).toBe('DAILY_LIMIT');
    expect(await failure(pets().care({ studentId: 'S001', operationId: op(), kind: 'WARM' }))).toBe('INVALID_INPUT');
    expect(await pets().studentView('S001')).toMatchObject({ feedsToday: 2, warmedToday: false });
    const history = await createDatabaseTransactionQueries({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction }).getTransactions();
    expect(history.map((transaction) => transaction.status)).toEqual(['PET_FEED', 'PET_FEED']);
  });

  it('refuses a feeding the student cannot pay for, and gives money and growth back when it is cancelled', async () => {
    await pets().saveSettings({ ...ON, goal: 20, feedPrice: 30 });
    await pets().adopt({ studentId: 'S002', operationId: op(), species: 'dog', name: '보리' });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    await harness.database.query(`UPDATE pets SET stage=1, color='brown', hatched_at=now() WHERE tenant_id=$1`, [harness.tenantOneId]);
    expect(await failure(pets().care({ studentId: 'S002', operationId: op() }))).toBe('NOT_ENOUGH_MONEY');

    await pets().care({ studentId: 'S001', operationId: op() });
    expect(await balance('S001')).toBe(70);
    const cancellation = await createDatabaseTransactionCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: `pet-feed:60000000-0000-4000-8000-${String(sequence - 1).padStart(12, '0')}` });
    expect(cancellation).toMatchObject({ originalKind: 'GROWTH_SPEND', reversalAmount: 30, balanceAfter: 100 });
    // Growth goes back; the stage stays.
    expect((await pets().studentView('S001')).pet).toMatchObject({ growth: 0, stage: 1 });
  });
});

describe('task rewards', () => {
  async function rewardTransaction(transactionId: string, kind: 'TASK_REWARD' | 'CANCELLATION', reverses: string | null = null) {
    await harness.database.query(`INSERT INTO transactions (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
      legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, reverses_transaction_id)
      VALUES ($1, $2, now(), 'S001', '김민준', $3, $4::bigint, $4::bigint, 100, 100 + $4::bigint, 'bank-task-completion', 'COMPLETED', $5)`,
    [harness.tenantOneId, transactionId, kind, kind === 'TASK_REWARD' ? 30 : -30, reverses]);
  }

  it('adds the task growth to the pet and takes it back when the reward is cancelled', async () => {
    await pets().saveSettings({ ...ON, goal: 20, taskGrowth: 3 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'turtle', name: '꼬북이' });
    await rewardTransaction('task-reward:a', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:a', operationId: op() }));
    expect((await pets().studentView('S001')).pet).toMatchObject({ growth: 3, stage: 1 });

    await rewardTransaction('cancel:a', 'CANCELLATION', 'task-reward:a');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => revokePetForTransaction(tx, harness.tenantOneId, {
      originalTransactionId: 'task-reward:a', reversalTransactionId: 'cancel:a', operationId: op() }));
    expect((await pets().studentView('S001')).pet).toMatchObject({ growth: 0, stage: 1 });
  });

  it('leaves the daily feedings alone, but records a task\'s food as care today', async () => {
    await pets().saveSettings({ ...ON, goal: 40 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    await harness.database.query(`UPDATE pets SET stage=1, color='brown', hatched_at=now(), growth=4 WHERE tenant_id=$1`, [harness.tenantOneId]);
    await rewardTransaction('task-reward:c', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:c', operationId: op() }));
    expect((await pets().studentView('S001')).feedsToday).toBe(0);
    await pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' });
    await pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' });
    expect(await failure(pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' }))).toBe('DAILY_LIMIT');
    // A task after the feedings still feeds the pet: tasks have no limit.
    await rewardTransaction('task-reward:d', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:d', operationId: op() }));
    expect(await pets().studentView('S001')).toMatchObject({ feedsToday: 2, pet: { growth: 8 } });
    expect((await pets().adminBoard()).students[0]).toMatchObject({ caresToday: 4, feedsToday: 2, taskFeedsToday: 2, caredDays7: 1, warmedToday: false });
  });

  it('adds nothing while pets are off, without a pet, or with task growth 0', async () => {
    await rewardTransaction('task-reward:b', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:b', operationId: op() }));
    await pets().saveSettings({ ...ON, taskGrowth: 0 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:b', operationId: op() }));
    expect((await pets().studentView('S001')).pet?.growth).toBe(0);
  });
});

describe('graduation and the 도감', () => {
  it('graduates a grown pet when the student chooses, pays the reward, and lets them pick a new egg', async () => {
    await pets().saveSettings({ ...ON, rewardAmount: 50, rewardProductId: 'P010' });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'rabbit', name: '솜이' });
    expect(await failure(pets().graduate({ studentId: 'S001', operationId: op() }))).toBe('NOT_GROWN');
    await harness.database.query(`UPDATE pets SET stage=3, growth=4, color='white', hatched_at=now() WHERE tenant_id=$1`, [harness.tenantOneId]);
    expect(await pets().studentView('S001')).toMatchObject({ rewardAmount: 50, rewardItem: '초코 과자 교환권' });

    const operationId = op();
    const graduated = await pets().graduate({ studentId: 'S001', operationId });
    expect(graduated).toMatchObject({ name: '솜이', rewardAmount: 50, rewardItem: '초코 과자 교환권', balanceAfter: 150 });
    expect(await pets().graduate({ studentId: 'S001', operationId })).toEqual(graduated);
    expect(await balance('S001')).toBe(150);

    const view = await pets().studentView('S001');
    expect(view.pet).toBeNull();
    expect(view.dex).toEqual([]);
    expect((await pets().dexPage('S001')).entries).toEqual([expect.objectContaining({ species: 'rabbit', color: 'white', name: '솜이' })]);
    const items = (await createStudentBagCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction })
      .studentBag('S001', { includeUsed: false })).items;
    expect(items).toEqual([expect.objectContaining({ title: '초코 과자 교환권', source: 'PET_GRADUATION', voucherProductId: 'P010' })]);
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'rabbit', name: '솜이2' });
    expect((await pets().adminBoard()).students.find((row) => row.studentId === 'S001')).toMatchObject({ graduations: 1, pet: expect.objectContaining({ name: '솜이2' }) });
  });

  it('hatches a color the student does not have yet when one is left', async () => {
    await pets().saveSettings(ON);
    const ids = PET_COLORS.dog.map((color) => color.id);
    for (const color of ids.slice(0, 3)) {
      await harness.database.query(`INSERT INTO pets (tenant_id, pet_id, student_id, species, color, name, stage, growth, status, adopted_at, hatched_at,
        graduated_at, graduate_operation_id, graduate_reward_amount, graduate_reward_item)
        VALUES ($1, $2, 'S001', 'dog', $3, '옛 펫', 3, 4, 'GRADUATED', now() - interval '30 days', now() - interval '29 days', now() - interval '1 day', $2, 0, '')`,
      [harness.tenantOneId, `old-${color}`, color]);
    }
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '새 친구' });
    const hatched = await pets().care({ studentId: 'S001', operationId: op() });
    expect(hatched.pet.color).toBe(ids[3]);
  });
});

describe('the 펫 상점 and the room', () => {
  it('sells only priced items, places a bought item, and takes it back when the purchase is cancelled', async () => {
    await pets().saveSettings({ ...ON, shopPrices: { 'wall:mint': { price: 30, sell: true }, 'rug:blue': { price: 20, sell: false } } });
    let view = await pets().studentView('S001');
    expect(view.shop).toEqual([{ key: 'wall:mint', slot: 'wall', id: 'mint', name: '민트 줄무늬', price: 30 }]);
    expect(view.room.wall).toBe('cream');
    expect(await failure(pets().buyDecor({ studentId: 'S001', operationId: op(), itemKey: 'rug:blue' }))).toBe('DECOR_UNAVAILABLE');
    expect(await failure(pets().buyDecor({ studentId: 'S001', operationId: op(), itemKey: 'wall:cream' }))).toBe('INVALID_INPUT');
    expect(await failure(pets().buyDecor({ studentId: 'S002', operationId: op(), itemKey: 'wall:mint' }))).toBe('NOT_ENOUGH_MONEY');

    const buyOperation = op();
    const bought = await pets().buyDecor({ studentId: 'S001', operationId: buyOperation, itemKey: 'wall:mint' });
    expect(bought).toMatchObject({ price: 30, balanceAfter: 70, room: expect.objectContaining({ wall: 'mint' }) });
    expect(await failure(pets().buyDecor({ studentId: 'S001', operationId: op(), itemKey: 'wall:mint' }))).toBe('DECOR_OWNED');
    expect((await pets().placeDecor({ studentId: 'S001', itemKey: 'wall:cream' })).room.wall).toBe('cream');
    expect((await pets().placeDecor({ studentId: 'S001', itemKey: 'wall:mint' })).room.wall).toBe('mint');
    expect(await failure(pets().placeDecor({ studentId: 'S001', itemKey: 'rug:blue' }))).toBe('DECOR_NOT_OWNED');
    view = await pets().studentView('S001');
    expect(view.owned).toEqual(['wall:mint']);

    await createDatabaseTransactionCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: `pet-decor:${buyOperation}` });
    view = await pets().studentView('S001');
    expect(view.owned).toEqual([]);
    expect(view.room.wall).toBe('cream');
    expect(await balance('S001')).toBe(100);
  });

  it('closes the shop when the teacher closes it', async () => {
    await pets().saveSettings({ ...ON, shopEnabled: false, shopPrices: { 'wall:mint': { price: 30, sell: true } } });
    expect((await pets().studentView('S001')).shop).toEqual([]);
    expect(await failure(pets().buyDecor({ studentId: 'S001', operationId: op(), itemKey: 'wall:mint' }))).toBe('SHOP_CLOSED');
  });
});

describe('company and accessories', () => {
  async function graduated(petId: string, species: string, color: string) {
    await harness.database.query(`INSERT INTO pets (tenant_id, pet_id, student_id, species, color, name, stage, growth, status, adopted_at, hatched_at,
      graduated_at, graduate_operation_id, graduate_reward_amount, graduate_reward_item)
      VALUES ($1, $2, 'S001', $3, $4, '옛 펫', 3, 4, 'GRADUATED', now() - interval '30 days', now() - interval '29 days', now() - interval '1 day', $2, 0, '')`,
    [harness.tenantOneId, petId, species, color]);
  }

  it('keeps a new graduate in the room, calls up to two back from the 도감, and feeds them while the pet is an egg', async () => {
    await pets().saveSettings(ON);
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'cat', name: '나비' });
    expect(await failure(pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' }))).toBe('NO_COMPANY');
    await harness.database.query(`UPDATE pets SET stage=3, growth=4, color='black', hatched_at=now() WHERE tenant_id=$1`, [harness.tenantOneId]);
    await pets().graduate({ studentId: 'S001', operationId: op() });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    let view = await pets().studentView('S001');
    expect(view.companions.map((pet) => pet.name)).toEqual(['나비']);

    // An egg does not eat: feeding is for the company, and adds no growth.
    const fed = await pets().care({ studentId: 'S001', operationId: op(), kind: 'FEED' });
    expect(fed).toMatchObject({ kind: 'FEED', grew: 0, price: 10, caresToday: 1 });
    const warmed = await pets().care({ studentId: 'S001', operationId: op(), kind: 'WARM' });
    expect(warmed).toMatchObject({ kind: 'WARM', grew: 1 });
    view = await pets().studentView('S001');
    expect(view).toMatchObject({ feedsToday: 1, warmedToday: true });

    await graduated('old-1', 'rabbit', 'white');
    await graduated('old-2', 'hamster', 'golden');
    const nabi = view.companions[0].petId;
    await pets().setCompanions({ studentId: 'S001', petIds: ['old-1', nabi] });
    expect((await pets().studentView('S001')).companions.map((pet) => pet.petId)).toEqual(['old-1', nabi]);
    expect(await failure(pets().setCompanions({ studentId: 'S001', petIds: ['old-1', 'old-2', nabi] }))).toBe('INVALID_INPUT');
    expect(await failure(pets().setCompanions({ studentId: 'S001', petIds: [view.pet?.petId ?? ''] }))).toBe('PET_NOT_FOUND');
    expect(await failure(pets().setCompanions({ studentId: 'S001', petIds: ['old-1', 'old-1'] }))).toBe('INVALID_INPUT');
    await pets().setCompanions({ studentId: 'S001', petIds: [] });
    expect((await pets().studentView('S001')).companions).toEqual([]);
  });

  it('sells accessories, puts them on a hatched pet, takes them off, and takes them back with a cancelled purchase', async () => {
    await pets().saveSettings({ ...ON, shopPrices: { 'acc:ribbon': { price: 20, sell: true } } });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    const egg = (await pets().studentView('S001')).pet?.petId ?? '';
    expect(await failure(pets().buyDecor({ studentId: 'S001', operationId: op(), itemKey: 'acc:ribbon', petId: egg }))).toBe('INVALID_INPUT');
    await harness.database.query(`UPDATE pets SET stage=1, color='brown', hatched_at=now() WHERE tenant_id=$1`, [harness.tenantOneId]);

    const buyOperation = op();
    await pets().buyDecor({ studentId: 'S001', operationId: buyOperation, itemKey: 'acc:ribbon', petId: egg });
    expect((await pets().studentView('S001')).pet?.accessory).toBe('ribbon');
    expect(await failure(pets().placeDecor({ studentId: 'S001', itemKey: 'acc:ribbon' }))).toBe('INVALID_INPUT');
    expect(await failure(pets().placeDecor({ studentId: 'S001', itemKey: 'acc:crown', petId: egg }))).toBe('DECOR_NOT_OWNED');
    await pets().placeDecor({ studentId: 'S001', itemKey: 'acc:none', petId: egg });
    expect((await pets().studentView('S001')).pet?.accessory).toBeNull();
    await pets().placeDecor({ studentId: 'S001', itemKey: 'acc:ribbon', petId: egg });
    expect((await pets().adminBoard()).students[0].pet?.accessory).toBe('ribbon');

    await createDatabaseTransactionCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: `pet-decor:${buyOperation}` });
    const view = await pets().studentView('S001');
    expect(view.pet?.accessory).toBeNull();
    expect(view.owned).toEqual([]);
  });

  it('tells what a task reward gave the tree and the pet', async () => {
    await pets().saveSettings({ ...ON, goal: 20, taskGrowth: 2 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'dog', name: '초코' });
    await harness.database.query(`INSERT INTO transactions (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
      legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot)
      VALUES ($1, 'task-reward:g', now(), 'S001', '김민준', 'TASK_REWARD', 30, 30, 100, 130, 'bank-task-completion', 'COMPLETED')`, [harness.tenantOneId]);
    expect(await pets().taskGains('task-reward:g')).toEqual({ tree: 0, pet: 0 });
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskPetGrowth(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:g', operationId: op() }));
    expect(await pets().taskGains('task-reward:g')).toEqual({ tree: 0, pet: 2 });
  });
});

describe('the teacher\'s growth adjustment', () => {
  it('adds growth (hatching an egg), takes it away (the stage follows, a hatched pet stays hatched) and stops at 0', async () => {
    await pets().saveSettings({ ...ON, goal: 40 });
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'cat', name: '나비' });
    const petId = (await pets().studentView('S001')).pet?.petId ?? '';
    const operationId = op();
    let board = await pets().adjustGrowth({ operationId, petId, amount: 20 });
    expect(board.students[0].pet).toMatchObject({ growth: 20, stage: 2 });
    expect(PET_COLORS.cat.map((color) => color.id)).toContain(board.students[0].pet?.color);
    // The same operation again changes nothing.
    board = await pets().adjustGrowth({ operationId, petId, amount: 20 });
    expect(board.students[0].pet?.growth).toBe(20);
    board = await pets().adjustGrowth({ operationId: op(), petId, amount: -5 });
    expect(board.students[0].pet).toMatchObject({ growth: 15, stage: 1 });
    board = await pets().adjustGrowth({ operationId: op(), petId, amount: -100 });
    expect(board.students[0].pet).toMatchObject({ growth: 0, stage: 1 });
    expect(await failure(pets().adjustGrowth({ operationId: op(), petId, amount: -1 }))).toBe('NOTHING_TO_REMOVE');
    expect(await failure(pets().adjustGrowth({ operationId: op(), petId, amount: 0 }))).toBe('INVALID_INPUT');
    expect(await failure(pets().adjustGrowth({ operationId: op(), petId: 'nope', amount: 1 }))).toBe('PET_NOT_FOUND');
    // The day's feeding count is not touched by the teacher's growth.
    expect((await pets().studentView('S001')).feedsToday).toBe(0);
  });
});

describe('the teacher board', () => {
  it('lists every active student with their pet and lets the teacher correct a name', async () => {
    await pets().saveSettings(ON);
    await pets().adopt({ studentId: 'S001', operationId: op(), species: 'hamster', name: '도토리' });
    await pets().care({ studentId: 'S001', operationId: op() });
    let board = await pets().adminBoard();
    expect(board.students).toEqual([
      expect.objectContaining({ studentId: 'S001', caresToday: 1, caredDays7: 1, graduations: 0, pet: expect.objectContaining({ name: '도토리', stage: 1 }) }),
      expect.objectContaining({ studentId: 'S002', pet: null, caresToday: 0 }),
    ]);
    const petId = board.students[0].pet?.petId ?? '';
    board = await pets().renamePet({ petId, name: '땅콩' });
    expect(board.students[0].pet?.name).toBe('땅콩');
    expect(await failure(pets().renamePet({ petId, name: '' }))).toBe('INVALID_INPUT');
    expect(await failure(pets().renamePet({ petId: 'nope', name: '땅콩' }))).toBe('PET_NOT_FOUND');
    expect(await failure(pets().saveSettings({ ...ON, rewardProductId: 'NOPE' }))).toBe('INVALID_INPUT');
    expect(lastOp()).toMatch(/^60000000-/);
  });
});
