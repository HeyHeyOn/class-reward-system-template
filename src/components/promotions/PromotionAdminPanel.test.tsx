import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Product, Promotion } from '@/domain/types';
import {
  PromotionAdminPanel,
  comparePromotions,
  formatPromotionContent,
  formatPromotionPeriod,
  parsePromotionResponse,
  zonedDatetimeLocalToIso,
  isoToZonedDatetimeLocal,
} from './PromotionAdminPanel';

const products: Product[] = [
  { productId: 'P001', name: '연필', price: 1_000, stock: 10, isActive: true, sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, sortOrder: 2 },
];
const base = {
  description: '설명', productIds: ['P001'], startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true, sortOrder: 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', schemaVersion: 3,
};
const percent: Promotion = { ...base, promotionId: 'PROMO-PCT', name: '기존 10% 할인', type: 'PERCENT_DISCOUNT', percent: 10 };
const nPlusOne: Promotion = { ...base, promotionId: 'PROMO-N', name: '연필 2+1', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 2 };

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function renderPanel() {
  return render(<PromotionAdminPanel products={products} currencyUnit="별" timeZone="Asia/Seoul" />);
}
async function load(promotions: Promotion[] = []) {
  const fetchMock = vi.fn(async () => response(promotions));
  vi.stubGlobal('fetch', fetchMock);
  renderPanel();
  await screen.findByRole('heading', { name: '행사 만들기' });
  return fetchMock;
}
function fillCommon(name = '새 행사') {
  fireEvent.change(screen.getByLabelText('행사명'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('행사 설명'), { target: { value: '새 설명' } });
  fireEvent.change(screen.getByLabelText('시작 일시'), { target: { value: '2026-08-10T09:30' } });
  fireEvent.change(screen.getByLabelText('종료 일시'), { target: { value: '2026-08-20T18:00' } });
  fireEvent.change(screen.getByLabelText('정렬 우선순위'), { target: { value: '7' } });
  fireEvent.click(screen.getByLabelText('연필 (P001) 대상'));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('datetime-local helpers', () => {
  it('converts an Asia/Seoul wall clock to the corresponding instant and back', () => {
    expect(zonedDatetimeLocalToIso('2026-08-10T09:30', 'Asia/Seoul')).toBe('2026-08-10T00:30:00.000Z');
    expect(isoToZonedDatetimeLocal('2026-08-10T00:30:00.000Z', 'Asia/Seoul')).toBe('2026-08-10T09:30');
  });

  it('rejects an ambiguous DST overlap while converting a normal wall time', () => {
    expect(zonedDatetimeLocalToIso('2026-11-01T01:30', 'America/New_York')).toBeNull();
    expect(zonedDatetimeLocalToIso('2026-11-01T03:30', 'America/New_York')).toBe('2026-11-01T08:30:00.000Z');
  });

  it('rejects invalid wall dates, invalid zones, DST gaps, and noncanonical instants', () => {
    expect(zonedDatetimeLocalToIso('2026-02-30T09:30', 'Asia/Seoul')).toBeNull();
    expect(zonedDatetimeLocalToIso('2026-08-10T09:30', 'Not/A_Zone')).toBeNull();
    expect(zonedDatetimeLocalToIso('2026-03-08T02:30', 'America/New_York')).toBeNull();
    expect(isoToZonedDatetimeLocal('not-a-date', 'Asia/Seoul')).toBe('');
    expect(isoToZonedDatetimeLocal('2026-08-10T00:30:00Z', 'Asia/Seoul')).toBe('');
    expect(isoToZonedDatetimeLocal('2026-08-10T00:30:00.000Z', 'Not/A_Zone')).toBe('');
  });
});

describe('promotion response validation and ordering', () => {
  it('accepts every exact promotion union member including fractional percent', () => {
    expect(parsePromotionResponse(percent)).toEqual(percent);
    expect(parsePromotionResponse(nPlusOne)).toEqual(nPlusOne);
    expect(parsePromotionResponse({ ...base, promotionId: 'PRICE', name: '가격', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 0 })).toBeTruthy();
    expect(parsePromotionResponse({ ...base, promotionId: 'FIXED', name: '정액', type: 'FIXED_DISCOUNT', discountAmount: 1 })).toBeTruthy();
    expect(parsePromotionResponse({ ...percent, percent: 12.5 })).toMatchObject({ percent: 12.5 });
  });

  it.each([
    ['blank promotion id', { ...percent, promotionId: '   ' }],
    ['blank name', { ...percent, name: '' }],
    ['non-string description', { ...percent, description: null }],
    ['blank product id', { ...percent, productIds: [' '] }],
    ['duplicate product id', { ...percent, productIds: ['P001', 'P001'] }],
    ['unknown type', { ...percent, type: 'UNKNOWN' }],
    ['zero percent', { ...percent, percent: 0 }],
    ['infinite percent', { ...percent, percent: Infinity }],
    ['fractional quantity', { ...nPlusOne, buyQuantity: 1.5 }],
    ['invalid canonical start', { ...percent, startsAt: '2026-08-01T00:00:00Z' }],
    ['equal period', { ...percent, endsAt: percent.startsAt }],
    ['nonboolean active', { ...percent, isActive: 'true' }],
    ['unsafe sort order', { ...percent, sortOrder: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid created timestamp', { ...percent, createdAt: 'bad' }],
    ['wrong schema', { ...percent, schemaVersion: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(parsePromotionResponse(value)).toBeNull();
  });

  it('orders by sortOrder then raw UTF-16 promotionId', () => {
    const values = [
      { ...percent, promotionId: '😀', sortOrder: 1 },
      { ...percent, promotionId: 'a', sortOrder: 2 },
      { ...percent, promotionId: 'Z', sortOrder: 1 },
    ];
    expect(values.sort(comparePromotions).map((value) => value.promotionId)).toEqual(['Z', '😀', 'a']);
  });
});

describe('PromotionAdminPanel', () => {
  it('starts exactly one initial GET in React StrictMode', async () => {
    const fetchMock = vi.fn(async () => response([]));
    vi.stubGlobal('fetch', fetchMock);

    render(<StrictMode><PromotionAdminPanel products={products} currencyUnit="별" timeZone="Asia/Seoul" /></StrictMode>);

    await screen.findByText('등록된 행사가 없습니다.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });
  });

  it('keeps a created promotion when the initial GET resolves stale after the POST', async () => {
    const initial = deferred<Response>();
    const created: Promotion = { ...base, promotionId: 'PROMO-NEW', name: '새 행사', description: '새 설명', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 7 };
    const fetchMock = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce(response(created, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fillCommon();
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    expect(await screen.findByText('행사를 추가했습니다.')).toBeTruthy();

    initial.resolve(response([]));
    await waitFor(() => expect(screen.queryByRole('status', { name: '행사 목록 불러오는 중' })).toBeNull());
    expect(screen.getByText('새 행사')).toBeTruthy();
    expect(screen.getByTestId('promotion-row').textContent).not.toContain('PROMO-NEW');
  });

  it('keeps an edited promotion after a completed refresh without a redundant GET after PATCH', async () => {
    const refresh = deferred<Response>();
    const updated: Promotion = { ...percent, name: '수정 할인', percent: 15 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([percent]))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(response(updated));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fireEvent.click(screen.getByRole('button', { name: '행사 목록 새로고침' }));
    refresh.resolve(response([percent]));
    await screen.findByText('기존 10% 할인');
    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '수정 할인' } });
    fireEvent.change(within(dialog).getByLabelText('수정 할인율'), { target: { value: '15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    expect(await screen.findByText('행사를 수정했습니다.')).toBeTruthy();

    await waitFor(() => expect(screen.queryByRole('status', { name: '행사 목록 불러오는 중' })).toBeNull());
    expect(screen.getByText('수정 할인')).toBeTruthy();
    expect(screen.queryByText('기존 10% 할인')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('does not continue a pending POST after unmount when it %s', async (outcome) => {
    const mutation = deferred<Response>();
    const created: Promotion = { ...base, promotionId: 'PROMO-NEW', name: '새 행사', description: '새 설명', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 7 };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(response([])).mockReturnValueOnce(mutation.promise);
    vi.stubGlobal('fetch', fetchMock);
    const view = renderPanel();
    await screen.findByText('등록된 행사가 없습니다.');
    fillCommon();
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.unmount();
    if (outcome === 'resolve') mutation.resolve(response(created, 201));
    else mutation.reject(new Error('network failed'));
    await mutation.promise.catch(() => undefined);
    await act(async () => { await Promise.resolve(); });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not continue a pending activation PATCH after unmount', async () => {
    const mutation = deferred<Response>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent])).mockReturnValueOnce(mutation.promise);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    const view = renderPanel();
    await screen.findByText('기존 10% 할인');
    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 비활성화' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.unmount();
    mutation.resolve(response({ ...percent, isActive: false }));
    await mutation.promise;
    await act(async () => { await Promise.resolve(); });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('starts only one mutation for duplicate submit events in the same tick', async () => {
    const mutation = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(response([])).mockReturnValue(mutation.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('등록된 행사가 없습니다.');
    fillCommon();
    const form = screen.getByRole('button', { name: '행사 추가' }).closest('form');
    expect(form).toBeTruthy();

    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    mutation.resolve(response({ ...base, promotionId: 'PROMO-NEW', name: '새 행사', description: '새 설명', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 7 }, 201));
    await mutation.promise;
  });

  it.each([
    ['failure', response({ error: 'stale failure' }, 500)],
    ['success', response([nPlusOne])],
  ])('ignores an older load %s after a newer load succeeds', async (_case, staleResponse) => {
    const older = deferred<Response>();
    const newer = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '행사 목록 새로고침' }));
    newer.resolve(response([percent]));
    expect(await screen.findByText('기존 10% 할인')).toBeTruthy();

    older.resolve(staleResponse);
    await waitFor(() => expect(screen.getByText('기존 10% 할인')).toBeTruthy());
    expect(screen.queryByText('연필 2+1')).toBeNull();
    expect(screen.queryByText('stale failure')).toBeNull();
    expect(screen.queryByRole('status', { name: '행사 목록 불러오는 중' })).toBeNull();
  });

  it('does not update state after unmount when a load resolves', async () => {
    const pending = deferred<Response>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const view = renderPanel();
    view.unmount();

    pending.resolve(response([percent]));
    await pending.promise;
    await Promise.resolve();

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('shows loading, canonical-order list details, empty state, and safe retry errors', async () => {
    let resolve!: (value: Response) => void;
    const first = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ error: '<script>bad</script>' }, 500))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(screen.getByRole('status', { name: '행사 목록 불러오는 중' })).toBeTruthy();
    resolve(response([nPlusOne, percent]));
    const rows = await screen.findAllByTestId('promotion-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('기존 10% 할인'), expect.stringContaining('연필 2+1'),
    ]);
    expect(rows[1].textContent).toContain('연필');
    expect(rows[1].textContent).toContain('2개 구매 시 1개 무료');
    fireEvent.click(screen.getByRole('button', { name: '행사 목록 새로고침' }));
    expect((await screen.findByRole('alert')).textContent).toContain('<script>bad</script>');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('등록된 행사가 없습니다.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/promotions', { cache: 'no-store' });
  });

  it('rejects a GET response containing duplicate promotion IDs without rendering either row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([percent, { ...percent, name: '중복 ID 행사' }])));
    renderPanel();

    expect((await screen.findByRole('alert')).textContent).toContain('행사 목록 형식이 올바르지 않습니다.');
    expect(screen.queryAllByTestId('promotion-row')).toHaveLength(0);
  });

  it('fails the whole GET when any active or inactive array element is malformed', async () => {
    const malformedInactive = { ...percent, promotionId: 'BROKEN', isActive: false, schemaVersion: 1 };
    vi.stubGlobal('fetch', vi.fn(async () => response([percent, malformedInactive])));
    renderPanel();
    expect((await screen.findByRole('alert')).textContent).toContain('행사 목록 형식이 올바르지 않습니다.');
    expect(screen.queryAllByTestId('promotion-row')).toHaveLength(0);
  });

  it('switches exact rule fields and exposes product targeting checkboxes', async () => {
    await load();
    expect(screen.getByLabelText('구매 수량')).toBeTruthy();
    expect(screen.getByLabelText('무료 수량')).toBeTruthy();
    expect(screen.getByLabelText('연필 (P001) 대상')).toBeTruthy();
    expect(screen.getByLabelText('지우개 (P002) 대상')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'PROMOTIONAL_PRICE' } });
    expect(screen.getByLabelText('행사 단가')).toBeTruthy();
    expect(screen.queryByLabelText('구매 수량')).toBeNull();
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'PERCENT_DISCOUNT' } });
    expect(screen.getByLabelText('할인율')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'FIXED_DISCOUNT' } });
    expect(screen.getByLabelText('유료 수량당 할인액')).toBeTruthy();
  });

  it('creates with the exact type-specific payload and appends the returned promotion', async () => {
    const created: Promotion = { ...base, promotionId: 'PROMO-NEW', name: '새 행사', description: '새 설명', type: 'FIXED_DISCOUNT', discountAmount: 100, sortOrder: 7 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(created, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('등록된 행사가 없습니다.');
    fillCommon();
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'FIXED_DISCOUNT' } });
    fireEvent.change(screen.getByLabelText('유료 수량당 할인액'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    await screen.findByText('행사를 추가했습니다.');
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe('/api/promotions');
    expect(request[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      name: '새 행사', description: '새 설명', startsAt: '2026-08-10T00:30:00.000Z', endsAt: '2026-08-20T09:00:00.000Z',
      isActive: true, sortOrder: 7, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: ['P001'],
    });
    expect(screen.getByTestId('promotion-row').textContent).not.toContain('PROMO-NEW');
  });

  it('edits with a full exact payload and toggles activation with activation-only PATCH', async () => {
    const updated: Promotion = { ...percent, name: '수정 할인', percent: 15 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([percent]))
      .mockResolvedValueOnce(response(updated))
      .mockResolvedValueOnce(response({ ...updated, isActive: false }))
      .mockResolvedValueOnce(response(updated));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPanel();
    await screen.findByText('기존 10% 할인');
    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('수정 시작 일시')).toHaveProperty('value', '2026-08-01T09:00');
    expect(within(dialog).getByLabelText('수정 종료 일시')).toHaveProperty('value', '2026-09-01T09:00');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '수정 할인' } });
    fireEvent.change(within(dialog).getByLabelText('수정 할인율'), { target: { value: '15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    await screen.findByText('행사를 수정했습니다.');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/promotions/PROMO-PCT');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      name: '수정 할인', description: '설명', startsAt: base.startsAt, endsAt: base.endsAt, isActive: true,
      sortOrder: 1, type: 'PERCENT_DISCOUNT', percent: 15, productIds: ['P001'],
    });
    fireEvent.click(screen.getByRole('button', { name: '수정 할인 비활성화' }));
    await screen.findByText('행사를 비활성화했습니다.');
    expect(confirm).toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ isActive: false });
    fireEvent.click(screen.getByRole('button', { name: '수정 할인 재활성화' }));
    await screen.findByText('행사를 재활성화했습니다.');
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ isActive: true });
  });

  it('submits a fractional percentage exactly and exposes a non-integer step', async () => {
    const created: Promotion = { ...percent, promotionId: 'PROMO-12-5', name: '12.5 할인', percent: 12.5, sortOrder: 7 };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response(created, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('등록된 행사가 없습니다.');
    fillCommon('12.5 할인');
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'PERCENT_DISCOUNT' } });
    const percentInput = screen.getByLabelText('할인율');
    expect(percentInput.getAttribute('step')).toBe('any');
    fireEvent.change(percentInput, { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    await screen.findByText('행사를 추가했습니다.');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ type: 'PERCENT_DISCOUNT', percent: 12.5 });
  });

  it('does not append or replace list state when a successful save response is malformed', async () => {
    const malformedCreated = { ...percent, promotionId: 'BAD-CREATE', schemaVersion: 1 };
    const malformedUpdated = { ...percent, name: '망가진 수정', schemaVersion: 1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([percent]))
      .mockResolvedValueOnce(response(malformedCreated, 201))
      .mockResolvedValueOnce(response(malformedUpdated));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fillCommon('잘못된 생성 응답');
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    expect((await screen.findByRole('alert')).textContent).toContain('행사 응답 형식이 올바르지 않습니다.');
    expect(screen.queryByText('잘못된 생성 응답')).toBeNull();
    expect(screen.getAllByTestId('promotion-row')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '수정 시도' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('행사 응답 형식이 올바르지 않습니다.');
    expect(screen.getByText('기존 10% 할인')).toBeTruthy();
    expect(screen.queryByText('망가진 수정')).toBeNull();
  });

  it('rejects a create response whose ID already exists without mutating the list', async () => {
    const duplicate: Promotion = { ...percent, name: '중복 생성 응답' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent])).mockResolvedValueOnce(response(duplicate, 201));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fillCommon('새 행사 시도');
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));

    expect((await screen.findByRole('alert')).textContent).toContain('행사 응답 ID가 올바르지 않습니다.');
    expect(screen.getAllByTestId('promotion-row')).toHaveLength(1);
    expect(screen.getByText('기존 10% 할인')).toBeTruthy();
    expect(screen.queryByText('중복 생성 응답')).toBeNull();
  });

  it('rejects mismatched IDs returned by edit without replacing list state', async () => {
    const mismatched: Promotion = { ...nPlusOne, name: '잘못 바뀐 행사' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent])).mockResolvedValueOnce(response(mismatched));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '수정 시도' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('행사 응답 ID가 올바르지 않습니다.');
    expect(screen.getAllByTestId('promotion-row')).toHaveLength(1);
    expect(screen.getByText('기존 10% 할인')).toBeTruthy();
    expect(screen.queryByText('잘못 바뀐 행사')).toBeNull();
  });

  it('rejects a mismatched ID returned by activation toggle without mutating the row', async () => {
    const mismatched: Promotion = { ...nPlusOne, isActive: false };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent])).mockResolvedValueOnce(response(mismatched));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 비활성화' }));

    expect((await screen.findByRole('alert')).textContent).toContain('행사 응답 ID가 올바르지 않습니다.');
    expect(screen.getAllByTestId('promotion-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '기존 10% 할인 비활성화' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '연필 2+1 재활성화' })).toBeNull();
  });

  it('reorders immediately after a low-priority create and a priority edit', async () => {
    const later: Promotion = { ...percent, promotionId: 'LATER', name: '나중 행사', sortOrder: 5 };
    const first: Promotion = { ...nPlusOne, promotionId: 'FIRST', name: '먼저 행사', sortOrder: 0 };
    const edited: Promotion = { ...later, sortOrder: -1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([later]))
      .mockResolvedValueOnce(response(first, 201))
      .mockResolvedValueOnce(response(edited));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('나중 행사');
    fillCommon('먼저 행사');
    fireEvent.change(screen.getByLabelText('정렬 우선순위'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    await screen.findByText('행사를 추가했습니다.');
    expect(screen.getAllByTestId('promotion-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('먼저 행사'), expect.stringContaining('나중 행사'),
    ]);

    fireEvent.click(screen.getByRole('button', { name: '나중 행사 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 정렬 우선순위'), { target: { value: '-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    await screen.findByText('행사를 수정했습니다.');
    expect(screen.getAllByTestId('promotion-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('나중 행사'), expect.stringContaining('먼저 행사'),
    ]);
  });

  it('rejects invalid dates and start-at-or-after-end before fetch', async () => {
    const fetchMock = await load();
    fillCommon('잘못된 행사');
    fireEvent.change(screen.getByLabelText('시작 일시'), { target: { value: '2026-08-20T18:00' } });
    fireEvent.change(screen.getByLabelText('종료 일시'), { target: { value: '2026-08-20T18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '행사 추가' }));
    expect((await screen.findByRole('alert')).textContent).toContain('시작 일시는 종료 일시보다 빨라야 합니다.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('previews loaded and draft promotions in stack order with totals and breakdown', async () => {
    await load([percent]);
    fillCommon('추가 정액 할인');
    fireEvent.change(screen.getByLabelText('행사 유형'), { target: { value: 'FIXED_DISCOUNT' } });
    fireEvent.change(screen.getByLabelText('유료 수량당 할인액'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('미리보기 상품'), { target: { value: 'P001' } });
    fireEvent.change(screen.getByLabelText('총 수령 수량'), { target: { value: '2' } });
    const preview = screen.getByRole('region', { name: '가격 미리보기 결과' });
    expect(preview.textContent).toContain('정상 합계 2,000별');
    expect(preview.textContent).toContain('최종 합계 1,600별');
    expect(preview.textContent).toContain('할인 합계 400별');
    const adjustments = within(preview).getAllByTestId('preview-adjustment');
    expect(adjustments[0].textContent).toContain('기존 10% 할인');
    expect(adjustments[0].textContent).toContain('2,000별 → 1,800별');
    expect(adjustments[1].textContent).toContain('추가 정액 할인');
    expect(adjustments[1].textContent).toContain('1,800별 → 1,600별');
  });

  it('previews N+1 paid/free quantities', async () => {
    await load();
    fillCommon('2+1 초안');
    fireEvent.change(screen.getByLabelText('구매 수량'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('무료 수량'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('미리보기 상품'), { target: { value: 'P001' } });
    fireEvent.change(screen.getByLabelText('총 수령 수량'), { target: { value: '3' } });
    const preview = screen.getByRole('region', { name: '가격 미리보기 결과' });
    expect(preview.textContent).toContain('유료 2개');
    expect(preview.textContent).toContain('무료 1개');
    expect(within(preview).getByTestId('preview-adjustment').textContent).toContain('무료 1개');
  });

  it('locks every draft and session-changing control while a save is pending', async () => {
    const pending = deferred<Response>();
    const updated: Promotion = { ...percent, name: '저장 중인 A' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent, nPlusOne])).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');

    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '저장 중인 A' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    await within(dialog).findByRole('status', { name: '행사 저장 중' });

    const editB = screen.getByRole('button', { name: '연필 2+1 편집', hidden: true }) as HTMLButtonElement;
    const cancel = within(dialog).getByRole('button', { name: '편집 취소' }) as HTMLButtonElement;
    expect(editB.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(screen.getByLabelText('행사명').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('연필 (P001) 대상').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('미리보기 상품').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('총 수령 수량').matches(':disabled')).toBe(true);

    fireEvent.click(editB);
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(dialog).getByLabelText('수정 행사명')).toHaveProperty('value', '저장 중인 A');
    expect(screen.getByLabelText('행사명')).toHaveProperty('value', '');

    pending.resolve(response(updated));
    expect(await screen.findByText('행사를 수정했습니다.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate submissions and exposes a safe saving error', async () => {
    let resolve!: (value: Response) => void;
    const saving = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockResolvedValueOnce(response([])).mockReturnValueOnce(saving);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('등록된 행사가 없습니다.');
    fillCommon();
    const save = screen.getByRole('button', { name: '행사 추가' });
    fireEvent.click(save);
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('status', { name: '행사 저장 중' })).toBeTruthy();
    fireEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(response({ error: '저장할 수 없습니다.' }, 500));
    expect((await screen.findByRole('alert')).textContent).toContain('저장할 수 없습니다.');
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('formats concise Korean content and exact Seoul periods deterministically', () => {
    expect(formatPromotionContent(nPlusOne, '별')).toBe('2개 구매 시 1개 무료');
    expect(formatPromotionContent(percent, '별')).toBe('10% 할인');
    expect(formatPromotionContent({ ...percent, type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 350 } as Promotion, '별')).toBe('행사 가격 350별');
    expect(formatPromotionContent({ ...percent, type: 'FIXED_DISCOUNT', discountAmount: 100 } as Promotion, '별')).toBe('1개당 100별 할인');
    expect(formatPromotionPeriod('2026-08-01T00:00:00.000Z', '2026-09-01T01:02:03.000Z')).toBe('2026/08/01 09:00:00 ~ 09/01 10:02:03');
    expect(formatPromotionPeriod('2026-12-30T15:00:00.000Z', '2026-12-31T15:00:00.000Z')).toBe('2026/12/31 00:00:00 ~ 2027/01/01 00:00:00');
  });

  it('renders only user-facing list details with a compact accessible product summary', async () => {
    const manyProducts: Product[] = [...products, { productId: 'P003', name: '자', price: 700, stock: 5, isActive: true, sortOrder: 3 }];
    vi.stubGlobal('fetch', vi.fn(async () => response([{ ...nPlusOne, productIds: ['P001', 'P002', 'P003'] }])));
    render(<PromotionAdminPanel products={manyProducts} currencyUnit="별" timeZone="Asia/Seoul" />);

    const row = await screen.findByTestId('promotion-row');
    expect(row.textContent).toContain('행사명연필 2+1');
    expect(row.textContent).toContain('행사 설명설명');
    expect(row.textContent).toContain('행사 내용2개 구매 시 1개 무료');
    expect(row.textContent).toContain('대상 상품연필, 지우개 +1');
    expect(within(row).getByText('연필, 지우개 +1').getAttribute('title')).toBe('연필, 지우개, 자');
    expect(row.textContent).toContain('행사 기간2026/08/01 09:00:00 ~ 09/01 09:00:00');
    expect(row.textContent).not.toContain('PROMO-N');
    expect(row.textContent).not.toContain('우선순위');
    expect(row.textContent).not.toContain('N_PLUS_ONE');
    expect(row.textContent).not.toContain('2026-08-01T');
  });

  it('uses a generic counted label when every target product is unavailable without leaking IDs', async () => {
    const secretPromotionId = 'PROMO-SECRET-ALL-UNKNOWN';
    const secretProductIds = ['PRODUCT-SECRET-DELETED-A', 'PRODUCT-SECRET-DELETED-B'];
    vi.stubGlobal('fetch', vi.fn(async () => response([{
      ...nPlusOne,
      promotionId: secretPromotionId,
      productIds: secretProductIds,
    }])));
    renderPanel();

    const row = await screen.findByTestId('promotion-row');
    const targetSummary = within(row).getByText('알 수 없는 상품 외 1개');
    expect(targetSummary.getAttribute('title')).toBe('알 수 없는 상품 (총 2개)');
    for (const secretId of [secretPromotionId, ...secretProductIds]) {
      expect(document.body.textContent).not.toContain(secretId);
      expect(targetSummary.getAttribute('title')).not.toContain(secretId);
      expect(row.outerHTML).not.toContain(secretId);
    }
  });

  it('keeps known names and unknown target counts without leaking mixed target IDs', async () => {
    const secretPromotionId = 'PROMO-SECRET-MIXED';
    const secretProductIds = ['PRODUCT-SECRET-MISSING-A', 'PRODUCT-SECRET-MISSING-B'];
    const mixedPromotion: Promotion = {
      ...percent,
      promotionId: secretPromotionId,
      productIds: ['P001', ...secretProductIds],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([mixedPromotion]))
      .mockResolvedValueOnce(response(mixedPromotion));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();

    const row = await screen.findByTestId('promotion-row');
    const targetSummary = within(row).getByText('연필, 알 수 없는 상품 +1');
    expect(targetSummary.getAttribute('title')).toBe('연필, 알 수 없는 상품 (총 3개)');
    for (const secretId of [secretPromotionId, ...secretProductIds]) {
      expect(document.body.textContent).not.toContain(secretId);
      expect(targetSummary.getAttribute('title')).not.toContain(secretId);
      expect(row.outerHTML).not.toContain(secretId);
    }

    fireEvent.click(within(row).getByRole('button', { name: `${mixedPromotion.name} 편집` }));
    const dialog = screen.getByRole('dialog');
    for (const secretId of secretProductIds) expect(dialog.outerHTML).not.toContain(secretId);
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    await screen.findByText('행사를 수정했습니다.');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).productIds).toEqual(['P001', ...secretProductIds]);
  });

  it('keeps the creation draft independent while editing in a labelled modal and restores focus on Escape', async () => {
    await load([percent]);
    fireEvent.change(screen.getByLabelText('행사명'), { target: { value: '보존할 생성 초안' } });
    const opener = screen.getByRole('button', { name: '기존 10% 할인 편집' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: '기존 10% 할인 행사 편집' });
    expect(within(dialog).getByLabelText('수정 행사명')).toHaveProperty('value', '기존 10% 할인');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('수정 행사명'));
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '버릴 수정' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('행사명')).toHaveProperty('value', '보존할 생성 초안');
    expect(document.activeElement).toBe(opener);
  });

  it('traps focus in the edit dialog and makes the underlying create and list panels inert', async () => {
    await load([percent, nPlusOne]);
    const opener = screen.getByRole('button', { name: '기존 10% 할인 편집' });
    const blockedDelete = screen.getByRole('button', { name: '연필 2+1 삭제' });
    const createName = screen.getByLabelText('행사명');
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: '기존 10% 할인 행사 편집' });
    const panelContent = screen.getByTestId('promotion-panel-content');
    expect(panelContent.hasAttribute('inert')).toBe(true);
    expect(panelContent.getAttribute('aria-hidden')).toBe('true');

    const cancel = within(dialog).getByRole('button', { name: '편집 취소' });
    const save = within(dialog).getByRole('button', { name: '행사 수정 저장' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('수정 행사명'));
    within(dialog).getByLabelText('수정 행사명').focus();
    fireEvent.keyDown(within(dialog).getByLabelText('수정 행사명'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);

    createName.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(blockedDelete);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('traps and restores delete dialog focus and locks every unsafe close while deleting', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent])).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText(percent.name);
    const opener = screen.getByRole('button', { name: `${percent.name} 삭제` });
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: `${percent.name} 행사 삭제` });
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    const confirm = within(dialog).getByRole('button', { name: '삭제 확인' });
    expect(document.activeElement).toBe(confirm);
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(confirm);
    await within(dialog).findByText('삭제 중…');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog);
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog')).toBe(dialog);

    pending.resolve(response({ promotionId: percent.promotionId }));
    await screen.findByText('행사를 삭제했습니다.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '행사 목록 새로고침' }));
  });

  it('closes delete by Escape, backdrop, and cancel and restores the exact opener each time', async () => {
    await load([percent]);
    const opener = screen.getByRole('button', { name: `${percent.name} 삭제` });
    for (const close of ['escape', 'backdrop', 'cancel'] as const) {
      fireEvent.click(opener);
      const dialog = screen.getByRole('dialog');
      if (close === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      else if (close === 'backdrop') fireEvent.mouseDown(dialog);
      else fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  });

  it('uses single-column mobile grids and full-width shrinkable datetime inputs', async () => {
    await load();
    expect(screen.getByRole('group', { name: '가격 미리보기 입력' }).className).toContain('grid-cols-1 sm:grid-cols-2');
    expect(screen.getByLabelText('구매 수량').parentElement?.parentElement?.className).toContain('grid-cols-1 sm:grid-cols-2');
    for (const label of ['시작 일시', '종료 일시']) {
      const input = screen.getByLabelText(label);
      expect(input.className).toContain('min-w-0');
      expect(input.className).toContain('w-full');
      expect(input.parentElement?.parentElement?.className).toContain('grid-cols-1 sm:grid-cols-2');
    }
  });

  it('saves an edit locally without a list GET and ignores a stale modal response after another edit opens', async () => {
    const firstSave = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(response([percent, nPlusOne])).mockReturnValueOnce(firstSave.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText('기존 10% 할인');
    fireEvent.change(screen.getByLabelText('행사명'), { target: { value: '생성 초안 유지' } });
    fireEvent.click(screen.getByRole('button', { name: '기존 10% 할인 편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('수정 행사명'), { target: { value: '저장된 수정' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '행사 수정 저장' }));
    firstSave.resolve(response({ ...percent, name: '저장된 수정' }));

    expect(await screen.findByText('행사를 수정했습니다.')).toBeTruthy();
    expect(screen.getByText('저장된 수정')).toBeTruthy();
    expect(screen.getByLabelText('행사명')).toHaveProperty('value', '생성 초안 유지');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels delete without a request and confirms an encoded DELETE with local removal', async () => {
    const encoded = { ...percent, promotionId: 'PROMO / 한글' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response([encoded])).mockResolvedValueOnce(response({ promotionId: encoded.promotionId }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText(encoded.name);
    fireEvent.click(screen.getByRole('button', { name: `${encoded.name} 삭제` }));
    const confirmation = screen.getByRole('dialog', { name: `${encoded.name} 행사 삭제` });
    fireEvent.click(within(confirmation).getByRole('button', { name: '취소' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: `${encoded.name} 삭제` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제 확인' }));
    expect(await screen.findByText('행사를 삭제했습니다.')).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/promotions/PROMO%20%2F%20%ED%95%9C%EA%B8%80');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(screen.queryByTestId('promotion-row')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains an item on generic delete failure and reloads once after the safe partial-failure message', async () => {
    const partial = '대상 상품 연결은 삭제되었지만 행사 삭제를 완료하지 못했습니다. 새로고침 후 재시도해 주세요.';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([percent]))
      .mockResolvedValueOnce(response({ error: '행사를 삭제하지 못했습니다.' }, 500))
      .mockResolvedValueOnce(response({ error: partial }, 500))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    await screen.findByText(percent.name);

    fireEvent.click(screen.getByRole('button', { name: `${percent.name} 삭제` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제 확인' }));
    expect((await screen.findByRole('alert')).textContent).toContain('행사를 삭제하지 못했습니다.');
    expect(screen.getByTestId('promotion-row')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: `${percent.name} 삭제` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제 확인' }));
    expect((await screen.findByRole('alert')).textContent).toContain(partial);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it.each(['white', 'black', 'navy'] as const)('applies semantic %s theme variables to panel, list, fields, and modal', async (themeColor) => {
    vi.stubGlobal('fetch', vi.fn(async () => response([percent])));
    render(<PromotionAdminPanel products={products} currencyUnit="별" timeZone="Asia/Seoul" themeColor={themeColor} />);
    const panel = screen.getByLabelText('행사 관리');
    await screen.findByText(percent.name);
    expect(panel.getAttribute('data-theme')).toBe(themeColor);
    expect(panel.className).toContain('bg-[var(--theme-shell)]');
    const row = screen.getByTestId('promotion-row');
    expect(row.className).toContain('bg-[var(--theme-content-card)]');
    const edit = within(row).getByRole('button', { name: `${percent.name} 편집` });
    const activation = within(row).getByRole('button', { name: `${percent.name} 비활성화` });
    expect(edit.className).toContain('bg-[var(--theme-accent-soft)]');
    expect(activation.className).toContain('bg-[var(--theme-accent-solid)]');
    for (const action of [edit, activation]) {
      expect(action.className).toContain('border-[var(--theme-border)]');
      expect(action.className).toContain('focus-visible:ring-[var(--theme-focus-ring)]');
    }
    expect(screen.getByLabelText('행사명').className).toContain('bg-[var(--theme-input)]');
    fireEvent.click(screen.getByRole('button', { name: `${percent.name} 편집` }));
    expect(screen.getByRole('dialog').className).toContain('text-[var(--theme-text)]');
  });
});
