// @vitest-environment node
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createStudentQrCodes } from '@/server/repositories/database/studentQrCodes';
import { resolveStudentQr } from '@/server/studentQr';
import { createLinkStore, parseLinkRequest, rosterVersion, studentNumber, verifyLinkSignature } from './links';

vi.mock('server-only', () => ({}));

const SECRET = 'l'.repeat(40);
const env = { DDANSSAEM_LINK_SECRET: SECRET };
const now = Date.parse('2026-10-16T09:00:00Z');
const iat = Math.floor(now / 1000);

describe('app-links calls (ddanssaem-hub/docs/app-links.md)', () => {
  it('accepts only the HMAC of the exact body with the link secret', () => {
    const body = JSON.stringify({ iat, sub: 'teacher' });
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyLinkSignature(body, signature, env)).toBe(true);
    expect(verifyLinkSignature(`${body} `, signature, env)).toBe(false);
    expect(verifyLinkSignature(body, createHmac('sha256', 'x'.repeat(40)).update(body).digest('hex'), env)).toBe(false);
    expect(verifyLinkSignature(body, signature, {})).toBe(false);
  });

  it('reads each call and refuses one older than five minutes', () => {
    const classId = '40000000-0000-4000-8000-0000000000AA';
    expect(parseLinkRequest(JSON.stringify({ iat, sub: 'teacher' }), 'classes', now)).toEqual({ sub: 'teacher' });
    expect(parseLinkRequest(JSON.stringify({ iat, sub: 'teacher', classId }), 'roster', now)).toEqual({ sub: 'teacher', classId: classId.toLowerCase() });
    expect(parseLinkRequest(JSON.stringify({ iat, sub: 'teacher', classId, card: 'DS1:ABC' }), 'card', now)).toEqual({ sub: 'teacher', classId: classId.toLowerCase(), card: 'DS1:ABC' });
    expect(parseLinkRequest(JSON.stringify({ iat: iat - 301, sub: 'teacher' }), 'classes', now)).toBe('STALE');
    expect(parseLinkRequest(JSON.stringify({ iat: iat + 301, sub: 'teacher' }), 'classes', now)).toBe('STALE');
    for (const bad of ['not json', '[]', JSON.stringify({ sub: 'teacher' }), JSON.stringify({ iat, sub: ' padded' }), JSON.stringify({ iat, sub: 'withdrawn:x' })]) {
      expect(parseLinkRequest(bad, 'classes', now)).toBe('INVALID');
    }
    expect(parseLinkRequest(JSON.stringify({ iat, sub: 'teacher', classId: 'slug' }), 'roster', now)).toBe('INVALID');
    expect(parseLinkRequest(JSON.stringify({ iat, sub: 'teacher', classId }), 'card', now)).toBe('INVALID');
  });

  it('numbers students by their id and versions the roster by what the board shows', () => {
    expect(studentNumber('0101')).toBe(101);
    expect(studentNumber('S01')).toBeNull();
    const roster = [{ id: '1', number: 1, name: '가람' }, { id: '2', number: 2, name: '나래' }];
    expect(rosterVersion(roster)).toBe(rosterVersion([...roster].reverse()));
    expect(rosterVersion(roster)).not.toBe(rosterVersion([roster[0], { ...roster[1], name: '나래2' }]));
    expect(rosterVersion(roster)).not.toBe(rosterVersion([roster[0]]));
  });
});

