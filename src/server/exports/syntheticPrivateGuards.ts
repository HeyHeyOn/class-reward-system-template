import 'server-only';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@/server/migration/validators';
import { requireSyntheticOriginalCatalog } from './syntheticOriginalCatalog';
const TABLES=[
  'local_product_chain.intent','local_product_chain.terminal','local_product_chain.outbox',
  'local_product_terminal.lease','local_product_terminal.seal','local_restore_control.lease',
  'local_restore_control.product_chain_terminal','local_restore_control.product_chain_checkpoint',
  'local_restore_control.sealed_export_execution','local_restore_control.sealed_preactivation',
] as const;
export type SyntheticPrivateTable=typeof TABLES[number];
function refused():never {throw new Error('Synthetic private immutability prerequisite refused.');}
function equal(a:unknown,b:unknown) {if (canonicalJson(a)!==canonicalJson(b)) refused();}
/** Existing controlled synthetic transactions only. A valid row/digest does not
 * prove its private immutable guards. Check native trigger semantics AND the
 * referenced function before trusting any receipt, including exact retries.
 * The creation-enrolled ORIGINAL and native catalog locks are required before
 * trusting rows. This is NOT a successor grant or hostile-host durability proof.
 */
export async function requireSyntheticPrivateGuards(q:PoolClient,table:SyntheticPrivateTable) {
  if (process.env.RUN_REAL_POSTGRES!=='1' || !TABLES.includes(table)) refused();
  await requireSyntheticOriginalCatalog(q,table);
  const schema=table.split('.')[0];
  await q.query(`LOCK TABLE ${table} IN SHARE MODE`);
  equal((await q.query("SELECT current_setting('session_replication_role') AS role")).rows,[{role:'origin'}]);
  const guards=(await q.query(`SELECT t.tgname,t.tgenabled,t.tgtype,t.tgnargs,t.tgattr::text AS columns,
    t.tgqual::text AS condition,octet_length(t.tgargs) AS argument_bytes,t.tgconstraint::text AS constraint_oid,
    t.tgoldtable,t.tgnewtable,t.tgfoid=to_regprocedure($2) AS expected_function
    FROM pg_trigger t WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,[table,`${schema}.immutable()`])).rows;
  const common={tgenabled:'O',tgnargs:0,columns:'',condition:null,argument_bytes:0,constraint_oid:'0',
    tgoldtable:null,tgnewtable:null,expected_function:true};
  // PostgreSQL TRIGGER_TYPE bitmask: ROW/BEFORE/DELETE/UPDATE and BEFORE/TRUNCATE.
  equal(guards,[{tgname:'immutable',tgtype:1|2|8|16,...common},{tgname:'no_truncate',tgtype:2|32,...common}]);
  const functions=(await q.query(`SELECT p.prosrc,p.prosecdef,p.proleakproof,p.proisstrict,p.proretset,p.provolatile,p.proparallel,
    p.prokind,p.proconfig,p.pronargs,p.prorettype='trigger'::regtype AS trigger_result,l.lanname,
    pg_get_userbyid(p.proowner)=current_user AS owned
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,[`${schema}.immutable()`])).rows;
  const message=schema==='local_restore_control' ? 'restore control is immutable' : 'synthetic terminal state is immutable';
  equal(functions,[{prosrc:`BEGIN RAISE EXCEPTION '${message}'; END`,prosecdef:false,proleakproof:false,proisstrict:false,
    proretset:false,provolatile:'v',proparallel:'u',prokind:'f',proconfig:null,pronargs:0,trigger_result:true,lanname:'plpgsql',owned:true}]);
}
