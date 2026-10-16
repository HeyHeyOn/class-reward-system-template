import 'server-only';

import { defaultAvatarFor } from '@/components/profile/avatar';
import { getDatabaseClient } from '@/server/db/client';
import type { ClassMembership } from '@/server/repositories/database/classMemberships';
import { defaultNickname, normalizeNickname } from '@/server/teacherAccounts';
import { hasTeacherSessionBinding, type TeacherSessionBinding } from '@/server/teacherSession';
import type { HubProfile } from './hub';

type Queryable = Readonly<{ query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> }>;

/** The 딴쌤 account name as the class nickname (20 characters at most), or the usual default. */
export function hubNickname(profile: Pick<HubProfile, 'name' | 'email'>): string {
  return normalizeNickname(Array.from(profile.name.trim()).slice(0, 20).join('')) ?? defaultNickname({ name: undefined, email: profile.email });
}

export function createHubAccountStore(db: Queryable) {
  return {
    /** 1-4: a class session for the teacher the hub vouched for, bound to the hub session. */
    async begin(profile: HubProfile): Promise<TeacherSessionBinding> {
      const { rows } = await db.query('SELECT * FROM public.platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb)',
        [profile.sub, profile.termsVersion, profile.sid, hubNickname(profile), JSON.stringify(defaultAvatarFor(profile.sub))]);
      const row = rows[0] as { generation?: unknown; session_id?: unknown } | undefined;
      const binding = { accountGeneration: row?.generation, sessionId: row?.session_id };
      if (rows.length !== 1 || !hasTeacherSessionBinding(binding as TeacherSessionBinding)) throw new Error('Invalid hub teacher session.');
      return binding as TeacherSessionBinding;
    },
    /** 2-2: the class sessions made from this hub session end; returns how many. */
    async endSessions(sid: string): Promise<number> {
      const { rows } = await db.query('SELECT public.platform_end_hub_teacher_sessions($1) AS ended', [sid]);
      return Number((rows[0] as { ended?: unknown } | undefined)?.ended ?? 0);
    },
    /** 3: the 딴쌤 account was deleted; the class withdraws the teacher. Returns the classes closed. */
    async accountDeleted(sub: string): Promise<number> {
      const { rows } = await db.query('SELECT public.platform_hub_account_deleted($1) AS closed', [sub]);
      return Number((rows[0] as { closed?: unknown } | undefined)?.closed ?? 0);
    },
  };
}

export function getProductionHubAccountStore() {
  return createHubAccountStore({ query: (text, values) => getDatabaseClient().pool.query(text, values) });
}

export type HubSummary = Readonly<{
  items: readonly Readonly<{ title: string; detail: string; url: string; pending: number }>[];
  total: number;
}>;
export const SUMMARY_ITEMS = 10;

/** 4: the teacher's classes for the hub's '내 학급', newest first. No student information. */
export function hubSummary(memberships: readonly ClassMembership[], origin: string): HubSummary {
  const live = memberships.filter((item) => !item.dashboard?.deletedAt)
    .sort((left, right) => (right.dashboard?.createdAt ?? '').localeCompare(left.dashboard?.createdAt ?? ''));
  return {
    items: live.slice(0, SUMMARY_ITEMS).map((item) => ({
      title: item.displayName,
      detail: item.lifecycle === 'DRAFT' ? '준비 중' : `학생 ${item.dashboard?.studentCount ?? 0}명`,
      url: item.lifecycle === 'DRAFT' ? `${origin}/classes/${item.slug}/start`
        : item.lifecycle === 'ACTIVE' ? `${origin}/c/${item.slug}/admin` : `${origin}/classes`,
      pending: 0,
    })),
    total: live.length,
  };
}
