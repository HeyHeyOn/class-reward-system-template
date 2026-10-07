import 'server-only';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DisposablePostgres } from './disposablePostgres';
import { canonicalJson } from '@/server/migration/validators';

const SOCKET = 'unix:///var/run/docker.sock';
const LABEL = 'io.class-store.synthetic-pg-owner';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function refused(): never { throw new Error('Owned archive PostgreSQL boundary refused.'); }

async function docker(args: string[], input?: Buffer): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(),'crs-archive-cli-'));
  try {
    return await new Promise<Buffer>((resolve,reject) => {
      const child = spawn('docker',['--host',SOCKET,...args],{env:{PATH:process.env.PATH,HOME:scratch,
        DOCKER_CONFIG:scratch,LANG:'C',NODE_ENV:'test'},stdio:['pipe','pipe','pipe']});
      const chunks: Buffer[] = []; let size = 0, errors = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned archive command timed out.')); },60_000);
      child.on('error',reject);
      child.stdin.on('error',reject);
      child.stdout.on('data',(data: Buffer) => { size += data.length; if (size > 16_000_000) { child.kill('SIGKILL'); reject(new Error('Owned archive exceeds bound.')); } else chunks.push(data); });
      child.stderr.on('data',(data: Buffer) => { if (errors.length < 3000) errors += data.toString('utf8'); });
      child.once('close',code => { clearTimeout(timer); if (code===0) resolve(Buffer.concat(chunks));
        else reject(new Error(`Owned archive command failed (${code}): ${errors.slice(0,3000)}`)); });
      child.stdin.end(input);
    });
  } finally { await rm(scratch,{recursive:true,force:true}); }
}

/** Trusted synthetic infrastructure only. Re-inspect exact ID, isolation and PG
 * system identifier: a copied marker/evidence object cannot redirect a pool. */
export async function inspectArchiveDatabase(db: DisposablePostgres) {
  if (process.env.RUN_REAL_POSTGRES!=='1' || !UUID.test(db.runId)) refused();
  const id = db.evidence.containerId;
  if (typeof id!=='string' || !/^[0-9a-f]{64}$/.test(id) || db.evidence.runId!==db.runId) refused();
  const [owned] = JSON.parse((await docker(['inspect',id])).toString('utf8'));
  const c = owned.HostConfig;
  const mounts = ['/test-bin','/tmp','/var/lib/postgresql/data','/var/run/postgresql'];
  if (owned.Id!==id || owned.Config.Labels?.[LABEL]!==db.runId || owned.Image!==db.evidence.imageId
    || owned.Config.User!=='postgres' || !owned.State.Running || c.NetworkMode!=='none'
    || Object.keys(c.PortBindings ?? {}).length || c.PublishAllPorts || c.Binds?.length || c.VolumesFrom?.length
    || !c.ReadonlyRootfs || c.Privileged || !c.CapDrop.includes('ALL') || !c.SecurityOpt.includes('no-new-privileges')
    || JSON.stringify(Object.keys(c.Tmpfs).sort())!==JSON.stringify(mounts)
    || owned.Mounts.some((m: {Type: string; Destination: string}) => m.Type!=='tmpfs' || !mounts.includes(m.Destination))) refused();
  const viaPool = await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()');
  const viaCli = (await docker(['exec','--user','postgres',id,'psql','-X','-w','-h','/var/run/postgresql','-U','postgres','-d','postgres',
    '-Atc','SELECT system_identifier::text FROM pg_control_system()'])).toString('utf8').trim();
  if (viaPool.rows.length!==1 || viaPool.rows[0].id!==viaCli) refused();
  return {id,systemIdentifier:viaCli};
}

export async function dumpOwnedDatabase(db: DisposablePostgres, snapshot: string) {
  return dumpDatabase(db,snapshot,['--exclude-table-data=public.migration_local_disposable_database',
    '--exclude-table-data=public.migration_local_materializations']);
}

