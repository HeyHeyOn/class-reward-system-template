import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { StudentStatus } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

export type StudentAdminAction = 'CREATE' | 'UPDATE' | 'DEACTIVATE';
export const MAX_STUDENT_ADMIN_BATCH_SIZE = 100;

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

export type UpdateStudentAdminInput = Readonly<{
  operationId: string;
  studentId: string;
  expectedStudentVersion: number;
  expectedAccountVersion: number;
  name: string;
  balance: number;
  status: StudentStatus;
}>;

type CanonicalUpdateStudentAdminInput = UpdateStudentAdminInput;

export type UpdateStudentAdminBatchInput = Readonly<{
  operationId: string;
  students: ReadonlyArray<Readonly<Omit<UpdateStudentAdminInput, 'operationId'>>>;
}>;

type CanonicalUpdateStudentAdminBatchInput = Readonly<{
  operationId: string;
  students: ReadonlyArray<CanonicalUpdateStudentAdminInput>;
}>;

export type DeactivateStudentAdminInput = Readonly<{
  operationId: string;
  studentId: string;
  expectedStudentVersion: number;
}>;

type CanonicalDeactivateStudentAdminInput = DeactivateStudentAdminInput;

export type DeactivateStudentAdminBatchInput = Readonly<{
  operationId: string;
  students: ReadonlyArray<Readonly<Omit<DeactivateStudentAdminInput, 'operationId'>>>;
}>;

type CanonicalDeactivateStudentAdminBatchInput = Readonly<{
  operationId: string;
  students: ReadonlyArray<CanonicalDeactivateStudentAdminInput>;
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
    expectedStudentVersion?: number;
    expectedAccountVersion?: number;
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
  const students = payload.students.map((student) => {
    const common = {
      studentId: canonicalText(student.studentId, 'student ID'),
      name: canonicalText(student.name, 'student name'),
      balance: safeInteger(student.balance, 'student balance'),
      status: studentStatus(student.status),
    };
    return payload.action === 'UPDATE'
      ? {
          ...common,
          expectedStudentVersion: positiveSafeInteger(student.expectedStudentVersion, 'student version'),
          expectedAccountVersion: positiveSafeInteger(student.expectedAccountVersion, 'account version'),
        }
      : common;
  }).sort((left, right) => left.studentId < right.studentId ? -1 : left.studentId > right.studentId ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({
    kind: 'STUDENT_ADMIN',
    action: payload.action,
    students,
    schemaVersion: 1,
  }), 'utf8').digest('hex');
}

