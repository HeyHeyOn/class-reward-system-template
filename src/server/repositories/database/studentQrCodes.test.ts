// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createStudentQrCodes, StudentQrCodeError } from './studentQrCodes';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

async function addStudent(tenantId: string, studentId: string, deleted = false) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status, deleted_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END)`,
    [tenantId, studentId, `학생 ${studentId}`, deleted ? 'INACTIVE' : 'ACTIVE', deleted],
  );
}

async function codes(tenantId: string) {
  const result = await harness.database.query<{ student_id: string; qr_code: string; signed_qr_accepted: boolean }>(
    'SELECT student_id, qr_code, signed_qr_accepted FROM students WHERE tenant_id=$1 ORDER BY student_id', [tenantId]);
  return result.rows;
}

const qrCodes = (tenantId: string) => createStudentQrCodes({
  tenantId, runTenantTransaction: harness.runTenantTransaction, runTenantSnapshot: harness.runTenantTransaction,
});

describe('student QR codes (migration 0057)', () => {
  beforeEach(async () => {
    harness = await createPgliteDatabaseHarness();
    await addStudent(harness.tenantOneId, 'S001');
    await addStudent(harness.tenantOneId, 'S002');
    await harness.database.exec(await readFile(resolve('src/server/db/migrations/0057_student_qr_codes.sql'), 'utf8'));
  });
  afterEach(async () => { await harness?.close(); });

  it('gives every existing and new student its own code, and keeps their old signed cards working', async () => {
    await addStudent(harness.tenantOneId, 'S003');
    await addStudent(harness.tenantTwoId, 'S001');
    const rows = [...await codes(harness.tenantOneId), ...await codes(harness.tenantTwoId)];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.qr_code).toMatch(/^[0-9A-F]{12}$/);
      expect(row.signed_qr_accepted).toBe(true);
    }
    expect(new Set(rows.map((row) => row.qr_code)).size).toBe(4);
    await expect(harness.database.query("UPDATE students SET qr_code='bad' WHERE student_id='S001'")).rejects.toThrow(/students_qr_code_check/);
  });

  it('finds a student by code only inside their own class and never a deleted one', async () => {
    const [first] = await codes(harness.tenantOneId);
    await expect(qrCodes(harness.tenantOneId).studentIdForCode(first.qr_code)).resolves.toBe('S001');
    await expect(qrCodes(harness.tenantTwoId).studentIdForCode(first.qr_code)).resolves.toBeNull();
    await expect(qrCodes(harness.tenantOneId).codeFor('S001')).resolves.toBe(first.qr_code);
    await harness.database.query("UPDATE students SET status='INACTIVE', deleted_at=now() WHERE tenant_id=$1 AND student_id='S001'", [harness.tenantOneId]);
    await expect(qrCodes(harness.tenantOneId).studentIdForCode(first.qr_code)).resolves.toBeNull();
    await expect(qrCodes(harness.tenantOneId).codeFor('S001')).resolves.toBeNull();
  });

  it('issues new codes that retire the old card and the signed card, for the chosen students only', async () => {
    const before = await codes(harness.tenantOneId);
    await expect(qrCodes(harness.tenantOneId).reissue(['S001'])).resolves.toEqual({ reissued: 1 });
    const after = await codes(harness.tenantOneId);
    expect(after[0].qr_code).not.toBe(before[0].qr_code);
    expect(after[0].signed_qr_accepted).toBe(false);
    expect(after[1]).toEqual(before[1]);
    await expect(qrCodes(harness.tenantOneId).studentIdForCode(before[0].qr_code)).resolves.toBeNull();
    await expect(qrCodes(harness.tenantOneId).studentIdForCode(after[0].qr_code)).resolves.toBe('S001');
    await expect(qrCodes(harness.tenantOneId).signedQrAccepted('S001')).resolves.toBe(false);
    await expect(qrCodes(harness.tenantOneId).signedQrAccepted('S002')).resolves.toBe(true);
  });

  it('changes nobody when any chosen student is missing, deleted or in another class', async () => {
    await addStudent(harness.tenantOneId, 'GONE', true);
    await addStudent(harness.tenantTwoId, 'OTHER');
    const before = await codes(harness.tenantOneId);
    for (const ids of [['S001', 'NOPE'], ['S001', 'GONE'], ['S001', 'OTHER']]) {
      await expect(qrCodes(harness.tenantOneId).reissue(ids)).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND', status: 404 });
    }
    expect(await codes(harness.tenantOneId)).toEqual(before);
  });

  it.each([[[]], [['S001', 'S001']], [[' S001']], ['S001'], [[1]], [Array.from({ length: 1001 }, (_, i) => `S${i}`)]])(
    'refuses a malformed student list %#', async (ids) => {
      await expect(qrCodes(harness.tenantOneId).reissue(ids)).rejects.toBeInstanceOf(StudentQrCodeError);
    },
  );
});
