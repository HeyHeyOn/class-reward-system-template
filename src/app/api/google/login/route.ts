import { NextResponse } from 'next/server';
import { createGoogleAuthUrl, makeState, setGoogleStateCookie } from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    if (process.env.GOOGLE_REFRESH_TOKEN?.trim()) {
      const message = encodeURIComponent('이 배포 앱은 생성 시 연결된 Google Sheets 권한으로 동작합니다. 관리자 비밀번호 또는 관리자 QR로 로그인하세요.');
      return NextResponse.redirect(new URL(`/admin/login?error=${message}`, request.url));
    }

    const origin = new URL(request.url).origin;
    const state = makeState();
    const authUrl = createGoogleAuthUrl(origin, state);
    const response = NextResponse.redirect(authUrl);
    setGoogleStateCookie(response, state);
    return response;
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Google 로그인을 시작하지 못했습니다.');
    return NextResponse.redirect(new URL(`/admin/login?error=${message}`, request.url));
  }
}
