import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/server/adminAuth';
import { clearGeneratorGrantCookie, clearGoogleSessionCookie } from '@/server/googleOAuth';
import { clearTenantAdminSessionCookie, readTenantAdminSessionCookie } from '@/server/tenantAdminSessionCookie';

/** Both logout entry points end all administrator authentication in this browser. */
export async function logoutAdministrator(request: Request): Promise<NextResponse> {
  if (process.env.CLASS_STORE_STORAGE === 'postgresql' && readTenantAdminSessionCookie(request)) {
    try {
      const { revokeTenantAdminSessionFromRequest } = await import('@/server/tenantAdminLogout');
      await revokeTenantAdminSessionFromRequest(request);
    } catch {
      // Preserve the bearer cookie for a retry; never report a successful
      // logout while its server-side revocation is unconfirmed.
      return NextResponse.json({ error: '로그아웃하지 못했습니다. 다시 시도해 주세요.' }, {
        status: 503, headers: { 'cache-control': 'no-store' },
      });
    }
  }
  const response = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  clearGoogleSessionCookie(response);
  clearGeneratorGrantCookie(response);
  clearTenantAdminSessionCookie(response);
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0,
  });
  return response;
}
