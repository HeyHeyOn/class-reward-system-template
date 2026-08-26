import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getActivePromotions } from '@/server/repositories/sheets/promotionQueries';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionQueries', () => ({ getActivePromotions: vi.fn() }));

describe('GET /api/promotions/active', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is public, uses the request-aware reader, and returns only the active query DTOs', async () => {
    const request = new Request('http://localhost/api/promotions/active');
    const reader = {};
    const promotions = [{ promotionId: 'ACTIVE', isActive: true, productIds: ['P001'] }];
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue(reader as never);
    vi.mocked(getActivePromotions).mockResolvedValue(promotions as never);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(getActivePromotions).toHaveBeenCalledWith(reader);
    await expect(response.json()).resolves.toEqual(promotions);
  });

  it('returns an empty list when optional promotion sheets are missing', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getActivePromotions).mockResolvedValue([]);

    const response = await GET(new Request('http://localhost/api/promotions/active'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('logs malformed/provider failures and returns a sanitized Korean 500 without raw details', async () => {
    const error = new Error('private credential: Promotions 필수 컬럼 type');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getActivePromotions).mockRejectedValue(error);

    const response = await GET(new Request('http://localhost/api/promotions/active'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '진행 중인 행사를 불러오지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain('private credential');
    expect(consoleError).toHaveBeenCalledWith('Failed to get active promotions', error);
  });
});
