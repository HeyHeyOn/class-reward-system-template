import { NextResponse } from 'next/server';
import { createGoogleAuthUrl, makeState, setGoogleStateCookie } from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
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
