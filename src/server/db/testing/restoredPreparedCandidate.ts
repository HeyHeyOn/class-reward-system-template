import 'server-only';
import { Pool } from 'pg';
import { ExecSocket } from './disposablePostgres';
import { inspectSettledPreparedCandidate, type ColdAnchor } from './coldRestoreStore';
import { inspectColdOrphan, readColdOrphan, type ColdOwnedInventory } from './ownedPgArchive';
import { readMaterializedRecoveryState, readPreparedArchivePrivileges, type MaterializedArchiveExpectation } from './materializedRestore';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { deepFreeze } from '@/server/migration/sensitiveRedaction';

const equal=(a:unknown,b:unknown) => {if (canonicalJson(a)!==canonicalJson(b)) throw new Error('Restored prepared candidate mismatch.');};
const ident=(s:string) => '"'+s.replaceAll('"','""')+'"';
const one=(wire:string):Record<string,unknown> => {
  const rows=JSON.parse(wire); if (!Array.isArray(rows) || rows.length!==1) throw new Error('Prepared singleton missing.');
  return rows[0];
};

/** SQL is read-only; the durable candidate gate is separate from restoration.
 * This internal SYNTHETIC adapter accepts no DB URL/pool/source lease/manifest.
 * A new process must authenticate the original pin, settled attempt and exact
 * cold ownership. Returned evidence is never a materialization/activation token.
 * The exclusive test coordinator is trusted; before/after equality cannot prove
 * a continuously fenced writer or freshness of operational originals. */
export async function reconcileRestoredPreparedCandidate(anchor:ColdAnchor,request:unknown) {
  return inspectSettledPreparedCandidate(anchor,request,async (seal,inventory,authenticatedAnchor) => {
    const p=seal.prepared! ,b=seal.binding;
    equal(p.intent.binding,b);
    equal([p.sourceFreshness,p.continuousWriterFence],['NOT_PROVEN','NOT_PROVEN']);
    equal(p.sourceGenerationDigest,sha256(p.sourceGeneration));
    const generation=one(p.sourceGeneration);
    equal([generation.tenant_id,generation.migration_job_id,generation.generation_id,String(generation.expected_state_version),
      generation.source_fingerprint,generation.manifest_digest,generation.scope,generation.writer_exclusion_status],
    [b.tenantId,b.migrationJobId,b.generationId,b.expectedStateVersion,b.sourceFingerprint,b.manifestDigest,'LOCAL_CANDIDATE','NOT_PROVEN']);
    equal([p.intent.ownerId,p.intent.sourceDatabaseId,p.intent.destinationDatabaseId,p.intent.expectedDestinationStateVersion],
      [seal.sourceOwner,seal.originalSourceId,seal.sourceId,'2']);
    equal(p.reportDigest,p.intent.expectedReportDigest);
    equal(sha256(canonicalJson(seal.receipt)),p.intent.expectedMaterializationDigest);
    equal([p.receipt.scope,p.receipt.status,p.receipt.stateVersion,p.receipt.authority,p.receipt.activationAllowed,p.receipt.complete,p.receipt.exclusion],
      ['LOCAL_PREPARED_STOP','RECONCILING','3','NONAUTHORITY',false,false,'NOT_PROVEN']);
    equal(p.receipt.intent,p.intent);
    equal(p.auditEventId,`local-prepared-stop:${sha256(canonicalJson(p.receipt))}`);
    if ([seal.sourceId,seal.originalSourceId].includes(inventory.runId) || seal.sourceOwner===inventory.ownerId) throw new Error('Cold identity reused.');
    const first=await inspectImage(seal,inventory);
    // inspectImage closes its pool even on failure. This is a genuinely NEW
    // native connection, not reuse of an ORM or cached/read-only JSON receipt.
    const reopened=await inspectImage(seal,inventory);
    equal(first.state,reopened.state);
    if (first.observation.backendPid===reopened.observation.backendPid) throw new Error('Cold pool not reopened.');
    const job=one(reopened.state.tables.migration_jobs),audit=one(reopened.state.tables.audit_events);
    equal([job.status,String(job.state_version),job.tenant_id,job.job_id,job.source_fingerprint,job.final_fingerprint,
      job.freeze_started_at,job.freeze_verified_at,job.completed_at],['RECONCILING','3',b.tenantId,b.migrationJobId,b.sourceFingerprint,null,null,null,null]);
    equal([audit.event_id,audit.redacted_details,audit.occurred_at],[p.auditEventId,p.receipt,job.updated_at]);
    return deepFreeze({scope:'LOCAL_RESTORED_PREPARED_CANDIDATE' as const,authority:'NONAUTHORITY' as const,activationAllowed:false as const,
      complete:false as const,status:'RECONCILING' as const,stateVersion:'3' as const,binding:b,stopIntentDigest:sha256(canonicalJson(p.intent)),
      auditEventId:p.auditEventId,job,audit,products:JSON.parse(reopened.state.tables.products),
      sourceEvidence:'PINNED_CAPTURED_SOURCE' as const,sourceFreshness:'NOT_PROVEN' as const,continuousWriterFence:'NOT_PROVEN' as const,
      capturedSource:{generation:JSON.parse(p.sourceGeneration),generationDigest:p.sourceGenerationDigest,
        tablesDigest:p.sourceTablesDigest,guardsDigest:p.sourceGuardsDigest,reportDigest:p.reportDigest},
      restoration:{anchor:authenticatedAnchor,attemptId:inventory.attemptId,ownerId:inventory.ownerId,databaseId:inventory.runId,
        containerId:inventory.containerId,systemIdentifier:inventory.systemIdentifier,archiveDigest:seal.digest},
      tableDigests:Object.fromEntries(Object.entries(reopened.state.tables).map(([name,wire]) => [name,{count:JSON.parse(wire).length,digest:sha256(wire)}])),
      observedImageDigest:sha256(canonicalJson(reopened.state)),observations:[first.observation,reopened.observation]});
  });
}

