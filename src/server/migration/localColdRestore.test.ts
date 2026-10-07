// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);
async function child(request: Record<string,unknown>) {
  const resultId=randomUUID();
  const output=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldRestoreChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=.cold-child-results/${resultId}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
    COLD_REQUEST:JSON.stringify({...request,resultId})},timeout:150_000,maxBuffer:8_000_000});
  console.info('COLD_CHILD',JSON.stringify({resultId,stdout:output.stdout,stderr:output.stderr}));
  const report=JSON.parse(readFileSync(`.cold-child-results/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  const result=JSON.parse(readFileSync(`.cold-child-results/${resultId}.json`,'utf8'));
  console.info('COLD_RESULT',JSON.stringify({resultId,...result}));
  return result;
}
async function capture(mixed=true, retainUntil=Date.now()+60_000, expiresAt=Date.now()+600_000) {
  const result=await child({phase:'capture',mixed,policy:{retainUntil,expiresAt}});
  expect(result.ok,result.error).toBe(true); expect(result.sourceClosed.containerRemoved).toBe(true);
  mkdirSync('.cold-launcher',{recursive:true,mode:0o700});
  const pin=`.cold-launcher/${result.anchor.id}.json`;
  writeFileSync(pin,JSON.stringify(result),{flag:'wx',mode:0o600});
  return JSON.parse(readFileSync(pin,'utf8')); // Separate trusted launcher, never archive metadata.
}
const control=(f: {anchor:{id:string}}) => `.cold-restore-control/${f.anchor.id}`;
const transport=(f: {anchor:{id:string}}) => `.cold-restore-transport/${f.anchor.id}.sql`;
const journal=(f: {anchor:{id:string}}) => JSON.parse(readFileSync(`${control(f)}/state.json`,'utf8'));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('cold process owned restore',() => {
  it.each([false,true])('restores SQL in a new process after source disposal mixed=%s',async mixed => {
    const f=await capture(mixed);
    const r=await child({phase:'restore',anchor:f.anchor,binding:f.binding});
    expect(r.ok,r.error).toBe(true); expect(r.pid).not.toBe(f.pid);
    expect(r.guardsVerified).toBe(true);
    expect(r.restored.databaseId).not.toBe(f.sourceDatabaseId);
    expect(r.restored.ownerId).not.toBe(f.anchor.ownerId);
    const expected=JSON.parse(readFileSync(`${control(f)}/expectation.json`,'utf8')).seal;
    for (const [table,wire] of Object.entries(expected.tables)) {
      if (!['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(table))
        expect(r.restored.readback.tables[table]).toEqual(JSON.parse(wire as string));
    }
    expect(r.restored.readback.guards).toBe(expected.guards);
    expect(r.restored.result.authority).toBe('NONAUTHORITY');
    expect(r.restored.result.sourceDatabaseId).toBe(f.sourceDatabaseId);
    expect(r.restored.readback.tables.products).toHaveLength(mixed ? 2 : 1);
    expect(r.restored.readback.relationships.claims).toHaveLength(mixed ? 2 : 1);
    expect(r.restored.readback.relationships.tombstones).toEqual([{n:1}]);
    expect(r.restored.readback.sequences.transactions_event_sequence_seq).toEqual({last_value:'900',is_called:true});
    expect(r.restored.readback.sequences.task_assignments_event_sequence_seq).toEqual({last_value:'700',is_called:false});
    expect(r.restored.readback.guards).toContain('transactions_immutable');
    expect(r.restored.cleanup.containerRemoved).toBe(true);
    expect(journal(f).status).toBe('SUCCEEDED');
    const retry=await child({phase:'restore',anchor:f.anchor,binding:f.binding});
    expect(retry.ok).toBe(false); expect(retry.error).toMatch(/Cold restore refused/);
    expect(journal(f).status).toBe('SUCCEEDED');
  },240_000);
  it('rejects owner pin binding copied receipt and unauthorized or partial archive replacement',async () => {
    const f=await capture();
    for (const [anchor,binding] of [
      [{...f.anchor,ownerId:randomUUID()},f.binding],
      [{...f.anchor,expectationSha256:'0'.repeat(64)},f.binding],
      [f.anchor,{...f.binding,manifestDigest:'0'.repeat(64)}],
    ]) {
      const r=await child({phase:'restore',anchor,binding});
      expect(r.ok).toBe(false); expect(r.error).toMatch(/Cold restore refused/); expect(journal(f).status).toBe('READY');
    }
    const bytes=readFileSync(transport(f));
    for (const replacement of [Buffer.concat([bytes,Buffer.from('\nSELECT 1;')]),bytes.subarray(0,100),
      Buffer.from(JSON.stringify({marker:{ownerId:f.anchor.ownerId},receipt:{hash:f.anchor.expectationSha256}}))]) {
      writeFileSync(transport(f),replacement);
      const r=await child({phase:'restore',anchor:f.anchor,binding:f.binding});
      expect(r.ok).toBe(false); expect(r.error).toMatch(/Cold restore refused/); expect(journal(f).status).toBe('READY');
    }
    writeFileSync(transport(f),bytes);
    const forged=await child({phase:'forged-capability',anchor:f.anchor});
    expect(forged.ok).toBe(false); expect(forged.dispatched).toBe(false);
    const expectation=readFileSync(`${control(f)}/expectation.json`);
    writeFileSync(`${control(f)}/expectation.json`,Buffer.concat([expectation,Buffer.from(' ')]));
    expect((await child({phase:'restore',anchor:f.anchor,binding:f.binding})).ok).toBe(false);
    writeFileSync(`${control(f)}/expectation.json`,expectation);
    const r=await child({phase:'restore',anchor:f.anchor,binding:f.binding}); expect(r.ok,r.error).toBe(true);
  },240_000);
  it('refuses early disposal and retains a terminal tombstone after authorized disposal',async () => {
    const f=await capture(true,Date.now()+300_000);
    const before=readFileSync(transport(f));
    const early=await child({phase:'dispose',anchor:f.anchor});
    expect(early.ok).toBe(false); expect(early.error).toMatch(/Cold restore refused/);
    expect(readFileSync(transport(f))).toEqual(before); expect(journal(f).status).toBe('READY');
    const eligible=await capture(false,Date.now()-1000);
    const disposed=await child({phase:'dispose',anchor:eligible.anchor}); expect(disposed.ok,disposed.error).toBe(true);
    expect(journal(eligible).status).toBe('DISPOSED');
    expect(() => readFileSync(transport(eligible))).toThrow();
    const restore=await child({phase:'restore',anchor:eligible.anchor,binding:eligible.binding});
    expect(restore.ok).toBe(false); expect(restore.error).toMatch(/Cold restore refused/);
  },240_000);
  it.each(['rollback','sequence'])('proves SQL rollback for %s and permits only a clean cold retry',async fault => {
    const f=await capture();
    const failed=await child({phase:'restore',anchor:f.anchor,binding:f.binding,fault});
    expect(failed.ok).toBe(false); expect(failed.dispatched).toBe(true);
    expect(journal(f).status).toBe('READY'); expect(journal(f).lastAttempt.rollbackVerified).toBe(true);
    expect(journal(f).lastAttempt.error).toMatch(/psql:[\s\S]*ERROR:/);
    expect(journal(f).lastAttempt.error).toMatch(fault==='rollback' ? /division by zero/ : /restore witness/);
    const retry=await child({phase:'restore',anchor:f.anchor,binding:f.binding}); expect(retry.ok,retry.error).toBe(true);
  },240_000);
  it.each(['ack','residue','postcommit-erased'])('quarantines %s uncertainty and never retries copied success evidence',async fault => {
    const f=await capture();
    const failed=await child({phase:'restore',anchor:f.anchor,binding:f.binding,fault});
    expect(failed.ok).toBe(false); expect(failed.dispatched).toBe(true);
    expect(journal(f).status).toBe('QUARANTINED'); expect(journal(f).lastAttempt.rollbackVerified).toBe(false);
    const retry=await child({phase:'restore',anchor:f.anchor,binding:f.binding});
    expect(retry.ok).toBe(false); expect(retry.error).toMatch(/Cold restore refused/);
  },240_000);
  it('rejects expiry unsafe transport links and modes without SQL dispatch',async () => {
    const f=await capture(), file=transport(f);
    const expectation=JSON.parse(readFileSync(`${control(f)}/expectation.json`,'utf8'));
    const expired=await child({phase:'restore',anchor:f.anchor,binding:f.binding,now:expectation.policy.expiresAt});
    expect(expired.ok).toBe(false); expect(expired.dispatched).toBe(false);
    chmodSync(file,0o644);
    expect((await child({phase:'restore',anchor:f.anchor,binding:f.binding})).ok).toBe(false);
    chmodSync(file,0o600);
    linkSync(file,file+'.link');
    expect((await child({phase:'restore',anchor:f.anchor,binding:f.binding})).ok).toBe(false);
    unlinkSync(file+'.link'); renameSync(file,file+'.saved'); symlinkSync(f.anchor.id+'.sql.saved',file);
    expect((await child({phase:'restore',anchor:f.anchor,binding:f.binding})).ok).toBe(false);
    unlinkSync(file); renameSync(file+'.saved',file);
    expect(journal(f).status).toBe('READY');
    expect((await child({phase:'restore',anchor:f.anchor,binding:f.binding})).ok).toBe(true);
  },240_000);
  it('fails closed after a coordinator exits while holding durable IN_FLIGHT',async () => {
    const f=await capture(false,Date.now()-1000);
    const abandoned=await child({phase:'abandon',anchor:f.anchor,binding:f.binding}); expect(abandoned.ok).toBe(true);
    expect(journal(f).status).toBe('IN_FLIGHT');
    const retry=await child({phase:'restore',anchor:f.anchor,binding:f.binding});
    expect(retry.ok).toBe(false); expect(retry.dispatched).toBe(false); expect(retry.pid).not.toBe(abandoned.pid);
    expect((await child({phase:'dispose',anchor:f.anchor})).ok).toBe(false);
    expect(journal(f).status).toBe('IN_FLIGHT');
  },240_000);
});
