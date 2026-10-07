import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BOARD_REFRESH_MS, useTaskBoard } from './useTaskBoard';
import { ledgerClient } from './ledgerClient';

vi.mock('./ledgerClient', () => ({ ledgerClient: { board: vi.fn() } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('pauses hidden-panel polling and refreshes when the panel is shown again', async () => {
  vi.useFakeTimers();
  vi.mocked(ledgerClient.board).mockResolvedValue({ ok: true, data: { now: '2026-10-07T00:00:00.000Z', tasks: [] } });
  const { result, rerender } = renderHook(({ polling }) => useTaskBoard({ enabled: true, polling }), { initialProps: { polling: true } });
  await act(async () => { await Promise.resolve(); });
  expect(ledgerClient.board).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBe('ready');
  rerender({ polling: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(BOARD_REFRESH_MS * 3); window.dispatchEvent(new Event('focus')); });
  expect(ledgerClient.board).toHaveBeenCalledTimes(1);
  expect(result.current.enabled).toBe(true);
  expect(result.current.status).toBe('ready');
  rerender({ polling: true });
  await act(async () => { await Promise.resolve(); });
  expect(ledgerClient.board).toHaveBeenCalledTimes(2);
});
