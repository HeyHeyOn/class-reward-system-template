import { accountReply, readAccountRequest, SIGN_IN_AGAIN, TRY_AGAIN_LATER } from '@/server/accountRequest';
import { getTeacherGoogleSessionFromRequest, hasTeacherSessionBinding, saveTeacherProfile } from '@/server/teacherSession';
import { requiredAgreementVersion } from '@/server/requiredAgreement';
import { getProductionTeacherAccountStore, parseProfileInput } from '@/server/teacherAccounts';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';

export const dynamic = 'force-dynamic';

/** Save the nickname and the preset avatar. Needs a session that agreed to the terms in force. */
export async function POST(request: Request) {
  const body = await readAccountRequest(request);
  if (body instanceof Response) return body;
  const session = await getTeacherGoogleSessionFromRequest(request, { requireAgreement: false });
  if (!session || !hasTeacherSessionBinding(session)) return accountReply(401, { error: SIGN_IN_AGAIN });
  if (session.agreement !== requiredAgreementVersion()) {
    return accountReply(403, { error: '바뀐 약관에 먼저 동의해 주세요.', code: 'AGREEMENT_REQUIRED' });
  }
  if (body.expectedSessionId !== session.sessionId) return accountReply(409, { error: '로그인 계정이 바뀌었어요. 화면을 새로 열어 주세요.', code: 'ACCOUNT_CHANGED' });
  const profileBody = { ...body };
  delete profileBody.expectedSessionId;
  let profile = parseProfileInput(profileBody);
  if (!profile) return accountReply(400, { error: '닉네임은 1~20자로, 프로필 아이콘은 목록에서 골라 주세요.' });
  try {
    // With the 딴쌤 hub the nickname is the 딴쌤 account name, set at each sign-in: only the icon changes here.
    if (hubLoginEnabled()) {
      const stored = await getProductionTeacherAccountStore().getProfile(session.subject);
      if (stored?.nickname) profile = { ...profile, nickname: stored.nickname };
    }
    await saveTeacherProfile(session, profile);
  } catch (error) {
    console.error('[account] profile could not be saved', error instanceof Error ? error.message : 'unknown');
    return accountReply(503, { error: `프로필을 저장하지 못했어요. ${TRY_AGAIN_LATER}` });
  }
  return accountReply(200, { ok: true, profile });
}
