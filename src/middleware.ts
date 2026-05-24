import { NextRequest, NextResponse } from 'next/server';
import { isGeneratorDeployment, isSystemDeployment } from '@/server/deploymentMode';

const ADMIN_SESSION_COOKIE = 'class_store_admin';
const GOOGLE_AUTH_COOKIE = 'class_store_google_auth';
const SESSION_VERSION = 'v1';
const SIGNED_SESSION_VERSION = 'v2';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isGeneratorDeployment() && isGeneratorBlockedRoute(pathname)) {
    return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
  }

  if (isGeneratorDeployment() && pathname.startsWith('/api/') && isGeneratorBlockedApi(pathname)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (isSystemDeployment() && pathname === '/admin/generator') {
    return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
  }

  if (isSystemDeployment() && pathname.startsWith('/api/generator/')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!pathname.startsWith('/admin') || pathname === '/admin/login') {
    return NextResponse.next();
  }

  const adminToken = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (adminToken && (await isValidAdminSession(adminToken))) return NextResponse.next();

  const googleOAuthEnabled = Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
  if (googleOAuthEnabled && request.cookies.get(GOOGLE_AUTH_COOKIE)?.value) return NextResponse.next();

  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if (!googleOAuthEnabled && !adminPassword) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/admin/login';
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/admin/:path*', '/bank', '/api/:path*'],
};

function isGeneratorBlockedRoute(pathname: string): boolean {
  if (pathname === '/admin/generator') return false;
  return pathname === '/bank' || pathname === '/admin' || pathname === '/admin/login' || pathname.startsWith('/admin/');
}

function isGeneratorBlockedApi(pathname: string): boolean {
  return !pathname.startsWith('/api/google/') && !pathname.startsWith('/api/generator/');
}

async function isValidAdminSession(token: string): Promise<boolean> {
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if (adminPassword && token === `${SESSION_VERSION}.${await sha256(adminPassword)}`) return true;

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== SIGNED_SESSION_VERSION) return false;
  const [version, issuedAt, passwordHash, signature] = parts;
  if (!/^\d+$/.test(issuedAt) || !/^[a-f0-9]{64}$/.test(passwordHash)) return false;
  const ageMs = Date.now() - Number(issuedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 1000 * 60 * 60 * 12) return false;
  const expected = await hmacSha256(`${version}.${issuedAt}.${passwordHash}`, process.env.AUTH_SECRET?.trim() || adminPassword || 'class-store-dev-secret');
  return expected === signature;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
