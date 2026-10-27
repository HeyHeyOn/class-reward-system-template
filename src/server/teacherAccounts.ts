import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { isSystemDeployment } from '@/server/deploymentMode';
import type { GoogleSession } from '@/server/googleOAuth';
import { AVATAR_JSON_MAX_LENGTH, defaultAvatarFor, normalizeAvatar, type AvatarConfig } from '@/components/profile/avatar';
import { currentLegalRevision, LEGAL_VERSION_PATTERN, revisionsSince, upcomingLegalRevision, type LegalRevision } from '@/lib/legalDocuments';
import type { HeaderAccount } from '@/components/brand/GlobalHeader';
import { hubAccountUrl, hubAvatarUrl, hubLoginEnabled, hubVerifyUrl } from '@/server/ddanssaem/hub';
import type { TeacherVerification } from '@/lib/teacherVerification';

type Queryable = Readonly<{ query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> }>;

export type AgreementRecord = Readonly<{ version: string; agreedAt: string }>;
/** `avatarUrl` is the 딴쌤 hub's picture of the icon (account-protocol 9-2); null when no hub is set. */
export type TeacherProfile = Readonly<{ nickname: string; avatar: AvatarConfig; avatarUrl: string | null }>;
type StoredProfile = Readonly<{ nickname: string; avatar: unknown; avatarUrl?: string | null; avatarFromHub?: boolean }>;

export type TeacherAccountStore = Readonly<{
  latestAgreement(subject: string): Promise<AgreementRecord | null>;
  hasAgreement(subject: string, version: string): Promise<boolean>;
  recordAgreement(subject: string, version: string): Promise<string>;
  getProfile(subject: string): Promise<StoredProfile | null>;
  saveProfile(subject: string, profile: Pick<TeacherProfile, 'nickname' | 'avatar'>): Promise<void>;
  /** 교사 인증 (account-protocol 10): null when the class keeps no profile for this teacher. */
  getVerification(subject: string): Promise<TeacherVerification | null>;
  /** Returns how many classes were closed. */
  withdraw(subject: string): Promise<number>;
}>;

/** Accounts, agreements and profiles exist for PostgreSQL classes (the central service). */
export function teacherAccountsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isSystemDeployment(env) && env.CLASS_STORE_STORAGE === 'postgresql';
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('Account time is invalid.');
  return date.toISOString();
}

export function createTeacherAccountStore(queryable: Queryable): TeacherAccountStore {
  return {
    async latestAgreement(subject) {
      const { rows } = await queryable.query('SELECT agreement_version, agreed_at FROM public.platform_latest_user_agreement($1)', [subject]);
      const row = rows[0] as { agreement_version?: unknown; agreed_at?: unknown } | undefined;
      if (!row) return null;
      if (typeof row.agreement_version !== 'string' || !LEGAL_VERSION_PATTERN.test(row.agreement_version)) throw new Error('Agreement row is invalid.');
      return { version: row.agreement_version, agreedAt: iso(row.agreed_at) };
    },
    async hasAgreement(subject, version) {
      const { rows } = await queryable.query('SELECT public.platform_has_user_agreement($1, $2) AS agreed', [subject, version]);
      return (rows[0] as { agreed?: unknown } | undefined)?.agreed === true;
    },
    async recordAgreement(subject, version) {
      const { rows } = await queryable.query('SELECT public.platform_record_user_agreement($1, $2) AS agreed_at', [subject, version]);
      return iso((rows[0] as { agreed_at?: unknown } | undefined)?.agreed_at);
    },
    async getProfile(subject) {
      const { rows } = await queryable.query('SELECT nickname, avatar, avatar_url, avatar_from_hub FROM public.platform_get_hub_profile($1)', [subject]);
      const row = rows[0] as { nickname?: unknown; avatar?: unknown; avatar_url?: unknown; avatar_from_hub?: unknown } | undefined;
      if (!row || typeof row.nickname !== 'string') return null;
      return { nickname: row.nickname, avatar: row.avatar, avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        avatarFromHub: row.avatar_from_hub === true };
    },
    async saveProfile(subject, profile) {
      await queryable.query('SELECT public.platform_save_user_profile($1, $2, $3::jsonb)', [subject, profile.nickname, JSON.stringify(profile.avatar)]);
    },
    async getVerification(subject) {
      const { rows } = await queryable.query('SELECT verified_until, required_from FROM public.platform_get_teacher_verification($1)', [subject]);
      const row = rows[0] as { verified_until?: unknown; required_from?: unknown } | undefined;
      if (!row) return null;
      const instant = (value: unknown) => (value === null || value === undefined ? null : iso(value));
      return { verifiedUntil: instant(row.verified_until), requiredFrom: instant(row.required_from) };
    },
    async withdraw(subject) {
      const { rows } = await queryable.query('SELECT public.platform_withdraw_user($1) AS closed', [subject]);
      return Number((rows[0] as { closed?: unknown } | undefined)?.closed ?? 0);
    },
  };
}

