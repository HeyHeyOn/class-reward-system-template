import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { openAdminMenu } from './testing/adminUi';

const moduleLoads = vi.hoisted(() => ({ transactions: 0, promotions: 0 }));

// Keep the real panels; observe module evaluation separately from their API requests.
vi.mock('./TransactionsPage', async (importOriginal) => {
  moduleLoads.transactions += 1;
  return importOriginal();
});
vi.mock('./promotions/PromotionAdminPanel', async (importOriginal) => {
  moduleLoads.promotions += 1;
  return importOriginal();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads optional panel code on first use and retains unsaved state across menu changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/students' || path === '/api/tasks?includeInactive=1' || path === '/api/transactions') {
      return Response.json([]);
    }
    if (path === '/api/products?includeInactive=1') return Response.json({ products: [], mutationPreconditions: [] });
    if (path === '/api/promotions') return Response.json({ promotions: [], mutationPreconditions: [] });
    if (path === '/api/settings') return Response.json({ currencyUnit: '별' });
    return Response.json({ error: 'Unexpected test request' }, { status: 404 });
  }));
  render(<AdminManagePage />);
  await screen.findByRole('heading', { name: '학급 보상 시스템' });
  expect(moduleLoads).toEqual({ transactions: 0, promotions: 0 });

  await openAdminMenu('매점');
  expect(moduleLoads).toEqual({ transactions: 0, promotions: 0 });
  fireEvent.click(screen.getByRole('tab', { name: '행사 관리' }));
  const promotionName = await screen.findByLabelText('행사명');
  fireEvent.change(promotionName, { target: { value: '아직 저장하지 않은 행사' } });
  expect(moduleLoads).toEqual({ transactions: 0, promotions: 1 });
  fireEvent.click(screen.getByRole('tab', { name: '상품·재고' }));
  fireEvent.click(screen.getByRole('tab', { name: '행사 관리' }));
  expect(screen.getByLabelText('행사명')).toHaveProperty('value', '아직 저장하지 않은 행사');

  await openAdminMenu('거래 내역');
  const transactionSearch = await screen.findByRole('searchbox', { name: '거래 검색' });
  fireEvent.change(transactionSearch, { target: { value: '학생 검색어' } });
  expect(moduleLoads).toEqual({ transactions: 1, promotions: 1 });
  await waitFor(() => expect(screen.queryByRole('status', { name: '거래 내역 불러오는 중' })).toBeNull());

  await openAdminMenu('홈');
  await openAdminMenu('거래 내역');
  expect(screen.getByRole('searchbox', { name: '거래 검색' })).toHaveProperty('value', '학생 검색어');
  expect(moduleLoads).toEqual({ transactions: 1, promotions: 1 });
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/promotions')).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/transactions')).toHaveLength(1);
});
