import 'server-only';
import { requireColdExportReplay } from '@/server/db/testing/coldRestoreStore';
import type { PoolClient } from 'pg';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readMaterializedRecoveryState, type MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { canonicalJson } from '@/server/migration/validators';
import { syntheticProductDeltaContract as contract, type ProductWrite } from './syntheticProductDelta';
import { createTerminalSchema, sourceIntent, destinationTerminal, requireSealEntry } from './syntheticProductTerminalState';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { enrollSyntheticOriginalCatalog } from './syntheticOriginalCatalog';
export type ProductChainPin={chainId:string;parentIdentity:string};
export type ProductChainCursor={segment:number;from:number;previousDigest:string};
export type ProductChainEndpoint={segment:number;checkpoint:number;sha256:string};
/** Explicit completeness gate relative to a separately trusted intended tip.
 * A valid prefix is not enough, and replay receipts are not authority to finish. */
export async function verifySyntheticProductChainCheckpoint(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,rawEndpoint:ProductChainEndpoint):Promise<{kind:'VERIFIED'} & ProductChainEndpoint> {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),endpoint=structuredClone(rawEndpoint);
  admit(base,pin); exact(endpoint,['segment','checkpoint','sha256']);
  if (!Number.isSafeInteger(endpoint.segment) || endpoint.segment<1 || endpoint.segment>MAX_SEGMENTS
    || !Number.isSafeInteger(endpoint.checkpoint) || endpoint.checkpoint<1 || endpoint.checkpoint>MAX_SEGMENTS*100
    || typeof endpoint.sha256!=='string' || endpoint.sha256.length!==64 || !HASH.test(endpoint.sha256)
    || [base.sourceId,base.originalSourceId].includes(db.runId) || ownerId===base.sourceOwner) refused();
  const physical=await inspectArchiveDatabase(db),q=await db.owner.connect();
  try {
    await q.query('BEGIN'); await lock(q,true);
    await admitDestination(q,db,ownerId,base,physical.systemIdentifier);
    if ((await q.query("SELECT to_regclass('local_restore_control.product_delta_checkpoint') AS name")).rows[0].name) refused();
    const stored=await journal(q,DESTINATION,base,pin,db,physical.systemIdentifier),tip=stored.entries.at(-1);
    if (!tip) refused();
    const terminal=await destinationTerminal(q,base,pin,{databaseId:db.runId,ownerId,systemIdentifier:physical.systemIdentifier});
    if (terminal) {
      equal(endpoint,terminal.seal.segments.at(-1));
      for (const entry of stored.entries) requireSealEntry(terminal.seal,
        {segment:entry.envelope.segment,checkpoint:entry.envelope.through,sha256:entry.receipt.artifact_digest});
    }
    equal(endpoint,{segment:tip.envelope.segment,checkpoint:tip.envelope.through,sha256:tip.receipt.artifact_digest});
    const actual=await readMaterializedRecoveryState(q);
    equal(actual.tables.migration_local_disposable_database,'[]'); equal(actual.tables.migration_local_materializations,'[]');
    stateMatches(actual,base,tip.envelope.transaction.finalProducts);
    await q.query('COMMIT'); return {kind:'VERIFIED',...endpoint};
  } catch (error) {await q.query('ROLLBACK'); throw error;}
  finally {q.release();}
}
type Transaction=ReturnType<typeof contract.decode>;
type Segment=ProductChainPin & ProductChainCursor & {profile:string;through:number;transaction:Transaction};
type Receipt={segment:number;chain_id:string;parent_identity:string;source_id:string;database_id:string;system_identifier:string;
  request_digest:string;artifact_digest:string;payload:string};
