// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { padletBoardsForStudent, syncPadletBoardsIfStale } from './configuredPadlet';

const m = vi.hoisted(() => ({ resolve: vi.fn(), callbacks: [] as Array<() => Promise<void>> }));
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (callback: () => Promise<void>) => { m.callbacks.push(callback); } }));
vi.mock('./configuredRepository', () => ({
  resolveCompatibilityConfiguredRepository: m.resolve,
  getCompatibilityCentralTenantContext: vi.fn(),
}));
beforeEach(() => { vi.clearAllMocks(); m.callbacks.length = 0; });

describe('configured Padlet background boundary', () => {
  it('resolves the teacher adapter in the request and does not wait for network work', async () => {
    const syncIfStale = vi.fn(async () => undefined);
    m.resolve.mockResolvedValue({ adapter: { syncIfStale } });
    await syncPadletBoardsIfStale(new Request('https://example.test/api/task-ledger'));
    expect(m.resolve).toHaveBeenCalledTimes(1);
    expect(syncIfStale).not.toHaveBeenCalled();
    m.resolve.mockRejectedValue(new Error('request context has ended'));
    await m.callbacks[0]();
    expect(syncIfStale).toHaveBeenCalledExactlyOnceWith(undefined, 'teacher');
    expect(m.resolve).toHaveBeenCalledTimes(1);
  });

  it('returns student links before sync and leaves a frozen deployment read-only', async () => {
    const links = new Map([['T1', { title: '게시판', url: 'https://padlet.com/test/abc123def456', sectionTitle: null }]]);
    const syncIfStale = vi.fn(async () => undefined);
    m.resolve.mockResolvedValue({ adapter: { syncIfStale, boardsForBank: async () => links } });
    const request = new Request('https://example.test/api/bank/me/tasks');
    expect(await padletBoardsForStudent(request, { sync: false })).toBe(links);
    expect(m.callbacks).toHaveLength(0);
    expect(await padletBoardsForStudent(request, { sync: true })).toBe(links);
    expect(syncIfStale).not.toHaveBeenCalled();
    await m.callbacks[0]();
    expect(syncIfStale).toHaveBeenCalledExactlyOnceWith(undefined, 'student');
  });
});
