import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getActivePromotions } from '@/server/repositories/sheets/promotionQueries';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionQueries', () => ({ getActivePromotions: vi.fn() }));
vi.mock('@/server/repositories/configuredCatalog', () => ({ createConfiguredCatalogReader: vi.fn() }));

describe('GET /api/promotions/active', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is public, uses the configured catalog, and returns only the active query DTOs', async () => {
    const request = new Request('http://localhost/api/promotions/active');

    const promotions = [{ promotionId: 'ACTIVE', isActive: true, productIds: ['P001'] }];
    const catalog = { getActivePromotions: vi.fn(async () => promotions) };
    vi.mocked(createConfiguredCatalogReader).mockResolvedValue(catalog as never);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-server-now')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(createConfiguredCatalogReader).toHaveBeenCalledWith(request);
    expect(catalog.getActivePromotions).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getActivePromotions).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(promotions);
  });

  it('returns an empty list when optional promotion sheets are missing', async () => {
    vi.mocked(createConfiguredCatalogReader).mockResolvedValue({
      getActivePromotions: vi.fn(async () => []),
    } as never);

    const response = await GET(new Request('http://localhost/api/promotions/active'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('logs malformed/provider failures and returns a sanitized Korean 500 without raw details', async () => {
    const error = new Error('private credential: Promotions 필수 컬럼 type');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredCatalogReader).mockResolvedValue({
      getActivePromotions: vi.fn(async () => { throw error; }),
    } as never);

    const response = await GET(new Request('http://localhost/api/promotions/active'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '진행 중인 행사를 불러오지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain('private credential');
    expect(consoleError).toHaveBeenCalledWith('Failed to get active promotions', error);
  });
});
