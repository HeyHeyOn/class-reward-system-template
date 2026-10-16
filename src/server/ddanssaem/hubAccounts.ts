import 'server-only';

import { defaultAvatarFor, isSameAvatar, normalizeAvatar, type AvatarConfig } from '@/components/profile/avatar';
import { getDatabaseClient } from '@/server/db/client';
import type { ClassMembership } from '@/server/repositories/database/classMemberships';
import { defaultNickname, normalizeNickname } from '@/server/teacherAccounts';
import { hasTeacherSessionBinding, type TeacherSessionBinding } from '@/server/teacherSession';
import { hubAvatarUrl, importHubAvatar, type AvatarImportResult, type HubIcon, type HubProfile } from './hub';

type Queryable = Readonly<{ query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> }>;

/** The 딴쌤 account name as the class nickname (20 characters at most), or the usual default. */
export function hubNickname(profile: Pick<HubProfile, 'name' | 'email'>): string {
  return normalizeNickname(Array.from(profile.name.trim()).slice(0, 20).join('')) ?? defaultNickname({ name: undefined, email: profile.email });
}

/** The name and icon the class keeps for a teacher (user_profiles). */
export type StoredHubProfile = Readonly<{ nickname: string; avatar: AvatarConfig | null; avatarUrl: string | null; avatarFromHub: boolean }>;
/** The icon to keep: the hub's, or (until it reaches the hub) one the teacher picked in the class. */
export type SettledIcon = Readonly<{ avatar: AvatarConfig; avatarUrl: string | null; fromHub: boolean }>;

/**
 * 9-3, 9-4: an icon the teacher picked in the class (not the class's default) that has not reached the hub goes
 * there once. The hub keeps it when the account has no icon of its own; otherwise the hub's icon is the one.
 * When the hub cannot be asked, the class's icon stays and is offered again next time.
 */
export async function settleHubIcon(input: Readonly<{
  sub: string;
  stored: StoredHubProfile | null;
  hub: HubIcon | null;
  importAvatar?: (sub: string, avatar: AvatarConfig) => Promise<AvatarImportResult>;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<SettledIcon> {
  const { sub, stored, hub, env = process.env } = input;
  const picked = stored && !stored.avatarFromHub && stored.avatar && !isSameAvatar(stored.avatar, defaultAvatarFor(sub)) ? stored.avatar : null;
  if (picked) {
    try {
      const result = await (input.importAvatar ?? ((s, a) => importHubAvatar(s, a, env)))(sub, picked);
      if (result === 'stored') return { avatar: picked, avatarUrl: hubAvatarUrl(picked, env), fromHub: true };
      if (result === 'kept' && hub) return { ...hub, fromHub: true };
    } catch (error) {
      console.error('[ddanssaem] icon import failed', error instanceof Error ? error.message : 'unknown');
    }
    return { avatar: picked, avatarUrl: hubAvatarUrl(picked, env), fromHub: false };
  }
  if (hub) return { ...hub, fromHub: true };
  const avatar = stored?.avatar ?? defaultAvatarFor(sub);
  return { avatar, avatarUrl: stored?.avatarUrl ?? hubAvatarUrl(avatar, env), fromHub: stored?.avatarFromHub ?? false };
}

export function createHubAccountStore(db: Queryable) {
  return {
    /** The name and icon kept for this teacher, or null when the class has no profile for them. */
    async profile(sub: string): Promise<StoredHubProfile | null> {
      const { rows } = await db.query('SELECT nickname, avatar, avatar_url, avatar_from_hub FROM public.platform_get_hub_profile($1)', [sub]);
      const row = rows[0] as { nickname?: unknown; avatar?: unknown; avatar_url?: unknown; avatar_from_hub?: unknown } | undefined;
      if (!row || typeof row.nickname !== 'string') return null;
      return { nickname: row.nickname, avatar: normalizeAvatar(row.avatar), avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        avatarFromHub: row.avatar_from_hub === true };
    },
    /** 1-4: a class session for the teacher the hub vouched for, bound to the hub session, with the account's name and icon. */
    async begin(profile: HubProfile, icon: SettledIcon): Promise<TeacherSessionBinding> {
      const { rows } = await db.query('SELECT * FROM public.platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7)',
        [profile.sub, profile.termsVersion, profile.sid, hubNickname(profile), JSON.stringify(icon.avatar), icon.avatarUrl, icon.fromHub]);
      const row = rows[0] as { generation?: unknown; session_id?: unknown } | undefined;
      const binding = { accountGeneration: row?.generation, sessionId: row?.session_id };
      if (rows.length !== 1 || !hasTeacherSessionBinding(binding as TeacherSessionBinding)) throw new Error('Invalid hub teacher session.');
      return binding as TeacherSessionBinding;
    },
    /** 9-3: the name or icon changed on the hub; false when the class keeps no profile for this teacher. */
    async profileUpdated(sub: string, nickname: string, icon: SettledIcon): Promise<boolean> {
      const { rows } = await db.query('SELECT public.platform_hub_profile_updated($1,$2,$3::jsonb,$4,$5) AS updated',
        [sub, nickname, JSON.stringify(icon.avatar), icon.avatarUrl, icon.fromHub]);
      return (rows[0] as { updated?: unknown } | undefined)?.updated === true;
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
