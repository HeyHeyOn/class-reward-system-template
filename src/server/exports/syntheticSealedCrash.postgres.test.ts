// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { certifyColdWorkerExit } from '@/server/db/testing/coldRestoreStore';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { sealedExportChild } from '../../../test-support/sealedExportHarness';
import { borrowChainDatabase } from '../../../test-support/productChainHarness';
import { comparable, terminalState } from '../../../test-support/productTerminalHarness';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { cleanupCrashWorkers, coldFiles, crashDispositionChild, crashWorker, killCrashWorker, save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
afterEach(cleanupCrashWorkers);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 sealed partial crash disposition',() => {
  it.each(['positive after-commit','positive during-transaction','negative after-commit'])('%s',async scenario => {
    const coordinator=await createDisposablePostgres(),id=randomUUID();
    console.info('SEALED_CRASH_COORDINATOR',JSON.stringify(coordinator.evidence));
    try {
      const coordinatorPin=await initializeTerminalCoordinator(coordinator,randomUUID());
      const common={coordinator:{runId:coordinator.runId,evidence:coordinator.evidence},coordinatorPin};
      const captured=await sealedExportChild({phase:'capture',...common});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      const boundary=scenario.endsWith('during-transaction') ? 'during-transaction' : 'after-commit';
      const w=await crashWorker({phase:'crash',...common,captured,boundary});
      const target=await borrowChainDatabase(w.barrier.destination);
      try {
        const read=async () => ({witness:await preactivationWitness(target.db),state:await terminalState(target.db),
          checkpoint:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows});
        const committed=await read();
        const envelope=JSON.parse(readFileSync(`.sealed-product-export/${captured.ref.sha256}.json`,'utf8'));
        const first=JSON.parse(envelope.journal[0].payload);
        expect(committed.checkpoint).toHaveLength(1); expect(committed.checkpoint[0]).toMatchObject({segment:1,artifact_digest:envelope.seal.segments[0].sha256});
        expect(comparable(committed.state.public.tables)).toEqual(comparable({...captured.base.tables,products:first.transaction.finalProducts}));
        expect(committed.state.public.guards).toBe(captured.base.guards); expect(committed.state.public.sequences).toEqual(captured.base.sequences);
        if (boundary==='during-transaction') {
          expect(w.barrier.transaction.checkpoint).toHaveLength(2);
          const inside=JSON.parse(envelope.journal[1].payload);
          expect(w.barrier.transaction.public.tables.products).toBe(inside.transaction.finalProducts);
          expect(w.barrier.transaction.public.tables.products).not.toBe(committed.state.public.tables.products);
          const activity=(await target.db.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1',[w.barrier.transaction.backend.pid])).rows;
          expect(activity).toEqual([{pid:w.barrier.transaction.backend.pid,state:'idle in transaction'}]);
        } else {
          expect(w.barrier.transaction.checkpoint).toEqual(committed.checkpoint);
          expect(w.barrier.transaction.public).toEqual(committed.state.public);
        }
        const childRequest={...common,captured,destination:w.barrier.destination,owner:w.barrier.owner};
        const negative=scenario.startsWith('negative');
        if (negative) await crashDispositionChild({phase:'blocked',...childRequest,expectedBlocker:'WORKER_STILL_LIVE'});
        const coldBefore=coldFiles(captured.anchor);
        await killCrashWorker(w,captured.anchor,!negative);
        if (negative) {
          await crashDispositionChild({phase:'blocked',...childRequest,expectedBlocker:'EXIT_UNPROVEN'});
          await certifyColdWorkerExit(captured.anchor,w.observation);
        }
        if (boundary==='during-transaction') {
          const deadline=Date.now()+30_000;
          while ((await target.db.owner.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[w.barrier.transaction.backend.pid])).rows.length) {
            if (Date.now()>deadline) throw new Error('Killed application transaction still live; cannot infer rollback');
            await new Promise(done => setTimeout(done,50));
          }
        }
        const afterDeath=await read(); expect(afterDeath).toEqual(committed);
        const coldAfter=coldFiles(captured.anchor);
        save(id,'crash-evidence',{scenario,capturePid:captured.pid,workerPid:w.child.pid,barrier:w.barrier,committed,afterDeath,coldBefore,coldAfter,
          conclusion:boundary==='during-transaction' ? 'Independent SQL observed segment2 in open transaction before kill; fresh SQL proves only committed segment1 survived' :
            'Independent SQL proved segment1 COMMIT before forced death; missing bridge response is not rollback'});
        const disposition=await crashDispositionChild({phase:'disposition',...childRequest,negative});
        expect(disposition.pid).not.toBe(w.child.pid); expect(disposition.pid).not.toBe(captured.pid);
        const retry=await crashDispositionChild({phase:'disposition',...common,captured,destination:w.barrier.destination,owner:w.barrier.owner});
        expect(retry.pid).not.toBe(disposition.pid); expect(retry.disposition).toEqual(disposition.disposition);
        expect(retry.before).toEqual(retry.after); expect(retry.stateBefore).toEqual(retry.stateAfter);
        save(id,'cold-restart',{scenario,disposition,retry});
      } finally {await target.release();}
    } finally {console.info('SEALED_CRASH_COORDINATOR_CLEANUP',JSON.stringify(await coordinator.close()));}
  },1_200_000);
});
