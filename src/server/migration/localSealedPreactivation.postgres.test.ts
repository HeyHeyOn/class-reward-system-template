// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { terminalChild } from '../../../test-support/productTerminalHarness';
import { preactivationChild } from '../../../test-support/sealedPreactivationHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task19 sealed preactivation preparation',() => {
  it.each(['positive','negative'])('%s complete sealed chain and cold application retry',async phase => {
    const coordinator=await createDisposablePostgres(); console.info('PREACTIVATION_COORDINATOR_PG',JSON.stringify(coordinator.evidence));
    const descriptor={runId:coordinator.runId,evidence:coordinator.evidence};
    try {
      const init=await terminalChild({phase:'initialize',coordinator:descriptor,coordinatorOwner:randomUUID()});
      const capture=await terminalChild({phase:'capture',coordinator:descriptor,coordinatorPin:init.pin});
      expect(capture.sourceClosed.containerRemoved).toBe(true);
      // Neither a terminal nor a source final-state receipt beside the transport
      // is a gate input. SourceFinal is used only for test comparison after replay.
      const transport={...capture,retain:null,retainRetry:null,coordinatorState:null};
      const restored=await preactivationChild({phase:'restore',coordinator:descriptor,coordinatorPin:init.pin,capture:transport,negative:phase==='negative'});
      expect(restored.cleanup.containerRemoved).toBe(true); expect(restored.pid).not.toBe(capture.pid);
      expect(restored.prepared.pid).not.toBe(restored.retry.pid);
      expect(restored.sourceClosed.containerRemoved).toBe(true);
      expect(restored.negatives.length).toBeGreaterThanOrEqual(4);
    } finally {console.info('PREACTIVATION_COORDINATOR_CLEANUP',JSON.stringify(await coordinator.close()));}
  },1_000_000);
});
