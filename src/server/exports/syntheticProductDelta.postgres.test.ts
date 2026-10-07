// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const exec=promisify(execFile);
async function child(request:Record<string,unknown>) {
  const resultId=randomUUID();
  mkdirSync('.product-delta-results',{recursive:true,mode:0o700});
  const requestPath=`.product-delta-results/${resultId}-request.json`;
  writeFileSync(requestPath,JSON.stringify({...request,resultId}),{flag:'wx',mode:0o600});
  let exit=0,stdout='',stderr='';
  try {
    ({stdout,stderr}=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/productDeltaChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=.product-delta-results/${resultId}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
      PRODUCT_DELTA_REQUEST_FILE:requestPath},timeout:210_000,maxBuffer:8_000_000}));
  } catch (error) { const e=error as {code:number;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr; }
  console.info('PRODUCT_DELTA_CHILD',JSON.stringify({resultId,exit,stdout,stderr}));
  const result=JSON.parse(readFileSync(`.product-delta-results/${resultId}.json`,'utf8'));
  expect(result.ok,result.error).toBe(true);
  expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`.product-delta-results/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  return result;
}
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('Task21 synthetic postwrite product recovery',() => {
  it.each(['positive','negative'])('%s independent cold restore and idempotent replay',async phase => {
    const captured=await child({phase:'capture'});
    expect(captured.sourceClosed.containerRemoved).toBe(true);
    const restored=await child({phase,capture:captured});
    expect(restored.pid).not.toBe(captured.pid);
    expect(restored.databaseId).not.toBe(restored.sourceId);
    expect(restored.cleanup.containerRemoved).toBe(true);
    if (phase==='negative') {
      expect(restored.negativeResults).toHaveLength(13);
      expect(restored.provenanceRefusal.before).toBe(restored.provenanceRefusal.after);
    }
  },480_000);
});
