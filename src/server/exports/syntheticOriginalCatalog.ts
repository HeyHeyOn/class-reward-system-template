import 'server-only';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@/server/migration/validators';

const ROOT=resolve('.synthetic-original-catalog');
const TABLES=new Set(['local_product_chain.intent','local_product_chain.terminal','local_product_chain.outbox',
  'local_product_terminal.lease','local_product_terminal.seal','local_restore_control.lease',
  'local_restore_control.product_chain_terminal','local_restore_control.product_chain_checkpoint',
  'local_restore_control.sealed_export_execution','local_restore_control.sealed_preactivation']);
function refused():never {throw new Error('Synthetic ORIGINAL catalog prerequisite refused.');}
function equal(a:unknown,b:unknown) {if (canonicalJson(a)!==canonicalJson(b)) refused();}

/** Native PostgreSQL 17 fixture only. ALL heap catalogs, including shared role/
 * database catalogs, stay locked until transaction end. No advisory-lock fiction,
 * event-trigger opt-out or server flag change. Failure never falls back to the
 * old relation-only guard. Trusted SQL owner/host/binary, not hostile superuser
 * code in this connection, is the boundary; this confers NO replay authority. */
export async function requireSyntheticCatalogFence(q:PoolClient) {
  if (process.env.RUN_REAL_POSTGRES!=='1') refused();
  // Bootstrap must not resolve a function/operator through an unvalidated path.
  // Even a rejected lookalike can have nonrollbackable sequence side effects.
  // The default path string does not exclude implicit pg_temp relation lookup
  // or a newly existing "$user" schema. Recheck effective resolution on EVERY
  // entry, before copied temporary catalogs can authenticate a changed guard.
  const mode=(await q.query(`SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS readonly,
    pg_catalog.current_setting('server_version_num') AS version,
    pg_catalog.current_setting('search_path') AS path,
    pg_catalog.current_schemas(true)::pg_catalog.text[] AS schemas,
    pg_catalog.current_setting('allow_system_table_mods') AS system_mods`)).rows[0];
  if (mode.isolation!=='read committed' || mode.readonly!=='off' || !/^17[0-9]{4}$/.test(mode.version)
    || mode.path!=='"$user", public' || mode.system_mods!=='off') refused();
  equal(mode.schemas,['pg_catalog','public']);
  // SHARE catalog locks alone admit two transactions that can then trap one
  // another on a catalog-lock upgrade. Take a self-conflicting native entrance
  // lock BEFORE collecting any SHARE locks. NOWAIT refuses the contender rather
  // than retaining a partial catalog lock set while waiting on the owner. The
  // lock is reentrant for this transaction, and PostgreSQL releases it only at
  // transaction/subtransaction end or backend death. This is fixture catalog
  // exclusion, NOT a transferable successor capability or operational fence.
  await q.query('LOCK TABLE pg_catalog.pg_namespace IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  // LOCK itself rejects an autocommit caller. SQL names come only from native
  // pg_catalog, are quoted, and cannot be chosen by an artifact or API caller.
  const catalogs=(await q.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pg_catalog' AND c.relkind='r' ORDER BY c.relname`)).rows;
  if (!catalogs.some(r => r.relname==='pg_proc') || !catalogs.some(r => r.relname==='pg_authid')) refused();
  await q.query(`LOCK TABLE ${catalogs.map(r => `pg_catalog."${String(r.relname).replaceAll('"','""')}"`).join(',')} IN SHARE MODE`);
  const privilege=(await q.query(`SELECT current_user,session_user,r.rolsuper,current_setting('session_replication_role') AS replication,
    pg_catalog.current_schemas(true)::pg_catalog.text[] AS schemas,
    current_setting('search_path') AS search_path FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0];
  equal(privilege,{current_user:'postgres',session_user:'postgres',rolsuper:true,replication:'origin',schemas:['pg_catalog','public'],search_path:'"$user", public'});
}

async function directory(path:string,create=false) {
  if (create) await mkdir(path,{mode:0o700}).catch(e => {if (e.code!=='EEXIST') throw e;});
  const s=await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid?.() || (s.mode & 0o777)!==0o700) refused();
}
async function syncDirectory(path:string) {
  const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {await f.sync();} finally {await f.close();}
}
async function location(q:PoolClient,table:string,create=false) {
  if (!TABLES.has(table)) refused();
  const r=(await q.query(`SELECT (pg_control_system()).system_identifier::text AS system,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database,pg_current_xact_id()::text AS xid`)).rows[0];
  if (!/^[1-9][0-9]*$/.test(r.system) || !/^[1-9][0-9]*$/.test(r.database) || !/^[1-9][0-9]*$/.test(r.xid)) refused();
  await directory(ROOT,create);
  const path=join(ROOT,`${r.system}-${r.database}-${table}`); await directory(path,create);
  if (create) await syncDirectory(ROOT);
  return {path,xid:r.xid as string};
}
/** Exact semantic catalog, including native OIDs (drop/recreate is drift).
 * Exclude ONLY vacuum/planner counters and physical storage bookkeeping. No
 * row data is a catalog baseline. Original row/chain/coordinator identity is
 * bound separately below and by the existing terminal/journal admission. */
async function catalog(q:PoolClient,table:string) {
  const result:Record<string,unknown>={};
  const schema=table.split('.')[0];
  const queries:Record<string,[string,unknown[]]>={
    schema:['SELECT to_jsonb(n) AS v FROM pg_namespace n WHERE n.nspname=$1',[schema]],
    relations:[`SELECT to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible','relfrozenxid','relminmxid','relfilenode','reltoastrelid'] AS v
      FROM pg_class c WHERE c.oid=$1::regclass OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid=$1::regclass) ORDER BY c.oid`,[table]],
    columns:['SELECT to_jsonb(a) AS v FROM pg_attribute a WHERE a.attrelid=$1::regclass ORDER BY a.attnum',[table]],
    defaults:['SELECT to_jsonb(d) AS v FROM pg_attrdef d WHERE d.adrelid=$1::regclass ORDER BY d.oid',[table]],
    constraints:['SELECT to_jsonb(c) AS v FROM pg_constraint c WHERE c.conrelid=$1::regclass OR c.confrelid=$1::regclass ORDER BY c.oid',[table]],
    triggers:['SELECT to_jsonb(t) AS v FROM pg_trigger t WHERE t.tgrelid=$1::regclass ORDER BY t.oid',[table]],
    rules:['SELECT to_jsonb(r) AS v FROM pg_rewrite r WHERE r.ev_class=$1::regclass ORDER BY r.oid',[table]],
    policies:['SELECT to_jsonb(p) AS v FROM pg_policy p WHERE p.polrelid=$1::regclass ORDER BY p.oid',[table]],
    indexes:['SELECT to_jsonb(i) AS v FROM pg_index i WHERE i.indrelid=$1::regclass ORDER BY i.indexrelid',[table]],
    types:['SELECT to_jsonb(t) AS v FROM pg_type t WHERE t.typrelid=$1::regclass ORDER BY t.oid',[table]],
    functions:['SELECT to_jsonb(p) AS v FROM pg_proc p WHERE p.pronamespace=$1::regnamespace ORDER BY p.oid',[schema]],
    languages:['SELECT to_jsonb(l) AS v FROM pg_language l ORDER BY l.oid',[]],
    languageFunctions:[`SELECT to_jsonb(p) AS v FROM pg_proc p WHERE oid IN
      (SELECT lanplcallfoid FROM pg_language UNION SELECT laninline FROM pg_language UNION SELECT lanvalidator FROM pg_language) ORDER BY oid`,[]],
    eventTriggers:['SELECT to_jsonb(e) AS v FROM pg_event_trigger e ORDER BY oid',[]],
    roles:[`SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil,rolbypassrls,rolconfig
      FROM pg_roles ORDER BY oid`,[]],
    memberships:['SELECT to_jsonb(m) AS v FROM pg_auth_members m ORDER BY m.oid',[]],
    database:['SELECT oid,datname,datdba,datistemplate,datallowconn,datconnlimit,datacl FROM pg_database WHERE datname=current_database()',[]],
    settings:['SELECT to_jsonb(s) AS v FROM pg_db_role_setting s ORDER BY setdatabase,setrole',[]],
    defaultACL:['SELECT to_jsonb(a) AS v FROM pg_default_acl a ORDER BY a.oid',[]],
    inheritance:['SELECT to_jsonb(i) AS v FROM pg_inherits i WHERE inhrelid=$1::regclass OR inhparent=$1::regclass ORDER BY inhrelid,inhseqno',[table]],
  };
  for (const [key,[sql,args]] of Object.entries(queries)) result[key]=(await q.query(sql,args)).rows;
  return result;
}
async function originals(q:PoolClient,path:string,xid:string) {
  const live:string[]=[];
  for (const file of (await readdir(path)).sort()) {
    const match=/^([1-9][0-9]*)\.json$/.exec(file); if (!match) refused();
    const status=(await q.query('SELECT pg_xact_status($1::xid8) AS status',[match[1]])).rows[0].status;
    // Aborted enrollment is retained as evidence, NEVER used as ORIGINAL. An
    // unknown/too-old xid or another live transaction is not permission to adopt.
    if (status==='aborted') continue;
    if (status!=='committed' && !(status==='in progress' && match[1]===xid)) refused();
    live.push(file);
  }
  if (live.length>1) refused();
  return live;
}
async function read(path:string) {
  // Reject nonregular evidence before a FIFO can wait for a writer while the
  // admission transaction holds native catalog locks. Never read/adopt it.
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=await f.stat();
    if (!s.isFile() || s.nlink!==1 || s.uid!==process.getuid?.() || (s.mode&0o777)!==0o400 || s.size>2_000_000) refused();
    const bytes=await f.readFile('utf8'); if (Buffer.byteLength(bytes)!==s.size) refused();
    return bytes;
  } finally {await f.close();}
}
/** ONLY source DDL call sites, in the same transaction as brand-new empty
 * table creation, BEFORE its first INSERT. Never enroll on read/retry or from
 * transport/caller pins. Append-only xid records reconcile rollback without
 * deleting/replacing evidence; a committed original can never be re-enrolled. */
export async function enrollSyntheticOriginalCatalog(q:PoolClient,table:string,identity:Record<string,unknown>) {
  await requireSyntheticCatalogFence(q);
  if (!TABLES.has(table)) refused();
  const created=(await q.query(`SELECT xmin::text=pg_current_xact_id()::xid::text AS created FROM pg_class WHERE oid=$1::regclass`,[table])).rows;
  equal(created,[{created:true}]);
  if ((await q.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) refused();
  const {path,xid}=await location(q,table,true);
  if ((await originals(q,path,xid)).length) refused();
  const value={version:1,table,xid,identity:structuredClone(identity),catalog:await catalog(q,table)};
  const f=await open(join(path,`${xid}.json`),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
  try {await f.writeFile(canonicalJson(value)); await f.sync();} finally {await f.close();}
  await syncDirectory(path);
}
export async function requireSyntheticOriginalCatalog(q:PoolClient,table:string) {
  await requireSyntheticCatalogFence(q);
  const {path,xid}=await location(q,table),files=await originals(q,path,xid);
  if (files.length!==1) refused();
  const bytes=await read(join(path,files[0])),baseline=JSON.parse(bytes);
  if (canonicalJson(baseline)!==bytes || baseline.version!==1 || baseline.table!==table || `${baseline.xid}.json`!==files[0]) refused();
  equal(await catalog(q,table),baseline.catalog);
  // Empty is allowed only while the ORIGINAL creation transaction is doing its
  // first insert. Callers still enforce singleton/journal cardinality on read.
  const rows=(await q.query(`SELECT to_jsonb(t) AS v FROM ${table} t`)).rows;
  if (!rows.length && baseline.xid!==xid) refused();
  for (const {v} of rows) for (const [key,value] of Object.entries(baseline.identity)) equal(v[key],value);
}