/** Separate ORIGINAL image: preserve even the historical SOURCE marker. Its
 * database_id remains the closed source ID, NEVER the fresh restore lease ID. */
export async function dumpOriginalOwnedDatabase(db: DisposablePostgres, snapshot: string) {
  return dumpDatabase(db,snapshot,[]);
}

async function dumpDatabase(db: DisposablePostgres, snapshot: string, exclusions: string[]) {
  const {id} = await inspectArchiveDatabase(db);
  if (!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(snapshot)) refused();
  return docker(['exec','--user','postgres',id,'pg_dump','-w','-h','/var/run/postgresql','-U','postgres','-d','postgres',
    '--format=plain','--inserts','--no-owner','--no-tablespaces',`--snapshot=${snapshot}`,...exclusions]);
}

/** psql owns ONE transaction spanning dump DDL/data, verification and receipt.
 * No trigger-disabling, replication role, or COPY/JSON importer emulation. */
export async function executeOwnedRestore(db: DisposablePostgres, script: string) {
  const {id} = await inspectArchiveDatabase(db);
  await docker(['exec','-i','--user','postgres',id,'psql','-X','-w','-q','-h','/var/run/postgresql','-U','postgres','-d','postgres',
    '--single-transaction','--set','ON_ERROR_STOP=1','--file=-'],Buffer.from(script,'utf8'));
}

export type ColdOwnedInventory = {
  version:1; packetId:string; attemptId:string; leaseSha256:string; ownerId:string;
  runId:string; imageId:string; phase:'PLANNED'|'CREATED'|'STARTING'|'ALLOCATED'|'DISPATCHED';
  containerId?:string; systemIdentifier?:string; control?:unknown[]; controlGuards?:unknown[];
};
export type ColdOwnedReadback = {
  systemIdentifier:string; schemas:string[]; publicObjects:unknown[]; sessions:unknown[];
  control:Record<string,unknown>[]; controlGuards:unknown[];
  identity:Record<string,unknown>[]; receipts:Record<string,unknown>[];
  registry:Record<string,unknown>[]; claims:Record<string,unknown>[]; operations:Record<string,unknown>[];
};
export class ColdOwnedBlocker extends Error {
  constructor(readonly blocker:string) { super(blocker); }
}
function blocked(blocker:string):never { throw new ColdOwnedBlocker(blocker); }
/** Inventory lookup is scoped to unpredictable owner AND packet AND attempt.
 * No global Docker inventory, endpoint, container-name adoption or credentials. */
