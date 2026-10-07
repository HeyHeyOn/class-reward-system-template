import 'server-only';
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseCatalogCommands } from '@/server/repositories/database/catalogCommands';
import { createClassStartRepository } from '@/server/repositories/database/classStart';
import { createDatabasePromotionCommands } from '@/server/repositories/database/promotionCommands';
import { createDatabaseSettingsCommands } from '@/server/repositories/database/settingsCommands';
import { createDatabaseStudentCommands } from '@/server/repositories/database/studentCommands';
import { createTaskLedgerCommands } from '@/server/repositories/database/taskLedger/commands';
import type { XlsxImportPlan } from './xlsxImportPlan';

type Run = <T>(tenantId: string, callback: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

export type XlsxImportConflictCode = 'NOT_EMPTY' | 'NOT_ACTIVE' | 'START_REFUSED' | 'START_CONFLICT';
/** A refusal that leaves the class exactly as it was (the transaction rolls back). */
export class XlsxImportConflictError extends Error {
  constructor(readonly code: XlsxImportConflictCode) {
    super(`Xlsx import refused: ${code}.`);
    this.name = 'XlsxImportConflictError';
  }
}

export type XlsxImportCounts = Readonly<{ students: number; products: number; promotions: number; tasks: number; transactions: number }>;
export type XlsxImportExecution = Readonly<{
  replayed: boolean;
  started: boolean;
  written: Readonly<{ students: number; products: number; promotions: number; tasks: number; completions: number; unassigned: number; deactivated: number }>;
}>;

/** Deterministic per-step operation IDs (UUID v4 layout), bound to one upload and one file. */
export function deriveXlsxImportOperationId(operationId: string, fileDigest: string, ...parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(['crs-xlsx-import-v1', operationId, fileDigest, ...parts])).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Rows that make a class "not empty" for an import (live or tombstoned). */
export async function readXlsxImportTargetCounts(tx: TenantTransaction, tenantId: string): Promise<XlsxImportCounts> {
  const result = await tx.execute(sql`SELECT
    (SELECT count(*) FROM students WHERE tenant_id=${tenantId})::int AS students,
    (SELECT count(*) FROM products WHERE tenant_id=${tenantId})::int AS products,
    (SELECT count(*) FROM promotions WHERE tenant_id=${tenantId})::int AS promotions,
    (SELECT count(*) FROM tasks WHERE tenant_id=${tenantId})::int AS tasks,
    (SELECT count(*) FROM transactions WHERE tenant_id=${tenantId})::int AS transactions`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const count = (key: string) => Number(row?.[key] ?? 0);
  return { students: count('students'), products: count('products'), promotions: count('promotions'),
    tasks: count('tasks'), transactions: count('transactions') };
}

export function isEmptyXlsxImportTarget(counts: XlsxImportCounts): boolean {
  return Object.values(counts).every(value => value === 0);
}

/** Runs the existing `$n` query text of a repository inside the caller's drizzle transaction. */
function transactionQueryable(tx: TenantTransaction) {
  return {
    async query(text: string, values: unknown[] = []) {
      const pieces = text.split(/\$(\d+)/);
      const chunks: SQL[] = pieces.map((piece, index) => index % 2 === 0 ? sql.raw(piece) : sql`${values[Number(piece) - 1]}`);
      const result = await tx.execute(sql.join(chunks, sql.raw('')));
      return { rows: result.rows as unknown[] };
    },
  };
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function assertOk(result: unknown, operationId: string): void {
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true
    || (result as { operationId?: unknown }).operationId !== operationId) {
    throw new Error('Xlsx import step acknowledgment integrity check failed.');
  }
}

/**
 * Writes the class's CURRENT state with the app's own commands, all bound to the caller's
 * single tenant transaction (a failure rolls every step back, including the class start).
 * Step operation IDs derive from (upload operationId, file digest): replaying the same upload
 * on the class it already filled is recognized by the first step's ledger row and writes nothing.
 */
export async function executeXlsxImportPlan(tx: TenantTransaction, input: Readonly<{
  tenantId: string; plan: XlsxImportPlan; operationId: string; start?: Readonly<{ slug: string; subject: string }>;
}>): Promise<XlsxImportExecution> {
  const { tenantId, plan, operationId } = input;
  const derive = (...parts: string[]) => deriveXlsxImportOperationId(operationId, plan.fileDigest, ...parts);
  const bound: Run = async (id, callback) => {
    if (id !== tenantId) throw new Error('Xlsx import transaction scope mismatch.');
    return callback(tx);
  };
  let started = false;
  if (input.start) {
    try {
      const result = await createClassStartRepository(transactionQueryable(tx))
        .start({ operationId: derive('class-start'), slug: input.start.slug, subject: input.start.subject });
      started = !result.replayed;
    } catch (error) {
      const code = sqlState(error);
      if (code === '42501') throw new XlsxImportConflictError('START_REFUSED');
      if (code === '23505') throw new XlsxImportConflictError('START_CONFLICT');
      throw error;
    }
  }
  // One import at a time per class; the emptiness check below is then stable.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crs-xlsx-import:${tenantId}`}, 0))`);
  const tenant = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId}`);
  if ((tenant.rows[0] as { lifecycle?: unknown } | undefined)?.lifecycle !== 'ACTIVE') throw new XlsxImportConflictError('NOT_ACTIVE');

  const marker = derive('settings');
  const replay = await tx.execute(sql`SELECT operation_kind, status FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${marker}`);
  const replayRow = replay.rows[0] as { operation_kind?: unknown; status?: unknown } | undefined;
  if (replayRow) {
    if (replayRow.operation_kind !== 'SETTINGS_ADMIN' || replayRow.status !== 'SUCCEEDED') {
      throw new Error('Xlsx import replay marker integrity check failed.');
    }
    return { replayed: true, started: false,
      written: { students: 0, products: 0, promotions: 0, tasks: 0, completions: 0, unassigned: 0, deactivated: 0 } };
  }
  if (!isEmptyXlsxImportTarget(await readXlsxImportTargetCounts(tx, tenantId))) throw new XlsxImportConflictError('NOT_EMPTY');

  const settings = createDatabaseSettingsCommands({ tenantId, runTenantTransaction: bound });
  const current = await settings.get();
  await settings.save({ operationId: marker, expectedSettingsVersion: current.settingsVersion, ...plan.settings });

  const students = createDatabaseStudentCommands({ tenantId, runTenantTransaction: bound });
  for (const student of plan.students) {
    const id = derive('student', student.studentId);
    assertOk(await students.create({ operationId: id, ...student }), id);
  }
  const catalog = createDatabaseCatalogCommands({ tenantId, runTenantTransaction: bound });
  for (const product of plan.products) {
    const id = derive('product', product.productId);
    assertOk(await catalog.create({ operationId: id, ...product }), id);
  }
  const promotions = createDatabasePromotionCommands({ tenantId, runTenantTransaction: bound });
  for (const promotion of plan.promotions) {
    const id = derive('promotion', promotion.promotionId);
    assertOk(await promotions.create({ operationId: id, ...promotion }), id);
  }

  // Tasks keep the sheet's IDs, repeat settings and each student's current stage (no cycles:
  // the class's task ledger starts here). Completions are marked without paying rewards again.
  const ledger = createTaskLedgerCommands({ tenantId, runTenantTransaction: bound });
  let completions = 0;
  for (const task of plan.tasks) {
    const id = derive('task', task.taskId);
    const completed = new Set([...task.completedStudentIds, ...task.completedUnassignedStudentIds]);
    const students = [
      ...task.readyStudentIds.filter((studentId) => !completed.has(studentId)).map((studentId) => ({ studentId, stage: 'READY' as const })),
      ...[...completed].map((studentId) => ({ studentId, stage: 'COMPLETED' as const })),
    ].sort((left, right) => left.studentId.localeCompare(right.studentId));
    const resetStage = task.schedule.recurrence.type === 'NONE' ? null
      : task.schedule.resetAssignmentOnCycle ? 'UNASSIGNED' as const
        : task.schedule.resetCompletionOnCycle ? 'READY' as const : null;
    const created = await ledger.createTask({ operationId: id, task: { title: task.title, description: task.description,
      reward: task.reward, isActive: task.isActive, sortOrder: task.sortOrder, availableFrom: task.availableFrom, dueAt: task.dueAt,
      prerequisiteTaskId: task.prerequisiteTaskId }, repeat: { recurrence: task.schedule.recurrence, resetStage }, students },
    { taskId: task.taskId, padletBoardId: task.padletBoardId });
    if (created.taskId !== task.taskId) throw new Error('Xlsx import task acknowledgment integrity check failed.');
    completions += completed.size;
  }
  const hidden = plan.tasks.filter(task => !task.isActive);
  return { replayed: false, started, written: { students: plan.students.length, products: plan.products.length,
    promotions: plan.promotions.length, tasks: plan.tasks.length, completions, unassigned: 0, deactivated: hidden.length } };
}
