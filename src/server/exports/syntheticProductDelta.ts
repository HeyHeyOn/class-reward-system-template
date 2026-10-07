import 'server-only';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readMaterializedRecoveryState, type MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { canonicalJson } from '@/server/migration/validators';
import { requireSyntheticCatalogFence } from './syntheticOriginalCatalog';

export type ProductWrite = { op:'create'|'update'; id:string; name:string; price:number; stock:number }
  | { op:'delete'; id:string };
export type ProductDelta = { bytes:Buffer; sha256:string; finalTables:Record<string,string> };
type Event = {sequence:number;entity:'products';op:'create'|'update'|'delete';id:string;before:string|null;after:string|null};
type Envelope = {profile:string;tenantId:string;sourceId:string;backupDigest:string;binding:MaterializedArchiveExpectation['binding'];
  from:number;through:number;events:Event[];finalProducts:string};
const PROFILE='SYNTHETIC_PRODUCT_TRANSACTION_V1';
const LIMIT=1_000_000;
const OMIT=new Set(['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations']);
const COLUMNS=['tenant_id','product_id','name','price','stock','is_active','image_url','category','sort_order','created_at','updated_at','deleted_at','version'];
const HASH=/^[0-9a-f]{64}$/;
const sha=(bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const ident=(s:string) => `"${s.replaceAll('"','""')}"`;
function refused():never { throw new Error('Synthetic product delta refused.'); }
function equal(a:unknown,b:unknown) { if (canonicalJson(a)!==canonicalJson(b)) refused(); }
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) refused();
  equal(Object.keys(value).sort(),[...keys].sort());
}
function text(v:unknown,max=1000):v is string { return typeof v==='string' && v.length>0 && v.length<=max && !v.includes('\0'); }
function row(raw:unknown,tenant:string,id:string) {
  if (!text(raw,100_000)) return refused();
  const r=JSON.parse(raw); exact(r,COLUMNS);
  if (r.tenant_id!==tenant || r.product_id!==id || !text(r.name) || !(r.name as string).trim()
    || typeof r.is_active!=='boolean' || !Number.isInteger(r.sort_order) || Number(r.sort_order)<-2147483648 || Number(r.sort_order)>2147483647) refused();
  for (const k of ['price','stock','version']) if (!Number.isSafeInteger(r[k]) || Number(r[k])<(k==='version' ? 1 : 0)) refused();
  for (const k of ['image_url','category']) if (r[k]!==null && (typeof r[k]!=='string' || (r[k] as string).length>1000)) refused();
  for (const k of ['created_at','updated_at','deleted_at']) {
    if (k==='deleted_at' && r[k]===null) continue;
    if (!text(r[k],64) || !Number.isFinite(Date.parse(r[k] as string))) refused();
  }
  return r;
}
const comparable=(tables:Record<string,string>) => Object.fromEntries(Object.entries(tables).filter(([t]) => !OMIT.has(t)));
function stateMatches(state:Awaited<ReturnType<typeof readMaterializedRecoveryState>>,base:MaterializedArchiveExpectation,products=base.tables.products) {
  equal(comparable(state.tables),{...comparable(base.tables),products});
  equal(state.guards,base.guards); equal(state.sequences,base.sequences);
}
async function lock(q:PoolClient,control=false) {
  await q.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='3000ms'; SET LOCAL TIME ZONE 'UTC'");
  await requireSyntheticCatalogFence(q);
  // Single synthetic cluster, no ambient URL or lifecycle/writer-fence changes.
  // A fixed whole-public lock set prevents hidden unsupported row mutations.
  if (control) await q.query('LOCK TABLE local_restore_control.lease IN EXCLUSIVE MODE');
  const tables=(await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  await q.query(`LOCK TABLE ${tables.map(t => `public.${ident(t.tablename)}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
}
async function product(q:PoolClient,tenant:string,id:string):Promise<string|null> {
  const found=await q.query('SELECT to_jsonb(p)::text AS wire FROM public.products p WHERE tenant_id=$1 AND product_id=$2',[tenant,id]);
  return found.rows[0]?.wire ?? null;
}
function admitBase(base:MaterializedArchiveExpectation) {
  if (!base || !HASH.test(base.digest) || base.digest.length!==64 || !base.tables.products) refused();
  const tenants=JSON.parse(base.tables.tenants), jobs=JSON.parse(base.tables.migration_jobs);
  if (tenants.length!==1 || tenants[0].id!==base.binding.tenantId || tenants[0].lifecycle!=='IMPORTING'
    || jobs.length!==1 || jobs[0].tenant_id!==base.binding.tenantId || jobs[0].job_id!==base.binding.migrationJobId || jobs[0].status!=='IMPORTING') refused();
}
/** ONE controlled synthetic transaction, not a general CDC or WAL cursor.
 * base is trusted coordinator evidence from the admitted cold backup, never
 * artifact-declared authority. No unsupported writers/entities are covered. */
export async function captureSyntheticProductWrites(source:DisposablePostgres,
  rawBase:MaterializedArchiveExpectation,rawWrites:ProductWrite[]):Promise<ProductDelta> {
  const base=structuredClone(rawBase),writes=structuredClone(rawWrites);
  admitBase(base);
  if (source.runId!==base.sourceId || !Array.isArray(writes) || !writes.length || writes.length>100) refused();
  for (const w of writes) {
    exact(w,w.op==='delete' ? ['op','id'] : ['op','id','name','price','stock']);
    if (!['create','update','delete'].includes(w.op) || !text(w.id) || w.id.trim()!==w.id) refused();
    if (w.op!=='delete' && (!text(w.name) || !w.name.trim() || !Number.isSafeInteger(w.price) || w.price<0 || !Number.isSafeInteger(w.stock) || w.stock<0)) refused();
  }
  const physical=await inspectArchiveDatabase(source);
  const q=await source.owner.connect();
  try {
    await q.query('BEGIN'); await lock(q);
    const before=await readMaterializedRecoveryState(q);
    const requestDigest=sha(canonicalJson({binding:base.binding,backupDigest:base.digest,writes}));
    const existing=(await q.query("SELECT to_regnamespace('local_product_delta') AS name")).rows[0].name;
    if (existing) {
      const receipts=(await q.query('SELECT * FROM local_product_delta.outbox')).rows;
      if (receipts.length!==1) refused();
      const receipt=receipts[0];
      equal({request:receipt.request_digest,system:receipt.system_identifier,source:receipt.source_id},
        {request:requestDigest,system:physical.systemIdentifier,source:source.runId});
      const bytes=Buffer.from(receipt.payload);
      if (bytes.length>LIMIT) refused();
      const envelope=decode(bytes,receipt.artifact_digest,base);
      stateMatches(before,base,envelope.finalProducts);
      equal(before.tables,{...base.tables,products:envelope.finalProducts});
      await q.query('COMMIT');
      return {bytes,sha256:receipt.artifact_digest,finalTables:before.tables};
    }
    stateMatches(before,base); equal(before.tables,base.tables);
    const events:Event[]=[];
    for (const w of writes) {
      const prior=await product(q,base.binding.tenantId,w.id);
      if ((w.op==='create') !== (prior===null)) refused();
      await q.query("SELECT set_config('app.tenant_id',$1,true)",[base.binding.tenantId]);
      await q.query('SET LOCAL ROLE app_runtime');
      const args=[base.binding.tenantId,w.id];
      const result=w.op==='delete'
        ? await q.query('DELETE FROM public.products WHERE tenant_id=$1 AND product_id=$2',args)
        : w.op==='create'
          ? await q.query('INSERT INTO public.products(tenant_id,product_id,name,price,stock) VALUES($1,$2,$3,$4,$5)',[...args,w.name,w.price,w.stock])
          : await q.query('UPDATE public.products SET name=$3,price=$4,stock=$5,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND product_id=$2',[...args,w.name,w.price,w.stock]);
      await q.query('RESET ROLE');
      if (result.rowCount!==1) refused();
      const after=await product(q,base.binding.tenantId,w.id);
      if (prior) row(prior,base.binding.tenantId,w.id);
      if (after) row(after,base.binding.tenantId,w.id);
      events.push({sequence:events.length+1,entity:'products',op:w.op,id:w.id,before:prior,after});
    }
    const final=await readMaterializedRecoveryState(q);
    stateMatches(final,base,final.tables.products);
    equal(final.tables,{...before.tables,products:final.tables.products});
    const envelope:Envelope={profile:PROFILE,tenantId:base.binding.tenantId,sourceId:base.sourceId,backupDigest:base.digest,
      binding:base.binding,from:0,through:events.length,events,finalProducts:final.tables.products};
    const bytes=Buffer.from(JSON.stringify(envelope));
    if (bytes.length>LIMIT) refused();
    // Persist the export in the SAME transaction as these controlled writes.
    // A lost COMMIT response can be retried against this database-backed outbox.
    // This is not an outbox for any other writer path or subsequent segment.
    decode(bytes,sha(bytes),base);
    await q.query(`CREATE SCHEMA local_product_delta;
      CREATE TABLE local_product_delta.outbox(singleton boolean PRIMARY KEY CHECK(singleton),source_id uuid NOT NULL,
        system_identifier text NOT NULL,request_digest text NOT NULL,artifact_digest text NOT NULL,payload text NOT NULL);
      CREATE FUNCTION local_product_delta.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic outbox is immutable'; END$$;
      CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON local_product_delta.outbox FOR EACH ROW EXECUTE FUNCTION local_product_delta.immutable();
      CREATE TRIGGER no_truncate BEFORE TRUNCATE ON local_product_delta.outbox FOR EACH STATEMENT EXECUTE FUNCTION local_product_delta.immutable();`);
    await q.query('INSERT INTO local_product_delta.outbox VALUES(true,$1,$2,$3,$4,$5)',
      [source.runId,physical.systemIdentifier,requestDigest,sha(bytes),bytes.toString('utf8')]);
    await q.query('COMMIT');
    return {bytes,sha256:sha(bytes),finalTables:final.tables};
  } catch (error) { await q.query('ROLLBACK'); throw error; }
  finally { q.release(); }
}
function decode(bytes:Buffer,pin:string,base:MaterializedArchiveExpectation):Envelope {
  if (!HASH.test(pin) || pin.length!==64 || sha(bytes)!==pin) refused();
  const e=JSON.parse(bytes.toString('utf8'));
  exact(e,['profile','tenantId','sourceId','backupDigest','binding','from','through','events','finalProducts']);
  if (e.profile!==PROFILE || e.tenantId!==base.binding.tenantId || e.sourceId!==base.sourceId || e.backupDigest!==base.digest
    || e.from!==0 || !Array.isArray(e.events) || !e.events.length || e.events.length>100 || e.through!==e.events.length) refused();
  equal(e.binding,base.binding);
  for (let i=0;i<e.events.length;i++) {
    const event=e.events[i]; exact(event,['sequence','entity','op','id','before','after']);
    if (event.sequence!==i+1 || event.entity!=='products' || !['create','update','delete'].includes(String(event.op))
      || !text(event.id) || event.id.trim()!==event.id) refused();
    const before=event.before===null ? null : row(event.before,base.binding.tenantId,event.id);
    const after=event.after===null ? null : row(event.after,base.binding.tenantId,event.id);
    if ((event.op==='create' && (before!==null || after===null || after.version!==1))
      || (event.op==='delete' && (before===null || after!==null))
      || (event.op==='update' && (!before || !after || Number(after.version)!==Number(before.version)+1 || after.created_at!==before.created_at))) refused();
  }
  if (!text(e.finalProducts,LIMIT)) refused();
  const rows=JSON.parse(e.finalProducts);
  if (!Array.isArray(rows) || rows.length>1000) refused();
  for (const r of rows) row(JSON.stringify(r),base.binding.tenantId,r.product_id);
  return e as unknown as Envelope;
}
/** Fresh independently cold-restored disposable destination only. The immutable
 * restore identity/receipt and private lease are checked on every call. The
 * separately retained digest is a trusted launcher input, NOT artifact auth.
 * Owner-only checkpoint and product writes are one PG transaction, no sequences
 * or guards are disabled. No runtime grant, activation or recovery API exists. */
export async function replaySyntheticProductDelta(db:DisposablePostgres,ownerId:string,
  rawBase:MaterializedArchiveExpectation,rawBytes:Buffer,expectedSha256:string):Promise<{kind:string;checkpoint:number}> {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length>LIMIT) refused();
  const bytes=Buffer.from(rawBytes),base=structuredClone(rawBase);
  admitBase(base);
  const e=decode(bytes,expectedSha256,base);
  if ([base.sourceId,base.originalSourceId].includes(db.runId) || ownerId===base.sourceOwner) refused();
  const physical=await inspectArchiveDatabase(db);
  const q=await db.owner.connect();
  try {
    await q.query('BEGIN'); await lock(q,true);
    const lease=(await q.query('SELECT * FROM local_restore_control.lease')).rows;
    equal(lease,[{singleton:true,database_id:db.runId,owner_id:ownerId,tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,
      system_identifier:physical.systemIdentifier,state:'EMPTY_LEASE'}]);
    const identity=(await q.query('SELECT * FROM public.migration_local_restore_databases')).rows;
    equal(identity,[{singleton:true,database_id:db.runId,owner_id:ownerId,tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,state:'RESTORED_NONAUTHORITY'}]);
    const receipts=(await q.query('SELECT * FROM public.migration_local_restorations')).rows;
    equal(receipts,[{tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,source_database_id:base.sourceId,
      destination_database_id:db.runId,source_owner_id:base.sourceOwner,destination_owner_id:ownerId,backup_digest:base.digest,
      source_readback_digest:sha(canonicalJson(base.tables)),schema_digest:sha(base.guards),
      provenance:{marker:base.marker,materialization:base.receipt},authority:'NONAUTHORITY',activation_allowed:false}]);
    const existing=(await q.query("SELECT to_regclass('local_restore_control.product_delta_checkpoint') AS name")).rows[0].name;
    const checkpoint={singleton:true,tenant_id:e.tenantId,source_id:e.sourceId,backup_digest:e.backupDigest,artifact_digest:expectedSha256,
      through:e.through,final_products_digest:sha(e.finalProducts)};
    const before=await readMaterializedRecoveryState(q);
    // The two source-only provenance tables must remain empty after restoration.
    // Excluding their intentional source/target difference from row reconciliation
    // must not admit copied or newly inserted authority-looking metadata.
    equal(before.tables.migration_local_disposable_database,'[]');
    equal(before.tables.migration_local_materializations,'[]');
    if (existing) {
      equal((await q.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows,[checkpoint]);
      stateMatches(before,base,e.finalProducts);
      await q.query('COMMIT'); return {kind:'ALREADY_APPLIED',checkpoint:e.through};
    }
    stateMatches(before,base);
    await q.query(`CREATE TABLE local_restore_control.product_delta_checkpoint(
      singleton boolean PRIMARY KEY CHECK(singleton),tenant_id uuid NOT NULL,source_id uuid NOT NULL,backup_digest text NOT NULL,
      artifact_digest text NOT NULL,through integer NOT NULL CHECK(through>0),final_products_digest text NOT NULL);
      CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON local_restore_control.product_delta_checkpoint FOR EACH ROW EXECUTE FUNCTION local_restore_control.immutable();
      CREATE TRIGGER no_truncate BEFORE TRUNCATE ON local_restore_control.product_delta_checkpoint FOR EACH STATEMENT EXECUTE FUNCTION local_restore_control.immutable();`);
    for (const event of e.events) {
      const current=await product(q,e.tenantId,event.id);
      equal(current===null ? null : JSON.parse(current),event.before===null ? null : JSON.parse(event.before));
      await q.query("SELECT set_config('app.tenant_id',$1,true)",[e.tenantId]);
      await q.query('SET LOCAL ROLE app_runtime');
      let result;
      if (event.op==='delete') result=await q.query('DELETE FROM public.products WHERE tenant_id=$1 AND product_id=$2',[e.tenantId,event.id]);
      else if (event.op==='create') result=await q.query('INSERT INTO public.products SELECT * FROM jsonb_populate_record(NULL::public.products,$1::jsonb)',[event.after]);
      else {
        const columns=COLUMNS.filter(c => !['tenant_id','product_id'].includes(c));
        result=await q.query(`UPDATE public.products p SET ${columns.map(c => `${ident(c)}=n.${ident(c)}`).join(',')}
          FROM jsonb_populate_record(NULL::public.products,$3::jsonb) n WHERE p.tenant_id=$1 AND p.product_id=$2`,[e.tenantId,event.id,event.after]);
      }
      await q.query('RESET ROLE');
      if (result.rowCount!==1) refused();
      const actual=await product(q,e.tenantId,event.id);
      equal(actual===null ? null : JSON.parse(actual),event.after===null ? null : JSON.parse(event.after));
    }
    const after=await readMaterializedRecoveryState(q);
    stateMatches(after,base,e.finalProducts);
    equal(after.tables,{...before.tables,products:e.finalProducts});
    await q.query(`INSERT INTO local_restore_control.product_delta_checkpoint VALUES(true,$1,$2,$3,$4,$5,$6)`,
      [e.tenantId,e.sourceId,e.backupDigest,expectedSha256,e.through,sha(e.finalProducts)]);
    equal((await q.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows,[checkpoint]);
    await q.query('COMMIT');
    return {kind:'APPLIED',checkpoint:e.through};
  } catch (error) { await q.query('ROLLBACK'); throw error; }
  finally { q.release(); }
}

// Shared only by the separately pinned synthetic chain extension. No route or
// runtime authority is exposed; V1 parsing, bounds and row semantics stay exact.
export const syntheticProductDeltaContract={admitBase,decode,stateMatches,lock,product,row,equal,exact,text,sha,ident,COLUMNS,PROFILE,LIMIT};
