import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { verifyBodySignature } from './hub';

// App links (ddanssaem-hub/docs/app-links.md): the 딴쌤 board server asks the class server for a teacher's
// classes, a class's roster and whether a student QR card belongs to that class. Each call is signed with
// DDANSSAEM_LINK_SECRET and names the teacher by the hub account sub; the class answers only for classes that
// teacher owns or helps run, and stores nothing about the board.

type Env = Readonly<Record<string, string | undefined>>;
type RunTenantTransaction = <TResult>(tenantId: string, callback: (tx: TenantTransaction) => Promise<TResult>) => Promise<TResult>;

export const LINK_SIGNATURE_HEADER = 'x-ddanssaem-signature';
const WINDOW_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function linkSecret(env: Env): string | null {
  const secret = env.DDANSSAEM_LINK_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export function linksEnabled(env: Env = process.env): boolean {
  return linkSecret(env) !== null;
}

export function verifyLinkSignature(body: string, signature: string | null, env: Env = process.env): boolean {
  const secret = linkSecret(env);
  return secret !== null && verifyBodySignature(body, signature, secret);
}

export type LinkCall = 'classes' | 'roster' | 'card';
export type LinkRequest = Readonly<{ sub: string; classId?: string; card?: string }>;

/** The signed body: `STALE` when iat is not within five minutes, `INVALID` when it is not a well-formed request. */
export function parseLinkRequest(body: string, call: LinkCall, now = Date.now()): LinkRequest | 'STALE' | 'INVALID' {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'INVALID';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'INVALID';
  const request = value as Record<string, unknown>;
  if (typeof request.iat !== 'number' || !Number.isFinite(request.iat)) return 'INVALID';
  if (Math.abs(now / 1000 - request.iat) > WINDOW_SECONDS) return 'STALE';
  const sub = request.sub;
  if (typeof sub !== 'string' || !sub || sub !== sub.trim() || sub.length > 255 || sub.startsWith('withdrawn:')) return 'INVALID';
  if (call === 'classes') return { sub };
  if (typeof request.classId !== 'string' || !UUID.test(request.classId)) return 'INVALID';
  const classId = request.classId.toLowerCase();
  if (call === 'roster') return { sub, classId };
  const card = request.card;
  if (typeof card !== 'string' || !card.trim() || card.length > 1024) return 'INVALID';
  return { sub, classId, card };
}

export type LinkStudent = Readonly<{ id: string; number: number | null; name: string }>;
export type LinkClass = Readonly<{ id: string; name: string; students: number }>;

/** The class shows the student id as the number ('0101' is 101); an id that is not a number has none. */
export function studentNumber(studentId: string): number | null {
  return /^\d{1,9}$/.test(studentId) ? Number(studentId) : null;
}

/** Changes whenever a student is added, renamed, renumbered or rested: the board knows to read again. */
export function rosterVersion(students: readonly LinkStudent[]): string {
  const rows = [...students].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((student) => [student.id, student.number, student.name]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
}

type Membership = Readonly<{ slug: string; displayName: string; role: string; dashboard?: Readonly<{ deletedAt: string | null }> }>;

export type LinkStoreDependencies = Readonly<{
  listMemberships(sub: string): Promise<readonly Membership[]>;
  findTenantId(slug: string): Promise<string | null>;
  runTenantSnapshot: RunTenantTransaction;
}>;

export function createLinkStore(dependencies: LinkStoreDependencies) {
  /** The classes this teacher owns or helps run, out of the trash, with their ids. */
  async function teacherClasses(sub: string): Promise<{ id: string; name: string }[]> {
    const memberships = (await dependencies.listMemberships(sub))
      .filter((item) => (item.role === 'OWNER' || item.role === 'ADMIN') && !item.dashboard?.deletedAt);
    const classes: { id: string; name: string }[] = [];
    for (const item of memberships) {
      const id = await dependencies.findTenantId(item.slug);
      if (id) classes.push({ id: id.toLowerCase(), name: item.displayName });
    }
    return classes;
  }
  async function activeStudents(classId: string): Promise<LinkStudent[]> {
    return dependencies.runTenantSnapshot(classId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT student_id, name FROM students
        WHERE tenant_id=${classId} AND status='ACTIVE' AND deleted_at IS NULL
        ORDER BY student_id`);
      return (result.rows as { student_id: string; name: string }[])
        .map((row) => ({ id: row.student_id, number: studentNumber(row.student_id), name: row.name }));
    });
  }
  async function teacherClass(sub: string, classId: string) {
    return (await teacherClasses(sub)).find((item) => item.id === classId) ?? null;
  }
  return {
    async classes(sub: string): Promise<LinkClass[]> {
      const classes = await teacherClasses(sub);
      return Promise.all(classes.map(async (item) => ({ ...item, students: (await activeStudents(item.id)).length })));
    },
    /** The class and its students in use, or null when it is not this teacher's class (404). */
    async roster(sub: string, classId: string) {
      const found = await teacherClass(sub, classId);
      if (!found) return null;
      const students = await activeStudents(found.id);
      return { class: found, students, groups: [] as const, version: rosterVersion(students) };
    },
    /** The student in use whose card this is (the store and bank rule), or null (404). */
    async cardStudent(sub: string, classId: string, card: string,
      resolve: (card: string, classId: string) => Promise<string>): Promise<LinkStudent | null> {
      const found = await teacherClass(sub, classId);
      if (!found) return null;
      let studentId: string;
      try {
        studentId = await resolve(card, found.id);
      } catch {
        return null;
      }
      return (await activeStudents(found.id)).find((student) => student.id === studentId) ?? null;
    },
  };
}

export type LinkStore = ReturnType<typeof createLinkStore>;
