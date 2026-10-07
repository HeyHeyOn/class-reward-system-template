import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { ExecSocket, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { createTenantTransactionRunner } from '@/server/db/transaction';
const exec=promisify(execFile);
export async function chainChild(request:Record<string,unknown>) {
  const resultId=randomUUID(),dir='.product-chain-results';
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=`${dir}/${resultId}-request.json`;
  writeFileSync(path,JSON.stringify({...request,resultId}),{flag:'wx',mode:0o600});
  let exit:number|string=0,stdout='',stderr='';
  try {
    ({stdout,stderr}=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/productChainChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${dir}/${resultId}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',PRODUCT_CHAIN_REQUEST_FILE:path},
      timeout:360_000,maxBuffer:12_000_000}));
  } catch (error) { const e=error as {code:number|string;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr; }
  console.info('PRODUCT_CHAIN_CHILD',JSON.stringify({resultId,exit,stdout,stderr}));
  const result=JSON.parse(readFileSync(`${dir}/${resultId}.json`,'utf8'));
  expect(result.ok,result.error).toBe(true); expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`${dir}/${resultId}-vitest.json`,'utf8'));
  expect(report.numFailedTests).toBe(0); expect(report.numPassedTests).toBe(1);
  return result;
}
/** Test-only process transport. The live parent retains creation/cleanup ownership.
 * Only its separately passed exact synthetic handle is borrowed; never discover or
 * adopt resources from delta bytes, names, endpoints, cold-orphan state or secrets. */
export async function borrowChainDatabase(descriptor:{runId:string;evidence:Record<string,unknown>}) {
  const id=descriptor.evidence.containerId;
  if (process.env.RUN_REAL_POSTGRES!=='1' || typeof id!=='string' || !/^[a-f0-9]{64}$/.test(id)
    || !/^[a-f0-9-]{36}$/.test(descriptor.runId)) throw new Error('Invalid parent-owned synthetic handle');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'};
  const inspection=JSON.parse((await exec('docker',['--host','unix:///var/run/docker.sock','inspect',id],{env})).stdout)[0];
  if (inspection.Id!==id || inspection.Config.Labels?.['io.class-store.synthetic-pg-owner']!==descriptor.runId
    || inspection.Image!==descriptor.evidence.imageId || inspection.HostConfig.NetworkMode!=='none'
    || inspection.HostConfig.Binds?.length || inspection.HostConfig.VolumesFrom?.length
    || Object.keys(inspection.HostConfig.PortBindings ?? {}).length) throw new Error('Unowned handle');
  const streams=new Set<ExecSocket>();
  const pool=(user:string) => new Pool({user,database:'postgres',host:'/var/run/postgresql',port:5432,password:() => '',ssl:false,
    options:'-c timezone=UTC',max:1,connectionTimeoutMillis:15_000,query_timeout:20_000,idleTimeoutMillis:1000,
    stream:() => {const s=new ExecSocket(id,env); streams.add(s); s.once('close',() => streams.delete(s)); return s;}});
  const owner=pool('postgres'),runtime=pool('app_runtime');
  owner.on('error',() => {}); runtime.on('error',() => {});
  const release=async () => {await Promise.all([owner.end(),runtime.end()]); for (const stream of streams) stream.destroy();};
  const db:DisposablePostgres={...descriptor,owner,runtime,runTenantTransaction:createTenantTransactionRunner({pool:runtime}),
    close:async () => {throw new Error('Borrower has no cleanup authority');}};
  try {await inspectArchiveDatabase(db); return {db,release};}
  catch (error) {await release(); throw error;}
}
