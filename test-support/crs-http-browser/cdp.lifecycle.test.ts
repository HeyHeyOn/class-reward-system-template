// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cdp } from './cdp';

// Synthetic EventTarget transport only: no sockets, browser or acceptance claim.
// It reproduces close/error/protocol races independently of Chrome launchability.
class SyntheticSocket extends EventTarget {
  static instances: SyntheticSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  });
  constructor(readonly url: string) { super(); SyntheticSocket.instances.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  fail() { this.dispatchEvent(new Event('error')); }
  disconnect() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const url = 'ws://127.0.0.1:12345/devtools/browser/task20-synthetic';
const last = () => SyntheticSocket.instances.at(-1)!;
async function connected() {
  const promise = Cdp.connect(url);
  last().open();
  return { cdp: await promise, socket: last() };
}
beforeEach(() => {
  SyntheticSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SyntheticSocket);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Task20 CDP terminal transport lifecycle (not browser acceptance)', () => {
  it('fails a close-before-open immediately, not after the open timeout', async () => {
    const result = Cdp.connect(url).then(() => 'OPEN', error => (error as Error).message);
    last().disconnect();
    // Drain only microtasks, not ten seconds of fake time.
    await vi.advanceTimersByTimeAsync(0);
    const settled = await Promise.race([result, Promise.resolve('STILL_PENDING')]);
    expect(settled).toMatch(/CDP .*closed/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a failed handshake and clears the open deadline', async () => {
    const result = Cdp.connect(url).catch(error => (error as Error).message);
    last().fail();
    expect(await result).toMatch(/CDP /);
    expect(last().close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a live transport on protocol corruption and rejects every pending command', async () => {
    const { cdp, socket } = await connected();
    const a = cdp.call('Page.enable').catch(error => (error as Error).message);
    const b = cdp.call('Network.enable').catch(error => (error as Error).message);
    socket.dispatchEvent(new MessageEvent('message', { data: '{not JSON; synthetic private payload' }));
    expect(await a).toBe('Invalid or oversized CDP event stream');
    expect(await b).toBe('Invalid or oversized CDP event stream');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(cdp.call('Runtime.enable')).rejects.toThrow('Invalid or oversized CDP event stream');
    expect(socket.sent).toHaveLength(2);
  });

  it('does not collect late protocol messages after a terminal error', async () => {
    const { cdp, socket } = await connected();
    socket.fail();
    socket.message({ method: 'Browser.downloadWillBegin', params: { guid: 'late-not-a-download' } });
    expect(cdp.events).toEqual([]);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('disposes idempotently and rejects outstanding calls without leftover timers', async () => {
    const { cdp, socket } = await connected();
    const pending = cdp.call('Page.navigate').catch(error => (error as Error).message);
    cdp.close(); cdp.close();
    expect(await pending).toBe('CDP disposed');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out an unopened socket exactly once and cleans the timer', async () => {
    const result = Cdp.connect(url).catch(error => (error as Error).message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatch(/CDP .*timeout/);
    expect(last().close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves positive reply correlation and session-specific event selection', async () => {
    const { cdp, socket } = await connected();
    const a = cdp.call<{ ok: string }>('Page.enable', {}, 'session-a');
    const b = cdp.call<{ ok: string }>('Network.enable', {}, 'session-b');
    expect(socket.sent).toEqual([
      { id: 1, method: 'Page.enable', params: {}, sessionId: 'session-a' },
      { id: 2, method: 'Network.enable', params: {}, sessionId: 'session-b' },
    ]);
    socket.message({ id: 2, result: { ok: 'b' } });
    socket.message({ id: 1, result: { ok: 'a' } });
    expect(await a).toEqual({ ok: 'a' }); expect(await b).toEqual({ ok: 'b' });
    socket.message({ method: 'Page.loadEventFired', sessionId: 'session-b', params: { timestamp: 2 } });
    socket.message({ method: 'Page.loadEventFired', sessionId: 'session-a', params: { timestamp: 1 } });
    expect(await cdp.event('Page.loadEventFired', 0, event => event.sessionId === 'session-a'))
      .toEqual({ method: 'Page.loadEventFired', sessionId: 'session-a', params: { timestamp: 1 } });
    expect(vi.getTimerCount()).toBe(0);
    cdp.close();
  });

  it('withholds raw command errors without destroying an otherwise usable transport', async () => {
    const { cdp, socket } = await connected();
    const denied = cdp.call('Page.syntheticUnsupported').catch(error => (error as Error).message);
    socket.message({ id: 1, error: { message: 'synthetic private raw payload' } });
    expect(await denied).toBe('CDP command rejected (raw payload withheld)');
    expect(socket.close).not.toHaveBeenCalled();
    const next = cdp.call('Page.enable');
    socket.message({ id: 2, result: {} });
    expect(await next).toEqual({});
    cdp.close();
  });
});
