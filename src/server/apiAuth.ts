import { isAdminAuthEnabled, isValidAdminSession } from '@/server/adminAuth';
import { getGoogleSessionFromRequest, isGoogleOAuthEnabled } from '@/server/googleOAuth';

const ADMIN_SESSION_COOKIE = 'class_store_admin';

type ApiAuthEnv = {
  [key: string]: string | undefined;
  ADMIN_PASSWORD?: string;
  AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function isAuthorizedAdminRequest(request: Request, env: ApiAuthEnv = process.env): boolean {
  const googleOAuthEnabled = isGoogleOAuthEnabled(env);
  const adminAuthEnabled = isAdminAuthEnabled(env);
  const cookies = parseCookieHeader(request.headers.get('cookie') ?? '');
  const adminToken = cookies.get(ADMIN_SESSION_COOKIE);
  if (adminAuthEnabled && isValidAdminSession(adminToken, env)) return true;
  if (!adminAuthEnabled && !googleOAuthEnabled) return true;

  return googleOAuthEnabled && getGoogleSessionFromRequest(request, env) !== null;
}

export function unauthorizedAdminResponse(): Response {
  return Response.json({ error: '관리자 로그인이 필요합니다.' }, { status: 401 });
}

function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    try {
      cookies.set(rawKey, decodeURIComponent(rawValue.join('=')));
    } catch {
      continue;
    }
  }
  return cookies;
}