async function inspectColdPhysical(inventory:ColdOwnedInventory) {
  if (process.env.RUN_REAL_POSTGRES!=='1' || !UUID.test(inventory.runId) || !UUID.test(inventory.ownerId)
    || !UUID.test(inventory.packetId) || !UUID.test(inventory.attemptId)
    || !/^sha256:[a-f0-9]{64}$/.test(inventory.imageId)) blocked('INVENTORY_MISMATCH');
  const ids=(await docker(['ps','-aq','--no-trunc','--filter',`label=${LABEL}=${inventory.runId}`,
    '--filter',`label=io.class-store.cold-packet=${inventory.packetId}`,
    '--filter',`label=io.class-store.cold-attempt=${inventory.attemptId}`])).toString('utf8').trim().split('\n').filter(Boolean);
  if (ids.length!==1 || !/^[a-f0-9]{64}$/.test(ids[0]) || (inventory.containerId && inventory.containerId!==ids[0])) blocked('OWNERSHIP_MISMATCH');
  const id=ids[0], [owned]=JSON.parse((await docker(['inspect',id])).toString('utf8'));
  const c=owned.HostConfig, mounts=['/test-bin','/tmp','/var/lib/postgresql/data','/var/run/postgresql'];
  if (owned.Id!==id || owned.Name!==`/crs-app-pg-${inventory.runId}` || owned.Config.Labels?.[LABEL]!==inventory.runId
    || owned.Config.Labels?.['io.class-store.cold-packet']!==inventory.packetId || owned.Config.Labels?.['io.class-store.cold-attempt']!==inventory.attemptId
    || owned.Image!==inventory.imageId || owned.Config.User!=='postgres' || c.NetworkMode!=='none'
    || Object.keys(c.PortBindings ?? {}).length || c.PublishAllPorts || c.Binds?.length || c.VolumesFrom?.length
    || !c.ReadonlyRootfs || c.Privileged || !c.CapDrop.includes('ALL') || !c.SecurityOpt.includes('no-new-privileges')
    || canonicalJson(Object.keys(c.Tmpfs).sort())!==canonicalJson(mounts)
    || owned.Mounts.some((m:{Type:string;Destination:string}) => m.Type!=='tmpfs' || !mounts.includes(m.Destination))) blocked('OWNERSHIP_MISMATCH');
  return owned;
}
export async function inspectColdOrphan(inventory:ColdOwnedInventory) {
  const owned=await inspectColdPhysical(inventory);
  if (!owned.State.Running || owned.State.Paused || owned.State.Restarting) blocked('DESTINATION_UNREADABLE');
  return owned.Id as string;
}
/** CREATED is pinned before STARTING is durably published and before any
 * Docker start invocation. Never infer this authority from stopped/PID/age. */
async function readUnstartedColdAllocation(inventory:ColdOwnedInventory) {
  if (inventory.phase!=='CREATED' || typeof inventory.containerId!=='string' || !/^[a-f0-9]{64}$/.test(inventory.containerId)) blocked('ALLOCATION_ID_UNPROVEN');
  const owned=await inspectColdPhysical(inventory), s=owned.State;
  if (s.Status!=='created' || s.Running!==false || s.Paused!==false || s.Restarting!==false || s.Dead!==false
    || s.Pid!==0 || s.ExitCode!==0 || s.Error!=='' || s.StartedAt!=='0001-01-01T00:00:00Z'
    || s.FinishedAt!=='0001-01-01T00:00:00Z' || owned.RestartCount!==0) blocked('ALLOCATION_START_UNPROVEN');
  return {kind:'NEVER_STARTED' as const,containerId:owned.Id as string,imageId:owned.Image as string,state:s,restartCount:owned.RestartCount as number};
}
export async function disposeUnstartedColdAllocation(inventory:ColdOwnedInventory) {
  const readback=await readUnstartedColdAllocation(inventory);
  const repeated=await readUnstartedColdAllocation(inventory);
  if (canonicalJson(readback)!==canonicalJson(repeated)) blocked('ALLOCATION_START_UNPROVEN');
  const id=readback.containerId;
  // Never force a newly running container through this never-started branch.
  await docker(['rm',id]);
  if ((await docker(['ps','-aq','--no-trunc','--filter',`id=${id}`])).toString('utf8').trim()) blocked('CLEANUP_UNCONFIRMED');
  return {readback,cleanup:{containerRemoved:true as const,id}};
}

/** Read-only, bounded native SQL. Missing public tables yield []; an unavailable
 * control lease or PG system identifier is NOT treated as an empty database. */
