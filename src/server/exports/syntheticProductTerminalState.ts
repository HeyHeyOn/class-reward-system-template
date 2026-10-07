import 'server-only';
import type { PoolClient } from 'pg';
import type { MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import type { ColdExportExecution } from '@/server/db/testing/coldRestoreStore';
import type { ProductChainEndpoint, ProductChainPin } from './syntheticProductChain';
import { canonicalJson } from '@/server/migration/validators';
import { syntheticProductDeltaContract as c } from './syntheticProductDelta';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { enrollSyntheticOriginalCatalog } from './syntheticOriginalCatalog';
const exact:typeof c.exact=c.exact;
export type TerminalCoordinatorPin={databaseId:string;ownerId:string;systemIdentifier:string};
export type ProductChainIntent=ProductChainPin & {profile:'SYNTHETIC_PRODUCT_INTENT_V1';sourceSystem:string;counts:number[]};
export type ProductChainSeal={profile:'SYNTHETIC_PRODUCT_TERMINAL_V1';intent:ProductChainIntent;segments:ProductChainEndpoint[]};
export type InstalledTerminal={coordinator:TerminalCoordinatorPin;destination:TerminalCoordinatorPin;seal:ProductChainSeal;execution?:ColdExportExecution};
export type TerminalTable='local_product_chain.intent'|'local_product_chain.terminal'|'local_product_terminal.lease'|
  'local_product_terminal.seal'|'local_restore_control.product_chain_terminal'|'local_restore_control.sealed_preactivation'|'local_restore_control.sealed_export_execution';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
export function terminalRefused():never {throw new Error('Synthetic product terminal intent/seal refused.');}
export function admitCoordinatorPin(pin:TerminalCoordinatorPin) {
  exact(pin,['databaseId','ownerId','systemIdentifier']);
  if (typeof pin.databaseId!=='string' || pin.databaseId.length!==36 || !UUID.test(pin.databaseId)
    || typeof pin.ownerId!=='string' || pin.ownerId.length!==36 || !UUID.test(pin.ownerId)
    || typeof pin.systemIdentifier!=='string' || !/^[1-9][0-9]{0,19}$/.test(pin.systemIdentifier)) terminalRefused();
}
export function admitIntent(intent:ProductChainIntent,base:MaterializedArchiveExpectation,pin:ProductChainPin,system?:string) {
  exact(intent,['profile','chainId','parentIdentity','sourceSystem','counts']);
  if (intent.profile!=='SYNTHETIC_PRODUCT_INTENT_V1' || intent.chainId!==pin.chainId || intent.parentIdentity!==pin.parentIdentity
    || intent.parentIdentity!==c.sha(canonicalJson(base)) || typeof intent.sourceSystem!=='string'
    || !/^[1-9][0-9]{0,19}$/.test(intent.sourceSystem) || (system!==undefined && system!==intent.sourceSystem)
    || !Array.isArray(intent.counts) || !intent.counts.length || intent.counts.length>32
    || Array.from(intent.counts).some(n => !Number.isSafeInteger(n) || n<1 || n>100)) terminalRefused();
}
export function admitSeal(seal:ProductChainSeal,base:MaterializedArchiveExpectation,pin:ProductChainPin) {
  exact(seal,['profile','intent','segments']); admitIntent(seal.intent,base,pin);
  if (seal.profile!=='SYNTHETIC_PRODUCT_TERMINAL_V1' || !Array.isArray(seal.segments) || seal.segments.length!==seal.intent.counts.length) terminalRefused();
  let checkpoint=0;
  for (const [i,e] of seal.segments.entries()) {
    exact(e,['segment','checkpoint','sha256']); checkpoint+=seal.intent.counts[i];
    if (e.segment!==i+1 || e.checkpoint!==checkpoint || typeof e.sha256!=='string' || e.sha256.length!==64 || !HASH.test(e.sha256)) terminalRefused();
  }
}
/** Fixed internal SQL names only. No raw segment bytes can select a table or
 * provide a terminal. Empty/corrupt singleton state is not treated as absent. */
export async function readTerminalRecord(q:PoolClient,table:TerminalTable):Promise<unknown|null> {
  if (!(await q.query('SELECT to_regclass($1) AS name',[table])).rows[0].name) return null;
  await requireSyntheticPrivateGuards(q,table);
  const rows=(await q.query(`SELECT * FROM ${table} LIMIT 2`)).rows;
  if (rows.length!==1) terminalRefused();
  const r=rows[0]; exact(r,['singleton','payload','digest']);
  if (r.singleton!==true || !c.text(r.payload,16000) || r.digest!==c.sha(r.payload as string)) terminalRefused();
  const value=JSON.parse(r.payload as string);
  if (canonicalJson(value)!==r.payload) terminalRefused();
  return value;
}
export async function createTerminalSchema(q:PoolClient,schema:'local_product_chain'|'local_product_terminal') {
  if ((await q.query('SELECT to_regnamespace($1) AS name',[schema])).rows[0].name) {
    if (!(await q.query('SELECT to_regprocedure($1) AS name',[`${schema}.immutable()`])).rows[0].name) terminalRefused();
    return;
  }
  await q.query(`CREATE SCHEMA ${schema}; REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC,app_runtime;
    CREATE FUNCTION ${schema}.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic terminal state is immutable'; END$$;
    REVOKE ALL ON FUNCTION ${schema}.immutable() FROM PUBLIC,app_runtime;`);
}
export async function insertTerminalRecord(q:PoolClient,table:TerminalTable,value:unknown) {
  const schema=table.split('.')[0],payload=canonicalJson(value);
  if (Buffer.byteLength(payload)>16000) terminalRefused();
  await q.query(`CREATE TABLE ${table}(singleton boolean PRIMARY KEY CHECK(singleton),payload text NOT NULL CHECK(octet_length(payload)<=16000),digest text NOT NULL);
    REVOKE ALL ON ${table} FROM PUBLIC,app_runtime;
    CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.immutable();
    CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.immutable();`);
  await enrollSyntheticOriginalCatalog(q,table,{singleton:true,payload,digest:c.sha(payload)});
  await q.query(`INSERT INTO ${table} VALUES(true,$1,$2)`,[payload,c.sha(payload)]);
  c.equal(await readTerminalRecord(q,table),value);
}
export async function sourceIntent(q:PoolClient,base:MaterializedArchiveExpectation,pin:ProductChainPin,system:string) {
  const intent=await readTerminalRecord(q,'local_product_chain.intent') as ProductChainIntent|null;
  if (intent) admitIntent(intent,base,pin,system);
  const seal=await readTerminalRecord(q,'local_product_chain.terminal') as ProductChainSeal|null;
  if (seal) {admitSeal(seal,base,pin); c.equal(seal.intent,intent);}
  return {intent,seal};
}
export async function destinationTerminal(q:PoolClient,base:MaterializedArchiveExpectation,pin:ProductChainPin,destination:TerminalCoordinatorPin) {
  const value=await readTerminalRecord(q,'local_restore_control.product_chain_terminal') as InstalledTerminal|null;
  const execution=await readTerminalRecord(q,'local_restore_control.sealed_export_execution') as ColdExportExecution|null;
  if (!value) {if (execution) terminalRefused(); return null;}
  exact(value,execution ? ['coordinator','destination','seal','execution'] : ['coordinator','destination','seal']);
  if (execution) c.equal(value.execution,execution);
  admitCoordinatorPin(value.coordinator); admitCoordinatorPin(value.destination);
  c.equal(value.destination,destination); admitSeal(value.seal,base,pin);
  if ([base.sourceId,base.originalSourceId,destination.databaseId].includes(value.coordinator.databaseId)
    || value.coordinator.systemIdentifier===destination.systemIdentifier || value.coordinator.systemIdentifier===value.seal.intent.sourceSystem) terminalRefused();
  return value;
}
export function requireSealEntry(seal:ProductChainSeal,endpoint:ProductChainEndpoint) {
  c.equal(seal.segments[endpoint.segment-1],endpoint);
}
