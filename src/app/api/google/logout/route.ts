import { NextResponse } from 'next/server';
import { clearGoogleSessionCookie } from '@/server/googleOAuth';
import { ADMIN_SESSION_COOKIE } from '@/server/adminAuth';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearGoogleSessionCookie(response);
  response.cookies.set(ADMIN_SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
