import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { getGoogleSessionFromRequest, getPendingAgreementFromRequest, type GoogleSession } from '@/server/googleOAuth';
import { requiredAgreementVersion } from '@/server/requiredAgreement';
import { teacherAccountsEnabled, type TeacherProfile } from '@/server/teacherAccounts';

export type TeacherSessionBinding = Readonly<{ accountGeneration: string; sessionId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function hasTeacherSessionBinding(value: Partial<TeacherSessionBinding>): value is TeacherSessionBinding {
  return typeof value.accountGeneration === 'string' && UUID.test(value.accountGeneration)
    && typeof value.sessionId === 'string' && UUID.test(value.sessionId);
}
type Identity = Pick<GoogleSession, 'subject'> & TeacherSessionBinding;
export type TeacherSessionQueryable = { query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> };

export function createTeacherSessionStore(db: TeacherSessionQueryable) {
  return {
    async begin(subject: string, version: string): Promise<TeacherSessionBinding & { agreed: boolean }> {
      const { rows } = await db.query('SELECT * FROM public.platform_begin_teacher_session($1,$2)', [subject, version]);
      const row = rows[0] as { generation?: unknown; session_id?: unknown; agreed?: unknown } | undefined;
      const binding = { accountGeneration: row?.generation, sessionId: row?.session_id };
      if (!hasTeacherSessionBinding(binding as TeacherSessionBinding) || typeof row?.agreed !== 'boolean') throw new Error('Invalid teacher session');
      return { ...binding, agreed: row.agreed } as TeacherSessionBinding & { agreed: boolean };
    },
    async valid(identity: Identity, pending: boolean, version: string | null): Promise<boolean> {
      const { rows } = await db.query('SELECT public.platform_validate_teacher_session($1,$2::uuid,$3::uuid,$4,$5) AS valid',
        [identity.subject, identity.accountGeneration, identity.sessionId, pending, version]);
      return (rows[0] as { valid?: unknown } | undefined)?.valid === true;
    },
    async mutate(identity: Identity, action: 'AGREE' | 'PROFILE' | 'WITHDRAW', payload: Record<string, unknown>) {
      const { rows } = await db.query('SELECT public.platform_mutate_teacher_account($1,$2,$3::uuid,$4::uuid,$5::jsonb) AS result',
        [action, identity.subject, identity.accountGeneration, identity.sessionId, JSON.stringify(payload)]);
      return (rows[0] as { result: { closedClasses?: number } }).result;
    },
    async end(identity: Identity) {
      await db.query('SELECT public.platform_end_teacher_session($1,$2::uuid,$3::uuid)', [identity.subject, identity.accountGeneration, identity.sessionId]);
    },
  };
}
export function getProductionTeacherSessionStore() {
  return createTeacherSessionStore({ query: (text, values) => getDatabaseClient().pool.query(text, values) });
}

/** End only identities carried by this browser; other devices retain their independent sessions. */
export async function endRequestTeacherSessions(request: Request) {
  if (!teacherAccountsEnabled()) return;
  for (const identity of [getGoogleSessionFromRequest(request), getPendingAgreementFromRequest(request)]) {
    if (identity && hasTeacherSessionBinding(identity)) await getProductionTeacherSessionStore().end(identity);
  }
}

/** Central PostgreSQL authorization. Legacy Sheets keeps its existing identity behavior. No cached revocation state. */
export async function getTeacherGoogleSessionFromRequest(request: Request, options: { requireAgreement?: boolean } = {}): Promise<GoogleSession | null> {
  const session = getGoogleSessionFromRequest(request);
  if (!teacherAccountsEnabled()) return session;
  if (!session || !hasTeacherSessionBinding(session)) return null;
  const pending = getPendingAgreementFromRequest(request);
  if (pending && (pending.subject !== session.subject || pending.sessionId !== session.sessionId || pending.accountGeneration !== session.accountGeneration)) return null;
  const version = options.requireAgreement === false ? null : requiredAgreementVersion();
  if (version && session.agreement !== version) return null;
  return await getProductionTeacherSessionStore().valid(session, false, version) ? session : null;
}

export async function isCurrentTeacherSession(session: Pick<GoogleSession, 'subject'> & Partial<GoogleSession>, queryable?: TeacherSessionQueryable): Promise<boolean> {
  if (!teacherAccountsEnabled()) return true;
  const version = requiredAgreementVersion();
  return hasTeacherSessionBinding(session) && session.agreement === version
    && await (queryable ? createTeacherSessionStore(queryable) : getProductionTeacherSessionStore()).valid(session, false, version);
}

export async function saveTeacherProfile(identity: Identity, profile: Pick<TeacherProfile, 'nickname' | 'avatar'>) {
  return getProductionTeacherSessionStore().mutate(identity, 'PROFILE', { ...profile, version: requiredAgreementVersion() });
}
