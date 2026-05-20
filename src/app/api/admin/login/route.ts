import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, createSignedAdminSessionToken, verifyAdminPasswordWithSettings } from '@/server/adminAuth';
import { createConfiguredSheetsReader } from '@/server/googleSheets';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const rawPassword = typeof body.password === 'string' ? body.password : '';
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
