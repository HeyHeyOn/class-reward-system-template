// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { chainChild } from '../../../test-support/productChainHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 synthetic multisegment product chain',() => {
  it.each(['positive','negative'])('%s cold restore and cold-process checkpoint retry',async phase => {
    const capture=await chainChild({phase:'capture'});
    expect(capture.sourceClosed.containerRemoved).toBe(true);
    expect(capture.segments).toHaveLength(3);
    const restored=await chainChild({phase:'restore',capture,negative:phase==='negative'});
    expect(restored.pid).not.toBe(capture.pid);
    expect(restored.databaseId).not.toBe(restored.sourceId);
    expect(restored.cleanup.containerRemoved).toBe(true);
    expect(restored.checkpoints.map((c:{applied:{applied:{checkpoint:number}}}) => c.applied.applied.checkpoint)).toEqual([2,4,6]);
    for (const c of restored.checkpoints) {
      expect(c.applied.pid).not.toBe(c.retry.pid);
      if (phase==='negative') expect(c.applied.negatives.length).toBeGreaterThanOrEqual(19);
    }
  },750_000);
});
