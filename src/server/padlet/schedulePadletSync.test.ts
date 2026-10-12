// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { schedulePadletSync } from './schedulePadletSync';

const queued = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (callback: () => Promise<void>) => { queued.push(callback); } }));
afterEach(() => { queued.length = 0; vi.restoreAllMocks(); });

describe('Padlet response-time work', () => {
  it('returns before external reads and keeps each captured tenant adapter separate', async () => {
    const teacher = { syncIfStale: vi.fn(async () => undefined) };
    const student = { syncIfStale: vi.fn(async () => undefined) };
    schedulePadletSync(teacher as unknown as ConfiguredPadlet, 'teacher');
    schedulePadletSync(student as unknown as ConfiguredPadlet, 'student');
    expect(teacher.syncIfStale).not.toHaveBeenCalled();
    expect(student.syncIfStale).not.toHaveBeenCalled();
    await queued[1]();
    expect(student.syncIfStale).toHaveBeenCalledExactlyOnceWith(undefined, 'student');
    expect(teacher.syncIfStale).not.toHaveBeenCalled();
    await queued[0]();
    expect(teacher.syncIfStale).toHaveBeenCalledExactlyOnceWith(undefined, 'teacher');
  });

  it('contains failures without exposing exception data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    schedulePadletSync({ syncIfStale: vi.fn().mockRejectedValue(new Error('private-token')) } as unknown as ConfiguredPadlet, 'student');
    await expect(queued[0]()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[padlet] background sync failed', { source: 'student' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
  });
});
