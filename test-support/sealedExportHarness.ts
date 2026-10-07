import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
const exec=promisify(execFile);
export const directory='.sealed-export-results';
export async function sealedExportChild(request:Record<string,unknown>) {
  const resultId=randomUUID(); mkdirSync(directory,{recursive:true,mode:0o700});
  const path=`${directory}/${resultId}-request.json`;
  writeFileSync(path,JSON.stringify({...request,resultId}),{flag:'wx',mode:0o600});
  let exit:number|string=0,stdout='',stderr='';
  try {
    ({stdout,stderr}=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/sealedExportChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${directory}/${resultId}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',SEALED_EXPORT_REQUEST:path},
      timeout:600_000,maxBuffer:12_000_000}));
  } catch (error) {const e=error as {code:number|string;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr;}
  console.info('SEALED_EXPORT_CHILD',JSON.stringify({resultId,exit,stdout,stderr}));
  const result=JSON.parse(readFileSync(`${directory}/${resultId}.json`,'utf8'));
  expect(result.ok,result.error).toBe(true); expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`${directory}/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  return result;
}