export function getProductionTeacherAccountStore(): TeacherAccountStore {
  return createTeacherAccountStore({ query: (text, values) => getDatabaseClient().pool.query(text, values) });
}

/** 1–20 characters after trimming, no control characters. */
export function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const nickname = value.trim().replace(/\s+/g, ' ');
  if (!nickname || [...nickname].length > 20 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/u.test(nickname)) return null;
  return nickname;
}

export function parseProfileInput(value: unknown): Pick<TeacherProfile, 'nickname' | 'avatar'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'nickname' && key !== 'avatar')) return null;
  const nickname = normalizeNickname(record.nickname);
  const avatar = normalizeAvatar(record.avatar);
  if (!nickname || !avatar || JSON.stringify(avatar).length > AVATAR_JSON_MAX_LENGTH) return null;
  return { nickname, avatar };
}

/** The Google name (or the e-mail's local part) until the teacher picks a nickname. */
export function defaultNickname(session: Pick<GoogleSession, 'name' | 'email'>): string {
  return normalizeNickname(session.name?.slice(0, 20)) ?? normalizeNickname(session.email.split('@')[0].slice(0, 20)) ?? '선생님';
}

export function resolveTeacherProfile(session: Pick<GoogleSession, 'subject' | 'name' | 'email'>, stored: StoredProfile | null,
  env: Readonly<Record<string, string | undefined>> = process.env): TeacherProfile {
  const avatar = normalizeAvatar(stored?.avatar) ?? defaultAvatarFor(session.subject);
  return {
    nickname: normalizeNickname(stored?.nickname) ?? defaultNickname(session),
    avatar,
    // The hub's address for an icon that follows the hub; otherwise the hub's picture of the icon kept here.
    avatarUrl: stored?.avatarFromHub && stored.avatarUrl ? stored.avatarUrl : hubAvatarUrl(avatar, env),
  };
}

export type LegalNotice = Readonly<{
  expectedSessionId?: string;
  /** Set when the teacher must agree again before using the service. */
  required: Readonly<{ current: LegalRevision; changes: readonly LegalRevision[] }> | null;
  /** A revision announced for later, shown as a notice. */
  upcoming: LegalRevision | null;
}>;

/** What a signed-in teacher must be told: a revision to agree to now, and/or one coming later. */
export function legalNoticeFor(session: Pick<GoogleSession, 'agreement' | 'sessionId'>, now: number = Date.now()): LegalNotice {
  // The 딴쌤 hub asks for its own terms before it signs a teacher in; the class has nothing to ask.
  if (session.agreement === 'hub') return { required: null, upcoming: null, ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}) };
  const current = currentLegalRevision(now);
  const required = session.agreement === current.version
    ? null
    : { current, changes: revisionsSince(session.agreement, now) };
  return { required, upcoming: upcomingLegalRevision(now), ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}) };
}

export type TeacherAccountView = Readonly<{ profile: TeacherProfile; notice: LegalNotice; header: HeaderAccount;
  /** 교사 인증 as the hub last said (none: nothing is blocked, no reminder). */
  verification: TeacherVerification | null }>;

/** The account button of the header: the name, the e-mail, the icon and where the account is managed (the 딴쌤 hub). */
export function headerAccountFor(session: Pick<GoogleSession, 'email'>, profile: Pick<TeacherProfile, 'nickname' | 'avatarUrl'>,
  env: Readonly<Record<string, string | undefined>> = process.env, verification: TeacherVerification | null = null): HeaderAccount {
  return { nickname: profile.nickname, email: session.email, avatarUrl: profile.avatarUrl,
    ...(hubLoginEnabled(env) ? { accountUrl: hubAccountUrl(env), verifyUrl: hubVerifyUrl(env), ...(verification ? { verification } : {}) } : {}) };
}

/** The header profile and the legal notice for a signed-in teacher; the profile falls back to defaults. */
export async function loadTeacherAccountView(session: GoogleSession, store: TeacherAccountStore = getProductionTeacherAccountStore()): Promise<TeacherAccountView> {
  const stored = await store.getProfile(session.subject).catch((error: unknown) => {
    console.error('[account] profile could not be read', error instanceof Error ? error.message : 'unknown');
    return null;
  });
  const profile = resolveTeacherProfile(session, stored);
  const verification = await teacherVerificationOf(session.subject, store);
  return { profile, notice: legalNoticeFor(session), header: headerAccountFor(session, profile, process.env, verification), verification };
}

/** The teacher's verification as the hub last said, with the 딴쌤 hub only; null (nothing blocked) when unreadable. */
export async function teacherVerificationOf(subject: string, store: TeacherAccountStore = getProductionTeacherAccountStore()): Promise<TeacherVerification | null> {
  if (!hubLoginEnabled()) return null;
  return store.getVerification(subject).catch((error: unknown) => {
    console.error('[account] teacher verification could not be read', error instanceof Error ? error.message : 'unknown');
    return null;
  });
}
