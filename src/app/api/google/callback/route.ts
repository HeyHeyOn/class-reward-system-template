import { NextResponse } from 'next/server';
import { isGeneratorDeployment } from '@/server/deploymentMode';
import {
  consumeGeneratorConsentStateCookie,
  consumeGoogleStateCookie,
  exchangeGoogleCodeForGeneratorGrant,
  exchangeGoogleCodeForSession,
  getGoogleSessionFromRequest,
  hasGeneratorConsentStateCookie,
  revokeGeneratorGrant,
  setGeneratorGrantCookie,
  setGoogleSessionCookie,
  type GeneratorGrant,
} from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const isGeneratorConsent = hasGeneratorConsentStateCookie(request);
  const successPath = isGeneratorDeployment() ? '/admin/generator?step=google' : '/admin';
  const response = NextResponse.redirect(new URL(successPath, request.url));
  let issuedGeneratorGrant: GeneratorGrant | null = null;
  let identityReturnTo: '/classes' | undefined;

  try {
    if (!code) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Google 인증 코드가 없습니다.');

    if (isGeneratorConsent) {
      if (!isGeneratorDeployment()) throw new Error('생성기 Google 권한 콜백이 올바르지 않습니다.');
      const binding = consumeGeneratorConsentStateCookie(request, response, state);
      if (!binding) throw new Error('Google 생성기 권한 상태값이 올바르지 않습니다. 다시 시도해 주세요.');
      const session = getGoogleSessionFromRequest(request);
      if (!session || session.subject !== binding.subject || session.email.toLowerCase() !== binding.email.toLowerCase()) {
        throw new Error('Google 로그인 세션이 변경되었습니다. 같은 계정으로 다시 로그인해 주세요.');
      }
      issuedGeneratorGrant = await exchangeGoogleCodeForGeneratorGrant(url.origin, code, binding);
      setGeneratorGrantCookie(response, issuedGeneratorGrant);
      return response;
    }

    const identityState = consumeGoogleStateCookie(request, response, state);
    if (!identityState) throw new Error('Google 로그인 상태값이 올바르지 않습니다. 다시 로그인해 주세요.');
    if (identityState.returnTo === '/classes') identityReturnTo = '/classes';
    const session = await exchangeGoogleCodeForSession(url.origin, code);
    setGoogleSessionCookie(response, session);
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
      if (failedIdentityState?.returnTo === '/classes') identityReturnTo = '/classes';
    }
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Google 로그인에 실패했습니다.');
    const errorPath = isGeneratorDeployment()
      ? `/admin/generator?error=${message}`
      : identityReturnTo
        ? `/classes?error=${message}`
        : `/admin/login?error=${message}`;
    const errorResponse = NextResponse.redirect(new URL(errorPath, request.url));
    if (isGeneratorConsent) {
      consumeGeneratorConsentStateCookie(request, errorResponse, state);
    } else {
      consumeGoogleStateCookie(request, errorResponse, state);
    }
    return errorResponse;
  }
}
