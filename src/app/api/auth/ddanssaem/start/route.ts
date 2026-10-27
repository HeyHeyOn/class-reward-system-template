import { NextResponse } from 'next/server';
import { clearGoogleSessionCookie, getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { HUB_CALLBACK_PATH, HUB_LOGIN_COOKIE, HUB_LOGIN_MAX_AGE_SECONDS, hubLoginEnabled, startHubLogin } from '@/server/ddanssaem/hub';
import { HUB_TRIED_COOKIE, HUB_TRIED_MAX_AGE_SECONDS, hubSignInState } from '@/server/ddanssaem/teacherGate';
import { endRequestTeacherSessions } from '@/server/teacherSession';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

/**
 * 1-1: sign in through the 딴쌤 hub; `next` is where to come back to in this app, `prompt=none` asks quietly.
 * 8-3: when the hub's hint says this browser signed out there, or signed in as another hub session, the class
 * session here ends first.
 */
export async function GET(request: Request) {
  if (!hubLoginEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(request.url);
  const silent = url.searchParams.get('prompt') === 'none';
  try {
    const { authorizeUrl, cookie } = startHubLogin(url.origin, url.searchParams.get('next') ?? '/classes', process.env, Date.now(), { silent });
    const response = NextResponse.redirect(authorizeUrl);
    const secure = process.env.NODE_ENV === 'production';
    response.cookies.set(HUB_LOGIN_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure, path: HUB_CALLBACK_PATH, maxAge: HUB_LOGIN_MAX_AGE_SECONDS });
    if (silent) response.cookies.set(HUB_TRIED_COOKIE, '1', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: HUB_TRIED_MAX_AGE_SECONDS });
    const session = getGoogleSessionFromRequest(request);
    const state = session ? hubSignInState(session, request.headers.get('cookie')) : 'UNKNOWN';
    if (state === 'SIGNED_OUT' || state === 'OTHER') {
      try {
        await endRequestTeacherSessions(request);
      } catch (error) {
        logFailure('[ddanssaem] class session could not be ended', error);
      }
      clearGoogleSessionCookie(response);
    }
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (error) {
    logFailure('[ddanssaem] sign-in could not start', error);
    return NextResponse.redirect(new URL('/classes?login_error=start', request.url));
  }
}