function createStudentDeactivatePayloadHash(
  input: CanonicalDeactivateStudentAdminInput | CanonicalDeactivateStudentAdminBatchInput,
): string {
  const students = ('students' in input ? input.students : [input])
    .map((student) => ({
      studentId: student.studentId,
      expectedStudentVersion: student.expectedStudentVersion,
    }))
    .sort((left, right) => left.studentId < right.studentId ? -1 : left.studentId > right.studentId ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({
    kind: 'STUDENT_ADMIN',
    action: 'DEACTIVATE',
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
          return resolveExisting(tx, dependencies.tenantId, existing, payloadHash, input, 'CREATE');
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
          return resolveExisting(tx, dependencies.tenantId, winner, payloadHash, input, 'CREATE');
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

    async update(rawInput: UpdateStudentAdminInput): Promise<StudentAdminSuccess> {
      const input = canonicalizeUpdate(rawInput);
      const payloadHash = createStudentAdminPayloadHash({ action: 'UPDATE', students: [input] });
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid student administration timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExisting(tx, dependencies.tenantId, existing, payloadHash, input, 'UPDATE');
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
          return resolveExisting(tx, dependencies.tenantId, winner, payloadHash, input, 'UPDATE');
        }

        const locked = await tx.execute(sql`
          SELECT s.version AS student_version, a.version AS account_version, a.balance,
                 s.status
          FROM students s
          JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${dependencies.tenantId} AND s.student_id=${input.studentId}
            AND s.deleted_at IS NULL
          FOR UPDATE OF s, a
        `);
        if (locked.rows.length !== 1) throw new Error('Student administration student integrity check failed.');
        const row = locked.rows[0] as {
          student_version: string | number | bigint;
          account_version: string | number | bigint;
          balance: string | number | bigint;
          status: StudentStatus;
        };
        const studentVersionBefore = dbSafeInteger(row.student_version);
        const accountVersionBefore = dbSafeInteger(row.account_version);
        const balanceBefore = dbSafeInteger(row.balance);
        if (studentVersionBefore !== input.expectedStudentVersion
          || accountVersionBefore !== input.expectedAccountVersion) {
          throw new Error('Student administration stale version.');
        }
        const studentVersionAfter = positiveSafeInteger(studentVersionBefore + 1, 'student version');
        const accountVersionAfter = positiveSafeInteger(accountVersionBefore + 1, 'account version');
        const delta = safeInteger(input.balance - balanceBefore, 'student balance delta');

        const studentUpdate = await tx.execute(sql`
          UPDATE students
          SET name=${input.name}, status=${input.status}, version=${studentVersionAfter}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${input.studentId}
            AND deleted_at IS NULL AND version=${input.expectedStudentVersion}
          RETURNING student_id
        `);
        const accountUpdate = await tx.execute(sql`
          UPDATE accounts
          SET balance=${input.balance}, version=${accountVersionAfter}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${input.studentId}
            AND version=${input.expectedAccountVersion}
          RETURNING student_id
        `);
        if (studentUpdate.rows.length !== 1 || accountUpdate.rows.length !== 1) {
          throw new Error('Student administration stale version.');
        }

        const transactionId = delta === 0
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
               'ADMIN_ADJUSTMENT', ${-delta}, ${delta}, ${balanceBefore}, ${input.balance},
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
          action: 'UPDATE',
          completedAt: now.toISOString(),
          students: [{
            studentId: input.studentId,
            name: input.name,
            balance: input.balance,
            status: input.status,
            studentVersionBefore,
            studentVersionAfter,
            accountVersionBefore,
            accountVersionAfter,
            balanceBefore,
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

    async updateBatch(rawInput: UpdateStudentAdminBatchInput): Promise<StudentAdminSuccess> {
      const input = canonicalizeUpdateBatch(rawInput);
      const payloadHash = createStudentAdminPayloadHash({ action: 'UPDATE', students: input.students });
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid student administration timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExistingUpdateBatch(tx, dependencies.tenantId, existing, payloadHash, input);
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
          return resolveExistingUpdateBatch(tx, dependencies.tenantId, winner, payloadHash, input);
        }

        const studentIds = input.students.map((student) => student.studentId);
        const locked = await tx.execute(sql`
          SELECT s.student_id, s.version AS student_version,
                 a.version AS account_version, a.balance
          FROM students s
          JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${dependencies.tenantId}
            AND s.student_id IN (${sql.join(studentIds.map((studentId) => sql`${studentId}`), sql`, `)})
            AND s.deleted_at IS NULL
          ORDER BY s.student_id
          FOR UPDATE OF s, a
        `);
        if (locked.rows.length !== input.students.length) {
          throw new Error('Student administration batch integrity check failed.');
        }
        const lockedRows = new Map((locked.rows as Array<{
          student_id: string;
          student_version: string | number | bigint;
          account_version: string | number | bigint;
          balance: string | number | bigint;
        }>).map((row) => [row.student_id, row] as const));
        const results: StudentAdminStudentResult[] = [];

        for (const student of input.students) {
          const row = lockedRows.get(student.studentId);
          if (!row) throw new Error('Student administration batch integrity check failed.');
          const studentVersionBefore = dbSafeInteger(row.student_version);
          const accountVersionBefore = dbSafeInteger(row.account_version);
          const balanceBefore = dbSafeInteger(row.balance);
          if (studentVersionBefore !== student.expectedStudentVersion
            || accountVersionBefore !== student.expectedAccountVersion) {
            throw new Error('Student administration stale version.');
          }
          const studentVersionAfter = positiveSafeInteger(studentVersionBefore + 1, 'student version');
          const accountVersionAfter = positiveSafeInteger(accountVersionBefore + 1, 'account version');
          const delta = safeInteger(student.balance - balanceBefore, 'student balance delta');
          const studentUpdate = await tx.execute(sql`
            UPDATE students
            SET name=${student.name}, status=${student.status}, version=${studentVersionAfter}, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND student_id=${student.studentId}
              AND deleted_at IS NULL AND version=${student.expectedStudentVersion}
            RETURNING student_id
          `);
          const accountUpdate = await tx.execute(sql`
            UPDATE accounts
            SET balance=${student.balance}, version=${accountVersionAfter}, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND student_id=${student.studentId}
              AND version=${student.expectedAccountVersion}
            RETURNING student_id
          `);
          if (studentUpdate.rows.length !== 1 || accountUpdate.rows.length !== 1) {
            throw new Error('Student administration stale version.');
          }
          const transactionId = delta === 0
            ? null
            : createStudentAdminTransactionId(input.operationId, student.studentId);
          if (transactionId) {
            await tx.execute(sql`
              INSERT INTO transactions
                (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
                 legacy_total_amount, balance_delta, balance_before, balance_after,
                 operator_snapshot, legacy_status_snapshot, operation_id, operation_hash,
                 schema_version)
              VALUES
                (${dependencies.tenantId}, ${transactionId}, ${now}, ${student.studentId}, ${student.name},
                 'ADMIN_ADJUSTMENT', ${-delta}, ${delta}, ${balanceBefore}, ${student.balance},
                 'admin', 'ADMIN_ADJUSTMENT',
                 ${createStudentAdminLedgerOperationId(input.operationId, student.studentId)},
                 ${payloadHash}, 1)
            `);
            await tx.execute(sql`
              INSERT INTO adjustments
                (tenant_id, adjustment_id, transaction_id, mode, requested_amount,
                 operator_snapshot, legacy_adjustment_id)
              VALUES
                (${dependencies.tenantId},
                 ${createStudentAdminAdjustmentId(input.operationId, student.studentId)},
                 ${transactionId}, 'set', ${student.balance}, 'admin', NULL)
            `);
          }
          results.push({
            studentId: student.studentId,
            name: student.name,
            balance: student.balance,
            status: student.status,
            studentVersionBefore,
            studentVersionAfter,
            accountVersionBefore,
            accountVersionAfter,
            balanceBefore,
            balanceAfter: student.balance,
            transactionId,
          });
        }

        const result: StudentAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'UPDATE',
          completedAt: now.toISOString(),
          students: results,
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

    async deactivate(rawInput: DeactivateStudentAdminInput): Promise<StudentAdminSuccess> {
      const input = canonicalizeDeactivate(rawInput);
      const payloadHash = createStudentDeactivatePayloadHash(input);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid student administration timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExisting(tx, dependencies.tenantId, existing, payloadHash, input, 'DEACTIVATE');
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
          return resolveExisting(tx, dependencies.tenantId, winner, payloadHash, input, 'DEACTIVATE');
        }

        const locked = await tx.execute(sql`
          SELECT s.name, s.version AS student_version,
                 a.version AS account_version, a.balance
          FROM students s
          JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${dependencies.tenantId} AND s.student_id=${input.studentId}
            AND s.deleted_at IS NULL
          FOR UPDATE OF s, a
        `);
        if (locked.rows.length !== 1) throw new Error('Student administration student integrity check failed.');
        const row = locked.rows[0] as {
          name: string;
          student_version: string | number | bigint;
          account_version: string | number | bigint;
          balance: string | number | bigint;
        };
        const studentVersionBefore = dbSafeInteger(row.student_version);
        const accountVersion = dbSafeInteger(row.account_version);
        const balance = dbSafeInteger(row.balance);
        if (studentVersionBefore !== input.expectedStudentVersion) {
          throw new Error('Student administration stale version.');
        }
        const studentVersionAfter = positiveSafeInteger(studentVersionBefore + 1, 'student version');
        const updated = await tx.execute(sql`
          UPDATE students
          SET status='INACTIVE', deleted_at=${now}, version=${studentVersionAfter}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${input.studentId}
            AND deleted_at IS NULL AND version=${input.expectedStudentVersion}
          RETURNING student_id
        `);
        if (updated.rows.length !== 1) throw new Error('Student administration stale version.');

        const result: StudentAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'DEACTIVATE',
          completedAt: now.toISOString(),
          students: [{
            studentId: input.studentId,
            name: row.name,
            balance,
            status: 'INACTIVE',
            studentVersionBefore,
            studentVersionAfter,
            accountVersionBefore: accountVersion,
            accountVersionAfter: accountVersion,
            balanceBefore: balance,
            balanceAfter: balance,
            transactionId: null,
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

    async deactivateBatch(rawInput: DeactivateStudentAdminBatchInput): Promise<StudentAdminSuccess> {
      const input = canonicalizeDeactivateBatch(rawInput);
      const payloadHash = createStudentDeactivatePayloadHash(input);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid student administration timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExistingDeactivateBatch(tx, dependencies.tenantId, existing, payloadHash, input);
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
          return resolveExistingDeactivateBatch(tx, dependencies.tenantId, winner, payloadHash, input);
        }

        const studentIds = input.students.map((student) => student.studentId);
        const locked = await tx.execute(sql`
          SELECT s.student_id, s.name, s.version AS student_version,
                 a.version AS account_version, a.balance
          FROM students s
          JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${dependencies.tenantId}
            AND s.student_id IN (${sql.join(studentIds.map((studentId) => sql`${studentId}`), sql`, `)})
            AND s.deleted_at IS NULL
          ORDER BY s.student_id
          FOR UPDATE OF s, a
        `);
        if (locked.rows.length !== input.students.length) {
          throw new Error('Student administration batch integrity check failed.');
        }
        const lockedRows = new Map((locked.rows as Array<{
          student_id: string;
          name: string;
          student_version: string | number | bigint;
          account_version: string | number | bigint;
          balance: string | number | bigint;
        }>).map((row) => [row.student_id, row] as const));
        const prepared = input.students.map((student) => {
          const row = lockedRows.get(student.studentId);
          if (!row) throw new Error('Student administration batch integrity check failed.');
          const studentVersionBefore = dbSafeInteger(row.student_version);
          if (studentVersionBefore !== student.expectedStudentVersion) {
            throw new Error('Student administration stale version.');
          }
          return {
            student,
            row,
            studentVersionBefore,
            studentVersionAfter: positiveSafeInteger(studentVersionBefore + 1, 'student version'),
            accountVersion: dbSafeInteger(row.account_version),
            balance: dbSafeInteger(row.balance),
          };
        });
        const results: StudentAdminStudentResult[] = [];
        for (const item of prepared) {
          const updated = await tx.execute(sql`
            UPDATE students
            SET status='INACTIVE', deleted_at=${now}, version=${item.studentVersionAfter}, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND student_id=${item.student.studentId}
              AND deleted_at IS NULL AND version=${item.student.expectedStudentVersion}
            RETURNING student_id
          `);
          if (updated.rows.length !== 1) throw new Error('Student administration stale version.');
          results.push({
            studentId: item.student.studentId,
            name: item.row.name,
            balance: item.balance,
            status: 'INACTIVE',
            studentVersionBefore: item.studentVersionBefore,
            studentVersionAfter: item.studentVersionAfter,
            accountVersionBefore: item.accountVersion,
            accountVersionAfter: item.accountVersion,
            balanceBefore: item.balance,
            balanceAfter: item.balance,
            transactionId: null,
          });
        }
        const result: StudentAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'DEACTIVATE',
          completedAt: now.toISOString(),
          students: results,
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
  input: CanonicalCreateStudentAdminInput | CanonicalUpdateStudentAdminInput
    | CanonicalDeactivateStudentAdminInput,
  action: StudentAdminAction,
): Promise<StudentAdminSuccess> {
  if (operation.operation_kind !== 'STUDENT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Student administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Student administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = action === 'CREATE'
    ? parseStoredCreateResult(
        operation.result_snapshot,
        input as CanonicalCreateStudentAdminInput,
        finishedAt,
      )
    : action === 'UPDATE'
      ? parseStoredUpdateResult(
          operation.result_snapshot,
          input as CanonicalUpdateStudentAdminInput,
          finishedAt,
        )
      : parseStoredDeactivateResult(
          operation.result_snapshot,
          input as CanonicalDeactivateStudentAdminInput,
          finishedAt,
        );
  assertOperationEvidence(operation, result);
  await assertCreateLedgers(tx, tenantId, result, payloadHash);
  if (action === 'DEACTIVATE') {
    await assertDeactivateState(tx, tenantId, result);
  }
  await assertOperationAudit(tx, tenantId, studentAdminAuditInput(result, finishedAt));
  return result;
}

async function resolveExistingUpdateBatch(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: CanonicalUpdateStudentAdminBatchInput,
): Promise<StudentAdminSuccess> {
  if (operation.operation_kind !== 'STUDENT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Student administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Student administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = parseStoredUpdateBatchResult(operation.result_snapshot, input, finishedAt);
  assertOperationEvidence(operation, result);
  await assertCreateLedgers(tx, tenantId, result, payloadHash);
  await assertOperationAudit(tx, tenantId, studentAdminAuditInput(result, finishedAt));
  return result;
}

async function resolveExistingDeactivateBatch(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: CanonicalDeactivateStudentAdminBatchInput,
): Promise<StudentAdminSuccess> {
  if (operation.operation_kind !== 'STUDENT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Student administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Student administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = parseStoredDeactivateBatchResult(operation.result_snapshot, input, finishedAt);
  assertOperationEvidence(operation, result);
  await assertCreateLedgers(tx, tenantId, result, payloadHash);
  await assertDeactivateState(tx, tenantId, result);
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

function parseStoredDeactivateResult(
  value: unknown,
  input: CanonicalDeactivateStudentAdminInput,
  finishedAt: Date,
): StudentAdminSuccess {
  const result = parseStoredDeactivateEnvelope(value, input.operationId, finishedAt, 1);
  assertStoredDeactivateStudent(result.students[0], input);
  return result;
}

function parseStoredDeactivateBatchResult(
  value: unknown,
  input: CanonicalDeactivateStudentAdminBatchInput,
  finishedAt: Date,
): StudentAdminSuccess {
  const result = parseStoredDeactivateEnvelope(
    value,
    input.operationId,
    finishedAt,
    input.students.length,
  );
  input.students.forEach((student, index) => assertStoredDeactivateStudent(result.students[index], student));
  return result;
}

function parseStoredDeactivateEnvelope(
  value: unknown,
  operationId: string,
  finishedAt: Date,
  studentCount: number,
): StudentAdminSuccess {
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'students'])
    || value.ok !== true || value.action !== 'DEACTIVATE' || value.operationId !== operationId
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.students)
    || value.students.length !== studentCount) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  return value as StudentAdminSuccess;
}

function assertStoredDeactivateStudent(
  student: unknown,
  input: CanonicalDeactivateStudentAdminInput,
): void {
  const keys = [
    'accountVersionAfter', 'accountVersionBefore', 'balance', 'balanceAfter', 'balanceBefore',
    'name', 'status', 'studentId', 'studentVersionAfter', 'studentVersionBefore', 'transactionId',
  ];
  if (!isExactRecord(student, keys)) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  const balance = safeInteger(student.balance, 'stored balance');
  const accountVersion = storedPositiveSafeInteger(student.accountVersionBefore);
  const studentVersionBefore = storedPositiveSafeInteger(student.studentVersionBefore);
  const studentVersionAfter = storedPositiveSafeInteger(student.studentVersionAfter);
  if (student.studentId !== input.studentId || typeof student.name !== 'string'
    || student.name.trim().length === 0
    || student.status !== 'INACTIVE'
    || studentVersionBefore !== input.expectedStudentVersion
    || studentVersionAfter !== storedVersionSuccessor(studentVersionBefore)
    || student.accountVersionAfter !== accountVersion
    || student.balanceBefore !== balance || student.balanceAfter !== balance
    || student.transactionId !== null) {
    throw new Error('Student administration stored result integrity check failed.');
  }
}

async function assertDeactivateState(
  tx: TenantTransaction,
  tenantId: string,
  result: StudentAdminSuccess,
): Promise<void> {
  const studentIds = result.students.map((student) => student.studentId);
  const rows = await tx.execute(sql`
    SELECT s.student_id, s.name, s.status, s.version AS student_version, s.deleted_at,
           a.balance, a.version AS account_version
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId}
      AND s.student_id IN (${sql.join(studentIds.map((studentId) => sql`${studentId}`), sql`, `)})
    ORDER BY s.student_id
    FOR UPDATE OF s, a
  `);
  const typedRows = rows.rows as StudentAdminDeactivateStateRow[];
  assertStudentAdminDeactivateStateRows(typedRows, result);
}

export type StudentAdminDeactivateStateRow = Readonly<{
  student_id: string;
  name: string;
  status: string;
  student_version: string | number | bigint;
  deleted_at: Date | string | null;
  balance: string | number | bigint;
  account_version: string | number | bigint;
}>;

export function assertStudentAdminDeactivateStateRows(
  rows: ReadonlyArray<StudentAdminDeactivateStateRow>,
  result: StudentAdminSuccess,
): void {
  if (rows.length !== result.students.length) {
    throw new Error('Student administration tombstone integrity check failed.');
  }
  const rowsByStudentId = new Map(rows.map((row) => [row.student_id, row] as const));
  if (rowsByStudentId.size !== rows.length) {
    throw new Error('Student administration tombstone integrity check failed.');
  }
  result.students.forEach((expected) => {
    const row = rowsByStudentId.get(expected.studentId);
    if (!row || row.name !== expected.name || row.status !== 'INACTIVE'
      || dbSafeInteger(row.student_version) !== expected.studentVersionAfter
      || operationTimestamp(row.deleted_at).toISOString() !== result.completedAt
      || dbSafeInteger(row.balance) !== expected.balance
      || dbSafeInteger(row.account_version) !== expected.accountVersionAfter) {
      throw new Error('Student administration tombstone integrity check failed.');
    }
  });
}

function parseStoredUpdateResult(
  value: unknown,
  input: CanonicalUpdateStudentAdminInput,
  finishedAt: Date,
): StudentAdminSuccess {
  const result = parseStoredUpdateEnvelope(value, input.operationId, finishedAt, 1);
  assertStoredUpdateStudent(result.students[0], input);
  return result;
}

function parseStoredUpdateBatchResult(
  value: unknown,
  input: CanonicalUpdateStudentAdminBatchInput,
  finishedAt: Date,
): StudentAdminSuccess {
  const result = parseStoredUpdateEnvelope(
    value,
    input.operationId,
    finishedAt,
    input.students.length,
  );
  input.students.forEach((student, index) => assertStoredUpdateStudent(result.students[index], student));
  return result;
}

function parseStoredUpdateEnvelope(
  value: unknown,
  operationId: string,
  finishedAt: Date,
  studentCount: number,
): StudentAdminSuccess {
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'students'])
    || value.ok !== true || value.action !== 'UPDATE' || value.operationId !== operationId
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.students)
    || value.students.length !== studentCount) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  return value as StudentAdminSuccess;
}

function assertStoredUpdateStudent(
  student: unknown,
  input: CanonicalUpdateStudentAdminInput,
): void {
  const keys = [
    'accountVersionAfter', 'accountVersionBefore', 'balance', 'balanceAfter', 'balanceBefore',
    'name', 'status', 'studentId', 'studentVersionAfter', 'studentVersionBefore', 'transactionId',
  ];
  if (!isExactRecord(student, keys)) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  const balanceBefore = safeInteger(student.balanceBefore, 'stored balance before');
  const studentVersionBefore = storedPositiveSafeInteger(student.studentVersionBefore);
  const studentVersionAfter = storedPositiveSafeInteger(student.studentVersionAfter);
  const accountVersionBefore = storedPositiveSafeInteger(student.accountVersionBefore);
  const accountVersionAfter = storedPositiveSafeInteger(student.accountVersionAfter);
  const expectedTransactionId = balanceBefore === input.balance
    ? null
    : createStudentAdminTransactionId(input.operationId, input.studentId);
  if (student.studentId !== input.studentId || student.name !== input.name
    || student.balance !== input.balance || student.status !== input.status
    || studentVersionBefore !== input.expectedStudentVersion
    || studentVersionAfter !== storedVersionSuccessor(studentVersionBefore)
    || accountVersionBefore !== input.expectedAccountVersion
    || accountVersionAfter !== storedVersionSuccessor(accountVersionBefore)
    || student.balanceBefore !== balanceBefore || student.balanceAfter !== input.balance
    || student.transactionId !== expectedTransactionId) {
    throw new Error('Student administration stored result integrity check failed.');
  }
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

function canonicalizeUpdate(input: UpdateStudentAdminInput): CanonicalUpdateStudentAdminInput {
  if (!input || typeof input !== 'object') throw new Error('A valid student update input is required.');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    studentId: canonicalText(input.studentId, 'student ID'),
    expectedStudentVersion: positiveSafeInteger(input.expectedStudentVersion, 'student version'),
    expectedAccountVersion: positiveSafeInteger(input.expectedAccountVersion, 'account version'),
    name: canonicalText(input.name, 'student name'),
    balance: safeInteger(input.balance, 'student balance'),
    status: studentStatus(input.status),
  };
}

function canonicalizeUpdateBatch(
  input: UpdateStudentAdminBatchInput,
): CanonicalUpdateStudentAdminBatchInput {
  if (!input || typeof input !== 'object' || !Array.isArray(input.students) || input.students.length === 0) {
    throw new Error('A nonempty student update batch is required.');
  }
  if (input.students.length > MAX_STUDENT_ADMIN_BATCH_SIZE) {
    throw new Error(`A student update batch may contain at most ${MAX_STUDENT_ADMIN_BATCH_SIZE} students.`);
  }
  const operationId = canonicalText(input.operationId, 'operation ID');
  const students = input.students.map((student) => canonicalizeUpdate({ ...student, operationId }))
    .sort((left, right) => left.studentId < right.studentId ? -1 : left.studentId > right.studentId ? 1 : 0);
  if (students.some((student, index) => index > 0 && students[index - 1].studentId === student.studentId)) {
    throw new Error('Duplicate student IDs are not allowed in an update batch.');
  }
  return { operationId, students };
}

function canonicalizeDeactivate(
  input: DeactivateStudentAdminInput,
): CanonicalDeactivateStudentAdminInput {
  if (!input || typeof input !== 'object') throw new Error('A valid student deactivate input is required.');
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    studentId: canonicalText(input.studentId, 'student ID'),
    expectedStudentVersion: positiveSafeInteger(input.expectedStudentVersion, 'student version'),
  };
}

function canonicalizeDeactivateBatch(
  input: DeactivateStudentAdminBatchInput,
): CanonicalDeactivateStudentAdminBatchInput {
  if (!input || typeof input !== 'object' || !Array.isArray(input.students) || input.students.length === 0) {
    throw new Error('A nonempty student deactivate batch is required.');
  }
  if (input.students.length > MAX_STUDENT_ADMIN_BATCH_SIZE) {
    throw new Error(`A student deactivate batch may contain at most ${MAX_STUDENT_ADMIN_BATCH_SIZE} students.`);
  }
  const operationId = canonicalText(input.operationId, 'operation ID');
  const students = input.students.map((student) => canonicalizeDeactivate({ ...student, operationId }))
    .sort((left, right) => left.studentId < right.studentId ? -1 : left.studentId > right.studentId ? 1 : 0);
  if (students.some((student, index) => index > 0 && students[index - 1].studentId === student.studentId)) {
    throw new Error('Duplicate student IDs are not allowed in a deactivate batch.');
  }
  return { operationId, students };
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

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = safeInteger(value, field);
  if (parsed < 1) throw new Error(`A positive ${field} is required.`);
  return parsed;
}

function storedPositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  return value as number;
}

function storedVersionSuccessor(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Student administration stored result integrity check failed.');
  }
  return value + 1;
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
