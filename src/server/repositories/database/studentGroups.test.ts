// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { installStudentGroups } from '@/server/db/testing/studentGroups';
import { createStudentGroups, MAX_STUDENT_GROUPS, normalizeGroupName } from './studentGroups';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;
const groups = (tenantId = harness.tenantOneId) => createStudentGroups({
  tenantId, runTenantTransaction: harness.runTenantTransaction, runTenantSnapshot: harness.runTenantTransaction,
});
async function addStudent(tenantId: string, studentId: string) {
  await harness.database.query("INSERT INTO students (tenant_id, student_id, name) VALUES ($1, $2, $3)", [tenantId, studentId, `학생 ${studentId}`]);
}
const groupOf = async (studentId: string, tenantId = harness.tenantOneId) => (await harness.database.query<{ group_id: string | null }>(
  'SELECT group_id::text FROM students WHERE tenant_id=$1 AND student_id=$2', [tenantId, studentId])).rows[0].group_id;

describe('모둠 (migration 0060)', () => {
  beforeEach(async () => {
    harness = await createPgliteDatabaseHarness();
    await installStudentGroups(harness);
    for (const id of ['S1', 'S2', 'S3']) await addStudent(harness.tenantOneId, id);
    await addStudent(harness.tenantTwoId, 'S1');
  });
  afterEach(async () => { await harness?.close(); });

  it('creates, renames and lists groups with the students in use in each', async () => {
    const one = await groups().create(' 1모둠 ');
    const two = await groups().create('2모둠');
    expect(one).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: '1모둠', students: [] });
    await groups().assign(one.id, ['S1', 'S2']);
    await groups().assign(two.id, ['S3']);
    await groups().rename(two.id, '별빛 모둠');
    expect(await groups().list()).toEqual([
      { id: one.id, name: '1모둠', students: ['S1', 'S2'] },
      { id: two.id, name: '별빛 모둠', students: ['S3'] },
    ]);
    await groups().assign(two.id, ['S1']);
    await groups().assign(null, ['S2']);
    expect((await groups().list()).map((group) => group.students)).toEqual([[], ['S1', 'S3']]);
  });

  it('keeps names unique and short, and stops at the group limit', async () => {
    const one = await groups().create('1모둠');
    const two = await groups().create('2모둠');
    await expect(groups().create('1모둠')).rejects.toMatchObject({ code: 'NAME_TAKEN', status: 409 });
    await expect(groups().rename(two.id, '1모둠')).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    await groups().rename(one.id, '1모둠');
    expect(() => normalizeGroupName('')).toThrow();
    expect(() => normalizeGroupName('가'.repeat(31))).toThrow();
    expect(normalizeGroupName('  별빛   모둠 ')).toBe('별빛 모둠');
    for (let index = 3; index <= MAX_STUDENT_GROUPS; index += 1) await groups().create(`${index}모둠`);
    await expect(groups().create('하나 더')).rejects.toMatchObject({ code: 'TOO_MANY' });
  });

  it('takes a rested or deleted student out of their group, and leaves students alone when a group goes', async () => {
    const one = await groups().create('1모둠');
    await groups().assign(one.id, ['S1', 'S2', 'S3']);
    await harness.database.query("UPDATE students SET status='INACTIVE' WHERE tenant_id=$1 AND student_id='S1'", [harness.tenantOneId]);
    await harness.database.query("UPDATE students SET status='INACTIVE', deleted_at=now() WHERE tenant_id=$1 AND student_id='S2'", [harness.tenantOneId]);
    expect(await groupOf('S1')).toBeNull();
    expect(await groupOf('S2')).toBeNull();
    expect((await groups().list())[0].students).toEqual(['S3']);
    await expect(groups().assign(one.id, ['S1'])).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
    expect(await groupOf('S3')).toBe(one.id);

    await groups().remove(one.id);
    expect(await groups().list()).toEqual([]);
    expect(await groupOf('S3')).toBeNull();
    await expect(groups().remove(one.id)).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
  });

  it('keeps each class to its own groups and students, all or none', async () => {
    const other = await groups(harness.tenantTwoId).create('다른 반 모둠');
    await expect(groups().assign(other.id, ['S1'])).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    await expect(groups().rename(other.id, '바꿈')).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    const one = await groups().create('1모둠');
    await expect(groups().assign(one.id, ['S1', 'S9'])).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
    expect(await groupOf('S1')).toBeNull();
    await expect(groups().assign(one.id, ['S1', 'S1'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(groups().assign('not-a-group', ['S1'])).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
    expect(await groups(harness.tenantTwoId).list()).toEqual([{ id: other.id, name: '다른 반 모둠', students: [] }]);
  });
});
