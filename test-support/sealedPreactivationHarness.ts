import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { canonicalJson } from '@/server/migration/validators';
import { digest, terminalState } from './productTerminalHarness';
const exec=promisify(execFile);
export const directory='.product-terminal-results';
export async function preactivationChild(request:Record<string,unknown>) {
  const resultId=randomUUID(); mkdirSync(directory,{recursive:true,mode:0o700});
  const path=`${directory}/${resultId}-preactivation-request.json`;
  writeFileSync(path,JSON.stringify({...request,resultId}),{flag:'wx',mode:0o600});
  let exit:number|string=0,stdout='',stderr='';
  try {
    ({stdout,stderr}=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/sealedPreactivationChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${directory}/${resultId}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',SEALED_PREACTIVATION_REQUEST:path},
      timeout:600_000,maxBuffer:12_000_000}));
  } catch (error) {const e=error as {code:number|string;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr;}
  console.info('SEALED_PREACTIVATION_CHILD',JSON.stringify({resultId,exit,stdout,stderr}));
  const result=JSON.parse(readFileSync(`${directory}/${resultId}-preactivation.json`,'utf8'));
  expect(result.ok,result.error).toBe(true); expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`${directory}/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  return result;
}
/** Full SQL row/xmin/ctid and public/private state, not a boolean MATCH. Files
 * contain only generated synthetic data. Same digest reuses the exact witness. */
export async function preactivationWitness(db:DisposablePostgres) {
  const state=await terminalState(db);
  const tables=(await db.owner.query(`SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN
    ('public','local_product_chain','local_restore_control','local_product_terminal') ORDER BY schemaname,tablename`)).rows;
  const sql:Record<string,unknown>={};
  for (const t of tables) sql[`${t.schemaname}.${t.tablename}`]=(await db.owner.query(
    `SELECT to_jsonb(t)::text AS wire,xmin::text,ctid::text FROM "${t.schemaname}"."${t.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  const privateFunctions=(await db.owner.query(`SELECT n.nspname,p.proname,pg_get_functiondef(p.oid) AS definition,p.proacl::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN
    ('local_product_chain','local_restore_control','local_product_terminal') ORDER BY n.nspname,p.proname`)).rows;
  const privateRelations=(await db.owner.query(`SELECT n.nspname,c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN
    ('local_product_chain','local_restore_control','local_product_terminal') ORDER BY n.nspname,c.relname`)).rows;
  const wire=canonicalJson({state,sql,privateFunctions,privateRelations}),sha256=digest(wire);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=`${directory}/${sha256}-preactivation-state.json`;
  try {writeFileSync(path,wire,{flag:'wx',mode:0o600});}
  catch (error) {if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; expect(readFileSync(path,'utf8')).toBe(wire);}
  return {sha256,path};
}