export async function readColdOrphan(inventory:ColdOwnedInventory):Promise<ColdOwnedReadback> {
  const id=await inspectColdOrphan(inventory);
  const aggregate=(query:string) => `(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM (${query}) t)`;
  const sessions="SELECT pid,state,wait_event,query FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()";
  const publicObjects="SELECT classid::regclass::text AS class,objid::text,objsubid,pg_describe_object(classid,objid,objsubid) AS description FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='public'::regnamespace";
  const controlGuards=`SELECT jsonb_build_array('object',classid::regclass::text,objid::text,objsubid,pg_describe_object(classid,objid,objsubid)) v FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='local_restore_control'::regnamespace
    UNION ALL SELECT jsonb_build_array('function',p.proname,pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace='local_restore_control'::regnamespace AND p.prokind='f'
    UNION ALL SELECT jsonb_build_array('trigger',t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='local_restore_control'::regnamespace AND NOT t.tgisinternal
    UNION ALL SELECT jsonb_build_array('constraint',c.conname,pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.connamespace='local_restore_control'::regnamespace
    UNION ALL SELECT jsonb_build_array('column',to_jsonb(c)) FROM information_schema.columns c WHERE c.table_schema='local_restore_control'
    UNION ALL SELECT jsonb_build_array('grant',to_jsonb(g)) FROM information_schema.role_table_grants g WHERE g.table_schema='local_restore_control'`;
  const tables={identity:'migration_local_restore_databases',receipts:'migration_local_restorations',registry:'padlet_claim_digest_registry',claims:'padlet_evidence_claims',operations:'operations'};
  const literal=(s:string) => `'${s.replaceAll("'","''")}'`;
  const script=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='1000ms';
    SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'schemas',(SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'),
      'publicObjects',${aggregate(publicObjects)},'sessions',${aggregate(sessions)},
      'control',${aggregate('SELECT * FROM local_restore_control.lease')},'controlGuards',${aggregate(controlGuards)});
    ${Object.entries(tables).map(([key,table]) => `SELECT CASE WHEN to_regclass('public.${table}') IS NULL OR EXISTS (${sessions})
      THEN ${literal(`SELECT jsonb_build_object('${key}','[]'::jsonb)`)}
      ELSE ${literal(`SELECT jsonb_build_object('${key}',${aggregate(`SELECT * FROM public.${table}`)})`)} END
      \\gexec`).join('\n')}
    COMMIT;`;
  const output=await docker(['exec','-i','--user','postgres',id,'psql','-X','-w','-qAt','-h','/var/run/postgresql','-U','postgres','-d','postgres',
    '--set','ON_ERROR_STOP=1','--file=-'],Buffer.from(script));
  const rows=output.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  if (rows.length!==6) blocked('DESTINATION_UNREADABLE');
  const readback=Object.assign({},...rows) as ColdOwnedReadback;
  if (!/^[0-9]+$/.test(readback.systemIdentifier) || (inventory.systemIdentifier && readback.systemIdentifier!==inventory.systemIdentifier)) blocked('CONTROL_MISMATCH');
  return readback;
}
export function coldOrphanEmpty(inventory:ColdOwnedInventory,readback:ColdOwnedReadback) {
  return inventory.phase==='ALLOCATED' && !!inventory.containerId && !!inventory.systemIdentifier
    && Array.isArray(inventory.control) && inventory.control.length===1 && Array.isArray(inventory.controlGuards) && inventory.controlGuards.length>0
    && readback.systemIdentifier===inventory.systemIdentifier && readback.sessions.length===0 && readback.publicObjects.length===0
    && canonicalJson(readback.schemas)===canonicalJson(['local_restore_control','public'])
    && canonicalJson(readback.control)===canonicalJson(inventory.control) && canonicalJson(readback.controlGuards)===canonicalJson(inventory.controlGuards);
}
/** Caller holds authenticated recovery lease and observed termination. Repeat
 * physical/SQL inspection immediately before exact removal; failures preserve. */
export async function disposeEmptyColdOrphan(inventory:ColdOwnedInventory) {
  const before=await readColdOrphan(inventory);
  if (!coldOrphanEmpty(inventory,before)) blocked('EMPTY_TARGET_UNPROVEN');
  const id=await inspectColdOrphan(inventory);
  await docker(['rm','--force',id]);
  // A failed Docker query is never interpreted as absence.
  if ((await docker(['ps','-aq','--no-trunc','--filter',`id=${id}`])).toString('utf8').trim()) blocked('CLEANUP_UNCONFIRMED');
  return {containerRemoved:true as const,id};
}