const {admitBase,stateMatches,lock,product,row,equal,text,sha,ident,COLUMNS,LIMIT}=contract;
const exact:typeof contract.exact=contract.exact;
const PROFILE='SYNTHETIC_PRODUCT_CHAIN_V1';
const MAX_SEGMENTS=32;
const HASH=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE='local_product_chain.outbox';
const DESTINATION='local_restore_control.product_chain_checkpoint';
function refused():never {throw new Error('Synthetic product chain refused.');}
function admit(base:MaterializedArchiveExpectation,pin:ProductChainPin) {
  admitBase(base); exact(pin,['chainId','parentIdentity']);
  if (!UUID.test(pin.chainId) || pin.chainId.length!==36 || !HASH.test(pin.parentIdentity)
    || pin.parentIdentity!==sha(canonicalJson(base))) refused();
}
function cursorValid(cursor:ProductChainCursor) {
  exact(cursor,['segment','from','previousDigest']);
  if (!Number.isSafeInteger(cursor.segment) || cursor.segment<1 || cursor.segment>MAX_SEGMENTS
    || !Number.isSafeInteger(cursor.from) || cursor.from<0 || cursor.from>=MAX_SEGMENTS*100
    || typeof cursor.previousDigest!=='string' || cursor.previousDigest.length!==64 || !HASH.test(cursor.previousDigest)) refused();
}
function decode(bytes:Buffer,digest:string,base:MaterializedArchiveExpectation,pin:ProductChainPin):Segment {
  if (!Buffer.isBuffer(bytes) || bytes.length>LIMIT || digest.length!==64 || !HASH.test(digest) || sha(bytes)!==digest) refused();
  const e=JSON.parse(bytes.toString('utf8'));
  exact(e,['profile','chainId','parentIdentity','segment','from','through','previousDigest','transaction']);
  if (e.profile!==PROFILE || e.chainId!==pin.chainId || e.parentIdentity!==pin.parentIdentity) refused();
  cursorValid({segment:e.segment as number,from:e.from as number,previousDigest:e.previousDigest as string});
  const inner=Buffer.from(JSON.stringify(e.transaction));
  const transaction=contract.decode(inner,sha(inner),base);
  if (e.through!==Number(e.from)+transaction.through || Number(e.through)>MAX_SEGMENTS*100) refused();
  return {...e,transaction} as Segment;
}
const first=(pin:ProductChainPin):ProductChainCursor => ({segment:1,from:0,previousDigest:sha(canonicalJson(pin))});
const position=(e:Segment):ProductChainCursor => ({segment:e.segment,from:e.from,previousDigest:e.previousDigest});
function next(pin:ProductChainPin,previous?:{envelope:Segment;receipt:Receipt}):ProductChainCursor {
  return previous ? {segment:previous.envelope.segment+1,from:previous.envelope.through,previousDigest:previous.receipt.artifact_digest} : first(pin);
}
/** Only fixed internal table identifiers reach SQL. Read the complete bounded
 * immutable journal on EVERY call; no in-memory cursor or caller receipt wins. */
