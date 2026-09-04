import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { TENANT_ROUTE_INVENTORY } from '@/server/repositories/routeInventory';

vi.mock('server-only', () => ({}));

describe('tenant scoped route surface', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['src/app/classes/page.tsx'],
    ['src/app/c/[slug]/layout.tsx'],
    ['src/app/c/[slug]/page.tsx'],
    ['src/app/c/[slug]/bank/page.tsx'],
    ['src/app/c/[slug]/admin/page.tsx'],
    ['src/app/c/[slug]/admin/[...path]/page.tsx'],
  ])('provides route file %s', async (file) => {
    await expect(access(resolve(process.cwd(), file))).resolves.toBeUndefined();
  });

  it('covers every tenant-data API method/path in the scoped dispatcher allowlist', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/app/api/c/[slug]/[...path]/route.ts'), 'utf8');
    const actual = Array.from(source.matchAll(/route\('([^']+)',\s*'([^']+)'/g),
      (match) => `${match[1]} /${match[2]}`).sort();
    const expected = TENANT_ROUTE_INVENTORY
      .filter((entry) => entry.scope === 'tenant-data')
      .map((entry) => `${entry.method} ${entry.route}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  it.each([
    ['/', '/c/default-class'],
    ['/bank', '/c/default-class/bank'],
    ['/admin', '/c/default-class/admin'],
    ['/admin/transactions', '/c/default-class/admin/transactions'],
  ])('redirects compatibility route %s to explicit default tenant', async (path, target) => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
    vi.stubEnv('CLASS_STORE_DEFAULT_TENANT_SLUG', 'default-class');

    const response = await proxy(new NextRequest(`https://example.test${path}?keep=1`));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`https://example.test${target}?keep=1`);
  });

  it('does not guess a compatibility tenant when no default is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');

    const response = await proxy(new NextRequest('https://example.test/bank'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('canonically redirects mixed-case scoped slugs without changing the rest of the URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');

    const response = await proxy(new NextRequest('https://example.test/c/Alpha-Class/admin/settings?tab=theme'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location'))
      .toBe('https://example.test/c/alpha-class/admin/settings?tab=theme');
  });

  it('fails closed with 404 for an invalid scoped slug', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');

    const response = await proxy(new NextRequest('https://example.test/c/alpha_class/admin'));

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('does not redirect generator root through a tenant', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    vi.stubEnv('CLASS_STORE_DEFAULT_TENANT_SLUG', 'default-class');

    const response = await proxy(new NextRequest('https://example.test/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
