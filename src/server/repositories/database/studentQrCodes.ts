import 'server-only';

import { sql } from 'drizzle-orm';
import { withTenantSnapshot, withTenantTransaction, type TenantTransaction } from '@/server/db/transaction';

type RunTenantTransaction = <TResult>(tenantId: string, callback: (tx: TenantTransaction) => Promise<TResult>) => Promise<TResult>;

export class StudentQrCodeError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'STUDENT_NOT_FOUND' | 'UNSUPPORTED', message: string, readonly status: number) {
    super(message);
    this.name = 'StudentQrCodeError';
  }
}

/** The most students one request may issue new codes for (a whole class fits). */
export const MAX_QR_REISSUE_STUDENTS = 1000;

/** The short QR code of each student (migration 0057) and the teacher's 'issue a new code'. */
export function createStudentQrCodes(dependencies: Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot: RunTenantTransaction;
}>) {
  const { tenantId, runTenantTransaction, runTenantSnapshot } = dependencies;
  return {
    /** The student a code belongs to, or null when no current student has it. */
    async studentIdForCode(code: string): Promise<string | null> {
      return runTenantSnapshot(tenantId, async (tx) => {
        const result = await tx.execute(sql`
          SELECT student_id FROM students
          WHERE tenant_id=${tenantId} AND qr_code=${code} AND deleted_at IS NULL`);
        const row = result.rows[0] as { student_id: string } | undefined;
        return row?.student_id ?? null;
      });
    },

    /** Whether a signed card printed before the short codes still works for the student. */
    async signedQrAccepted(studentId: string): Promise<boolean> {
      return runTenantSnapshot(tenantId, async (tx) => {
        const result = await tx.execute(sql`
          SELECT signed_qr_accepted FROM students WHERE tenant_id=${tenantId} AND student_id=${studentId}`);
        const row = result.rows[0] as { signed_qr_accepted: boolean } | undefined;
        return row ? row.signed_qr_accepted : true;
      });
    },

    /** The code printed on the student's card, or null when there is no such current student. */
    async codeFor(studentId: string): Promise<string | null> {
      return runTenantSnapshot(tenantId, async (tx) => {
        const result = await tx.execute(sql`
          SELECT qr_code FROM students WHERE tenant_id=${tenantId} AND student_id=${studentId} AND deleted_at IS NULL`);
        const row = result.rows[0] as { qr_code: string } | undefined;
        return row?.qr_code ?? null;
      });
    },

    /** New codes for these students, all or none; every card printed before stops working. */
    async reissue(studentIds: unknown): Promise<{ reissued: number }> {
      const ids = parseStudentIds(studentIds);
      return runTenantTransaction(tenantId, async (tx) => {
        const result = await tx.execute(sql`
          UPDATE students
          SET qr_code=upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), signed_qr_accepted=false
          WHERE tenant_id=${tenantId} AND student_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND deleted_at IS NULL
          RETURNING student_id`);
        if (result.rows.length !== ids.length) {
          throw new StudentQrCodeError('STUDENT_NOT_FOUND', '학생을 찾지 못했어요. 화면을 새로고침한 뒤 다시 시도해 주세요.', 404);
        }
        return { reissued: ids.length };
      });
    },
  };
}

/** The class's codes over the production database. */
export function createTenantStudentQrCodes(tenantId: string) {
  return createStudentQrCodes({ tenantId, runTenantTransaction: withTenantTransaction, runTenantSnapshot: withTenantSnapshot });
}

function parseStudentIds(value: unknown): string[] {
  const invalid = () => new StudentQrCodeError('INVALID_INPUT', '새로 발급할 학생을 다시 골라 주세요.', 400);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QR_REISSUE_STUDENTS) throw invalid();
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !id || id !== id.trim() || Buffer.byteLength(id, 'utf8') > 128) throw invalid();
    ids.add(id);
  }
  if (ids.size !== value.length) throw invalid();
  return [...ids];
}
