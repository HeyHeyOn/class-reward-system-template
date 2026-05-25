import { NextResponse } from 'next/server';
import { isGeneratorDeployment } from '@/server/deploymentMode';
import {
  consumeGoogleStateCookie,
  exchangeGoogleCodeForSession,
  setGoogleSessionCookie,
} from '@/server/googleOAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const response = NextResponse.redirect(new URL(isGeneratorDeployment() ? '/admin/generator?step=google' : '/admin', request.url));

  try {
    if (!code) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Google 인증 코드가 없습니다.');
    if (!consumeGoogleStateCookie(request, response, state)) throw new Error('Google 로그인 상태값이 올바르지 않습니다. 다시 로그인해 주세요.');

    const session = await exchangeGoogleCodeForSession(url.origin, code);
    setGoogleSessionCookie(response, session);
    return response;
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Google 로그인에 실패했습니다.');
    const errorPath = isGeneratorDeployment() ? `/admin/generator?error=${message}` : `/admin/login?error=${message}`;
    return NextResponse.redirect(new URL(errorPath, request.url));
  }
}
