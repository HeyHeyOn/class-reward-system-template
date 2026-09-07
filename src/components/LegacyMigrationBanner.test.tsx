import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyMigrationBanner } from './LegacyMigrationBanner';
import { LegacyMigrationNotice } from '@/server/LegacyMigrationNotice';
import { readFileSync } from 'node:fs';

const navigation = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
const runtime = vi.hoisted(() => ({ connection: vi.fn(async () => undefined) }));
vi.mock('next/server', () => ({ connection: runtime.connection }));
afterEach(() => { cleanup(); navigation.pathname = '/'; vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('legacy migration notice', () => {
  it('is wired once into the root layout', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(layout).toContain('<LegacyMigrationNotice />');
    expect(layout).toContain('<Suspense');
  });
  it('renders runtime config with a user-initiated, no-referrer central link, not a redirect', async () => {
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    vi.stubEnv('MIGRATION_CENTRAL_TARGET_URL', 'https://central.example/c/class-a');
    window.history.replaceState({}, '', '/bank?qr=private&next=https://evil.example');
    render(await LegacyMigrationNotice());
    expect(runtime.connection).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('읽기 전용');
    const link = screen.getByRole('link', { name: '중앙 서비스로 이동' });
    expect(link.getAttribute('href')).toBe('https://central.example/c/class-a');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(window.location.search).toContain('qr=private');
    expect(document.querySelector('form, iframe, img, meta[http-equiv="refresh"]')).toBeNull();
  });
  it('keeps the banner when a malicious target is rejected without rendering the input', async () => {
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    vi.stubEnv('MIGRATION_CENTRAL_TARGET_URL', 'javascript:alert("private")');
    render(await LegacyMigrationNotice());
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.innerHTML).not.toContain('private');
  });
  it('renders nothing when unset', async () => {
    vi.stubEnv('MIGRATION_READ_ONLY', undefined);
    render(await LegacyMigrationNotice());
    expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(['/c/class-a', '/c/class-a/bank', '/c/class-a/admin', '/classes', '/admin/generator'])('does not claim %s is a frozen legacy class', path => {
    navigation.pathname = path;
    render(<LegacyMigrationBanner mode={{ readOnly: true, centralTargetUrl: 'https://central.example/c/class-a' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(['/', '/bank', '/admin', '/admin/login', '/admin/students'])('covers legacy UI %s', path => {
    navigation.pathname = path;
    render(<LegacyMigrationBanner mode={{ readOnly: true, centralTargetUrl: null }} />);
    expect(screen.getByRole('status').textContent).toContain('조회는 계속');
  });
});
