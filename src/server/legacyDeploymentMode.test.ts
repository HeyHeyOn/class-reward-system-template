// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLegacyDeploymentMode, legacyWriteFreezeResponse } from './legacyDeploymentMode';
import { runWithTrustedTenantRequestContext } from './trustedTenantRequestContext';
vi.mock('server-only', () => ({}));
afterEach(() => vi.unstubAllEnvs());

describe('legacy deployment policy', () => {
  it.each([undefined, '', 'false'])('keeps normal operation for %s', flag => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: flag })).toEqual({ readOnly: false, centralTargetUrl: null });
  });
  it('enables freeze only by explicit true without needing a target', () => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: 'true' })).toEqual({ readOnly: true, centralTargetUrl: null });
  });
  it.each(['TRUE', '1', 'yes', ' true ', 'MIGRATION_READ_ONLY'])('fails closed on mistyped nonempty flag %s', flag => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: flag }).readOnly).toBe(true);
  });
  it('does not freeze central PostgreSQL deployment authority', () => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: 'true', CLASS_STORE_STORAGE: 'postgresql' }).readOnly).toBe(false);
  });
  it('does not override trusted active tenant routing even on a legacy deployment', () => {
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const result = runWithTrustedTenantRequestContext({ tenant: {
      id: '10000000-0000-4000-8000-000000000001', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul',
    } }, () => legacyWriteFreezeResponse());
    expect(result).toBeNull();
  });
  it('keeps generator Sheets creation frozen even if platform DB storage is configured', () => {
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    expect(legacyWriteFreezeResponse('generator-sheets')?.status).toBe(503);
  });
  it('accepts only a server-configured canonical HTTPS tenant landing page', () => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: 'true', MIGRATION_CENTRAL_TARGET_URL: 'https://central.example/c/class-a' }))
      .toEqual({ readOnly: true, centralTargetUrl: 'https://central.example/c/class-a' });
  });
  it('hides target before freeze', () => {
    expect(getLegacyDeploymentMode({ MIGRATION_CENTRAL_TARGET_URL: 'https://central.example/c/class-a' }).centralTargetUrl).toBeNull();
  });
  it.each([
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/c/a',
    'http://central.example/c/a', 'https://user:password@central.example/c/a',
    'https://central.example/c/a?qr=private', 'https://central.example/c/a#credential',
    'https://central.example/c/a?', 'https://central.example/c/a#',
    'https://central.example/c/%61', 'https://central.example/c/a/../b',
    'https://central.example/c/a/admin', 'https://central.example/c/a/', 'https://central.example/c/UPPER',
    'https://central.example/c/a\\evil', 'https://central.example/c/<script>',
    ' https://central.example/c/a', 'https://central.example/c/a\n',
    'https://central.example/c/a\u0000', 'https://central.example/redirect',
    'https://central.example/c/' + 'a'.repeat(64), 'https://central.example:443/c/a',
  ])('invalid target never weakens freeze or becomes a link: %s', target => {
    expect(getLegacyDeploymentMode({ MIGRATION_READ_ONLY: 'true', MIGRATION_CENTRAL_TARGET_URL: target }))
      .toEqual({ readOnly: true, centralTargetUrl: null });
  });
});
