import { NextResponse } from 'next/server';
import { isGeneratorDeployment, isSystemDeployment } from '@/server/deploymentMode';
import {
  createGeneratorConsentAuthUrl,
  createGoogleAuthUrl,
  getGeneratorGoogleClientFingerprint,
  getGoogleSessionFromRequest,
  makeState,
  setGeneratorConsentStateCookie,
  setGoogleStateCookie,
} from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const purpose = url.searchParams.get('purpose');
    const returnTo = url.searchParams.get('returnTo') === '/classes' ? '/classes' : undefined;

    if (purpose === 'generator') {
      if (!isGeneratorDeployment()) {
        throw new Error('생성기 Google 권한은 생성기 배포에서만 요청할 수 있습니다.');
      }
      const session = getGoogleSessionFromRequest(request);
      if (!session) {
        throw new Error('먼저 Google 계정으로 로그인한 다음 시트 생성 권한을 승인해 주세요.');
      }
      const state = makeState();
      const response = NextResponse.redirect(createGeneratorConsentAuthUrl(url.origin, state));
      setGeneratorConsentStateCookie(response, {
        purpose: 'generator',
        state,
        subject: session.subject,
        email: session.email,
        clientFingerprint: getGeneratorGoogleClientFingerprint(),
        issuedAt: Date.now(),
      });
      return response;
    }

    if (purpose) {
      throw new Error('지원하지 않는 Google 로그인 목적입니다.');
    }

    if (isSystemDeployment() && process.env.GOOGLE_REFRESH_TOKEN?.trim() && !returnTo) {
      const message = encodeURIComponent('이 배포 앱은 생성 시 연결된 Google Sheets 권한으로 동작합니다. 관리자 비밀번호 또는 관리자 QR로 로그인하세요.');
      return NextResponse.redirect(new URL(`/admin/login?error=${message}`, request.url));
    }

    const state = makeState();
    const authUrl = createGoogleAuthUrl(url.origin, state);
    const response = NextResponse.redirect(authUrl);
    setGoogleStateCookie(response, state, returnTo);
    return response;
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Google 로그인을 시작하지 못했습니다.');
    const errorPath = isSystemDeployment() ? `/admin/login?error=${message}` : `/admin/generator?error=${message}`;
    return NextResponse.redirect(new URL(errorPath, request.url));
  }
}
