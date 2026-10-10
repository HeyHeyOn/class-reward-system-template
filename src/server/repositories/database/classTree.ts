import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  CLASS_TREE_LIMITS,
  DEFAULT_CLASS_TREE_SETTINGS,
  DEFAULT_TREE_NAME,
  classTreeGoal,
  type ClassTreeSettings,
} from '@/domain/classTree';
import {
  CLASS_TREE_OPERATION_ID,
  type ClassTreeAdminBoardDto,
  type ClassTreeDto,
  type ClassTreeHarvestResultDto,
  type ClassTreeStudentViewDto,
  type ClassTreeClassFeedResultDto,
  type ClassTreeWaterResultDto,
} from '@/lib/classTreeApi';
import { appendOperationAudit } from './operationAudit';
import { giveHarvestReward, readRewardProduct, storageItemShape } from './studentBag';

/*
 * The class apple tree (migration 0044). Lock order, shared with every other money writer:
 * student/account rows first, then the growing tree row. A harvest locks all active accounts
 * (in student_id order) before the tree, so it never waits on a tree while holding the tree.
 */

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type ClassTreeErrorCode =
  | 'TREE_OFF' | 'TREE_BUSY' | 'TREE_READY' | 'TREE_NOT_READY' | 'WATER_OFF' | 'DAILY_LIMIT'
  | 'NOT_ENOUGH_MONEY' | 'STUDENT_INVALID' | 'NO_STUDENTS' | 'VOUCHER_NOT_FOUND' | 'INVALID_INPUT'
  | 'OPERATION_CONFLICT' | 'OPERATION_PENDING' | 'UNSUPPORTED';

export class ClassTreeError extends Error {
  constructor(readonly code: ClassTreeErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'ClassTreeError';
  }
}

