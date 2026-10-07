// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// These throw on module evaluation, not just on a provider request. A PostgreSQL
// route must compose successfully without loading any legacy writer or SDK.
vi.mock('@/server/googleSheets', () => { throw new Error('Eager Sheets SDK import'); });
vi.mock('@/server/sheetsRepository', () => { throw new Error('Eager legacy repository import'); });
vi.mock('@/server/repositories/sheets/promotionQueries', () => { throw new Error('Eager Sheets promotion read'); });
vi.mock('@/server/repositories/sheets/promotionCommands', () => { throw new Error('Eager Sheets promotion write'); });
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => { throw new Error('Eager Sheets task history'); });

describe('PostgreSQL composition isolates the legacy implementation', () => {
  it('loads every configured composition root without evaluating Sheets modules', async () => {
    const roots = import.meta.glob('./configured*.ts');
    const modules = Object.entries(roots).filter(([path]) => !path.includes('.test.'));
    expect(modules.length).toBeGreaterThan(20);
    for (const [path, load] of modules) {
      await expect(load(), path).resolves.toBeDefined();
    }
  }, 30_000);

  it('keeps shared settings, password verification and checkout hashing independent', async () => {
    const settings = await import('@/server/settings');
    const auth = await import('@/server/adminAuth');
    const checkout = await import('@/server/checkoutService');
    expect(settings.normalizeCurrencyUnit(' 별 ')).toBe('별');
    const hash = auth.createAdminPasswordHash('test-only-password');
    expect(await auth.verifyAdminPasswordHashAsync('test-only-password', hash)).toBe(true);
    expect(typeof checkout.createCheckoutPayloadHash).toBe('function');
  });
});
