import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

describe('proxy deployment routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['/admin', '/admin/login', '/admin/manage', '/admin/student-qrs', '/bank'])(
    'returns 404 for system page route %s in generator-only deployment',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await proxy(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it('keeps the generator page available in generator-only deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    const response = await proxy(new NextRequest('https://class-store-generator.vercel.app/admin/generator'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each(['/api/admin/login', '/api/admin/logout', '/api/bank/balance', '/api/products', '/api/students', '/api/settings'])(
    'returns 404 for system API route %s in generator-only deployment',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await proxy(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it.each(['/api/google/session', '/api/google/login', '/api/generator/create'])(
    'keeps generator API route %s available in generator-only deployment',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await proxy(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it('returns 404 for generator page routes in system deployments before admin auth', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');

    const response = await proxy(new NextRequest('https://class-store.vercel.app/admin/generator'));

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('returns 404 for generator APIs in system deployments', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');

    const response = await proxy(new NextRequest('https://class-store.vercel.app/api/generator/create'));

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });
});


describe('PostgreSQL unscoped page recovery', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['/', '/admin', '/admin/login', '/admin/manage', '/admin/transactions', '/bank'])('redirects %s to class selection even with an existing Google session', async (path) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('CLASS_STORE_DEFAULT_TENANT_SLUG', '');
    const response = await proxy(new NextRequest(`https://class-store.example${path}?next=/admin`, {
      headers: { cookie: 'class_store_google_auth=existing-session' },
    }));
    expect(response.headers.get('location')).toBe('https://class-store.example/classes');
  });

  it.each(['/c/alpha/admin', '/c/alpha/admin/login', '/api/google/login', '/api/c/alpha/settings', '/classes'])('preserves scoped/platform route %s', async (path) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    const response = await proxy(new NextRequest(`https://class-store.example${path}`));
    expect(response.headers.get('location')).toBeNull();
  });

  it('keeps an explicitly configured default class redirect', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('CLASS_STORE_DEFAULT_TENANT_SLUG', 'alpha');
    const response = await proxy(new NextRequest('https://class-store.example/admin'));
    expect(response.headers.get('location')).toBe('https://class-store.example/c/alpha/admin');
  });

  it('preserves legacy Sheets entry routing', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const response = await proxy(new NextRequest('https://class-store.example/'));
    expect(response.headers.get('location')).toBeNull();
  });
});