const DAY_START = sql`(date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type SettingsRow = {
  tree_enabled: boolean; water_price: string; water_daily_limit: number; task_drops: number; target_weeks: number;
  goal_override: string | null; reward_amount: string; reward_product_id: string | null; tree_name: string;
};
type TreeRow = {
  tree_no: number; goal: string; drops: string; status: string; started_at: Date | string;
  harvested_at: Date | string | null; harvest_recipients: number | null; harvest_reward_amount: string | null;
  harvest_coupon: string | null;
};
type OperationRow = { operation_kind: string; payload_hash: string; status: string; result_snapshot: unknown };

const toNumber = (value: string | number | bigint | null | undefined): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Class tree integer is out of range.');
  return parsed;
};
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function requireOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !CLASS_TREE_OPERATION_ID.test(operationId)) {
    throw new ClassTreeError('INVALID_INPUT', '요청 번호가 올바르지 않아요. 다시 시도해 주세요.', 400);
  }
  return operationId;
}

/** Whether migration 0044 is installed; writers that are shared with older paths check it first. */
async function treeTablesPresent(tx: TenantTransaction): Promise<boolean> {
  const result = await tx.execute(sql`SELECT to_regclass('public.growth_settings') IS NOT NULL AS present`);
  return (result.rows[0] as { present?: unknown } | undefined)?.present === true;
}

export async function readClassTreeSettings(tx: TenantTransaction, tenantId: string): Promise<ClassTreeSettings> {
  const result = await tx.execute(sql`
    SELECT tree_enabled, water_price::text AS water_price, water_daily_limit, task_drops, target_weeks,
           goal_override::text AS goal_override, reward_amount::text AS reward_amount, reward_product_id, tree_name
    FROM growth_settings WHERE tenant_id=${tenantId}`);
  const row = result.rows[0] as SettingsRow | undefined;
  if (!row) return DEFAULT_CLASS_TREE_SETTINGS;
  return {
    enabled: row.tree_enabled === true,
    treeName: row.tree_name || DEFAULT_TREE_NAME,
    waterPrice: toNumber(row.water_price),
    waterDailyLimit: toNumber(row.water_daily_limit),
    taskDrops: toNumber(row.task_drops),
    targetWeeks: toNumber(row.target_weeks),
    goalOverride: row.goal_override === null ? null : toNumber(row.goal_override),
    rewardAmount: toNumber(row.reward_amount),
    rewardProductId: row.reward_product_id,
  };
}

async function readGrowingTree(tx: TenantTransaction, tenantId: string, lock: boolean): Promise<TreeRow | undefined> {
  const statement = sql`
    SELECT tree_no, goal::text AS goal, drops::text AS drops, status, started_at, harvested_at, harvest_recipients,
           harvest_reward_amount::text AS harvest_reward_amount, harvest_coupon
    FROM class_trees WHERE tenant_id=${tenantId} AND status='GROWING'`;
  const result = await tx.execute(lock ? sql`${statement} FOR UPDATE` : statement);
  return result.rows[0] as TreeRow | undefined;
}

async function countActiveStudents(tx: TenantTransaction, tenantId: string): Promise<number> {
  const result = await tx.execute(sql`
    SELECT count(*)::int AS count FROM students WHERE tenant_id=${tenantId} AND status='ACTIVE' AND deleted_at IS NULL`);
  return toNumber((result.rows[0] as { count: number }).count);
}

async function startTree(tx: TenantTransaction, tenantId: string, goal: number): Promise<number> {
  const next = await tx.execute(sql`SELECT COALESCE(max(tree_no), 0) + 1 AS tree_no FROM class_trees WHERE tenant_id=${tenantId}`);
  const treeNo = toNumber((next.rows[0] as { tree_no: number }).tree_no);
  await tx.execute(sql`INSERT INTO class_trees (tenant_id, tree_no, goal) VALUES (${tenantId}, ${treeNo}, ${goal})`);
  return treeNo;
}

function treeDto(row: TreeRow): ClassTreeDto {
  return { treeNo: row.tree_no, goal: toNumber(row.goal), drops: toNumber(row.drops), startedAt: iso(row.started_at) };
}

async function addDrops(tx: TenantTransaction, tenantId: string, tree: TreeRow, drop: Readonly<{
  dropId: string; source: 'WATER' | 'TASK' | 'SUN' | 'CANCEL'; studentId: string | null; amount: number;
  transactionId: string | null; operationId: string | null; note: string | null;
}>): Promise<number> {
  const after = toNumber(tree.drops) + drop.amount;
  if (after < 0 || after > MAX_SAFE) throw new Error('Class tree drops out of range.');
  await tx.execute(sql`
    INSERT INTO tree_drops (tenant_id, drop_id, tree_no, source, student_id, amount, transaction_id, operation_id, note)
    VALUES (${tenantId}, ${drop.dropId}, ${tree.tree_no}, ${drop.source}, ${drop.studentId}, ${drop.amount},
            ${drop.transactionId}, ${drop.operationId}, ${drop.note})`);
  await tx.execute(sql`
    UPDATE class_trees SET drops=${after}, version=version+1
    WHERE tenant_id=${tenantId} AND tree_no=${tree.tree_no}`);
  return after;
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
    if (!row) throw new Error('Class tree operation could not be read.');
    return resolveOperation<TResult>(row, payloadHash);
  }
  const { result, entityId, details } = await body(now);
  await appendOperationAudit(tx, tenantId, {
    operationId, eventType, entityType: 'class_tree', entityId, redactedDetails: details, occurredAt: now,
  });
  await tx.execute(sql`
    UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}`);
  return result;
}

function resolveOperation<TResult>(row: OperationRow, payloadHash: string): TResult {
  if (row.operation_kind !== 'GROWTH' || row.payload_hash !== payloadHash) {
    throw new ClassTreeError('OPERATION_CONFLICT', '같은 요청 번호로 다른 내용이 이미 처리됐어요. 화면을 새로고침해 주세요.', 409);
  }
  if (row.status !== 'SUCCEEDED' || !row.result_snapshot || typeof row.result_snapshot !== 'object') {
    throw new ClassTreeError('OPERATION_PENDING', '앞서 보낸 요청을 아직 처리하고 있어요. 잠시 후 다시 확인해 주세요.', 409);
  }
  return row.result_snapshot as TResult;
}

/* ------------------------------------------------------------------ */
/* Hooks used inside other money writers                               */
/* ------------------------------------------------------------------ */

/** A paid task completion adds the class's task drops to the growing tree (when it is on and not full). */
export async function addTaskTreeDrops(tx: TenantTransaction, tenantId: string, input: Readonly<{
  studentId: string; transactionId: string; operationId: string;
}>): Promise<void> {
  if (!await treeTablesPresent(tx)) return;
  const settings = await readClassTreeSettings(tx, tenantId);
  if (!settings.enabled || settings.taskDrops === 0) return;
  const tree = await readGrowingTree(tx, tenantId, true);
  if (!tree || toNumber(tree.drops) >= toNumber(tree.goal)) return;
  await addDrops(tx, tenantId, tree, {
    dropId: `tree-task:${input.transactionId}`, source: 'TASK', studentId: input.studentId, amount: settings.taskDrops,
    transactionId: input.transactionId, operationId: input.operationId, note: null,
  });
}

/**
 * When a watering or a task reward is cancelled, its drops leave the tree they went to, as long
 * as that tree is still growing. A harvested tree keeps what it had.
 */
export async function revokeTreeDropsForTransaction(tx: TenantTransaction, tenantId: string, input: Readonly<{
  originalTransactionId: string; reversalTransactionId: string; operationId: string;
}>): Promise<void> {
  if (!await treeTablesPresent(tx)) return;
  const given = await tx.execute(sql`
    SELECT tree_no, student_id, sum(amount)::text AS amount FROM tree_drops
    WHERE tenant_id=${tenantId} AND transaction_id=${input.originalTransactionId} AND source IN ('WATER', 'TASK')
    GROUP BY tree_no, student_id`);
  for (const row of given.rows as Array<{ tree_no: number; student_id: string; amount: string }>) {
    const treeResult = await tx.execute(sql`
      SELECT tree_no, goal::text AS goal, drops::text AS drops, status, started_at, harvested_at, harvest_recipients,
             harvest_reward_amount::text AS harvest_reward_amount, harvest_coupon
      FROM class_trees WHERE tenant_id=${tenantId} AND tree_no=${row.tree_no} FOR UPDATE`);
    const tree = treeResult.rows[0] as TreeRow | undefined;
    if (!tree || tree.status !== 'GROWING') continue;
    const amount = Math.min(toNumber(row.amount), toNumber(tree.drops));
    if (amount <= 0) continue;
    await addDrops(tx, tenantId, tree, {
      dropId: `tree-cancel:${input.reversalTransactionId}`, source: 'CANCEL', studentId: row.student_id, amount: -amount,
      transactionId: input.reversalTransactionId, operationId: input.operationId, note: null,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Commands and reads                                                  */
/* ------------------------------------------------------------------ */

export type ClassTreeDependencies = Readonly<{ tenantId: string; runTenantTransaction: RunTenantTransaction }>;

export function createClassTreeCommands(dependencies: ClassTreeDependencies) {
  const { tenantId, runTenantTransaction } = dependencies;

  const commands = {
    /** The bank view for one student. */
    async studentView(studentId: string): Promise<ClassTreeStudentViewDto> {
      return runTenantTransaction(tenantId, async (tx) => {
        const settings = await readClassTreeSettings(tx, tenantId);
        const tree = settings.enabled ? await readGrowingTree(tx, tenantId, false) : undefined;
        const counts = await tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM tree_drops WHERE tenant_id=${tenantId} AND source='WATER'
               AND student_id=${studentId} AND created_at >= ${DAY_START}) AS mine,
            (SELECT count(DISTINCT student_id)::int FROM tree_drops WHERE tenant_id=${tenantId} AND source='WATER'
               AND created_at >= ${DAY_START}) AS waterers,
            (SELECT count(*)::int FROM class_trees WHERE tenant_id=${tenantId} AND status='HARVESTED') AS harvested`);
        const row = counts.rows[0] as { mine: number; waterers: number; harvested: number };
        return {
          enabled: settings.enabled,
          treeName: settings.treeName,
          tree: tree ? treeDto(tree) : null,
          apples: await countActiveStudents(tx, tenantId),
          waterPrice: settings.waterPrice,
          waterDailyLimit: settings.waterDailyLimit,
          myWaterToday: toNumber(row.mine),
          waterersToday: toNumber(row.waterers),
          harvestedTrees: toNumber(row.harvested),
        };
      });
    },

    /** Everything the teacher's tree screen shows. */
    async adminBoard(): Promise<ClassTreeAdminBoardDto> {
      return runTenantTransaction(tenantId, async (tx) => {
        const settings = await readClassTreeSettings(tx, tenantId);
        const tree = await readGrowingTree(tx, tenantId, false);
        const activeStudents = await countActiveStudents(tx, tenantId);
        const contributions = await tx.execute(sql`
          SELECT s.student_id, s.name,
                 COALESCE(sum(d.amount) FILTER (WHERE d.source='WATER' AND c.drop_id IS NULL), 0)::text AS water,
                 COALESCE(sum(d.amount) FILTER (WHERE d.source='TASK' AND c.drop_id IS NULL), 0)::text AS task,
                 count(*) FILTER (WHERE d.source='WATER' AND d.created_at >= ${DAY_START})::int AS water_today
          FROM students s
          LEFT JOIN tree_drops d ON d.tenant_id=s.tenant_id AND d.student_id=s.student_id AND d.tree_no=${tree?.tree_no ?? -1}
            AND d.source IN ('WATER', 'TASK')
          -- A cancelled watering or task reward no longer counts as help.
          LEFT JOIN transactions r ON r.tenant_id=d.tenant_id AND r.reverses_transaction_id=d.transaction_id
          LEFT JOIN tree_drops c ON c.tenant_id=r.tenant_id AND c.transaction_id=r.transaction_id AND c.source='CANCEL'
          WHERE s.tenant_id=${tenantId} AND s.status='ACTIVE' AND s.deleted_at IS NULL
          GROUP BY s.student_id, s.name
          ORDER BY s.student_id`);
        const sun = await tx.execute(sql`
          SELECT COALESCE(sum(amount), 0)::text AS total FROM tree_drops
          WHERE tenant_id=${tenantId} AND tree_no=${tree?.tree_no ?? -1} AND source='SUN'`);
        const harvests = await tx.execute(sql`
          SELECT tree_no, goal::text AS goal, drops::text AS drops, started_at, harvested_at, harvest_recipients,
                 harvest_reward_amount::text AS harvest_reward_amount, harvest_coupon
          FROM class_trees WHERE tenant_id=${tenantId} AND status='HARVESTED' ORDER BY tree_no DESC LIMIT 20`);
        const rewardProducts = await tx.execute(sql`
          SELECT p.product_id, p.name, p.image_url, p.is_active, c.digital_kind
          FROM products p LEFT JOIN coupon_products c ON c.tenant_id=p.tenant_id AND c.product_id=p.product_id
          WHERE p.tenant_id=${tenantId} AND p.deleted_at IS NULL
          ORDER BY p.sort_order, p.name, p.product_id`);
        const contributionRows = contributions.rows as Array<{ student_id: string; name: string; water: string; task: string; water_today: number }>;
        return {
          settings,
          activeStudents,
          computedGoal: classTreeGoal({ ...settings, goalOverride: null }, activeStudents),
          rewardProducts: (rewardProducts.rows as Array<{ product_id: string; name: string; image_url: string | null; is_active: boolean; digital_kind: string | null }>)
            .map((row) => ({
              productId: row.product_id, name: row.name, imageUrl: row.image_url || null, isActive: row.is_active === true,
              digitalKind: row.digital_kind === 'CONSUMABLE' || row.digital_kind === 'COLLECTIBLE' ? row.digital_kind : null,
            })),
          tree: tree ? treeDto(tree) : null,
          waterersToday: contributionRows.filter((row) => toNumber(row.water_today) > 0).length,
          classFeedTotal: toNumber((sun.rows[0] as { total: string }).total),
          contributions: contributionRows.map((row) => {
            const water = toNumber(row.water), task = toNumber(row.task);
            return { studentId: row.student_id, name: row.name, water, task, total: water + task, waterToday: toNumber(row.water_today) };
          }),
          harvests: (harvests.rows as TreeRow[]).map((row) => ({
            treeNo: row.tree_no, goal: toNumber(row.goal), drops: toNumber(row.drops), startedAt: iso(row.started_at),
            harvestedAt: iso(row.harvested_at as Date | string), recipients: toNumber(row.harvest_recipients),
            rewardAmount: toNumber(row.harvest_reward_amount), rewardItem: row.harvest_coupon ?? '',
          })),
        };
      });
    },

    /**
     * Saves the teacher's settings. Turning the tree on for the first time plants tree No. 1; a
     * change to anything the goal depends on resets the growing tree's goal.
     */
    async saveSettings(settings: ClassTreeSettings): Promise<ClassTreeAdminBoardDto> {
      await runTenantTransaction(tenantId, async (tx) => {
        if (settings.rewardProductId !== null && !await readRewardProduct(tx, tenantId, settings.rewardProductId)) {
          throw new ClassTreeError('INVALID_INPUT', '수확 보상 상품을 찾지 못했어요. 상품 목록을 새로 불러와 주세요.', 400);
        }
        const before = await readClassTreeSettings(tx, tenantId);
        await tx.execute(sql`
          INSERT INTO growth_settings (tenant_id, tree_enabled, water_price, water_daily_limit, task_drops, target_weeks,
                                       goal_override, reward_amount, reward_coupon, reward_product_id, tree_name)
          VALUES (${tenantId}, ${settings.enabled}, ${settings.waterPrice}, ${settings.waterDailyLimit}, ${settings.taskDrops},
                  ${settings.targetWeeks}, ${settings.goalOverride}, ${settings.rewardAmount}, '', ${settings.rewardProductId}, ${settings.treeName})
          ON CONFLICT (tenant_id) DO UPDATE SET
            tree_enabled=EXCLUDED.tree_enabled, water_price=EXCLUDED.water_price, water_daily_limit=EXCLUDED.water_daily_limit,
            task_drops=EXCLUDED.task_drops, target_weeks=EXCLUDED.target_weeks, goal_override=EXCLUDED.goal_override,
            reward_amount=EXCLUDED.reward_amount, reward_coupon=EXCLUDED.reward_coupon, reward_product_id=EXCLUDED.reward_product_id,
            tree_name=EXCLUDED.tree_name,
            version=growth_settings.version+1, updated_at=clock_timestamp()`);
        const tree = await readGrowingTree(tx, tenantId, true);
        const goal = classTreeGoal(settings, await countActiveStudents(tx, tenantId));
        if (!tree) {
          if (settings.enabled) await startTree(tx, tenantId, goal);
          return;
        }
        const goalInputsChanged = before.targetWeeks !== settings.targetWeeks || before.goalOverride !== settings.goalOverride
          || before.waterDailyLimit !== settings.waterDailyLimit || before.taskDrops !== settings.taskDrops;
        if (goalInputsChanged && toNumber(tree.goal) !== goal) {
          await tx.execute(sql`UPDATE class_trees SET goal=${goal}, version=version+1 WHERE tenant_id=${tenantId} AND tree_no=${tree.tree_no}`);
        }
      });
      return commands.adminBoard();
    },

    /** A student waters the tree: pays the price (when there is one) and adds one drop. */
    async water(input: Readonly<{ studentId: string; operationId: string }>): Promise<ClassTreeWaterResultDto> {
      const operationId = requireOperationId(input.operationId);
      const studentId = input.studentId;
      const payloadHash = hashOf({ kind: 'TREE_WATER', studentId, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'CLASS_TREE_WATERED', async (now) => {
        const settings = await readClassTreeSettings(tx, tenantId);
        if (!settings.enabled) throw new ClassTreeError('TREE_OFF', '선생님이 아직 학급 나무를 열지 않았어요.', 409);
        if (settings.waterDailyLimit === 0) throw new ClassTreeError('WATER_OFF', '지금은 양분 주기를 쉬고 있어요.', 409);
        const accountResult = await tx.execute(sql`
          SELECT s.name, s.status, s.deleted_at, a.balance::text AS balance
          FROM students s JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${tenantId} AND s.student_id=${studentId}
          FOR UPDATE OF s, a`);
        const account = accountResult.rows[0] as { name: string; status: string; deleted_at: unknown; balance: string } | undefined;
        if (!account || account.status !== 'ACTIVE' || account.deleted_at !== null) {
          throw new ClassTreeError('STUDENT_INVALID', '학생 정보를 확인하지 못했어요. 다시 로그인해 주세요.', 404);
        }
        const tree = await readGrowingTree(tx, tenantId, true);
        if (!tree) throw new ClassTreeError('TREE_BUSY', '나무를 새로 심는 중이에요. 잠시 후 다시 눌러 주세요.', 409);
        if (toNumber(tree.drops) >= toNumber(tree.goal)) {
          throw new ClassTreeError('TREE_READY', '나무가 다 자랐어요. 선생님이 수확할 때까지 기다려 주세요.', 409);
        }
        const today = await tx.execute(sql`
          SELECT count(*)::int AS count FROM tree_drops
          WHERE tenant_id=${tenantId} AND source='WATER' AND student_id=${studentId} AND created_at >= ${DAY_START}`);
        const wateredToday = toNumber((today.rows[0] as { count: number }).count);
        if (wateredToday >= settings.waterDailyLimit) {
          throw new ClassTreeError('DAILY_LIMIT', '오늘은 양분을 다 줬어요. 내일 또 줄 수 있어요.', 409);
        }
        const balance = toNumber(account.balance);
        const price = settings.waterPrice;
        if (balance < price) throw new ClassTreeError('NOT_ENOUGH_MONEY', '잔액이 부족해서 양분을 줄 수 없어요.', 409);
        const balanceAfter = balance - price;
        let transactionId: string | null = null;
        if (price > 0) {
          transactionId = `tree-water:${operationId}`;
          await tx.execute(sql`
            UPDATE accounts SET balance=${balanceAfter}, version=version+1, updated_at=${now}
            WHERE tenant_id=${tenantId} AND student_id=${studentId}`);
          await tx.execute(sql`
            INSERT INTO transactions
              (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind, legacy_total_amount,
               balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, operation_id,
               operation_hash, schema_version)
            VALUES (${tenantId}, ${transactionId}, ${now}, ${studentId}, ${account.name}, 'GROWTH_SPEND', ${price},
                    ${-price}, ${balance}, ${balanceAfter}, 'bank-class-tree', 'TREE_WATER', ${operationId}, ${payloadHash}, 1)`);
        }
        const drops = await addDrops(tx, tenantId, tree, {
          dropId: `tree-water:${operationId}`, source: 'WATER', studentId, amount: 1, transactionId, operationId, note: null,
        });
        const goal = toNumber(tree.goal);
        const result: ClassTreeWaterResultDto = {
          ok: true, operationId, treeNo: tree.tree_no, drops, goal, ready: drops >= goal,
          myWaterToday: wateredToday + 1, price, balanceAfter, wateredAt: now.toISOString(),
        };
        return { result, entityId: String(tree.tree_no), details: { studentId, price, drops } };
      }));
    },

    /** The teacher's classFeed: drops for the whole class, e.g. after a class-wide praise. */
    async classFeed(input: Readonly<{ operationId: string; amount: number; note: string }>): Promise<ClassTreeClassFeedResultDto> {
      const operationId = requireOperationId(input.operationId);
      const { min, max } = CLASS_TREE_LIMITS.classFeedDrops;
      if (!Number.isSafeInteger(input.amount) || input.amount < min || input.amount > max) {
        throw new ClassTreeError('INVALID_INPUT', `반 전체에 줄 양분은 ${min}~${max.toLocaleString('ko-KR')} 사이로 정해 주세요.`, 400);
      }
      const note = typeof input.note === 'string' ? input.note.trim().replace(/\s+/gu, ' ') : '';
      if ([...note].length > CLASS_TREE_LIMITS.classFeedNoteLength || /[\u0000-\u001f\u007f-\u009f]/u.test(note)) {
        throw new ClassTreeError('INVALID_INPUT', `메모는 ${CLASS_TREE_LIMITS.classFeedNoteLength}자 이내로 적어 주세요.`, 400);
      }
      const payloadHash = hashOf({ kind: 'TREE_CLASS_FEED', amount: input.amount, note, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'CLASS_TREE_CLASS_FEED', async () => {
        const settings = await readClassTreeSettings(tx, tenantId);
        if (!settings.enabled) throw new ClassTreeError('TREE_OFF', '학급 나무를 먼저 켜 주세요.', 409);
        const tree = await readGrowingTree(tx, tenantId, true);
        if (!tree) throw new ClassTreeError('TREE_BUSY', '자라는 나무가 없어요. 화면을 새로고침해 주세요.', 409);
        if (toNumber(tree.drops) >= toNumber(tree.goal)) {
          throw new ClassTreeError('TREE_READY', '나무가 이미 다 자랐어요. 수확해 주세요.', 409);
        }
        const drops = await addDrops(tx, tenantId, tree, {
          dropId: `tree-class:${operationId}`, source: 'SUN', studentId: null, amount: input.amount, transactionId: null,
          operationId, note: note || null,
        });
        const goal = toNumber(tree.goal);
        const result: ClassTreeClassFeedResultDto = { ok: true, operationId, treeNo: tree.tree_no, amount: input.amount, drops, goal, ready: drops >= goal };
        return { result, entityId: String(tree.tree_no), details: { amount: input.amount, drops } };
      }));
    },

    /**
     * Harvests a full tree: every active student gets the reward money and reward product set now, and
     * the next tree is planted with a goal for the current class size.
     */
    async harvest(input: Readonly<{ operationId: string; treeNo: number }>): Promise<ClassTreeHarvestResultDto> {
      const operationId = requireOperationId(input.operationId);
      if (!Number.isSafeInteger(input.treeNo) || input.treeNo < 1) {
        throw new ClassTreeError('INVALID_INPUT', '수확할 나무를 다시 골라 주세요.', 400);
      }
      const payloadHash = hashOf({ kind: 'TREE_HARVEST', treeNo: input.treeNo, schemaVersion: 1 });
      return runTenantTransaction(tenantId, (tx) => runOperation(tx, tenantId, operationId, payloadHash, 'CLASS_TREE_HARVESTED', async (now) => {
        const settings = await readClassTreeSettings(tx, tenantId);
        const students = (await tx.execute(sql`
          SELECT s.student_id, s.name, a.balance::text AS balance
          FROM students s JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${tenantId} AND s.status='ACTIVE' AND s.deleted_at IS NULL
          ORDER BY s.student_id
          FOR UPDATE OF s, a`)).rows as Array<{ student_id: string; name: string; balance: string }>;
        const tree = await readGrowingTree(tx, tenantId, true);
        if (!tree || tree.tree_no !== input.treeNo) {
          throw new ClassTreeError('TREE_NOT_READY', '이 나무는 이미 수확했어요. 화면을 새로고침해 주세요.', 409);
        }
        if (toNumber(tree.drops) < toNumber(tree.goal)) {
          throw new ClassTreeError('TREE_NOT_READY', '아직 열매가 다 익지 않았어요.', 409);
        }
        const rewardAmount = settings.rewardAmount;
        // A reward product deleted since it was picked gives nothing.
        const rewardProduct = settings.rewardProductId === null ? null : await readRewardProduct(tx, tenantId, settings.rewardProductId);
        const rewardItem = rewardProduct ? storageItemShape(rewardProduct).title : '';
        for (const student of students) {
          if (rewardAmount > 0) {
            const balance = toNumber(student.balance);
            const balanceAfter = balance + rewardAmount;
            if (!Number.isSafeInteger(balanceAfter)) throw new Error('Harvest reward balance out of range.');
            await tx.execute(sql`
              UPDATE accounts SET balance=${balanceAfter}, version=version+1, updated_at=${now}
              WHERE tenant_id=${tenantId} AND student_id=${student.student_id}`);
            await tx.execute(sql`
              INSERT INTO transactions
                (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind, legacy_total_amount,
                 balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, operation_id,
                 operation_hash, schema_version)
              VALUES (${tenantId}, ${`tree-harvest:${operationId}:${student.student_id}`}, ${now}, ${student.student_id},
                      ${student.name}, 'GROWTH_REWARD', ${rewardAmount}, ${rewardAmount}, ${balance}, ${balanceAfter},
                      'admin-class-tree', 'TREE_HARVEST', ${`tree-harvest:${operationId}:${student.student_id}`}, ${payloadHash}, 1)`);
          }
          if (rewardProduct) await giveHarvestReward(tx, tenantId, { studentId: student.student_id, product: rewardProduct, treeNo: tree.tree_no, operationId });
        }
        const harvested = await tx.execute(sql`
          UPDATE class_trees SET status='HARVESTED', harvested_at=clock_timestamp(), harvest_operation_id=${operationId},
                 harvest_recipients=${students.length}, harvest_reward_amount=${rewardAmount}, harvest_coupon=${rewardItem},
                 version=version+1
          WHERE tenant_id=${tenantId} AND tree_no=${tree.tree_no} RETURNING harvested_at`);
        const harvestedAt = iso((harvested.rows[0] as { harvested_at: Date | string }).harvested_at);
        const nextGoal = classTreeGoal(settings, students.length);
        const nextTreeNo = await startTree(tx, tenantId, nextGoal);
        const result: ClassTreeHarvestResultDto = {
          ok: true, operationId, treeNo: tree.tree_no, recipients: students.length, rewardAmount, rewardItem,
          nextTreeNo, nextGoal, harvestedAt,
        };
        return { result, entityId: String(tree.tree_no), details: { recipients: students.length, rewardAmount, rewardProduct: rewardProduct?.productId ?? null } };
      }));
    },
  };
  return commands;
}
