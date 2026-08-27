import { describe, expect, it, vi } from 'vitest';
import { enqueueTaskCommand } from './taskCommandQueue';

describe('task command queue telemetry', () => {
  it('reports process-local queue wait without exposing the queue key', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = enqueueTaskCommand('private-resource-key', async () => gate);
    let now = 100;
    const onStart = vi.fn();
    const second = enqueueTaskCommand('private-resource-key', async () => 'done', {
      now: () => now,
      onStart,
    });

    now = 175;
    release();
    await expect(second).resolves.toBe('done');
    await first;

    expect(onStart).toHaveBeenCalledWith({ queueWaitMs: 75 });
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('queueKey');
  });
});
