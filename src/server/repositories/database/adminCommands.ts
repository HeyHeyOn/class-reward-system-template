import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RESULT_KEYS = ['adjustedAt', 'amount', 'mode', 'ok', 'operationId', 'students'] as const;
const STUDENT_RESULT_KEYS = [
  'balanceAfter', 'balanceBefore', 'delta', 'studentId', 'studentName', 'transactionId',
] as const;

export type AdminAdjustmentMode = 'set' | 'add' | 'subtract';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseAdminCommandDependencies = {
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
  /** Fault injection after all account updates and before immutable ledger inserts. */
  afterAccountUpdates?: () => Promise<void>;
};

export type AdminAdjustmentInput = Readonly<{
  operationId: string;
  studentIds: ReadonlyArray<string>;
  mode: AdminAdjustmentMode;
  amount: number;
  /** Optional trusted-caller binding; browsers send neither tenant nor hash. */
  payloadHash?: string;
}>;

export type AdminAdjustmentStudentResult = Readonly<{
  studentId: string;
  studentName: string;
  balanceBefore: number;
  balanceAfter: number;
  delta: number;
  transactionId: string | null;
}>;

export type AdminAdjustmentSuccess = Readonly<{
  ok: true;
  operationId: string;
  mode: AdminAdjustmentMode;
  amount: number;
  adjustedAt: string;
  students: ReadonlyArray<AdminAdjustmentStudentResult>;
}>;

export type AdminAdjustmentErrorCode =
  | 'OPERATION_CONFLICT'
  | 'OPERATION_PENDING'
  | 'OPERATION_FAILED'
  | 'STUDENT_INVALID'
  | 'UNSAFE_BALANCE'
  | 'INTEGRITY_FAILURE';

export class AdminAdjustmentError extends Error {
  constructor(readonly code: AdminAdjustmentErrorCode) {
    super(messageFor(code));
    this.name = 'AdminAdjustmentError';
  }
}

type CanonicalInput = Readonly<{
  operationId: string;
  studentIds: string[];
  mode: AdminAdjustmentMode;
  amount: number;
  payloadHash?: string;
}>;

type OperationRow = {
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  finished_at: Date | string | null;
};

type AccountRow = {
  student_id: string;
  name: string;
  balance: string | number | bigint;
};

type AdjustmentRow = {
  adjustment_id: string;
  transaction_id: string;
  mode: string;
  requested_amount: string | number | bigint;
  operator_snapshot: string;
  legacy_adjustment_id: string | null;
};

type LedgerRow = {
  transaction_id: string;
  occurred_at: Date | string;
  student_id: string;
  student_name_snapshot: string;
  kind: string;
  legacy_total_amount: string | number | bigint;
  balance_delta: string | number | bigint;
  balance_before: string | number | bigint;
  balance_after: string | number | bigint;
  operator_snapshot: string;
  legacy_status_snapshot: string | null;
  operation_id: string | null;
  operation_hash: string | null;
  schema_version: number;
  item_count: string | number | bigint;
  inventory_count: string | number | bigint;
  completion_count: string | number | bigint;
};

