import { accountReply, readAccountRequest, SIGN_IN_AGAIN, TRY_AGAIN_LATER } from '@/server/accountRequest';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { currentLegalRevision } from '@/lib/legalDocuments';
import { getProductionTeacherAccountStore, parseProfileInput } from '@/server/teacherAccounts';

export const dynamic = 'force-dynamic';

/** Save the nickname and the preset avatar. Needs a session that agreed to the terms in force. */
export async function POST(request: Request) {
  const body = await readAccountRequest(request);
  if (body instanceof Response) return body;
  const session = getGoogleSessionFromRequest(request);
  if (!session) return accountReply(401, { error: SIGN_IN_AGAIN });
  if (session.agreement !== currentLegalRevision().version) {
    return accountReply(403, { error: '바뀐 약관에 먼저 동의해 주세요.', code: 'AGREEMENT_REQUIRED' });
  }
  const profile = parseProfileInput(body);
  if (!profile) return accountReply(400, { error: '닉네임은 1~20자로, 프로필 아이콘은 목록에서 골라 주세요.' });
  try {
    await getProductionTeacherAccountStore().saveProfile(session.subject, profile);
  } catch (error) {
    console.error('[account] profile could not be saved', error instanceof Error ? error.message : 'unknown');
    return accountReply(503, { error: `프로필을 저장하지 못했어요. ${TRY_AGAIN_LATER}` });
  }
  return accountReply(200, { ok: true, profile });
}
