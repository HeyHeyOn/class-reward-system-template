import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, createSignedAdminSessionToken, verifyAdminPasswordWithSettings } from '@/server/adminAuth';
import { createConfiguredSheetsReader } from '@/server/googleSheets';

export async function POST(request: Request) {
  // PostgreSQL classes: administrators sign in with Google only. Password and QR logins came from
  // the Google Sheets edition, which had no social login.
  if (process.env.CLASS_STORE_STORAGE === 'postgresql') {
    return Response.json({ error: '학급 관리자는 Google 계정으로 로그인해 주세요.', code: 'GOOGLE_LOGIN_REQUIRED' }, { status: 410 });
  }

  const body = (await request.json().catch(() => ({}))) as { password?: unknown; kind?: unknown; value?: unknown };
  const candidate = typeof body.password === 'string'
    ? body.password
    : (body.kind === 'password' || body.kind === 'qr') && typeof body.value === 'string' ? body.value : '';
  const rawPassword = candidate;
  const password = rawPassword.startsWith('class-store-admin:') ? rawPassword.slice('class-store-admin:'.length) : rawPassword;
  const reader = await createConfiguredSheetsReader().catch(() => undefined);

  if (!(await verifyAdminPasswordWithSettings(password, reader))) {
    return Response.json({ error: '관리자 비밀번호가 올바르지 않습니다.' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, createSignedAdminSessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return response;
}
