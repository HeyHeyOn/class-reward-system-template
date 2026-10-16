import { NextResponse } from 'next/server';
import { clearPendingAgreementCookie, setGoogleSessionCookie } from '@/server/googleOAuth';
import { exchangeHubCode, HUB_AGREEMENT, HUB_CALLBACK_PATH, HUB_LOGIN_COOKIE, hubLoginEnabled, openHubLogin } from '@/server/ddanssaem/hub';
import { getProductionHubAccountStore } from '@/server/ddanssaem/hubAccounts';
import { HUB_TRIED_COOKIE, hubStartPath } from '@/server/ddanssaem/teacherGate';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { endRequestTeacherSessions } from '@/server/teacherSession';

export const dynamic = 'force-dynamic';

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

/** 1-3, 1-4: back from the hub. Check the state, trade the code for the teacher, start the class session. */
export async function GET(request: Request) {
  if (!hubLoginEnabled() || !teacherAccountsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const url = new URL(request.url);
  const login = openHubLogin(cookieValue(request, HUB_LOGIN_COOKIE));
  const finish = (location: string) => {
    const response = NextResponse.redirect(new URL(location, request.url));
    response.cookies.set(HUB_LOGIN_COOKIE, '', { path: HUB_CALLBACK_PATH, maxAge: 0 });
    response.headers.set('cache-control', 'no-store');
    return response;
  };
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  // 8-3: a quiet sign-in the hub could not finish (not signed in, or the terms to agree to) asks once with a prompt.
  if (login?.silent && url.searchParams.get('state') === login.state && (error === 'login_required' || error === 'consent_required')) {
    return finish(hubStartPath(login.next));
  }
  if (error || !code || !login || url.searchParams.get('state') !== login.state) {
    return finish(`/classes?login_error=${encodeURIComponent(error && /^[a-z_]{1,40}$/.test(error) ? error : 'state')}`);
  }
  try {
    const profile = await exchangeHubCode({ origin: url.origin, code, verifier: login.verifier });
    await endRequestTeacherSessions(request);
    const binding = await getProductionHubAccountStore().begin(profile);
    const response = finish(login.next);
    setGoogleSessionCookie(response, {
      subject: profile.sub, email: profile.email, ...(profile.name ? { name: profile.name } : {}),
      issuedAt: Date.now(), agreement: HUB_AGREEMENT, ...binding, hubSid: profile.sid,
    });
    clearPendingAgreementCookie(response);
    response.cookies.set(HUB_TRIED_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  } catch (failure) {
    console.error('[ddanssaem] sign-in failed', failure instanceof Error ? `${failure.name}: ${failure.message}` : 'unknown');
    return finish('/classes?login_error=exchange');
  }
}