export function createAdminAdjustmentLedgerOperationId(
  parentOperationId: string,
  studentId: string,
): string {
  const normalizedStudentId = studentId.trim();
  if (!UUID.test(parentOperationId) || !normalizedStudentId || normalizedStudentId !== studentId) {
    throw new Error('Canonical parent operation and student IDs are required.');
  }
  const bytes = createHash('sha256').update(JSON.stringify({
    kind: 'ADMIN_ADJUSTMENT_LEDGER', parentOperationId, studentId: normalizedStudentId,
  }), 'utf8').digest().subarray(0, 16);
  // RFC 9562 UUIDv8: deterministic application-defined child ledger identity.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Student IDs are trimmed and then sorted by JS code-unit order for canonical hashing/locking/results. */
export function createAdminAdjustmentPayloadHash(
  input: Pick<AdminAdjustmentInput, 'studentIds' | 'mode' | 'amount'>,
): string {
  const canonical = canonicalizeSemantics(input);
  return createHash('sha256').update(JSON.stringify({
    kind: 'ADMIN_ADJUSTMENT',
    studentIds: canonical.studentIds,
    mode: canonical.mode,
    amount: canonical.amount,
    transactionKind: 'ADMIN_ADJUSTMENT',
    operatorSnapshot: 'admin',
    legacyStatusSnapshot: 'ADMIN_ADJUSTMENT',
    legacyAmountConvention: 'negative-delta',
    schemaVersion: 1,
  }), 'utf8').digest('hex');
}

export function createAdminAdjustmentResultHash(result: AdminAdjustmentSuccess): string {
  return createHash('sha256').update(JSON.stringify({
    adjustedAt: result.adjustedAt,
    amount: result.amount,
    mode: result.mode,
    ok: result.ok,
    operationId: result.operationId,
    students: result.students.map((student) => ({
      balanceAfter: student.balanceAfter,
      balanceBefore: student.balanceBefore,
      delta: student.delta,
      studentId: student.studentId,
      studentName: student.studentName,
      transactionId: student.transactionId,
    })),
  }), 'utf8').digest('hex');
}

export function createDatabaseAdminCommands(dependencies: DatabaseAdminCommandDependencies) {
  return {
    async adjust(rawInput: AdminAdjustmentInput): Promise<AdminAdjustmentSuccess> {
      const input = canonicalizeInput(rawInput);
      const payloadHash = createAdminAdjustmentPayloadHash(input);
      if (input.payloadHash && input.payloadHash !== payloadHash) {
        throw new AdminAdjustmentError('OPERATION_CONFLICT');
      }
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid adjustment timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        // LOCK ORDER: existing operation row first, then every student/account row in stable
        // student_id order FOR UPDATE. A fresh operation is serialized by its unique insert.
        // PGlite is a serialized fallback only; it does not prove real PostgreSQL concurrency.
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId, true);
        if (existing) {
          return resolveExisting(tx, dependencies.tenantId, input, payloadHash, existing);
        }

        const inserted = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'ADMIN_ADJUSTMENT', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (inserted.rows.length === 0) {
          const raced = await readOperation(tx, dependencies.tenantId, input.operationId, true);
          if (!raced) throw new Error('Admin adjustment operation could not be read.');
          return resolveExisting(tx, dependencies.tenantId, input, payloadHash, raced);
        }

        const accounts = await lockAccounts(tx, dependencies.tenantId, input.studentIds);
        const changes = calculateChanges(accounts, input);

        for (const change of changes) {
          if (change.delta === 0) continue;
          await tx.execute(sql`
            UPDATE accounts
            SET balance=${change.balanceAfter}, version=version+1, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND student_id=${change.studentId}
          `);
        }
        await dependencies.afterAccountUpdates?.();

        for (const change of changes) {
          if (change.transactionId === null) continue;
          await tx.execute(sql`
            INSERT INTO transactions
              (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
               legacy_total_amount, balance_delta, balance_before, balance_after,
               operator_snapshot, legacy_status_snapshot, operation_id, operation_hash,
               schema_version)
            VALUES
              (${dependencies.tenantId}, ${change.transactionId}, ${now}, ${change.studentId},
               ${change.studentName}, 'ADMIN_ADJUSTMENT', ${-change.delta}, ${change.delta},
               ${change.balanceBefore}, ${change.balanceAfter}, 'admin', 'ADMIN_ADJUSTMENT',
               ${createAdminAdjustmentLedgerOperationId(input.operationId, change.studentId)}, ${payloadHash}, 1)
          `);
          await tx.execute(sql`
            INSERT INTO adjustments
              (tenant_id, adjustment_id, transaction_id, mode, requested_amount,
               operator_snapshot, legacy_adjustment_id)
            VALUES
              (${dependencies.tenantId}, ${adjustmentId(input.operationId, change.studentId)},
               ${change.transactionId}, ${input.mode}, ${input.amount}, 'admin', NULL)
          `);
        }

        const result: AdminAdjustmentSuccess = {
          ok: true,
          operationId: input.operationId,
          mode: input.mode,
          amount: input.amount,
          adjustedAt: now.toISOString(),
          students: changes,
        };
        await appendOperationAudit(
          tx,
          dependencies.tenantId,
          adminAdjustmentAuditInput(input.operationId, result, now),
        );
        await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        `);
        return result;
      });
    },
  };
}

function canonicalizeInput(input: AdminAdjustmentInput): CanonicalInput {
  if (!input || typeof input !== 'object') throw new Error('A valid adjustment input is required.');
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (input.payloadHash !== undefined && (typeof input.payloadHash !== 'string' || !SHA256.test(input.payloadHash))) {
    throw new Error('A lowercase SHA-256 payload hash is required.');
  }
  const semantics = canonicalizeSemantics(input);
  return { operationId: input.operationId, ...semantics, ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}) };
}

function canonicalizeSemantics(
  input: Pick<AdminAdjustmentInput, 'studentIds' | 'mode' | 'amount'>,
): Pick<CanonicalInput, 'studentIds' | 'mode' | 'amount'> {
  if (!Array.isArray(input.studentIds) || input.studentIds.length === 0) {
    throw new Error('At least one student ID is required.');
  }
  const studentIds = input.studentIds.map((value) => {
    if (typeof value !== 'string') throw new Error('Every student ID must be a string.');
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Student IDs cannot be blank.');
    return trimmed;
  });
  if (new Set(studentIds).size !== studentIds.length) throw new Error('Duplicate student IDs are not allowed.');
  if (input.mode !== 'set' && input.mode !== 'add' && input.mode !== 'subtract') {
    throw new Error('Adjustment mode must be set, add, or subtract.');
  }
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
    throw new Error('Adjustment amount must be a nonnegative safe integer.');
  }
  return { studentIds: [...studentIds].sort(), mode: input.mode, amount: input.amount };
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<OperationRow | undefined> {
  const statement = sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
  `;
  const result = lock ? await tx.execute(sql`${statement} FOR UPDATE`) : await tx.execute(statement);
  return result.rows[0] as OperationRow | undefined;
}

async function lockAccounts(
  tx: TenantTransaction,
  tenantId: string,
  studentIds: readonly string[],
): Promise<AccountRow[]> {
  const ids = sql.join(studentIds.map((id) => sql`${id}`), sql`, `);
  const result = await tx.execute(sql`
    SELECT s.student_id, s.name, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id IN (${ids})
    ORDER BY s.student_id
    FOR UPDATE OF s, a
  `);
  const rows = result.rows as AccountRow[];
  if (rows.length !== studentIds.length
    || rows.some((row, index) => row.student_id !== studentIds[index])) {
    throw new AdminAdjustmentError('STUDENT_INVALID');
  }
  return rows;
}

function calculateChanges(rows: AccountRow[], input: CanonicalInput): AdminAdjustmentStudentResult[] {
  return rows.map((row) => {
    const before = safeInteger(row.balance);
    let after: number;
    if (input.mode === 'set') after = input.amount;
    else if (input.mode === 'add') after = checkedAdd(before, input.amount);
    else after = checkedAdd(before, -input.amount);
    const delta = after - before;
    if (!Number.isSafeInteger(delta)) throw new AdminAdjustmentError('UNSAFE_BALANCE');
    const writesLedger = input.mode === 'set' || delta !== 0;
    return {
      studentId: row.student_id,
      studentName: row.name,
      balanceBefore: before,
      balanceAfter: after,
      delta,
      transactionId: writesLedger ? transactionId(input.operationId, row.student_id) : null,
    };
  });
}

async function resolveExisting(
  tx: TenantTransaction,
  tenantId: string,
  input: CanonicalInput,
  payloadHash: string,
  operation: OperationRow,
): Promise<AdminAdjustmentSuccess> {
  if (operation.operation_kind !== 'ADMIN_ADJUSTMENT' || operation.payload_hash !== payloadHash) {
    throw new AdminAdjustmentError('OPERATION_CONFLICT');
  }
  if (operation.status === 'PENDING') throw new AdminAdjustmentError('OPERATION_PENDING');
  if (operation.status === 'FAILED') throw new AdminAdjustmentError('OPERATION_FAILED');
  const stored = parseStoredResult(operation.result_snapshot, input);
  validateStoredStudentSemantics(stored, input);
  const ledgerResult = await tx.execute(sql`
    SELECT t.transaction_id, t.occurred_at, t.student_id, t.student_name_snapshot, t.kind,
           t.legacy_total_amount::text AS legacy_total_amount,
           t.balance_delta::text AS balance_delta, t.balance_before::text AS balance_before,
           t.balance_after::text AS balance_after, t.operator_snapshot, t.legacy_status_snapshot,
           t.operation_id, t.operation_hash, t.schema_version,
           (SELECT count(*)::text FROM transaction_items i
            WHERE i.tenant_id=t.tenant_id AND i.transaction_id=t.transaction_id) AS item_count,
           (SELECT count(*)::text FROM inventory_ledger l
            WHERE l.tenant_id=t.tenant_id AND l.transaction_id=t.transaction_id) AS inventory_count,
           (SELECT count(*)::text FROM task_completions c
            WHERE c.tenant_id=t.tenant_id AND c.transaction_id=t.transaction_id) AS completion_count
    FROM transactions t
    WHERE t.tenant_id=${tenantId}
      AND (t.operation_id=${input.operationId}
        OR t.transaction_id LIKE ${`admin-adjustment:${input.operationId}:%`})
    ORDER BY t.student_id, t.transaction_id
    FOR UPDATE
  `);
  validateLedgers(ledgerResult.rows as LedgerRow[], stored, payloadHash);
  const adjustmentResult = await tx.execute(sql`
    SELECT adjustment_id, transaction_id, mode, requested_amount::text AS requested_amount,
           operator_snapshot, legacy_adjustment_id
    FROM adjustments
    WHERE tenant_id=${tenantId}
      AND (adjustment_id LIKE ${`adjustment:${input.operationId}:%`}
        OR transaction_id LIKE ${`admin-adjustment:${input.operationId}:%`})
    ORDER BY transaction_id
    FOR UPDATE
  `);
  validateAdjustmentRows(adjustmentResult.rows as AdjustmentRow[], stored);
  await assertOperationAudit(
    tx,
    tenantId,
    adminAdjustmentAuditInput(input.operationId, stored, requiredAuditDate(operation.finished_at)),
  );
  return stored;
}

function adminAdjustmentAuditInput(
  operationId: string,
  result: AdminAdjustmentSuccess,
  occurredAt: Date,
) {
  return {
    operationId,
    eventType: 'ADMIN_ADJUSTMENT_COMPLETED',
    entityType: 'OPERATION',
    entityId: operationId,
    redactedDetails: {
      amount: result.amount,
      changedStudentCount: result.students.filter((student) => student.delta !== 0).length,
      mode: result.mode,
      resultHash: createAdminAdjustmentResultHash(result),
      studentCount: result.students.length,
    },
    occurredAt,
  } as const;
}

function requiredAuditDate(value: Date | string | null): Date {
  if (value === null) throw new Error('Admin adjustment audit integrity check failed.');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Admin adjustment audit integrity check failed.');
  return date;
}

function parseStoredResult(snapshot: unknown, input: CanonicalInput): AdminAdjustmentSuccess {
  if (!isRecord(snapshot) || !exactKeys(snapshot, RESULT_KEYS)
    || snapshot.ok !== true || snapshot.operationId !== input.operationId
    || snapshot.mode !== input.mode || snapshot.amount !== input.amount
    || typeof snapshot.adjustedAt !== 'string' || !isCanonicalTimestamp(snapshot.adjustedAt)
    || !Array.isArray(snapshot.students) || snapshot.students.length !== input.studentIds.length) {
    throw new AdminAdjustmentError('INTEGRITY_FAILURE');
  }
  for (const student of snapshot.students) {
    if (!isRecord(student) || !exactKeys(student, STUDENT_RESULT_KEYS)
      || typeof student.studentId !== 'string' || typeof student.studentName !== 'string'
      || !Number.isSafeInteger(student.balanceBefore) || !Number.isSafeInteger(student.balanceAfter)
      || !Number.isSafeInteger(student.delta)
      || (student.transactionId !== null && typeof student.transactionId !== 'string')) {
      throw new AdminAdjustmentError('INTEGRITY_FAILURE');
    }
  }
  return snapshot as unknown as AdminAdjustmentSuccess;
}

function validateStoredStudentSemantics(
  stored: AdminAdjustmentSuccess,
  input: CanonicalInput,
): void {
  for (let index = 0; index < stored.students.length; index += 1) {
    const student = stored.students[index];
    const expectedAfter = input.mode === 'set'
      ? input.amount
      : student.balanceBefore + (input.mode === 'add' ? input.amount : -input.amount);
    const computedDelta = student.balanceAfter - student.balanceBefore;
    const expectedTransaction = input.mode === 'set' || student.delta !== 0
      ? transactionId(input.operationId, student.studentId)
      : null;
    if (student.studentId !== input.studentIds[index]
      || !student.studentName.trim()
      || !Number.isSafeInteger(expectedAfter) || expectedAfter !== student.balanceAfter
      || !Number.isSafeInteger(computedDelta) || computedDelta !== student.delta
      || student.transactionId !== expectedTransaction) {
      throw new AdminAdjustmentError('INTEGRITY_FAILURE');
    }
  }
}

function validateLedgers(
  rows: LedgerRow[],
  stored: AdminAdjustmentSuccess,
  payloadHash: string,
): void {
  const expected = stored.students.filter((student) => student.transactionId !== null);
  if (rows.length !== expected.length) throw new AdminAdjustmentError('INTEGRITY_FAILURE');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const student = expected[index];
    if (row.transaction_id !== student.transactionId
      || canonicalTimestamp(row.occurred_at) !== stored.adjustedAt
      || row.student_id !== student.studentId || row.student_name_snapshot !== student.studentName
      || row.kind !== 'ADMIN_ADJUSTMENT'
      || safeInteger(row.legacy_total_amount) !== -student.delta
      || safeInteger(row.balance_delta) !== student.delta
      || safeInteger(row.balance_before) !== student.balanceBefore
      || safeInteger(row.balance_after) !== student.balanceAfter
      || row.operator_snapshot !== 'admin' || row.legacy_status_snapshot !== 'ADMIN_ADJUSTMENT'
      || row.operation_id !== createAdminAdjustmentLedgerOperationId(stored.operationId, student.studentId)
      || row.operation_hash !== payloadHash
      || row.schema_version !== 1
      || safeInteger(row.item_count) !== 0
      || safeInteger(row.inventory_count) !== 0
      || safeInteger(row.completion_count) !== 0) {
      throw new AdminAdjustmentError('INTEGRITY_FAILURE');
    }
  }
}

function validateAdjustmentRows(
  rows: AdjustmentRow[],
  stored: AdminAdjustmentSuccess,
): void {
  const expected = stored.students.filter((student) => student.transactionId !== null);
  if (rows.length !== expected.length) throw new AdminAdjustmentError('INTEGRITY_FAILURE');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const student = expected[index];
    if (row.adjustment_id !== adjustmentId(stored.operationId, student.studentId)
      || row.transaction_id !== student.transactionId
      || row.mode !== stored.mode
      || safeInteger(row.requested_amount) !== stored.amount
      || row.operator_snapshot !== 'admin'
      || row.legacy_adjustment_id !== null) {
      throw new AdminAdjustmentError('INTEGRITY_FAILURE');
    }
  }
}


function adjustmentId(operationId: string, studentId: string): string {
  return `adjustment:${operationId}:${studentId}`;
}

function transactionId(operationId: string, studentId: string): string {
  return `admin-adjustment:${operationId}:${studentId}`;
}

function safeInteger(value: string | number | bigint): number {
  let parsed: bigint;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw new AdminAdjustmentError('UNSAFE_BALANCE');
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AdminAdjustmentError('UNSAFE_BALANCE');
  }
  return Number(parsed);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new AdminAdjustmentError('UNSAFE_BALANCE');
  return result;
}

function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AdminAdjustmentError('INTEGRITY_FAILURE');
  return date.toISOString();
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function messageFor(code: AdminAdjustmentErrorCode): string {
  switch (code) {
    case 'OPERATION_CONFLICT': return 'This operation is bound to different adjustment data.';
    case 'OPERATION_PENDING': return 'This adjustment is still pending.';
    case 'OPERATION_FAILED': return 'This adjustment previously failed.';
    case 'STUDENT_INVALID': return 'One or more selected students cannot be adjusted.';
    case 'UNSAFE_BALANCE': return 'An account balance is outside the supported range.';
    case 'INTEGRITY_FAILURE': return 'Stored adjustment integrity validation failed.';
  }
}
