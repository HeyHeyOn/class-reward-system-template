import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

describe('middleware deployment routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['/admin', '/admin/login', '/admin/manage', '/admin/student-qrs', '/bank'])(
    'redirects generator-only deployment route %s back to the generator page',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await middleware(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://class-store-generator.vercel.app/admin/generator');
    },
  );

  it('keeps the generator page available in generator-only deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    const response = await middleware(new NextRequest('https://class-store-generator.vercel.app/admin/generator'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each(['/api/admin/login', '/api/admin/logout', '/api/bank/balance', '/api/products', '/api/students', '/api/settings'])(
    'returns 404 for system API route %s in generator-only deployment',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await middleware(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it.each(['/api/google/session', '/api/google/login', '/api/generator/create'])(
    'keeps generator API route %s available in generator-only deployment',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

      const response = await middleware(new NextRequest(`https://class-store-generator.vercel.app${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    },
  );
});
