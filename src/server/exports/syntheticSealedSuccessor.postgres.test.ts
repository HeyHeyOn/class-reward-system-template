// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { sealedExportChild } from '../../../test-support/sealedExportHarness';
import { borrowChainDatabase } from '../../../test-support/productChainHarness';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { comparable, terminalState } from '../../../test-support/productTerminalHarness';
import { cleanupCrashWorkers, crashDispositionChild, crashWorker, killCrashWorker, save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
afterEach(cleanupCrashWorkers);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 sealed successor boundary',() => {
  it.each(['cold successor rejected','tamper and ownership rejected','successor transaction death rejected','complete SQL death rejected'])('%s',async scenario => {
    const coordinator=await createDisposablePostgres(),id=randomUUID();
    console.info('SEALED_SUCCESSOR_COORDINATOR',JSON.stringify(coordinator.evidence));
    try {
      const coordinatorPin=await initializeTerminalCoordinator(coordinator,randomUUID());
      const common={coordinator:{runId:coordinator.runId,evidence:coordinator.evidence},coordinatorPin};
      const captured=await sealedExportChild({phase:'capture',...common});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      const complete=scenario==='complete SQL death rejected',negative=scenario==='tamper and ownership rejected';
      const boundary=negative ? 'during-transaction' : 'after-commit';
      const w=await crashWorker({phase:'crash',...common,captured,boundary,segment:complete ? 3 : 1});
      const target=await borrowChainDatabase(w.barrier.destination);
      try {
        const read=async () => ({witness:await preactivationWitness(target.db),state:await terminalState(target.db),
          checkpoint:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows});
        const committed=await read(),envelope=JSON.parse(readFileSync(`.sealed-product-export/${captured.ref.sha256}.json`,'utf8'));
        expect(committed.checkpoint).toHaveLength(complete ? 3 : 1);
        const products=JSON.parse(envelope.journal[complete ? 2 : 0].payload).transaction.finalProducts;
        expect(comparable(committed.state.public.tables)).toEqual(comparable({...captured.base.tables,products}));
        expect(committed.state.public.sequences).toEqual(captured.base.sequences); expect(committed.state.public.guards).toBe(captured.base.guards);
        const activity=async (pid:number) => (await target.db.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1',[pid])).rows;
        const gone=async (pid:number) => {
          const deadline=Date.now()+30_000;
          while ((await activity(pid)).length) {if (Date.now()>deadline) throw new Error('Native transaction still present'); await new Promise(done => setTimeout(done,50));}
        };
        const originalActivity=negative ? await activity(w.barrier.transaction.backend.pid) : null;
        if (negative) {
          expect(w.barrier.transaction.checkpoint).toHaveLength(2);
          expect(originalActivity).toEqual([{pid:w.barrier.transaction.backend.pid,state:'idle in transaction'}]);
        }
        await killCrashWorker(w,captured.anchor);
        if (negative) await gone(w.barrier.transaction.backend.pid);
        const afterDeath=await read(); expect(afterDeath).toEqual(committed);
        const request={suite:'successor',phase:'probe',...common,captured,destination:w.barrier.destination,owner:w.barrier.owner,complete,negative};
        let successorDeath:unknown=null;
        if (scenario==='successor transaction death rejected') {
          const successor=await crashWorker({...request,phase:'successor-transaction'});
          expect(successor.child.pid).not.toBe(w.child.pid);
          const before=await read(),nativeBefore=await activity(successor.barrier.backend.pid);
          expect(before).toEqual(committed); expect(nativeBefore).toEqual([{pid:successor.barrier.backend.pid,state:'idle in transaction'}]);
          await killCrashWorker(successor,captured.anchor,false); await gone(successor.barrier.backend.pid);
          const after=await read(); expect(after).toEqual(before);
          successorDeath={pid:successor.child.pid,barrier:successor.barrier,before,after,nativeBefore,nativeAfter:await activity(successor.barrier.backend.pid)};
        }
        const first=await crashDispositionChild(request),afterProbe=await read(),retry=await crashDispositionChild({...request,negative:false});
        expect(first.pid).not.toBe(w.child.pid); expect(retry.pid).not.toBe(first.pid);
        expect(first.accepted).toBe(false); expect(retry.accepted).toBe(false); expect(first.disposition).toEqual(retry.disposition);
        // Deliberate committed tamper/restore changes xmin/ctid OUTSIDE measured
        // reject intervals. Every reject compares its exact own before/after.
        expect(afterProbe.state).toEqual(afterDeath.state); expect(afterProbe.checkpoint).toEqual(afterDeath.checkpoint);
        if (!negative) expect(afterProbe).toEqual(afterDeath);
        expect(await read()).toEqual(afterProbe);
        save(id,'successor-evidence',{scenario,originalPid:w.child.pid,barrier:w.barrier,committed,afterDeath,afterProbe,originalActivity,successorDeath,first,retry,
          outcome:'FAIL_CLOSED_ONLY; no resumed suffix, no accepted recovery, no new preparation'});
      } finally {await target.release();}
    } finally {console.info('SEALED_SUCCESSOR_COORDINATOR_CLEANUP',JSON.stringify(await coordinator.close()));}
  },1_200_000);
});
