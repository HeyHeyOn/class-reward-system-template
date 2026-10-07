// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { canonicalJson } from '@/server/migration/validators';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { sealedExportChild } from '../../../test-support/sealedExportHarness';
import { borrowChainDatabase } from '../../../test-support/productChainHarness';
import { comparable, terminalState } from '../../../test-support/productTerminalHarness';
import { cleanupCrashWorkers, crashDispositionChild, crashWorker, killCrashWorker, save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
afterEach(cleanupCrashWorkers);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 missing durable successor positive contract',() => {
  it('characterizes why SQL plus same-UID ORIGINAL is not an independent immutable enrollment authority',async () => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID(),forgedOwner=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,owner);
      const bucket=readdirSync('.synthetic-original-catalog').find(n => n.startsWith(pin.systemIdentifier+'-')
        && n.endsWith('-local_product_terminal.lease'))!;
      const path=`.synthetic-original-catalog/${bucket}/${readdirSync(`.synthetic-original-catalog/${bucket}`)[0]}`;
      const original=readFileSync(path,'utf8'),copy=JSON.parse(original),lease=JSON.parse(copy.identity.payload);
      lease.pin.ownerId=forgedOwner;
      const payload=canonicalJson(lease),digest=createHash('sha256').update(payload).digest('hex');
      copy.identity={singleton:true,payload,digest};
      // Deliberate test-owned trust-boundary attack, NOT an enrollment path.
      // chmod by the same owner demonstrates why mode 0400 is not immutability.
      const q=await db.owner.connect();
      try {
        await q.query('BEGIN; ALTER TABLE local_product_terminal.lease DISABLE TRIGGER USER');
        await q.query('UPDATE local_product_terminal.lease SET payload=$1,digest=$2',[payload,digest]);
        await q.query('ALTER TABLE local_product_terminal.lease ENABLE TRIGGER USER; COMMIT');
      } finally {await q.query('ROLLBACK'); q.release();}
      chmodSync(path,0o600); writeFileSync(path,canonicalJson(copy)); chmodSync(path,0o400);
      const before=await preactivationWitness(db);
      let returned:unknown=null,error:unknown=null;
      try {returned=await initializeTerminalCoordinator(db,forgedOwner);} catch (e) {error=e instanceof Error ? e.message : String(e);}
      const after=await preactivationWitness(db);
      save(id,'immutable-authority-blocker',{pin,forgedOwner,original,forged:readFileSync(path,'utf8'),before,after,returned,error,
        accepted:error===null,grantEnrolled:false,successorAccepted:false,
        boundary:'A trusted SQL owner AND trusted filesystem UID can rewrite provenance coherently; neither is an external immutable authority.'});
      expect(after).toEqual(before);
      expect(returned).toEqual({...pin,ownerId:forgedOwner}); expect(error).toBeNull();
      // This passing characterization proves a missing trust root, not a safe
      // grant. Preserve the mutated disposable fixture evidence, then remove it.
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('resumes the exact retained sealed transaction in a cold process without changing terminal identity',async () => {
    const coordinator=await createDisposablePostgres(),id=randomUUID();
    console.info('ENROLLMENT_CONTRACT_PG',JSON.stringify(coordinator.evidence));
    try {
      const coordinatorPin=await initializeTerminalCoordinator(coordinator,randomUUID());
      const common={coordinator:{runId:coordinator.runId,evidence:coordinator.evidence},coordinatorPin};
      const captured=await sealedExportChild({phase:'capture',...common});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      const retained=readFileSync(`.sealed-product-export/${captured.ref.sha256}.json`);
      const original=await crashWorker({phase:'crash',...common,captured,boundary:'after-commit',segment:1});
      const target=await borrowChainDatabase(original.barrier.destination);
      try {
        const before={state:await terminalState(target.db),
          execution:(await target.db.owner.query('SELECT * FROM local_restore_control.sealed_export_execution')).rows,
          terminal:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_terminal')).rows,
          checkpoint:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows};
        expect(before.checkpoint).toHaveLength(1);
        await killCrashWorker(original,captured.anchor);
        const request={suite:'successor',phase:'positive-contract',...common,captured,
          destination:original.barrier.destination,owner:original.barrier.owner};
        const first=await crashDispositionChild(request),retry=await crashDispositionChild(request);
        const after={state:await terminalState(target.db),
          execution:(await target.db.owner.query('SELECT * FROM local_restore_control.sealed_export_execution')).rows,
          terminal:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_terminal')).rows,
          checkpoint:(await target.db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows};
        save(id,'missing-enrollment-positive',{originalPid:original.child.pid,originalIdentity:original.barrier.identity,
          sourceClosed:captured.sourceClosed,export:captured.ref,before,after,first,retry,
          missing:'No live-authorized durable enrollment/retirement/consume entry point exists; death is not retirement authority.'});
        expect(first.pid).not.toBe(original.child.pid); expect(retry.pid).not.toBe(first.pid);
        expect(first.terminal).toEqual(before.terminal); expect(after.terminal).toEqual(before.terminal);
        expect(after.execution).toEqual(before.execution); expect(after.checkpoint.slice(0,1)).toEqual(before.checkpoint);
        expect(first.after).toEqual(retry.before); expect(retry.after).toEqual(retry.before);
        expect(readFileSync(`.sealed-product-export/${captured.ref.sha256}.json`)).toEqual(retained);
        // Keep this RED executable and visible until a real enrollment protocol
        // satisfies it. It is excluded by filename only from bounded GREEN runs.
        expect(first.accepted,JSON.stringify(first.error)).toBe(true);
        expect(first.returned).toMatchObject({kind:'APPLIED',segment:2});
        expect(retry.accepted,JSON.stringify(retry.error)).toBe(true);
        expect(retry.returned).toMatchObject({kind:'ALREADY_APPLIED',segment:2});
        expect(after.checkpoint).toHaveLength(2);
        const segment=JSON.parse(JSON.parse(retained.toString('utf8')).journal[1].payload);
        expect(first.returned.checkpoint).toBe(segment.through); expect(retry.returned.checkpoint).toBe(segment.through);
        expect(comparable(after.state.public.tables)).toEqual(comparable({...captured.base.tables,products:segment.transaction.finalProducts}));
        expect(after.state.public.sequences).toEqual(before.state.public.sequences);
        expect(after.state.public.guards).toEqual(before.state.public.guards);
      } finally {await target.release();}
    } finally {const closed=await coordinator.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },600_000);
});
