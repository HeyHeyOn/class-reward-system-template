import { accountReply, readAccountIdentity, readAccountRequest, SIGN_IN_AGAIN, TRY_AGAIN_LATER } from '@/server/accountRequest';
import { clearPendingAgreementCookie, getPendingAgreementFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import { getProductionTeacherSessionStore, hasTeacherSessionBinding } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

/**
 * Agree to the terms and the privacy policy in force. For a sign-in waiting for agreement (sign-up, or a
 * new version at sign-in), this is when the session starts; for a signed-in teacher it updates the
 * agreement without extending the original authentication lifetime.
 */
export async function POST(request: Request) {
  if (hubLoginEnabled()) return accountReply(409, { error: '약관 동의는 딴쌤 계정에서 해요.', code: 'HUB_ACCOUNT' });
  const body = await readAccountRequest(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !['terms', 'privacy', 'age', 'expectedSessionId'].includes(key))
    || body.terms !== true || body.privacy !== true || body.age !== true) {
    return accountReply(400, { error: '필수 항목에 모두 동의해 주세요.' });
  }
  const identity = await readAccountIdentity(request);
  if (!identity) return accountReply(401, { error: SIGN_IN_AGAIN });
  const who = identity.kind === 'pending' ? identity.pending : identity.session;
  if (body.expectedSessionId !== who.sessionId) return accountReply(409, { error: '로그인 계정이 바뀌었어요. 화면을 새로 열어 주세요.', code: 'ACCOUNT_CHANGED' });
  const version = currentLegalRevision().version;
  try {
    await getProductionTeacherSessionStore().mutate(who, 'AGREE', { version });
  } catch (error) {
    logFailure('[account] agreement could not be recorded', error);
    return accountReply(503, { error: `동의를 저장하지 못했어요. ${TRY_AGAIN_LATER}` });
  }
  const redirectTo = identity.kind === 'pending' ? identity.pending.returnTo ?? '/classes' : null;
  const response = accountReply(200, { ok: true, version, redirectTo });
  setGoogleSessionCookie(response, {
    subject: who.subject,
    email: who.email,
    ...(who.name ? { name: who.name } : {}),
    issuedAt: who.issuedAt,
    accountGeneration: who.accountGeneration,
    sessionId: who.sessionId,
    agreement: version,
  });
  clearPendingAgreementCookie(response);
  return response;
}

/** Leave the agreement step without agreeing: the waiting sign-in is discarded and no account is made. */
export async function DELETE(request: Request) {
  const body = await readAccountRequest(request, { body: false });
  if (body instanceof Response) return body;
  const pending = getPendingAgreementFromRequest(request);
  if (pending && hasTeacherSessionBinding(pending)) {
    try { await getProductionTeacherSessionStore().end(pending); }
    catch { return accountReply(503, { error: TRY_AGAIN_LATER }); }
  }
  const response = accountReply(200, { ok: true, redirectTo: '/classes' });
  clearPendingAgreementCookie(response);
  return response;
}
