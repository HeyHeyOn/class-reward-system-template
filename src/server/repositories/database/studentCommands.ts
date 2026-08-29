import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { StudentStatus } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

export type StudentAdminAction = 'CREATE';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseStudentCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

export type CreateStudentAdminInput = Readonly<{
  operationId: string;
  studentId: string;
  name: string;
  balance: number;
  status: StudentStatus;
}>;

type CanonicalCreateStudentAdminInput = Readonly<{
  operationId: string;
  studentId: string;
  name: string;
  balance: number;
  status: StudentStatus;
}>;

export type StudentAdminStudentResult = Readonly<{
  studentId: string;
  name: string;
  balance: number;
  status: StudentStatus;
  studentVersionBefore: number | null;
  studentVersionAfter: number;
  accountVersionBefore: number | null;
  accountVersionAfter: number;
  balanceBefore: number | null;
  balanceAfter: number;
  transactionId: string | null;
}>;

export type StudentAdminSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: StudentAdminAction;
  completedAt: string;
  students: ReadonlyArray<StudentAdminStudentResult>;
}>;

type StudentAdminPayload = Readonly<{
  action: StudentAdminAction;
  students: ReadonlyArray<Readonly<{
    studentId: string;
    name: string;
    balance: number;
    status: StudentStatus;
  }>>;
}>;

type OperationRow = Readonly<{
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  finished_at: Date | string | null;
  attempt_count: string | number | bigint;
  failure_code: string | null;
  started_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}>;

type StudentAdminLedgerRow = Readonly<{
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
  adjustment_id: string | null;
  adjustment_mode: string | null;
  requested_amount: string | number | bigint | null;
  adjustment_operator: string | null;
  legacy_adjustment_id: string | null;
  item_count: string | number | bigint;
  inventory_count: string | number | bigint;
  completion_count: string | number | bigint;
}>;

export function createStudentAdminPayloadHash(payload: StudentAdminPayload): string {
  const students = payload.students.map((student) => ({
    studentId: canonicalText(student.studentId, 'student ID'),
    name: canonicalText(student.name, 'student name'),
    balance: safeInteger(student.balance, 'student balance'),
    status: studentStatus(student.status),
  })).sort((left, right) => left.studentId < right.studentId ? -1 : left.studentId > right.studentId ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({
    kind: 'STUDENT_ADMIN',
    action: payload.action,
    students,
    schemaVersion: 1,
  }), 'utf8').digest('hex');
}

export function createStudentAdminResultHash(result: StudentAdminSuccess): string {
  return createHash('sha256').update(JSON.stringify({
    action: result.action,
    completedAt: result.completedAt,
    ok: result.ok,
    operationId: result.operationId,
    students: result.students.map((student) => ({
      accountVersionAfter: student.accountVersionAfter,
      accountVersionBefore: student.accountVersionBefore,
      balance: student.balance,
      balanceAfter: student.balanceAfter,
      balanceBefore: student.balanceBefore,
      name: student.name,
      status: student.status,
      studentId: student.studentId,
      studentVersionAfter: student.studentVersionAfter,
      studentVersionBefore: student.studentVersionBefore,
      transactionId: student.transactionId,
    })),
  }), 'utf8').digest('hex');
}

export function createStudentAdminLedgerOperationId(parentOperationId: string, studentId: string): string {
  const operationId = canonicalText(parentOperationId, 'parent operation ID');
  const canonicalStudentId = canonicalText(studentId, 'student ID');
  const bytes = createHash('sha256').update(JSON.stringify({
    kind: 'STUDENT_ADMIN_LEDGER',
    parentOperationId: operationId,
    studentId: canonicalStudentId,
  }), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createStudentAdminTransactionId(parentOperationId: string, studentId: string): string {
  return createStudentAdminScopedId(
    'student-admin', 'STUDENT_ADMIN_TRANSACTION', parentOperationId, studentId,
  );
}

export function createStudentAdminAdjustmentId(parentOperationId: string, studentId: string): string {
  return createStudentAdminScopedId(
    'student-admin-adjustment', 'STUDENT_ADMIN_ADJUSTMENT', parentOperationId, studentId,
  );
}

function createStudentAdminScopedId(
  prefix: string,
  kind: string,
  parentOperationId: string,
  studentId: string,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    kind,
    parentOperationId: canonicalText(parentOperationId, 'parent operation ID'),
    studentId: canonicalText(studentId, 'student ID'),
  }), 'utf8').digest('hex');
  return `${prefix}:${digest}`;
}