async function inspectImage(seal:MaterializedArchiveExpectation,inventory:ColdOwnedInventory) {
  const control=await readColdOrphan(inventory);
  equal(control.control,inventory.control); equal(control.controlGuards,inventory.controlGuards);
  equal(control.schemas,['local_restore_control','public']);
  const id=await inspectColdOrphan(inventory),streams=new Set<ExecSocket>();
  const pool=new Pool({user:'postgres',database:'postgres',host:'/var/run/postgresql',port:5432,password:() => '',ssl:false,
    options:'-c timezone=UTC -c default_transaction_read_only=on',application_name:'class-store-prepared-candidate',
    connectionTimeoutMillis:15000,statement_timeout:15000,query_timeout:20000,idle_in_transaction_session_timeout:30000,max:1,idleTimeoutMillis:0,
    stream:() => {const stream=new ExecSocket(id,{PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'}); streams.add(stream); return stream;}});
  pool.on('error',() => {});
  let begun=false;
  try {
    await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun=true;
    const observed=(await pool.query('SELECT pg_backend_pid() AS pid,system_identifier::text AS system FROM pg_control_system()')).rows[0];
    equal(observed.system,inventory.systemIdentifier);
    const readOnly=(await pool.query('SHOW transaction_read_only')).rows[0].transaction_read_only; equal(readOnly,'on');
    equal((await pool.query('SELECT to_jsonb(t) AS value FROM local_restore_control.lease t')).rows.map(r => r.value),inventory.control);
    const identity={singleton:true,database_id:inventory.runId,owner_id:inventory.ownerId,tenant_id:seal.binding.tenantId,
      job_id:seal.binding.migrationJobId,state:'RESTORED_NONAUTHORITY'};
    const receipt={tenant_id:seal.binding.tenantId,job_id:seal.binding.migrationJobId,source_database_id:seal.sourceId,
      destination_database_id:inventory.runId,source_owner_id:seal.sourceOwner,destination_owner_id:inventory.ownerId,
      backup_digest:seal.digest,source_readback_digest:sha256(canonicalJson(seal.tables)),schema_digest:sha256(seal.guards),
      provenance:{marker:seal.marker,materialization:seal.receipt,prepared:seal.prepared},authority:'NONAUTHORITY',activation_allowed:false};
    const expected:Record<string,unknown[]>={};
    for (const [table,wire] of Object.entries(seal.tables)) expected[table]=table==='migration_local_restore_databases' ? [identity]
      : table==='migration_local_restorations' ? [receipt] : ['migration_local_disposable_database','migration_local_materializations'].includes(table) ? [] : JSON.parse(wire);
    const tables=(await pool.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
    equal(tables,Object.keys(expected).sort());
    // Owner counts first: no full reads of unexpected private/foreign rows.
    for (const table of tables) equal((await pool.query(`SELECT count(*)::text AS n FROM public.${ident(table)}`)).rows,[{n:String(expected[table].length)}]);
    const state=await readMaterializedRecoveryState(pool);
    for (const [table,wire] of Object.entries(state.tables)) equal(JSON.parse(wire),expected[table]);
    equal(state.guards,seal.guards); equal(state.sequences,seal.sequences);
    equal(await readPreparedArchivePrivileges(pool),seal.prepared!.privileges);
    await pool.query('COMMIT'); begun=false;
    const after=await readColdOrphan(inventory);
    equal(after.control,inventory.control); equal(after.controlGuards,inventory.controlGuards);
    equal(after.schemas,control.schemas); equal(after.systemIdentifier,control.systemIdentifier);
    return {state,observation:{backendPid:observed.pid,systemIdentifier:observed.system,readOnly}};
  } catch (error) {
    if (begun) {
      const rolledBack=await pool.query('ROLLBACK');
      equal(rolledBack.command,'ROLLBACK');
      console.info('PREPARED_CANDIDATE_READ_ROLLBACK',JSON.stringify({pid:process.pid,command:rolledBack.command,databaseId:inventory.runId}));
    }
    throw error;
  } finally {
    try {await pool.end();} finally {for (const stream of streams) stream.destroy();}
  }
}
