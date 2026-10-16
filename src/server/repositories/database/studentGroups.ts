import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';

// 모둠 (migration 0060): the teacher groups the class's students. A student is in at most one group, and a
// rested or deleted student is in none (the database clears it). Deleting a group leaves its students in none.

type RunTenantTransaction = <TResult>(tenantId: string, callback: (tx: TenantTransaction) => Promise<TResult>) => Promise<TResult>;

export const MAX_STUDENT_GROUPS = 50;
export const MAX_GROUP_NAME_LENGTH = 30;
const MAX_ASSIGN_STUDENTS = 1000;
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type StudentGroupErrorCode = 'INVALID_INPUT' | 'NAME_TAKEN' | 'TOO_MANY' | 'GROUP_NOT_FOUND' | 'STUDENT_NOT_FOUND' | 'UNSUPPORTED';

export class StudentGroupError extends Error {
  constructor(readonly code: StudentGroupErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'StudentGroupError';
  }
}

/** A group and the students in use who are in it. */
export type StudentGroup = Readonly<{ id: string; name: string; students: readonly string[] }>;

export function normalizeGroupName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!name || Array.from(name).length > MAX_GROUP_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new StudentGroupError('INVALID_INPUT', `모둠 이름은 1~${MAX_GROUP_NAME_LENGTH}자로 써 주세요.`, 400);
  }
  return name;
}

function parseGroupId(value: unknown): string {
  if (typeof value !== 'string' || !GROUP_ID.test(value)) {
    throw new StudentGroupError('GROUP_NOT_FOUND', '모둠을 찾지 못했어요. 화면을 새로고침해 주세요.', 404);
  }
  return value;
}

function parseStudentIds(value: unknown): string[] {
  const invalid = () => new StudentGroupError('INVALID_INPUT', '모둠에 넣을 학생을 다시 골라 주세요.', 400);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ASSIGN_STUDENTS) throw invalid();
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id || id !== id.trim() || Buffer.byteLength(id, 'utf8') > 128) throw invalid();
    ids.add(id);
  }
  if (ids.size !== value.length) throw invalid();
  return [...ids];
}

function nameTaken(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
const takenError = () => new StudentGroupError('NAME_TAKEN', '같은 이름의 모둠이 있어요.', 409);
const missingGroup = () => new StudentGroupError('GROUP_NOT_FOUND', '모둠을 찾지 못했어요. 화면을 새로고침해 주세요.', 404);

export async function listStudentGroups(tx: TenantTransaction, tenantId: string): Promise<StudentGroup[]> {
  const result = await tx.execute(sql`
    SELECT g.group_id::text AS id, g.name,
      coalesce(array_agg(s.student_id ORDER BY s.student_id) FILTER (WHERE s.student_id IS NOT NULL), '{}') AS students
    FROM student_groups g
    LEFT JOIN students s ON s.tenant_id=g.tenant_id AND s.group_id=g.group_id AND s.status='ACTIVE' AND s.deleted_at IS NULL
    WHERE g.tenant_id=${tenantId}
    GROUP BY g.group_id, g.name, g.created_at
    ORDER BY g.created_at, g.name`);
  return (result.rows as { id: string; name: string; students: string[] }[]).map((row) => ({ id: row.id, name: row.name, students: row.students }));
}

export function createStudentGroups(dependencies: Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot: RunTenantTransaction;
}>) {
  const { tenantId, runTenantTransaction, runTenantSnapshot } = dependencies;
  return {
    async list(): Promise<StudentGroup[]> {
      return runTenantSnapshot(tenantId, (tx) => listStudentGroups(tx, tenantId));
    },

    async create(rawName: unknown): Promise<StudentGroup> {
      const name = normalizeGroupName(rawName);
      try {
        return await runTenantTransaction(tenantId, async (tx) => {
          const count = await tx.execute(sql`SELECT count(*)::int AS n FROM student_groups WHERE tenant_id=${tenantId}`);
          if ((count.rows[0] as { n: number }).n >= MAX_STUDENT_GROUPS) {
            throw new StudentGroupError('TOO_MANY', `모둠은 ${MAX_STUDENT_GROUPS}개까지 만들 수 있어요.`, 409);
          }
          const result = await tx.execute(sql`
            INSERT INTO student_groups (tenant_id, name) VALUES (${tenantId}, ${name})
            ON CONFLICT (tenant_id, name) DO NOTHING
            RETURNING group_id::text AS id`);
          const row = result.rows[0] as { id: string } | undefined;
          if (!row) throw takenError();
          return { id: row.id, name, students: [] };
        });
      } catch (error) {
        if (nameTaken(error)) throw takenError();
        throw error;
      }
    },

    async rename(rawGroupId: unknown, rawName: unknown): Promise<void> {
      const groupId = parseGroupId(rawGroupId);
      const name = normalizeGroupName(rawName);
      try {
        await runTenantTransaction(tenantId, async (tx) => {
          const taken = await tx.execute(sql`
            SELECT 1 FROM student_groups WHERE tenant_id=${tenantId} AND name=${name} AND group_id<>${groupId}::uuid`);
          if (taken.rows.length > 0) throw takenError();
          const result = await tx.execute(sql`
            UPDATE student_groups SET name=${name}, updated_at=clock_timestamp()
            WHERE tenant_id=${tenantId} AND group_id=${groupId}::uuid RETURNING group_id`);
          if (result.rows.length === 0) throw missingGroup();
        });
      } catch (error) {
        if (nameTaken(error)) throw takenError();
        throw error;
      }
    },

    /** The group goes; its students stay, in no group. */
    async remove(rawGroupId: unknown): Promise<void> {
      const groupId = parseGroupId(rawGroupId);
      await runTenantTransaction(tenantId, async (tx) => {
        const result = await tx.execute(sql`
          DELETE FROM student_groups WHERE tenant_id=${tenantId} AND group_id=${groupId}::uuid RETURNING group_id`);
        if (result.rows.length === 0) throw missingGroup();
      });
    },

    /** Put these students in use in the group (or in none with null), all or none of them. */
    async assign(rawGroupId: unknown, rawStudentIds: unknown): Promise<{ assigned: number }> {
      const groupId = rawGroupId === null ? null : parseGroupId(rawGroupId);
      const ids = parseStudentIds(rawStudentIds);
      return runTenantTransaction(tenantId, async (tx) => {
        if (groupId) {
          const group = await tx.execute(sql`
            SELECT 1 FROM student_groups WHERE tenant_id=${tenantId} AND group_id=${groupId}::uuid FOR SHARE`);
          if (group.rows.length === 0) throw missingGroup();
        }
        const result = await tx.execute(sql`
          UPDATE students SET group_id=${groupId}::uuid
          WHERE tenant_id=${tenantId} AND student_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND status='ACTIVE' AND deleted_at IS NULL
          RETURNING student_id`);
        if (result.rows.length !== ids.length) {
          throw new StudentGroupError('STUDENT_NOT_FOUND', '모둠에 넣을 수 없는 학생이 있어요. 쉬는 학생은 모둠에 넣을 수 없어요.', 404);
        }
        return { assigned: ids.length };
      });
    },
  };
}

export type StudentGroupsRepository = ReturnType<typeof createStudentGroups>;

/** The groups of one class over the production database. */
export function createTenantStudentGroups(tenantId: string): StudentGroupsRepository {
  return createStudentGroups({ tenantId, runTenantTransaction: withTenantTransaction, runTenantSnapshot: withTenantSnapshot });
}
