import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
const exec=promisify(execFile);
export const digest=(v:Buffer|string) => createHash('sha256').update(v).digest('hex');
export async function terminalChild(request:Record<string,unknown>) {
  const resultId=randomUUID(),dir='.product-terminal-results';
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=`${dir}/${resultId}-request.json`;
  writeFileSync(path,JSON.stringify({...request,resultId}),{flag:'wx',mode:0o600});
  let exit:number|string=0,stdout='',stderr='';
  try {
    ({stdout,stderr}=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/productTerminalChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${dir}/${resultId}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',PRODUCT_TERMINAL_REQUEST_FILE:path},
      timeout:480_000,maxBuffer:12_000_000}));
  } catch (error) {const e=error as {code:number|string;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr;}
  console.info('PRODUCT_TERMINAL_CHILD',JSON.stringify({resultId,exit,stdout,stderr}));
  const result=JSON.parse(readFileSync(`${dir}/${resultId}.json`,'utf8'));
  expect(result.ok,result.error).toBe(true); expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`${dir}/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  return result;
}
export async function terminalState(db:DisposablePostgres) {
  const schemas=['local_product_chain','local_restore_control','local_product_terminal'];
  const tables=(await db.owner.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename',[schemas])).rows;
  const rows:Record<string,unknown>={};
  for (const t of tables) rows[`${t.schemaname}.${t.tablename}`]=(await db.owner.query(`SELECT to_jsonb(t)::text AS wire FROM "${t.schemaname}"."${t.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  const guards=(await db.owner.query(`SELECT n.nspname,c.relname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1) AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`,[schemas])).rows;
  const objects=(await db.owner.query(`SELECT n.nspname,pg_describe_object(d.classid,d.objid,d.objsubid) AS v FROM pg_depend d JOIN pg_namespace n
    ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid WHERE n.nspname=ANY($1) ORDER BY n.nspname,v`,[schemas])).rows;
  return {public:await readMaterializedRecoveryState(db.owner),private:{rows,guards,objects}};
}
export const comparable=(tables:Record<string,string>) => Object.fromEntries(Object.entries(tables).filter(([t]) =>
  !['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(t)));
