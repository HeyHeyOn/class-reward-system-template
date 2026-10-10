import { accountReply, readAccountIdentity, readAccountRequest, SIGN_IN_AGAIN, TRY_AGAIN_LATER } from '@/server/accountRequest';
import { clearPendingAgreementCookie, setGoogleSessionCookie } from '@/server/googleOAuth';
import { getProductionTeacherAccountStore } from '@/server/teacherAccounts';
import { currentLegalRevision } from '@/lib/legalDocuments';

export const dynamic = 'force-dynamic';

/**
 * Agree to the terms and the privacy policy in force. For a sign-in waiting for agreement (sign-up, or a
 * new version at sign-in), this is when the session starts; for a signed-in teacher it renews the
 * session with the new version.
 */
export async function POST(request: Request) {
  const body = await readAccountRequest(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !['terms', 'privacy', 'age'].includes(key))
    || body.terms !== true || body.privacy !== true || body.age !== true) {
    return accountReply(400, { error: '필수 항목에 모두 동의해 주세요.' });
  }
  const identity = readAccountIdentity(request);
  if (!identity) return accountReply(401, { error: SIGN_IN_AGAIN });
  const who = identity.kind === 'pending' ? identity.pending : identity.session;
  const version = currentLegalRevision().version;
  try {
    await getProductionTeacherAccountStore().recordAgreement(who.subject, version);
  } catch (error) {
    console.error('[account] agreement could not be recorded', error instanceof Error ? error.message : 'unknown');
    return accountReply(503, { error: `동의를 저장하지 못했어요. ${TRY_AGAIN_LATER}` });
  }
  const redirectTo = identity.kind === 'pending' ? identity.pending.returnTo ?? '/classes' : null;
  const response = accountReply(200, { ok: true, version, redirectTo });
  setGoogleSessionCookie(response, {
    subject: who.subject,
    email: who.email,
    ...(who.name ? { name: who.name } : {}),
    issuedAt: Date.now(),
    agreement: version,
  });
  clearPendingAgreementCookie(response);
  return response;
}

/** Leave the agreement step without agreeing: the waiting sign-in is discarded and no account is made. */
export async function DELETE(request: Request) {
  const body = await readAccountRequest(request, { body: false });
  if (body instanceof Response) return body;
  const response = accountReply(200, { ok: true, redirectTo: '/classes' });
  clearPendingAgreementCookie(response);
  return response;
}
