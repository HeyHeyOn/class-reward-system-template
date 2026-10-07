// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { sealedExportChild } from '../../../test-support/sealedExportHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const modules=import.meta.glob('./syntheticSealedExport.ts');
suite('Task21 sealed export recovery',() => {
  it.each(['positive','negative'])('%s immutable export and cold application recovery',async phase => {
    const coordinator=await createDisposablePostgres(); console.info('SEALED_EXPORT_COORDINATOR_PG',JSON.stringify(coordinator.evidence));
    try {
      expect(modules['./syntheticSealedExport.ts'],'executable sealed export/restore bridge').toBeTypeOf('function');
      const coordinatorPin=await initializeTerminalCoordinator(coordinator,randomUUID());
      const common={coordinator:{runId:coordinator.runId,evidence:coordinator.evidence},coordinatorPin};
      const captured=await sealedExportChild({phase:'capture',...common,negative:phase==='negative'});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      const restored=await sealedExportChild({phase:'restore',...common,captured,negative:phase==='negative'});
      expect(restored.pid).not.toBe(captured.pid); expect(restored.cleanup.containerRemoved).toBe(true);
      expect(restored.prepared.pid).not.toBe(restored.retry.pid);
      expect(restored.retry.after).toEqual(restored.retry.before);
      expect(restored.archiveTransportAbsent).toBe(true);
      if (phase==='negative') expect(restored.negatives.length).toBeGreaterThanOrEqual(16);
    } finally {console.info('SEALED_EXPORT_COORDINATOR_CLEANUP',JSON.stringify(await coordinator.close()));}
  },1_000_000);
});