export function createDatabaseStudentCommands(dependencies: DatabaseStudentCommandDependencies) {
  return {
    async create(rawInput: CreateStudentAdminInput): Promise<StudentAdminSuccess> {
      const input = canonicalizeCreate(rawInput);
      const payloadHash = createStudentAdminPayloadHash({ action: 'CREATE', students: [input] });
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid student administration timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExisting(tx, dependencies.tenantId, existing, payloadHash, input);
        }

        const operation = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'STUDENT_ADMIN', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (operation.rows.length !== 1) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Student administration operation race integrity check failed.');
          return resolveExisting(tx, dependencies.tenantId, winner, payloadHash, input);
        }

        await tx.execute(sql`
          INSERT INTO students
            (tenant_id, student_id, name, status, version, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.studentId}, ${input.name}, ${input.status}, 1, ${now}, ${now})
        `);
        await tx.execute(sql`
          INSERT INTO accounts
            (tenant_id, student_id, balance, version, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.studentId}, ${input.balance}, 1, ${now})
        `);

        const transactionId = input.balance === 0
          ? null
          : createStudentAdminTransactionId(input.operationId, input.studentId);
        if (transactionId) {
          await tx.execute(sql`
            INSERT INTO transactions
              (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
               legacy_total_amount, balance_delta, balance_before, balance_after,
               operator_snapshot, legacy_status_snapshot, operation_id, operation_hash,
               schema_version)
            VALUES
              (${dependencies.tenantId}, ${transactionId}, ${now}, ${input.studentId}, ${input.name},
               'ADMIN_ADJUSTMENT', ${-input.balance}, ${input.balance}, 0, ${input.balance},
               'admin', 'ADMIN_ADJUSTMENT',
               ${createStudentAdminLedgerOperationId(input.operationId, input.studentId)},
               ${payloadHash}, 1)
          `);
          await tx.execute(sql`
            INSERT INTO adjustments
              (tenant_id, adjustment_id, transaction_id, mode, requested_amount,
               operator_snapshot, legacy_adjustment_id)
            VALUES
              (${dependencies.tenantId},
               ${createStudentAdminAdjustmentId(input.operationId, input.studentId)},
               ${transactionId}, 'set', ${input.balance}, 'admin', NULL)
          `);
        }

        const result: StudentAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'CREATE',
          completedAt: now.toISOString(),
          students: [{
            studentId: input.studentId,
            name: input.name,
            balance: input.balance,
            status: input.status,
            studentVersionBefore: null,
            studentVersionAfter: 1,
            accountVersionBefore: null,
            accountVersionAfter: 1,
            balanceBefore: null,
            balanceAfter: input.balance,
            transactionId,
          }],
        };
        await appendOperationAudit(tx, dependencies.tenantId, studentAdminAuditInput(result, now));
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

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
): Promise<OperationRow | undefined> {
  const result = await tx.execute(sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at,
           attempt_count, failure_code, started_at, created_at, updated_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  `);
  return result.rows[0] as OperationRow | undefined;
}

async function resolveExisting(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: CanonicalCreateStudentAdminInput,
): Promise<StudentAdminSuccess> {
  if (operation.operation_kind !== 'STUDENT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Student administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Student administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = parseStoredCreateResult(operation.result_snapshot, input, finishedAt);
  assertOperationEvidence(operation, result);
  await assertCreateLedgers(tx, tenantId, result, payloadHash);
  await assertOperationAudit(tx, tenantId, studentAdminAuditInput(result, finishedAt));
  return result;
}

function assertOperationEvidence(operation: OperationRow, result: StudentAdminSuccess): void {
  const completedAt = result.completedAt;
  if (dbSafeInteger(operation.attempt_count) !== 1 || operation.failure_code !== null
    || operationTimestamp(operation.started_at).toISOString() !== completedAt
    || operationTimestamp(operation.created_at).toISOString() !== completedAt
    || operationTimestamp(operation.updated_at).toISOString() !== completedAt
    || operationTimestamp(operation.finished_at).toISOString() !== completedAt) {
    throw new Error('Student administration operation integrity check failed.');
  }
}

function operationTimestamp(value: Date | string | null): Date {
  const timestamp = value instanceof Date ? value : new Date(value ?? 'invalid');
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Student administration operation integrity check failed.');
  }
  return timestamp;
}

function parseStoredCreateResult(
  value: unknown,
  input: CanonicalCreateStudentAdminInput,
  finishedAt: Date,
): StudentAdminSuccess {
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'students'])
    || value.ok !== true || value.action !== 'CREATE' || value.operationId !== input.operationId
    || value.completedAt !== canonicalTimestamp(finishedAt)
    || !Array.isArray(value.students) || value.students.length !== 1) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  const student = value.students[0];
  if (!isExactRecord(student, [
    'accountVersionAfter', 'accountVersionBefore', 'balance', 'balanceAfter', 'balanceBefore',
    'name', 'status', 'studentId', 'studentVersionAfter', 'studentVersionBefore', 'transactionId',
  ])) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  const expectedTransactionId = input.balance === 0
    ? null
    : createStudentAdminTransactionId(input.operationId, input.studentId);
  if (student.studentId !== input.studentId || student.name !== input.name
    || student.balance !== input.balance || student.status !== input.status
    || student.studentVersionBefore !== null || student.studentVersionAfter !== 1
    || student.accountVersionBefore !== null || student.accountVersionAfter !== 1
    || student.balanceBefore !== null || student.balanceAfter !== input.balance
    || student.transactionId !== expectedTransactionId) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  return value as StudentAdminSuccess;
}

async function assertCreateLedgers(
  tx: TenantTransaction,
  tenantId: string,
  result: StudentAdminSuccess,
  payloadHash: string,
): Promise<void> {
  const expected = result.students.filter((student) => student.transactionId !== null);
  const candidateTransactionIds = result.students.map((student) =>
    createStudentAdminTransactionId(result.operationId, student.studentId));
  const candidateOperationIds = result.students.map((student) =>
    createStudentAdminLedgerOperationId(result.operationId, student.studentId));
  const rows = (await tx.execute(sql`
    SELECT t.transaction_id, t.occurred_at, t.student_id, t.student_name_snapshot,
           t.kind, t.legacy_total_amount, t.balance_delta, t.balance_before,
           t.balance_after, t.operator_snapshot, t.legacy_status_snapshot,
           t.operation_id, t.operation_hash, t.schema_version,
           a.adjustment_id, a.mode AS adjustment_mode, a.requested_amount,
           a.operator_snapshot AS adjustment_operator, a.legacy_adjustment_id,
           (SELECT count(*) FROM transaction_items i
            WHERE i.tenant_id=t.tenant_id AND i.transaction_id=t.transaction_id) AS item_count,
           (SELECT count(*) FROM inventory_ledger i
            WHERE i.tenant_id=t.tenant_id AND i.transaction_id=t.transaction_id) AS inventory_count,
           (SELECT count(*) FROM task_completions c
            WHERE c.tenant_id=t.tenant_id AND c.transaction_id=t.transaction_id) AS completion_count
    FROM transactions t
    LEFT JOIN adjustments a
      ON a.tenant_id=t.tenant_id AND a.transaction_id=t.transaction_id
    WHERE t.tenant_id=${tenantId}
      AND (t.operation_hash=${payloadHash}
        OR t.transaction_id IN (${sql.join(candidateTransactionIds.map((id) => sql`${id}`), sql`, `)})
        OR t.operation_id IN (${sql.join(candidateOperationIds.map((id) => sql`${id}`), sql`, `)}))
    ORDER BY t.transaction_id
  `)).rows as StudentAdminLedgerRow[];
  const sortedExpected = [...expected].sort((left, right) =>
    left.transactionId! < right.transactionId! ? -1 : left.transactionId! > right.transactionId! ? 1 : 0);
  if (rows.length !== sortedExpected.length) throw new Error('Student administration ledger integrity check failed.');
  for (const [index, student] of sortedExpected.entries()) {
    const row = rows[index];
    const before = student.balanceBefore ?? 0;
    const delta = student.balanceAfter - before;
    if (row.transaction_id !== student.transactionId
      || canonicalTimestamp(row.occurred_at) !== result.completedAt
      || row.student_id !== student.studentId || row.student_name_snapshot !== student.name
      || row.kind !== 'ADMIN_ADJUSTMENT'
      || dbSafeInteger(row.legacy_total_amount) !== -delta
      || dbSafeInteger(row.balance_delta) !== delta
      || dbSafeInteger(row.balance_before) !== before
      || dbSafeInteger(row.balance_after) !== student.balanceAfter
      || row.operator_snapshot !== 'admin' || row.legacy_status_snapshot !== 'ADMIN_ADJUSTMENT'
      || row.operation_id !== createStudentAdminLedgerOperationId(result.operationId, student.studentId)
      || row.operation_hash !== payloadHash || row.schema_version !== 1
      || row.adjustment_id !== createStudentAdminAdjustmentId(result.operationId, student.studentId)
      || row.adjustment_mode !== 'set' || dbSafeInteger(row.requested_amount) !== student.balanceAfter
      || row.adjustment_operator !== 'admin' || row.legacy_adjustment_id !== null
      || dbSafeInteger(row.item_count) !== 0 || dbSafeInteger(row.inventory_count) !== 0
      || dbSafeInteger(row.completion_count) !== 0) {
      throw new Error('Student administration ledger integrity check failed.');
    }
  }
}

function studentAdminAuditInput(result: StudentAdminSuccess, occurredAt: Date) {
  return {
    operationId: result.operationId,
    eventType: 'STUDENT_ADMIN_COMPLETED',
    entityType: 'OPERATION',
    entityId: result.operationId,
    redactedDetails: {
      action: result.action,
      changedStudentCount: result.students.length,
      ledgerCount: result.students.filter((student) => student.transactionId !== null).length,
      resultHash: createStudentAdminResultHash(result),
      studentCount: result.students.length,
    },
    occurredAt,
  };
}

function canonicalizeCreate(input: CreateStudentAdminInput): CanonicalCreateStudentAdminInput {
  if (!input || typeof input !== 'object') throw new Error('A valid student create input is required.');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    studentId: canonicalText(input.studentId, 'student ID'),
    name: canonicalText(input.name, 'student name'),
    balance: safeInteger(input.balance, 'student balance'),
    status: studentStatus(input.status),
  };
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`A valid ${field} is required.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`A valid ${field} is required.`);
  return trimmed;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`A safe integer ${field} is required.`);
  return value as number;
}

function dbSafeInteger(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error('Student administration ledger integrity check failed.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Student administration ledger integrity check failed.');
  return parsed;
}

function canonicalTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Student administration ledger integrity check failed.');
  return timestamp.toISOString();
}

function studentStatus(value: unknown): StudentStatus {
  if (value !== 'ACTIVE' && value !== 'INACTIVE') throw new Error('A valid student status is required.');
  return value;
}
