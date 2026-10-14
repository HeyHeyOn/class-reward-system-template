import { NextResponse } from 'next/server';
import { isGeneratorDeployment, isSystemDeployment } from '@/server/deploymentMode';
import { googleIdentityLoginPath, type GoogleIdentityReturnTo } from '@/lib/googleIdentityReturnTo';
import { currentLegalRevision } from '@/lib/legalDocuments';
import { getProductionClassMembershipRepository } from '@/server/repositories/database/classMemberships';
import { getProductionTeacherAccountStore, teacherAccountsEnabled } from '@/server/teacherAccounts';
import { endRequestTeacherSessions, getProductionTeacherSessionStore } from '@/server/teacherSession';
import {
  clearGoogleSessionCookie,
  clearPendingAgreementCookie,
  consumeGeneratorConsentStateCookie,
  consumeGoogleStateCookie,
  exchangeGoogleCodeForGeneratorGrant,
  exchangeGoogleCodeForSession,
  getGoogleSessionFromRequest,
  hasGeneratorConsentStateCookie,
  revokeGeneratorGrant,
  setGeneratorGrantCookie,
  setGoogleSessionCookie,
  setPendingAgreementCookie,
  type GeneratorGrant,
} from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const isGeneratorConsent = hasGeneratorConsentStateCookie(request);
  const postgresIdentity = isSystemDeployment() && process.env.CLASS_STORE_STORAGE === 'postgresql';
  const successPath = isGeneratorDeployment() ? '/admin/generator?step=google' : postgresIdentity ? '/classes' : '/admin';
  const response = NextResponse.redirect(new URL(successPath, request.url));
  let issuedGeneratorGrant: GeneratorGrant | null = null;
  let identityReturnTo: GoogleIdentityReturnTo | undefined;

  try {
    if (!code) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Google 인증 코드가 없어요.');

    if (isGeneratorConsent) {
      if (!isGeneratorDeployment()) throw new Error('생성기 Google 권한 콜백이 올바르지 않아요.');
      const binding = consumeGeneratorConsentStateCookie(request, response, state);
      if (!binding) throw new Error('Google 생성기 권한 상태값이 올바르지 않아요. 다시 시도해 주세요.');
      const session = getGoogleSessionFromRequest(request);
      if (!session || session.subject !== binding.subject || session.email.toLowerCase() !== binding.email.toLowerCase()) {
        throw new Error('Google 로그인 세션이 변경됐어요. 같은 계정으로 다시 로그인해 주세요.');
      }
      issuedGeneratorGrant = await exchangeGoogleCodeForGeneratorGrant(url.origin, code, binding);
      setGeneratorGrantCookie(response, issuedGeneratorGrant);
      return response;
    }

    const identityState = consumeGoogleStateCookie(request, response, state);
    if (!identityState) throw new Error('Google 로그인 상태값이 올바르지 않아요. 다시 로그인해 주세요.');
    identityReturnTo = identityState.returnTo;
    const session = await exchangeGoogleCodeForSession(url.origin, code);
    if (teacherAccountsEnabled()) {
      // The account starts only after agreeing to the terms in force: until then this sign-in waits.
      const accounts = getProductionTeacherAccountStore();
      const version = currentLegalRevision().version;
      const { agreed, ...binding } = await getProductionTeacherSessionStore().begin(session.subject, version);
      await endRequestTeacherSessions(request);
      if (!agreed) {
        const latest = await accounts.latestAgreement(session.subject);
        // Teachers who made classes before the terms existed agree as existing members (and may withdraw).
        const existing = latest !== null
          || (await getProductionClassMembershipRepository().listByGoogleSubject(session.subject)).length > 0;
        clearGoogleSessionCookie(response);
        setPendingAgreementCookie(response, {
          purpose: 'agreement',
          subject: session.subject,
          email: session.email,
          ...(session.name ? { name: session.name } : {}),
          mode: existing ? 'update' : 'signup',
          ...(latest ? { agreedVersion: latest.version } : {}),
          ...(identityState.returnTo ? { returnTo: identityState.returnTo } : {}),
          issuedAt: Date.now(),
          ...binding,
        });
        response.headers.set('location', new URL('/signup', request.url).toString());
        return response;
      }
      setGoogleSessionCookie(response, { ...session, agreement: version, ...binding });
    } else {
      setGoogleSessionCookie(response, session);
    }
    clearPendingAgreementCookie(response);
    if (identityState.returnTo) {
      response.headers.set('location', new URL(identityState.returnTo, request.url).toString());
    }
    return response;
  } catch (error) {
    if (issuedGeneratorGrant) {
      await revokeGeneratorGrant(issuedGeneratorGrant).catch(() => undefined);
    }
    if (!isGeneratorConsent && !identityReturnTo) {
      const failedIdentityState = consumeGoogleStateCookie(request, response, state);
      identityReturnTo = failedIdentityState?.returnTo;
    }
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Google 로그인에 실패했어요.');
    const errorPath = isGeneratorDeployment()
      ? `/admin/generator?error=${message}`
      : `${googleIdentityLoginPath(identityReturnTo ?? (postgresIdentity ? '/classes' : undefined))}?error=${message}`;
    const errorResponse = NextResponse.redirect(new URL(errorPath, request.url));
    if (isGeneratorConsent) {
      consumeGeneratorConsentStateCookie(request, errorResponse, state);
    } else {
      consumeGoogleStateCookie(request, errorResponse, state);
    }
    return errorResponse;
  }
}
