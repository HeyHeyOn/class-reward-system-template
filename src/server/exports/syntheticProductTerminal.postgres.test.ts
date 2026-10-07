// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { terminalChild } from '../../../test-support/productTerminalHarness';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 durable terminal intent',() => {
  it.each(['positive','negative'])('%s independent coordinator and cold application retries',async phase => {
    // The launcher retains this exact independent synthetic handle, never a
    // container locator, seal or terminal endpoint from segment transport.
    const coordinator=await createDisposablePostgres();
    console.info('TERMINAL_COORDINATOR_PG',JSON.stringify(coordinator.evidence));
    const descriptor={runId:coordinator.runId,evidence:coordinator.evidence},ownerId=randomUUID();
    try {
      const init=await terminalChild({phase:'initialize',coordinator:descriptor,coordinatorOwner:ownerId});
      const retry=await terminalChild({phase:'initialize',coordinator:descriptor,coordinatorOwner:ownerId});
      expect(init.pid).not.toBe(retry.pid); expect(init.pin).toEqual(retry.pin);
      const captured=await terminalChild({phase:'capture',coordinator:descriptor,coordinatorPin:init.pin});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      // Evidence returned beside segment bytes is deliberately NOT the control
      // plane. Forge those copies: only authenticated coordinator SQL may win.
      const forgedSeal={...captured.retain.seal,intent:{...captured.retain.seal.intent,counts:[2]},segments:captured.retain.seal.segments.slice(0,1)};
      const transport={...captured,retain:{seal:forgedSeal},retainRetry:null,coordinatorState:null,sourceFinal:null};
      const restored=await terminalChild({phase:'restore',coordinator:descriptor,coordinatorPin:init.pin,capture:transport,negative:phase==='negative'});
      expect(restored.pid).not.toBe(captured.pid);
      expect(restored.cleanup.containerRemoved).toBe(true);
      expect(restored.verified.kind).toBe('SEALED_TERMINAL_VERIFIED');
      expect(restored.checkpoints.map((v:{applied:{checkpoint:number}}) => v.applied.checkpoint)).toEqual([2,4,6]);
      expect(restored.install.pid).not.toBe(restored.installRetry.pid);
      expect(restored.checkpoints.every((v:{pid:number;retry:{pid:number}}) => v.pid!==v.retry.pid)).toBe(true);
      expect(restored.coldVerify.pid).not.toBe(restored.pid);
    } finally {console.info('TERMINAL_COORDINATOR_CLEANUP',JSON.stringify(await coordinator.close()));}
  },1_000_000);
});
