import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePadletTaskRefresh } from './usePadletTaskRefresh';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Padlet task refresh', () => {
  it('refreshes visible linked-task screens and stops when disabled or unmounted', async () => {
    const refresh = vi.fn(async () => undefined);
    const hook = renderHook(({ enabled }) => usePadletTaskRefresh(enabled, refresh), { initialProps: { enabled: false } });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refresh).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: true });
    hook.unmount();
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips hidden screens and overlapping reads, then refreshes on return', async () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderHook(() => usePadletTaskRefresh(true, refresh));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(refresh).not.toHaveBeenCalled();
    visible.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => { finish(); });
  });
});
