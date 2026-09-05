import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, createSignedAdminSessionToken, verifyAdminPasswordWithSettings } from '@/server/adminAuth';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionTenantLegacyAdminAuth } from '@/server/tenantLegacyAdminAuth';

export const TENANT_ADMIN_SESSION_COOKIE = 'class_store_tenant_admin';

export async function POST(request: Request) {
  if (process.env.CLASS_STORE_STORAGE === 'postgresql') {
    const trusted = getOptionalTrustedTenantRequestContext();
    if (!trusted) return Response.json({ error: 'Not found.' }, { status: 404 });
    if (!isStrictJsonRequest(request)) {
      return Response.json({ error: 'Invalid request.' }, { status: 400 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!isTenantCredentialBody(body)) {
      return Response.json({ error: 'Invalid request.' }, { status: 400 });
    }
    try {
      const session = await getProductionTenantLegacyAdminAuth().login(body);
      const response = NextResponse.json({ ok: true });
      response.cookies.set(TENANT_ADMIN_SESSION_COOKIE, session.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: 60 * 60 * 12,
      });
      return response;
    } catch {
      return Response.json({ error: '관리자 자격 증명이 올바르지 않습니다.' }, { status: 401 });
    }
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

function isStrictJsonRequest(request: Request): boolean {
  return new URL(request.url).search === ''
    && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '');
}

function isTenantCredentialBody(value: unknown): value is { kind: 'password' | 'qr'; value: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 2
    && Object.hasOwn(body, 'kind') && Object.hasOwn(body, 'value')
    && (body.kind === 'password' || body.kind === 'qr')
    && typeof body.value === 'string';
}
