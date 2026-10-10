import { ADMIN_SESSION_COOKIE } from '@/server/adminAuth';
import { accountReply, readAccountIdentity, readAccountRequest, SIGN_IN_AGAIN, TRY_AGAIN_LATER } from '@/server/accountRequest';
import { clearGeneratorGrantCookie, clearGoogleSessionCookie, clearPendingAgreementCookie } from '@/server/googleOAuth';
import { clearTenantAdminSessionCookie } from '@/server/tenantAdminSessionCookie';
import { getProductionTeacherAccountStore } from '@/server/teacherAccounts';

export const dynamic = 'force-dynamic';

/**
 * Withdraw from the service. Works for a signed-in teacher and for one who declines a new version of
 * the terms at sign-in. The account's classes close at once (see platform_withdraw_user) and this
 * browser is signed out.
 */
export async function POST(request: Request) {
  const body = await readAccountRequest(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 1 || body.confirm !== true) {
    return accountReply(400, { error: '탈퇴 안내를 확인했다고 표시해 주세요.' });
  }
  const identity = readAccountIdentity(request);
  if (!identity) return accountReply(401, { error: SIGN_IN_AGAIN });
  const subject = identity.kind === 'pending' ? identity.pending.subject : identity.session.subject;
  let closedClasses: number;
  try {
    closedClasses = await getProductionTeacherAccountStore().withdraw(subject);
  } catch (error) {
    console.error('[account] withdrawal failed', error instanceof Error ? error.message : 'unknown');
    return accountReply(503, { error: `탈퇴를 마치지 못했어요. ${TRY_AGAIN_LATER}` });
  }
  const response = accountReply(200, { ok: true, closedClasses, redirectTo: '/classes?withdrawn=1' });
  clearGoogleSessionCookie(response);
  clearPendingAgreementCookie(response);
  clearGeneratorGrantCookie(response);
  clearTenantAdminSessionCookie(response);
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0,
  });
  return response;
}
