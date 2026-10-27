import 'server-only';

import { blocksNewClass, NEW_CLASS_BLOCKED, type TeacherVerification } from '@/lib/teacherVerification';
import { hubLoginEnabled, hubVerifyUrl } from '@/server/ddanssaem/hub';
import { classMutationReply } from './classMutationRequest';
import { teacherVerificationOf } from './teacherAccounts';

export type VerificationOf = (subject: string) => Promise<TeacherVerification | null>;

/**
 * 교사 인증 (ddanssaem-hub/docs/account-protocol.md 10-4): a teacher who must be verified and is not cannot make a
 * new class (a new one, or a duplicate). Everything that exists stays as it is. The refusal names the reason and
 * where to verify; null when the class may be made.
 */
export async function newClassRefusal(subject: string, verificationOf: VerificationOf = teacherVerificationOf, now = Date.now()): Promise<Response | null> {
  if (!blocksNewClass(await verificationOf(subject), now)) return null;
  return classMutationReply(403, { error: NEW_CLASS_BLOCKED, code: 'TEACHER_VERIFICATION_REQUIRED',
    ...(hubLoginEnabled() ? { verifyUrl: hubVerifyUrl() } : {}) });
}