describe('the class answers for its own teacher only', () => {
  let harness: PgliteDatabaseHarness;
  const TEACHER = 'hub-teacher';
  const SLUGS: Record<string, string> = {};

  async function addStudent(tenantId: string, studentId: string, name: string, active = true) {
    await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status, deleted_at)
      VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN NULL ELSE now() END)`, [tenantId, studentId, name, active ? 'ACTIVE' : 'INACTIVE', active]);
  }
  const memberships = (sub: string) => sub !== TEACHER ? [] : [
    { slug: 'one', displayName: '5학년 1반', role: 'OWNER', dashboard: { deletedAt: null } },
    { slug: 'two', displayName: '작년 반', role: 'ADMIN', dashboard: { deletedAt: '2026-10-01T00:00:00Z' } },
  ];
  const store = () => createLinkStore({
    listMemberships: async (sub) => memberships(sub),
    findTenantId: async (slug) => SLUGS[slug] ?? null,
    runTenantSnapshot: harness.runTenantTransaction,
  });
  const qr = (tenantId: string) => createStudentQrCodes({ tenantId, runTenantTransaction: harness.runTenantTransaction, runTenantSnapshot: harness.runTenantTransaction });
  const resolveCard = async (card: string, classId: string) =>
    (await resolveStudentQr(card, classId, qr(classId), { STUDENT_QR_ACTIVE_KEY_ID: 'k1', STUDENT_QR_SIGNING_KEYS: JSON.stringify({ k1: 'a'.repeat(43) }) })).studentId;

  beforeAll(async () => {
    harness = await createPgliteDatabaseHarness();
    await harness.database.exec(await readFile(resolve('src/server/db/migrations/0057_student_qr_codes.sql'), 'utf8'));
    SLUGS.one = harness.tenantOneId;
    SLUGS.two = harness.tenantTwoId;
    await addStudent(harness.tenantOneId, '01', '가람');
    await addStudent(harness.tenantOneId, '02', '나래');
    await addStudent(harness.tenantOneId, '03', '쉬는 학생', false);
    await addStudent(harness.tenantTwoId, '01', '다른 반 학생');
  }, 60000);
  afterAll(async () => { await harness?.close(); });

  it('lists the teacher\'s classes out of the trash with the students in use', async () => {
    await expect(store().classes(TEACHER)).resolves.toEqual([{ id: harness.tenantOneId, name: '5학년 1반', students: 2 }]);
    await expect(store().classes('someone-else')).resolves.toEqual([]);
  });

  it('gives the roster of students in use, an empty groups list and a version, and nothing for another class', async () => {
    const roster = await store().roster(TEACHER, harness.tenantOneId);
    expect(roster).toMatchObject({
      class: { id: harness.tenantOneId, name: '5학년 1반' },
      students: [{ id: '01', number: 1, name: '가람' }, { id: '02', number: 2, name: '나래' }],
      groups: [],
    });
    expect(roster?.version).toMatch(/^[0-9a-f]{32}$/);
    await expect(store().roster(TEACHER, harness.tenantTwoId)).resolves.toBeNull();
    await expect(store().roster('someone-else', harness.tenantOneId)).resolves.toBeNull();

    await harness.database.query("UPDATE students SET name='가람이' WHERE tenant_id=$1 AND student_id='01'", [harness.tenantOneId]);
    const renamed = await store().roster(TEACHER, harness.tenantOneId);
    expect(renamed?.version).not.toBe(roster?.version);
    await harness.database.query("UPDATE students SET name='가람' WHERE tenant_id=$1 AND student_id='01'", [harness.tenantOneId]);
  });

  it('checks a card by the store and bank rule: the current code of a student in use, in that class', async () => {
    const code = async (tenantId: string, studentId: string) => (await harness.database.query<{ qr_code: string }>(
      'SELECT qr_code FROM students WHERE tenant_id=$1 AND student_id=$2', [tenantId, studentId])).rows[0].qr_code;
    const card = `DS1:${await code(harness.tenantOneId, '02')}`;
    await expect(store().cardStudent(TEACHER, harness.tenantOneId, card.toLowerCase(), resolveCard)).resolves.toEqual({ id: '02', number: 2, name: '나래' });
    await expect(store().cardStudent(TEACHER, harness.tenantOneId, `DS1:${await code(harness.tenantOneId, '03')}`, resolveCard)).resolves.toBeNull();
    await expect(store().cardStudent(TEACHER, harness.tenantOneId, `DS1:${await code(harness.tenantTwoId, '01')}`, resolveCard)).resolves.toBeNull();
    await expect(store().cardStudent('someone-else', harness.tenantOneId, card, resolveCard)).resolves.toBeNull();
    await expect(store().cardStudent(TEACHER, harness.tenantOneId, 'DS1:NOTACODE', resolveCard)).resolves.toBeNull();

    await qr(harness.tenantOneId).reissue(['02']);
    await expect(store().cardStudent(TEACHER, harness.tenantOneId, card, resolveCard)).resolves.toBeNull();
  });
});
