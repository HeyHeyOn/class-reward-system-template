import { describe, expect, it, vi } from 'vitest';
import { captureFinalCandidateWindow } from './finalCaptureWindow';

type State = { generation: number; disabled: boolean };
const stable = (): State => ({ generation: 7, disabled: true });

// These are local fakes, not evidence that a deployed writer or a human editor was excluded.
describe('local final capture window (non-authoritative)', () => {
  it('captures fresh data only between two matching disabled-generation reads', async () => {
    const events: string[] = [];
    const readState = vi.fn(async () => { events.push('state'); return stable(); });
    const capture = vi.fn(async () => { events.push('capture'); return { digest: 'fresh' }; });
    const result = await captureFinalCandidateWindow(readState, capture);
    expect(events).toEqual(['state', 'capture', 'state']);
    expect(result).toEqual({ authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', generation: 7, candidate: { digest: 'fresh' } });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [{ generation: 7, disabled: false }, stable()],
    [stable(), { generation: 8, disabled: true }],
    [stable(), { generation: 7, disabled: false }],
  ])('refuses an absent or changed control generation without publishing a candidate', async (first, second) => {
    const capture = vi.fn(async () => ({ digest: 'fresh' }));
    const readState = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(captureFinalCandidateWindow(readState, capture)).rejects.toThrow('Final capture window refused.');
    expect(capture).toHaveBeenCalledTimes(first.disabled ? 1 : 0);
  });

  it('refuses malformed control states and capture failures without a successful result', async () => {
    const capture = vi.fn(async () => ({ digest: 'fresh' }));
    await expect(captureFinalCandidateWindow(async () => ({ generation: 0, disabled: true }), capture)).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
    await expect(captureFinalCandidateWindow(async () => stable(), async () => { throw new Error('capture failed'); })).rejects.toThrow('Final capture window refused.');
  });
  it('refuses when the original mutable control response is changed during capture', async () => {
    const first = stable();
    const readState = vi.fn().mockImplementation(async () => first);
    await expect(captureFinalCandidateWindow(readState, async () => {
      first.generation = 8;
      return { digest: 'fresh' };
    })).rejects.toThrow('Final capture window refused.');
  });
});
