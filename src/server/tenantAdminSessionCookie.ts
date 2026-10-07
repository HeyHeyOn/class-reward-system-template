import type { NextResponse } from 'next/server';

export const TENANT_ADMIN_SESSION_COOKIE = 'class_store_tenant_admin';

export function parseTenantAdminSessionToken(token: string): { raw: string; sessionVersion: number } | null {
  if (token.length > 512) return null;
  const parts = token.split('.');
  const version = Number(parts[1]);
  if (parts.length !== 3 || parts[0] !== 'csa1' || !/^[1-9][0-9]*$/.test(parts[1])
    || !Number.isSafeInteger(version) || version > 2147483647 || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  return { raw: parts[2], sessionVersion: version };
}

export function readTenantAdminSessionCookie(request: Request): string | undefined {
  // Match the compatibility authorizer: the last well-formed value wins.
  let token: string | undefined;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== TENANT_ADMIN_SESSION_COOKIE) continue;
    try { token = decodeURIComponent(value.join('=')); } catch { /* Ignore malformed cookies. */ }
  }
  return token;
}

export function clearTenantAdminSessionCookie(response: NextResponse): void {
  response.cookies.set(TENANT_ADMIN_SESSION_COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
  });
}