async function journal(q:PoolClient,table:typeof SOURCE|typeof DESTINATION,base:MaterializedArchiveExpectation,
  pin:ProductChainPin,db:DisposablePostgres,system:string) {
  const exists=(await q.query('SELECT to_regclass($1) AS name',[table])).rows[0].name;
  if (!exists) return {exists:false,entries:[]};
  await requireSyntheticPrivateGuards(q,table);
  const receipts=(await q.query<Receipt>(`SELECT * FROM ${table} ORDER BY segment LIMIT 33`)).rows;
  if (!receipts.length || receipts.length>MAX_SEGMENTS) refused();
  const entries:{envelope:Segment;receipt:Receipt}[]=[];
  for (const receipt of receipts) {
    exact(receipt,['segment','chain_id','parent_identity','source_id','database_id','system_identifier','request_digest','artifact_digest','payload']);
    if (receipt.chain_id!==pin.chainId || receipt.parent_identity!==pin.parentIdentity || receipt.source_id!==base.sourceId
      || receipt.database_id!==db.runId || receipt.system_identifier!==system || !HASH.test(receipt.request_digest)
      || receipt.request_digest.length!==64 || !text(receipt.payload,LIMIT)) refused();
    const envelope=decode(Buffer.from(receipt.payload),receipt.artifact_digest,base,pin);
    if (receipt.segment!==envelope.segment) refused();
    equal(position(envelope),next(pin,entries.at(-1)));
    if (table===DESTINATION && receipt.request_digest!==receipt.artifact_digest) refused();
    entries.push({envelope,receipt});
  }
  return {exists:true,entries};
}
async function createJournal(q:PoolClient,table:typeof SOURCE|typeof DESTINATION,identity:Record<string,unknown>) {
  if (table===SOURCE) await createTerminalSchema(q,'local_product_chain');
  const schema=table===SOURCE ? 'local_product_chain' : 'local_restore_control';
  await q.query(`CREATE TABLE ${table}(segment integer PRIMARY KEY CHECK(segment BETWEEN 1 AND 32),chain_id uuid NOT NULL,
    parent_identity text NOT NULL,source_id uuid NOT NULL,database_id uuid NOT NULL,system_identifier text NOT NULL,
    request_digest text NOT NULL,artifact_digest text NOT NULL UNIQUE,payload text NOT NULL CHECK(octet_length(payload)<=1000000));
    CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.immutable();
    CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.immutable();`);
  await enrollSyntheticOriginalCatalog(q,table,identity);
}
async function append(q:PoolClient,table:typeof SOURCE|typeof DESTINATION,db:DisposablePostgres,system:string,
  base:MaterializedArchiveExpectation,pin:ProductChainPin,e:Segment,bytes:Buffer,requestDigest:string) {
  await q.query(`INSERT INTO ${table} VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.segment,pin.chainId,pin.parentIdentity,base.sourceId,db.runId,system,requestDigest,sha(bytes),bytes.toString('utf8')]);
}
/** One controlled committed product mutation batch per segment. The separate
 * parent and chain pin must come from the trusted private coordinator, NEVER
 * from transport. No ambient database URL, CDC or operational writer contract. */
export async function captureSyntheticProductSegment(source:DisposablePostgres,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,rawCursor:ProductChainCursor,rawWrites:ProductWrite[]):Promise<{bytes:Buffer;sha256:string}> {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),cursor=structuredClone(rawCursor),writes=structuredClone(rawWrites);
  admit(base,pin); cursorValid(cursor);
  if (source.runId!==base.sourceId || !Array.isArray(writes) || !writes.length || writes.length>100) refused();
  for (const w of writes) {
    exact(w,w.op==='delete' ? ['op','id'] : ['op','id','name','price','stock']);
    if (!['create','update','delete'].includes(w.op) || !text(w.id) || w.id.trim()!==w.id) refused();
    if (w.op!=='delete' && (!text(w.name) || !w.name.trim() || !Number.isSafeInteger(w.price) || w.price<0 || !Number.isSafeInteger(w.stock) || w.stock<0)) refused();
  }
  const physical=await inspectArchiveDatabase(source),q=await source.owner.connect();
  try {
    await q.query('BEGIN'); await lock(q);
    if ((await q.query("SELECT to_regnamespace('local_product_delta') AS name")).rows[0].name) refused();
    const stored=await journal(q,SOURCE,base,pin,source,physical.systemIdentifier),tip=stored.entries.at(-1);
    const before=await readMaterializedRecoveryState(q),products=tip?.envelope.transaction.finalProducts ?? base.tables.products;
    stateMatches(before,base,products); equal(before.tables,{...base.tables,products});
    const declared=await sourceIntent(q,base,pin,physical.systemIdentifier);
    if (declared.intent && (cursor.segment>declared.intent.counts.length || writes.length!==declared.intent.counts[cursor.segment-1]
      || cursor.from!==declared.intent.counts.slice(0,cursor.segment-1).reduce((a,b) => a+b,0))) refused();
    if (declared.seal) for (const entry of stored.entries) requireSealEntry(declared.seal,
      {segment:entry.envelope.segment,checkpoint:entry.envelope.through,sha256:entry.receipt.artifact_digest});
    const requestDigest=sha(canonicalJson({pin,cursor,writes}));
    if (tip && cursor.segment===tip.envelope.segment) {
      equal(position(tip.envelope),cursor);
      if (tip.receipt.request_digest!==requestDigest) refused();
      await q.query('COMMIT'); return {bytes:Buffer.from(tip.receipt.payload),sha256:tip.receipt.artifact_digest};
    }
    equal(cursor,next(pin,tip));
    if (declared.seal) refused();
    const events:Transaction['events']=[];
    for (const w of writes) {
      const prior=await product(q,base.binding.tenantId,w.id);
      if ((w.op==='create')!==(prior===null)) refused();
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
    stateMatches(final,base,final.tables.products); equal(final.tables,{...before.tables,products:final.tables.products});
    const envelope:Segment={profile:PROFILE,...pin,...cursor,through:cursor.from+events.length,
      transaction:{profile:contract.PROFILE,tenantId:base.binding.tenantId,sourceId:base.sourceId,backupDigest:base.digest,binding:base.binding,
        from:0,through:events.length,events,finalProducts:final.tables.products}};
    const bytes=Buffer.from(JSON.stringify(envelope)); decode(bytes,sha(bytes),base,pin);
    if (!stored.exists) await createJournal(q,SOURCE,{chain_id:pin.chainId,parent_identity:pin.parentIdentity,
      source_id:base.sourceId,database_id:source.runId,system_identifier:physical.systemIdentifier});
    await append(q,SOURCE,source,physical.systemIdentifier,base,pin,envelope,bytes,requestDigest);
    await q.query('COMMIT'); return {bytes,sha256:sha(bytes)};
  } catch (error) {await q.query('ROLLBACK'); throw error;}
  finally {q.release();}
}
async function admitDestination(q:PoolClient,db:DisposablePostgres,ownerId:string,base:MaterializedArchiveExpectation,system:string) {
  await requireSyntheticPrivateGuards(q,'local_restore_control.lease');
  equal((await q.query('SELECT * FROM local_restore_control.lease')).rows,
    [{singleton:true,database_id:db.runId,owner_id:ownerId,tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,system_identifier:system,state:'EMPTY_LEASE'}]);
  equal((await q.query('SELECT * FROM public.migration_local_restore_databases')).rows,
    [{singleton:true,database_id:db.runId,owner_id:ownerId,tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,state:'RESTORED_NONAUTHORITY'}]);
  equal((await q.query('SELECT * FROM public.migration_local_restorations')).rows,
    [{tenant_id:base.binding.tenantId,job_id:base.binding.migrationJobId,source_database_id:base.sourceId,
      destination_database_id:db.runId,source_owner_id:base.sourceOwner,destination_owner_id:ownerId,backup_digest:base.digest,
      source_readback_digest:sha(canonicalJson(base.tables)),schema_digest:sha(base.guards),
      provenance:{marker:base.marker,materialization:base.receipt},authority:'NONAUTHORITY',activation_allowed:false}]);
}
/** Durable append-only checkpoint and native product DML share one transaction.
 * Exact latest retry is idempotent; historical duplicate/conflict never repairs
 * or mutates the target. Each invocation reauthenticates the cold destination. */
export async function replaySyntheticProductSegment(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,rawBytes:Buffer,expectedSha256:string):Promise<{kind:string;segment:number;checkpoint:number}> {
  return replayProductSegment(db,ownerId,rawBase,rawPin,rawBytes,expectedSha256,false);
}
async function replayProductSegment(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,rawBytes:Buffer,expectedSha256:string,requireTerminal:boolean):Promise<{kind:string;segment:number;checkpoint:number}> {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length>LIMIT) refused();
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),bytes=Buffer.from(rawBytes);
  admit(base,pin); const e=decode(bytes,expectedSha256,base,pin);
  if ([base.sourceId,base.originalSourceId].includes(db.runId) || ownerId===base.sourceOwner) refused();
  const physical=await inspectArchiveDatabase(db),q=await db.owner.connect();
  try {
    await q.query('BEGIN'); await lock(q,true);
    await admitDestination(q,db,ownerId,base,physical.systemIdentifier);
    if ((await q.query("SELECT to_regclass('local_restore_control.product_delta_checkpoint') AS name")).rows[0].name) refused();
    const stored=await journal(q,DESTINATION,base,pin,db,physical.systemIdentifier),tip=stored.entries.at(-1);
    const terminal=await destinationTerminal(q,base,pin,{databaseId:db.runId,ownerId,systemIdentifier:physical.systemIdentifier});
    if (requireTerminal && !terminal) refused();
    if (terminal) {
      if (terminal.execution) await requireColdExportReplay(db,terminal.execution,base);
      requireSealEntry(terminal.seal,{segment:e.segment,checkpoint:e.through,sha256:expectedSha256});
      for (const entry of stored.entries) requireSealEntry(terminal.seal,
        {segment:entry.envelope.segment,checkpoint:entry.envelope.through,sha256:entry.receipt.artifact_digest});
    }
    const before=await readMaterializedRecoveryState(q);
    equal(before.tables.migration_local_disposable_database,'[]'); equal(before.tables.migration_local_materializations,'[]');
    stateMatches(before,base,tip?.envelope.transaction.finalProducts ?? base.tables.products);
    const answer={segment:e.segment,checkpoint:e.through};
    if (tip && e.segment===tip.envelope.segment) {
      if (tip.receipt.artifact_digest!==expectedSha256 || tip.receipt.payload!==bytes.toString('utf8')) refused();
      await q.query('COMMIT'); return {kind:'ALREADY_APPLIED',...answer};
    }
    equal(position(e),next(pin,tip));
    if (!stored.exists) await createJournal(q,DESTINATION,{chain_id:pin.chainId,parent_identity:pin.parentIdentity,
      source_id:base.sourceId,database_id:db.runId,system_identifier:physical.systemIdentifier});
    for (const event of e.transaction.events) {
      const current=await product(q,base.binding.tenantId,event.id);
      equal(current===null ? null : JSON.parse(current),event.before===null ? null : JSON.parse(event.before));
      await q.query("SELECT set_config('app.tenant_id',$1,true)",[base.binding.tenantId]); await q.query('SET LOCAL ROLE app_runtime');
      let result;
      if (event.op==='delete') result=await q.query('DELETE FROM public.products WHERE tenant_id=$1 AND product_id=$2',[base.binding.tenantId,event.id]);
      else if (event.op==='create') result=await q.query('INSERT INTO public.products SELECT * FROM jsonb_populate_record(NULL::public.products,$1::jsonb)',[event.after]);
      else {
        const columns=COLUMNS.filter(c => !['tenant_id','product_id'].includes(c));
        result=await q.query(`UPDATE public.products p SET ${columns.map(c => `${ident(c)}=n.${ident(c)}`).join(',')}
          FROM jsonb_populate_record(NULL::public.products,$3::jsonb) n WHERE p.tenant_id=$1 AND p.product_id=$2`,[base.binding.tenantId,event.id,event.after]);
      }
      await q.query('RESET ROLE'); if (result.rowCount!==1) refused();
      const actual=await product(q,base.binding.tenantId,event.id);
      equal(actual===null ? null : JSON.parse(actual),event.after===null ? null : JSON.parse(event.after));
    }
    const after=await readMaterializedRecoveryState(q);
    stateMatches(after,base,e.transaction.finalProducts); equal(after.tables,{...before.tables,products:e.transaction.finalProducts});
    await append(q,DESTINATION,db,physical.systemIdentifier,base,pin,e,bytes,expectedSha256);
    await q.query('COMMIT'); return {kind:'APPLIED',...answer};
  } catch (error) {await q.query('ROLLBACK'); throw error;}
  finally {q.release();}
}

// Internal synthetic extension only; no route, operational writer or new authority.
export const syntheticProductChainContract={admit,decode,journal,admitDestination,SOURCE,DESTINATION,replayProductSegment} as const;
