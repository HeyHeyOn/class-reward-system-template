import 'server-only';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { createDisposablePostgres, type DisposablePostgres } from './disposablePostgres';
import { dumpOwnedDatabase, dumpOriginalOwnedDatabase, executeOwnedRestore, inspectArchiveDatabase } from './ownedPgArchive';
import { reconcileLocalPreparedTransition, type LocalCandidateBinding, type LocalPreparedTransitionIntent } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { enrollSyntheticOriginalCatalog, requireSyntheticCatalogFence } from '@/server/exports/syntheticOriginalCatalog';
import { dispatchColdTarget, enrollColdArchive, readColdLease, type ColdLease, type ColdPolicy } from './coldRestoreStore';

type Query = { query: (text: string, values?: unknown[]) => Promise<{rows: Record<string, unknown>[]}> };
type Witness = Record<string,string>;
type Backup = Readonly<{bytes: Buffer; seal: object}>;
type PreparedWitness = {contract:'LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1'; intent:LocalPreparedTransitionIntent;
  auditEventId:string; receipt:Readonly<Record<string,unknown>>; sourceGeneration:string; sourceGenerationDigest:string;
  // New seals retain the already-admitted source SQL/archive/delta evidence.
  // Older digest-only seals remain readable but cannot prove source retention.
  // This is provenance, NOT a native source-DB restore or an authority grant.
  sourceTables?:Witness;
  sourceTablesDigest:string; sourceGuardsDigest:string; reportDigest:string; postStopReadbackDigest:string; privileges:string;
  sourceFreshness:'NOT_PROVEN'; continuousWriterFence:'NOT_PROVEN'};
type Seal = {digest: string; binding: LocalCandidateBinding; sourceId: string; sourceOwner: string;
  originalSourceId: string; tables: Witness; guards: string; sequences: Witness; marker: Record<string,unknown>; receipt: Record<string,unknown>;
  prepared?:PreparedWitness;
  original?:{contract:'LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1';candidateDatabaseId:string;candidateBackupDigest:string;
    candidateTablesDigest:string;prepared:PreparedWitness}};
export type MaterializedArchiveExpectation = Seal;
type Target = { execute: (script: string) => Promise<void> };
type Lease = {database: DisposablePostgres; ownerId: string; binding: LocalCandidateBinding; control: string;
  original:boolean;controlCatalog?:string;used: boolean};
const seals = new WeakMap<object,Seal>();
const targets = new WeakMap<Target,Lease>();
const busy = new WeakSet<DisposablePostgres>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OMIT = new Set(['migration_local_disposable_database','migration_local_materializations']);
const DATA = new Set(['tenants','migration_jobs','tenant_settings','students','accounts','products','promotions','promotion_products',
  'tasks','task_allowed_students','task_assignments','transactions','transaction_items','adjustments','task_completions','operations',
  'padlet_evidence_claims','padlet_claim_digest_tombstones','padlet_claim_digest_registry','migration_sources','migration_source_records','migration_snapshots',...OMIT]);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ident = (s: string) => `"${s.replaceAll('"','""')}"`;
const literal = (s: string) => `'${s.replaceAll("'","''")}'`;
function refused(): never { throw new Error('Local disposable PostgreSQL restore refused.'); }
function equal(a: unknown,b: unknown) { if (canonicalJson(a)!==canonicalJson(b)) refused(); }
function bindingCopy(b: LocalCandidateBinding): LocalCandidateBinding {
  // A generation binding is not a caller-supplied archive-state label. Snapshot
  // exactly its data fields before any await; never invoke accessors/coercions or
  // carry extra PREPARED metadata into an IMPORTING-only archive expectation.
  if (!b || typeof b!=='object' || types.isProxy(b) || Object.getPrototypeOf(b)!==Object.prototype) refused();
  const keys = ['tenantId','migrationJobId','generationId','expectedStateVersion','sourceFingerprint','manifestDigest'];
  if (Reflect.ownKeys(b).length!==keys.length) refused();
  const copy: Record<string,string> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(b,key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value!=='string'
      || !descriptor.value || descriptor.value.length>256) refused();
    copy[key] = descriptor.value;
  }
  if (!UUID.test(copy.tenantId) || copy.migrationJobId.trim()!==copy.migrationJobId
    || !/^[1-9][0-9]{0,15}$/.test(copy.expectedStateVersion) || !Number.isSafeInteger(Number(copy.expectedStateVersion))
    || !/^[0-9a-f]{64}$/.test(copy.sourceFingerprint) || !/^[0-9a-f]{64}$/.test(copy.manifestDigest)) refused();
  return Object.freeze(copy) as LocalCandidateBinding;
}
const TABLES = "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename";
// Do not select private/unrelated field values merely to discover that the
// database is inadmissible. Owner counts see rows hidden from runtime by RLS.
async function requireEmptyExcept(q: Query, allowed: ReadonlySet<string>) {
  for (const {tablename} of (await q.query(TABLES)).rows) {
    const table = String(tablename);
    if (!allowed.has(table) && (await q.query(`SELECT count(*)::text AS n FROM public.${ident(table)}`)).rows[0].n!=='0') refused();
  }
}
// Full SQL values, not projection JSON used as an importer. Wire text retains
// PostgreSQL bigint/timestamp precision; JSON below is only validation evidence.
function rowsSql(table: string) {
  return `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS wire FROM ${table} t`;
}
async function wire(q: Query, statement: string) { return String((await q.query(statement)).rows[0].wire); }
async function witness(q: Query): Promise<Witness> {
  const result: Witness = {};
  for (const row of (await q.query(TABLES)).rows) {
    const table = String(row.tablename);
    result[table] = await wire(q,rowsSql(`public.${ident(table)}`));
  }
  return result;
}
const SEQUENCES = "SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename";
const sequenceSql = (name: string) => `SELECT jsonb_build_array(jsonb_build_object('last_value',last_value::text,'is_called',is_called))::text AS wire FROM public.${ident(name)}`;
async function sequenceWitness(q: Query): Promise<Witness> {
  const result: Witness = {};
  for (const {sequencename} of (await q.query(SEQUENCES)).rows) result[String(sequencename)]=await wire(q,sequenceSql(String(sequencename)));
  return result;
}
// Compare actual schema contracts, including function bodies, trigger modes,
// constraints, RLS policies, defaults/indexes and ACL. No caller MATCH accepted.
// Let PostgreSQL's precedence-aware deparser flatten redundant AND grouping;
// raw non-pretty CHECK text is not stable across a native dump/reparse cycle.
const GUARDS = `SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text AS wire FROM (
  SELECT jsonb_build_array('table',c.relname,c.relrowsecurity,c.relforcerowsecurity) v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
  UNION ALL SELECT jsonb_build_array('constraint',c.conrelid::regclass::text,c.conname,c.convalidated,pg_get_constraintdef(c.oid,true)) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
  UNION ALL SELECT jsonb_build_array('trigger',t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
  UNION ALL SELECT jsonb_build_array('function',p.proname,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT jsonb_build_array('policy',to_jsonb(p)) FROM pg_policies p WHERE schemaname='public'
  UNION ALL SELECT jsonb_build_array('column',to_jsonb(c)) FROM information_schema.columns c WHERE table_schema='public'
  UNION ALL SELECT jsonb_build_array('index',to_jsonb(i)) FROM pg_indexes i WHERE schemaname='public'
  UNION ALL SELECT jsonb_build_array('grant',to_jsonb(g)) FROM information_schema.role_table_grants g WHERE table_schema='public'
  UNION ALL SELECT jsonb_build_array('sequence',to_jsonb(s)-'last_value') FROM pg_sequences s WHERE schemaname='public'
) s`;

const ORIGINAL_CONTROL_GUARDS=GUARDS.replaceAll("'public'","'local_restore_control'");
const ORIGINAL_RECEIPTS='local_restore_control.original_restorations';
const SCHEMAS = "SELECT COALESCE(jsonb_agg(nspname ORDER BY nspname),'[]'::jsonb)::text AS wire FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'";
async function admitSource(q: Query, db: DisposablePostgres, owner: string, b: LocalCandidateBinding, tables: Witness) {
  equal(JSON.parse(await wire(q,SCHEMAS)),['public']);
  const one = (table: string): Record<string,unknown> => { const rows = JSON.parse(tables[table] ?? '[]'); if (rows.length!==1) refused(); return rows[0]; };
  const marker = one('migration_local_disposable_database'), receipt = one('migration_local_materializations');
  equal(marker,{singleton:true,database_id:db.runId,owner_id:owner,role:'DESTINATION',tenant_id:b.tenantId,job_id:b.migrationJobId});
  const {domain_readback,...stored} = receipt;
  stored.expected_state_version = String(stored.expected_state_version);
  if (typeof stored.source_database_id!=='string' || !UUID.test(stored.source_database_id) || stored.source_database_id===db.runId) refused();
  equal(stored,{tenant_id:b.tenantId,job_id:b.migrationJobId,generation_id:b.generationId,source_database_id:stored.source_database_id,
    destination_database_id:db.runId,owner_id:owner,expected_state_version:b.expectedStateVersion,source_fingerprint:b.sourceFingerprint,
    manifest_digest:b.manifestDigest,scope:'LOCAL_DISPOSABLE_DOMAIN',authority:'NONAUTHORITY',activation_allowed:false});
  const job = one('migration_jobs'), tenant = one('tenants');
  if (job.tenant_id!==b.tenantId || job.job_id!==b.migrationJobId || job.status!=='IMPORTING' || String(job.state_version)!=='2'
    || job.source_fingerprint!==b.sourceFingerprint || job.final_fingerprint!==null || job.freeze_started_at!==null
    || job.freeze_verified_at!==null || job.completed_at!==null || tenant.id!==b.tenantId || tenant.lifecycle!=='IMPORTING') refused();
  const readback: Record<string,{count: number; digest: string}> = {};
  const visible = (await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND has_table_privilege('app_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') ORDER BY tablename")).rows;
  for (const {tablename} of visible) {
    const table = String(tablename); if (OMIT.has(table)) continue;
    const rows = JSON.parse(tables[table]);
    readback[table] = {count:rows.length,digest:sha256(canonicalJson(rows.map((row: unknown) => canonicalJson(row)).sort()))};
  }
  equal(domain_readback,readback);
  for (const [table,data] of Object.entries(tables)) {
    if (!DATA.has(table) && data!=='[]') refused();
    for (const row of JSON.parse(data)) if ((row.tenant_id && row.tenant_id!==b.tenantId)
      || (row.claimed_by_tenant_id && row.claimed_by_tenant_id!==b.tenantId)) refused();
  }
  if ((await q.query("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgenabled='D' LIMIT 1")).rows.length) refused();
  return {marker,receipt,originalSourceId:stored.source_database_id};
}

/** Real full PostgreSQL archive from one read-only exported snapshot. The seal
 * is process-local trusted capability, NOT serializable caller authorization.
 * Caller may retain/reopen bytes; source need not exist during restoration. */
export async function backupMaterializedDatabase(source: DisposablePostgres, ownerId: string, raw: LocalCandidateBinding): Promise<Backup> {
  const binding = bindingCopy(raw);
  if (!UUID.test(ownerId) || busy.has(source)) refused();
  busy.add(source);
  try {
    await inspectArchiveDatabase(source);
    const client = await source.owner.connect();
    let captured: Seal; let bytes: Buffer;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      equal(JSON.parse(await wire(client,SCHEMAS)),['public']);
      await requireEmptyExcept(client,DATA);
      const tables = await witness(client), provenance = await admitSource(client,source,ownerId,binding,tables);
      const guards = await wire(client,GUARDS);
      const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      bytes = await dumpOwnedDatabase(source,snapshot);
      if (!bytes.length || bytes.length > 16_000_000) refused();
      const sequences = await sequenceWitness(client);
      captured = {digest:hash(bytes),binding,sourceId:source.runId,sourceOwner:ownerId,tables,guards,sequences,...provenance};
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    equal(await witness(source.owner),captured.tables);
    equal(await wire(source.owner,GUARDS),captured.guards);
    equal(await sequenceWitness(source.owner),captured.sequences);
    const seal = Object.freeze({}); seals.set(seal,captured);
    return Object.freeze({bytes,seal});
  } finally { busy.delete(source); }
}

const PREPARED_DATA = new Set([...DATA,'audit_events']);
const FULL_EVIDENCE = ['migration_full_generations','migration_full_sources','migration_full_targets','migration_full_mappings',
  'migration_full_contributors','migration_full_delta_entries','migration_full_claim_recaptures','migration_full_reconciliation'];

// Prepared-only authority profile. Resolve OIDs to names and expand effective
// default ACLs, so a native restore into another cluster compares semantically.
// Never read role passwords/configuration values or transport role authority.
const PREPARED_PRIVILEGES = `WITH objects AS (
  SELECT 'schema' kind,n.nspname name,n.nspowner owner,COALESCE(n.nspacl,acldefault('n',n.nspowner)) acl
    FROM pg_namespace n WHERE n.nspname='public'
  UNION ALL SELECT 'relation',c.relname,c.relowner,COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')
  UNION ALL SELECT 'routine',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',p.proowner,COALESCE(p.proacl,acldefault('f',p.proowner))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  UNION ALL SELECT 'column',c.relname||'.'||a.attname,c.relowner,a.attacl
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND a.attacl IS NOT NULL AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'default',COALESCE(n.nspname,'GLOBAL')||':'||d.defaclobjtype::text,d.defaclrole,d.defaclacl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR n.nspname='public'
) SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text AS wire FROM (
  SELECT jsonb_build_array('owner',kind,name,pg_get_userbyid(owner)) v FROM objects
  UNION ALL SELECT jsonb_build_array('acl',o.kind,o.name,pg_get_userbyid(a.grantor),
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
    FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) a
  UNION ALL SELECT jsonb_build_array('role',rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
    rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil IS NULL,rolconfig IS NULL) FROM pg_roles WHERE rolname='app_runtime'
  UNION ALL SELECT jsonb_build_array('membership',pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)
    FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='app_runtime') OR member=(SELECT oid FROM pg_roles WHERE rolname='app_runtime')
) s`;

/** Closed test-only schema profile. Construct a NEW empty owned reference from
 * pinned migrations, not the archive/caller's declaration. Only these existing
 * synthetic fixture grants are allowed. Never alters the admitted databases. */
async function preparedReferenceGuards() {
  const reference = await createDisposablePostgres();
  try {
    for (const table of FULL_EVIDENCE) await reference.owner.query(`GRANT SELECT,INSERT ON ${ident(table)} TO app_runtime`);
    await reference.owner.query(`GRANT SELECT ON migration_local_disposable_database TO app_runtime;
      GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime;
      GRANT SELECT ON migration_local_restore_databases,migration_local_restorations TO app_runtime`);
    await requireEmptyExcept(reference.owner,new Set());
    return {guards:await wire(reference.owner,GUARDS),privileges:await wire(reference.owner,PREPARED_PRIVILEGES)};
  } finally { console.info('PREPARED_REFERENCE_CLEANUP',JSON.stringify(await reference.close())); }
}

function preparedIntentCopy(raw:LocalPreparedTransitionIntent):LocalPreparedTransitionIntent {
  if (!raw || typeof raw!=='object' || types.isProxy(raw) || Object.getPrototypeOf(raw)!==Object.prototype) refused();
  const keys=['binding','ownerId','sourceDatabaseId','destinationDatabaseId','expectedDestinationStateVersion',
    'expectedReportDigest','expectedMaterializationDigest'];
  if (Reflect.ownKeys(raw).length!==keys.length) refused();
  const copy:Record<string,unknown>={};
  for (const key of keys) {
    const d=Object.getOwnPropertyDescriptor(raw,key);
    if (!d || !d.enumerable || !('value' in d)) refused();
    copy[key]=d.value;
  }
  const binding=bindingCopy(copy.binding as LocalCandidateBinding);
  if (![copy.ownerId,copy.sourceDatabaseId,copy.destinationDatabaseId].every(v => typeof v==='string' && UUID.test(v))
    || copy.sourceDatabaseId===copy.destinationDatabaseId || copy.expectedDestinationStateVersion!=='2'
    || ![copy.expectedReportDigest,copy.expectedMaterializationDigest].every(v => typeof v==='string' && /^[0-9a-f]{64}$/.test(v))) refused();
  return Object.freeze({...copy,binding}) as LocalPreparedTransitionIntent;
}

/** Distinct post-COMMIT admission, NOT an option that widens IMPORTING/2.
 * Both handles are exclusively owned synthetic test fixtures. Recompute source
 * candidate/READY/version/reports using the unchanged prepared verifier. Then
 * pin the independently observed committed RECONCILING/3 snapshot, including
 * its immutable STOP audit, exact timestamps and all tables/guards/sequences.
 * Observed stability is NOT current-source freshness or a continuous fence. */
export async function backupPreparedDatabase(sourceEvidence: DisposablePostgres, destination: DisposablePostgres,
  raw: LocalPreparedTransitionIntent): Promise<Backup> {
  const intent=preparedIntentCopy(raw),{binding}=intent;
  if (sourceEvidence===destination || sourceEvidence.runId!==intent.sourceDatabaseId
    || destination.runId!==intent.destinationDatabaseId || busy.has(sourceEvidence) || busy.has(destination)) refused();
  busy.add(sourceEvidence); busy.add(destination);
  try {
    const sourcePhysical=await inspectArchiveDatabase(sourceEvidence), destinationPhysical=await inspectArchiveDatabase(destination);
    if (sourcePhysical.id===destinationPhysical.id || sourcePhysical.systemIdentifier===destinationPhysical.systemIdentifier) refused();
    const {guards:expectedGuards,privileges:expectedPrivileges}=await preparedReferenceGuards();
    for (const db of [sourceEvidence,destination]) {
      equal(JSON.parse(await wire(db.owner,SCHEMAS)),['public']);
      equal(await wire(db.owner,GUARDS),expectedGuards);
      equal(await wire(db.owner,PREPARED_PRIVILEGES),expectedPrivileges);
      equal((await db.owner.query("SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='app_runtime'")).rows,
        [{rolsuper:false,rolbypassrls:false,rolinherit:false}]);
      await requireEmptyExcept(db.owner,db===destination ? PREPARED_DATA : new Set([...PREPARED_DATA,...FULL_EVIDENCE]));
    }
    const lease=(db:DisposablePostgres) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:intent.ownerId,
      queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
    const reconcile=() => reconcileLocalPreparedTransition(intent,lease(sourceEvidence),lease(destination));
    const verified=await reconcile();
    // Only after schema + owner count + semantic inventory admission may full
    // SQL witnesses be read. No unrelated/private field values are collected.
    const sourceState=await readMaterializedRecoveryState(sourceEvidence.owner);
    const q=await destination.owner.connect();
    let captured:Seal,bytes:Buffer;
    try {
      await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      equal(JSON.parse(await wire(q,SCHEMAS)),['public']);
      equal(await wire(q,GUARDS),expectedGuards);
      equal(await wire(q,PREPARED_PRIVILEGES),expectedPrivileges);
      await requireEmptyExcept(q,PREPARED_DATA);
      const tables=await witness(q),sequences=await sequenceWitness(q);
      const one=(table:string):Record<string,unknown> => {
        const rows=JSON.parse(tables[table] ?? '[]'); if (rows.length!==1) refused(); return rows[0];
      };
      const marker=one('migration_local_disposable_database'),receipt=one('migration_local_materializations');
      equal(marker,{singleton:true,database_id:destination.runId,owner_id:intent.ownerId,role:'DESTINATION',tenant_id:binding.tenantId,job_id:binding.migrationJobId});
      if (sha256(canonicalJson(receipt))!==intent.expectedMaterializationDigest) refused();
      const job=one('migration_jobs'),tenant=one('tenants'),audit=one('audit_events');
      if (job.status!=='RECONCILING' || String(job.state_version)!=='3' || job.tenant_id!==binding.tenantId || job.job_id!==binding.migrationJobId
        || job.source_fingerprint!==binding.sourceFingerprint || job.final_fingerprint!==null || job.freeze_started_at!==null
        || job.freeze_verified_at!==null || job.completed_at!==null || tenant.id!==binding.tenantId || tenant.lifecycle!=='IMPORTING') refused();
      equal(audit,{tenant_id:binding.tenantId,event_id:verified.auditEventId,job_id:binding.migrationJobId,actor_user_id:null,
        event_type:'MIGRATION_LOCAL_PREPARED_STOP',operation_id:null,entity_type:null,entity_id:null,
        redacted_details:verified.receipt,occurred_at:job.updated_at});
      const readback:Record<string,{count:number;digest:string}>={};
      const visible=(await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND has_table_privilege('app_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') ORDER BY tablename")).rows;
      for (const {tablename} of visible) {
        const table=String(tablename); if (OMIT.has(table)) continue;
        const rows=JSON.parse(tables[table]);
        readback[table]={count:rows.length,digest:sha256(canonicalJson(rows.map((row:unknown) => canonicalJson(row)).sort()))};
      }
      equal(sha256(canonicalJson(readback)),verified.observedReadbackDigest);
      for (const data of Object.values(tables)) for (const row of JSON.parse(data)) {
        if ((row.tenant_id && row.tenant_id!==binding.tenantId) || (row.claimed_by_tenant_id && row.claimed_by_tenant_id!==binding.tenantId)) refused();
      }
      const sourceGeneration=sourceState.tables.migration_full_generations;
      if (JSON.parse(sourceGeneration).length!==1) refused();
      const prepared:PreparedWitness={contract:'LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1',intent,
        auditEventId:verified.auditEventId,receipt:verified.receipt,sourceGeneration,sourceGenerationDigest:sha256(sourceGeneration),
        sourceTables:sourceState.tables,sourceTablesDigest:sha256(canonicalJson(sourceState.tables)),sourceGuardsDigest:sha256(sourceState.guards),
        reportDigest:intent.expectedReportDigest,postStopReadbackDigest:verified.observedReadbackDigest,privileges:expectedPrivileges,
        sourceFreshness:'NOT_PROVEN',continuousWriterFence:'NOT_PROVEN'};
      const snapshot=(await q.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      bytes=await dumpOwnedDatabase(destination,snapshot);
      if (!bytes.length || bytes.length>16_000_000) refused();
      captured={digest:hash(bytes),binding,sourceId:destination.runId,sourceOwner:intent.ownerId,originalSourceId:sourceEvidence.runId,
        tables,guards:expectedGuards,sequences,marker,receipt,prepared};
      await q.query('COMMIT');
    } catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
    equal(await reconcile(),verified);
    equal(await readMaterializedRecoveryState(sourceEvidence.owner),sourceState);
    equal(await readMaterializedRecoveryState(destination.owner),{tables:captured.tables,guards:captured.guards,sequences:captured.sequences});
    for (const db of [sourceEvidence,destination]) equal(await wire(db.owner,PREPARED_PRIVILEGES),expectedPrivileges);
    equal(await inspectArchiveDatabase(sourceEvidence),sourcePhysical);
    equal(await inspectArchiveDatabase(destination),destinationPhysical);
    const seal=Object.freeze({}); seals.set(seal,captured);
    return Object.freeze({bytes,seal});
  } finally { busy.delete(sourceEvidence); busy.delete(destination); }
}

/** Separate ORIGINAL native image, admitted ONLY alongside an already prepared
 * synthetic candidate. Reuse the unchanged exact original/candidate verifier;
 * no caller-selected mode widens the existing IMPORTING/prepared producers.
 * This recovers the importer mirror and its full archive/delta SQL, NOT the
 * editable workbook service or permission to roll back/reactivate a source. */
export async function backupOriginalDatabase(source:DisposablePostgres, candidate:DisposablePostgres,
  raw:LocalPreparedTransitionIntent):Promise<Backup> {
  const intent=preparedIntentCopy(raw);
  const candidateBackup=await backupPreparedDatabase(source,candidate,intent);
  const admitted=seals.get(candidateBackup.seal);
  if (!admitted?.prepared?.sourceTables || busy.has(source) || busy.has(candidate)) refused();
  busy.add(source); busy.add(candidate);
  try {
    const prepared=admitted.prepared, physical=await inspectArchiveDatabase(source);
    const q=await source.owner.connect();
    let captured:Seal,bytes:Buffer;
    try {
      await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      equal(JSON.parse(await wire(q,SCHEMAS)),['public']);
      equal(await wire(q,PREPARED_PRIVILEGES),prepared.privileges);
      const state=await readMaterializedRecoveryState(q);
      equal(state.tables,prepared.sourceTables);
      equal(sha256(state.guards),prepared.sourceGuardsDigest);
      const marker=JSON.parse(state.tables.migration_local_disposable_database);
      equal(marker,[{singleton:true,database_id:source.runId,owner_id:intent.ownerId,role:'SOURCE',
        tenant_id:intent.binding.tenantId,job_id:intent.binding.migrationJobId}]);
      const snapshot=(await q.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      bytes=await dumpOriginalOwnedDatabase(source,snapshot);
      if (!bytes.length || bytes.length>16_000_000) refused();
      captured={digest:hash(bytes),binding:intent.binding,sourceId:source.runId,originalSourceId:source.runId,
        sourceOwner:intent.ownerId,...state,marker:marker[0],receipt:{},
        original:{contract:'LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1',candidateDatabaseId:candidate.runId,
          candidateBackupDigest:admitted.digest,candidateTablesDigest:sha256(canonicalJson(admitted.tables)),prepared}};
      await q.query('COMMIT');
    } catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
    equal(await readMaterializedRecoveryState(source.owner),{tables:captured.tables,guards:captured.guards,sequences:captured.sequences});
    equal(await readMaterializedRecoveryState(candidate.owner),{tables:admitted.tables,guards:admitted.guards,sequences:admitted.sequences});
    for (const db of [source,candidate]) equal(await wire(db.owner,PREPARED_PRIVILEGES),prepared.privileges);
    equal(await inspectArchiveDatabase(source),physical);
    const seal=Object.freeze({}); seals.set(seal,captured);
    return Object.freeze({bytes,seal});
  } finally { busy.delete(source); busy.delete(candidate); }
}

/** Allocates only after owner-level global vacancy, never on a copied marker.
 * Replaces fresh empty public DDL, not an existing import/dataset. Immutable
 * private control schema survives rollback; no runtime grants are added. */
export async function allocateRestoreTarget(database: DisposablePostgres, ownerId: string, raw: LocalCandidateBinding): Promise<Target> {
  return allocateTarget(database,ownerId,raw,false);
}
export async function allocateOriginalRestoreTarget(database: DisposablePostgres, ownerId: string, raw: LocalCandidateBinding): Promise<Target> {
  return allocateTarget(database,ownerId,raw,true);
}
async function allocateTarget(database: DisposablePostgres, ownerId: string, raw: LocalCandidateBinding, original:boolean): Promise<Target> {
  const binding = bindingCopy(raw);
  if (!UUID.test(ownerId) || busy.has(database)) refused();
  busy.add(database);
  try {
    const physical = await inspectArchiveDatabase(database);
    const q = await database.owner.connect();
    let control: string,controlCatalog: string | undefined;
    try {
      await q.query('BEGIN');
      await requireSyntheticCatalogFence(q);
      equal(JSON.parse(await wire(q,SCHEMAS)),['public']);
      await requireEmptyExcept(q,new Set());
      await q.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner;
        CREATE SCHEMA local_restore_control;
        CREATE TABLE local_restore_control.lease(singleton boolean PRIMARY KEY CHECK(singleton),database_id uuid NOT NULL,
          owner_id uuid NOT NULL,tenant_id uuid NOT NULL,job_id text NOT NULL,system_identifier text NOT NULL,state text NOT NULL CHECK(state='EMPTY_LEASE'));
        CREATE FUNCTION local_restore_control.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'restore control is immutable'; END$$;
        CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON local_restore_control.lease FOR EACH ROW EXECUTE FUNCTION local_restore_control.immutable();
        CREATE TRIGGER no_truncate BEFORE TRUNCATE ON local_restore_control.lease FOR EACH STATEMENT EXECUTE FUNCTION local_restore_control.immutable();`);
      await enrollSyntheticOriginalCatalog(q,'local_restore_control.lease',{singleton:true,database_id:database.runId,owner_id:ownerId,
        tenant_id:binding.tenantId,job_id:binding.migrationJobId,system_identifier:physical.systemIdentifier,state:'EMPTY_LEASE'});
      await q.query("INSERT INTO local_restore_control.lease VALUES(true,$1,$2,$3,$4,$5,'EMPTY_LEASE')",[database.runId,ownerId,binding.tenantId,binding.migrationJobId,physical.systemIdentifier]);
      if (original) {
        // ORIGINAL is not a materialized candidate. Do not fabricate a
        // materialization receipt or relax migration 0029's candidate checks.
        await q.query(`CREATE TABLE ${ORIGINAL_RECEIPTS}(singleton boolean PRIMARY KEY CHECK(singleton),receipt jsonb NOT NULL
          CHECK(jsonb_typeof(receipt)='object') CHECK((receipt->>'authority'='NONAUTHORITY') IS TRUE)
          CHECK((receipt->>'activation_allowed'='false') IS TRUE)
          CHECK((receipt->'provenance'->'original'->>'contract'='LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1') IS TRUE));
          CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${ORIGINAL_RECEIPTS} FOR EACH ROW EXECUTE FUNCTION local_restore_control.immutable();
          CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${ORIGINAL_RECEIPTS} FOR EACH STATEMENT EXECUTE FUNCTION local_restore_control.immutable();`);
        controlCatalog=await wire(q,ORIGINAL_CONTROL_GUARDS);
      }
      control = await wire(q,rowsSql('local_restore_control.lease'));
      await q.query('COMMIT');
    } catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
    const target: Target = {execute:script => executeOwnedRestore(database,script)};
    targets.set(target,{database,ownerId,binding,control,original,controlCatalog,used:false});
    return target;
  } finally { busy.delete(database); }
}

function checkSql(query: string, expected: string) {
  // A false/missing/count/value/schema/relationship mismatch aborts the same
  // transaction as the restored DDL/data, rather than a post-commit warning.
  const tag = `$restore_check_${sha256(query+expected)}$`;
  if (query.includes(tag) || expected.includes(tag)) refused();
  return `DO ${tag} DECLARE actual jsonb:=(${query})::jsonb; expected jsonb:=${literal(expected)}::jsonb;
    BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'restore witness mismatch: %',
      (SELECT jsonb_agg(value) FROM (SELECT value FROM jsonb_array_elements(actual) EXCEPT SELECT value FROM jsonb_array_elements(expected) LIMIT 1) d);
    END IF; END ${tag};`;
}
export async function restoreMaterializedDatabase(backup: Backup, target: Target) {
  // Snapshot transport bytes synchronously; caller Buffer mutation during an
  // awaited infrastructure check must not change the authenticated SQL program.
  if (!Buffer.isBuffer(backup.bytes) || backup.bytes.length>16_000_000) refused();
  const bytes = Buffer.from(backup.bytes);
  const seal = seals.get(backup.seal), lease = targets.get(target);
  if (!seal || !lease || lease.used || hash(bytes)!==seal.digest
    || Boolean(seal.original)!==lease.original
    || busy.has(lease.database) || [seal.sourceId,seal.originalSourceId,seal.original?.candidateDatabaseId].includes(lease.database.runId)
    || lease.ownerId===seal.sourceOwner) refused();
  equal(lease.binding,seal.binding);
  busy.add(lease.database);
  try {
    await inspectArchiveDatabase(lease.database);
    equal(JSON.parse(await wire(lease.database.owner,SCHEMAS)),['local_restore_control','public']);
    equal(await wire(lease.database.owner,rowsSql('local_restore_control.lease')),lease.control);
    if (lease.original) {
      equal(await wire(lease.database.owner,ORIGINAL_CONTROL_GUARDS),lease.controlCatalog);
      equal(await wire(lease.database.owner,rowsSql(ORIGINAL_RECEIPTS)),'[]');
    }
    if ((await lease.database.owner.query(TABLES)).rows.length) refused(); // includes exact/damaged retry, never repair
    const identity = {singleton:true,database_id:lease.database.runId,owner_id:lease.ownerId,
      tenant_id:seal.binding.tenantId,job_id:seal.binding.migrationJobId,state:'RESTORED_NONAUTHORITY'};
    const receipt = {tenant_id:seal.binding.tenantId,job_id:seal.binding.migrationJobId,
      source_database_id:seal.sourceId,destination_database_id:lease.database.runId,source_owner_id:seal.sourceOwner,destination_owner_id:lease.ownerId,
      backup_digest:seal.digest,source_readback_digest:sha256(canonicalJson(seal.tables)),schema_digest:sha256(seal.guards),
      provenance:seal.original ? {marker:seal.marker,original:seal.original}
        : {marker:seal.marker,materialization:seal.receipt,...(seal.prepared ? {prepared:seal.prepared} : {})},authority:'NONAUTHORITY',activation_allowed:false};
    const insert = (table: string,row: Record<string,unknown>) => `INSERT INTO ${table} (${Object.keys(row).map(ident).join(',')}) VALUES (${Object.values(row).map(value =>
      typeof value==='boolean' ? String(value) : literal(typeof value==='string' ? value : JSON.stringify(value))).join(',')});`;
    const checks = Object.entries(seal.tables).map(([table,data]) => checkSql(rowsSql(`public.${ident(table)}`),!seal.original && OMIT.has(table) ? '[]' : data));
    const sequenceChecks = Object.entries(seal.sequences).map(([name,data]) => checkSql(sequenceSql(name),data));
    // Match the owner's default implicit pg_catalog-before-public lookup. In
    // particular pgcrypto also exports gen_random_uuid; deparse must not choose
    // a different qualification just because pg_dump cleared search_path.
    // pg_dump treats initdb's PUBLIC USAGE as the public-schema baseline and
    // omits it. The allocator deliberately recreated an empty schema; reproduce
    // only that independently admitted baseline, never caller-selected grants.
    const privileges=seal.prepared?.privileges ?? seal.original?.prepared.privileges;
    const receiptTable=seal.original ? ORIGINAL_RECEIPTS : 'public.migration_local_restorations';
    const receiptRow=seal.original ? {singleton:true,receipt} : receipt;
    const script = bytes.toString('utf8')+(privileges ? '\nGRANT USAGE ON SCHEMA public TO PUBLIC;\n' : '')
      +'\nSET search_path=pg_catalog,public; SET TIME ZONE \'UTC\'; SET standard_conforming_strings=on;\n'
      +checkSql(SCHEMAS,JSON.stringify(['local_restore_control','public']))+'\n'
      +(privileges ? checkSql(PREPARED_PRIVILEGES,privileges)+'\n' : '')
      +checkSql(GUARDS,seal.guards)+'\n'+checks.join('\n')+'\n'+sequenceChecks.join('\n')+'\n'
      +insert('public.migration_local_restore_databases',identity)+'\n'+insert(receiptTable,receiptRow)+'\n'
      +checkSql(rowsSql('public.migration_local_restore_databases'),JSON.stringify([identity]))+'\n'
      +checkSql(rowsSql(receiptTable),JSON.stringify([receiptRow]))+'\n'
      +(lease.original ? checkSql(ORIGINAL_CONTROL_GUARDS,lease.controlCatalog!)+'\n' : '')
      +checkSql(rowsSql('local_restore_control.lease'),lease.control)+'\n';
    await target.execute(script);
    // Acknowledged COMMIT is irreversible even if receipt readback then fails
    // or external damage empties public. Never downgrade this target to READY.
    lease.used = true;
    // Recheck the complete committed image against the admitted seal, not just
    // its immutable receipts: post-COMMIT domain/guard/sequence damage must not
    // publish SUCCEEDED. This is an exclusive synthetic readback, not a writer
    // fence. A failure remains irreversible/quarantined via lease.used above.
    const q = await lease.database.owner.connect();
    try {
      await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      equal(JSON.parse(await wire(q,SCHEMAS)),['local_restore_control','public']);
      equal(await wire(q,rowsSql('local_restore_control.lease')),lease.control);
      if (lease.original) {
        equal(await wire(q,ORIGINAL_CONTROL_GUARDS),lease.controlCatalog);
        equal(JSON.parse(await wire(q,rowsSql(ORIGINAL_RECEIPTS))),[receiptRow]);
      }
      const actual = await witness(q);
      equal(Object.keys(actual),Object.keys(seal.tables));
      for (const [table,data] of Object.entries(seal.tables)) {
        const expected = table==='migration_local_restore_databases' ? [identity]
          : !seal.original && table==='migration_local_restorations' ? [receipt] : !seal.original && OMIT.has(table) ? [] : JSON.parse(data);
        equal(JSON.parse(actual[table]),expected);
      }
      equal(await wire(q,GUARDS),seal.guards);
      if (privileges) equal(await wire(q,PREPARED_PRIVILEGES),privileges);
      equal(await sequenceWitness(q),seal.sequences);
      await q.query('COMMIT');
    } catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
    return Object.freeze({authority:'NONAUTHORITY' as const,activationAllowed:false as const,
      sourceDatabaseId:seal.sourceId,destinationDatabaseId:lease.database.runId,backupDigest:seal.digest});
  } finally { busy.delete(lease.database); }
}

/** Transfer only a genuinely admitted in-process backup into trusted storage. */
export async function retainMaterializedBackup(backup: Backup, policy: ColdPolicy) {
  const captured=seals.get(backup.seal);
  if (!captured || hash(backup.bytes)!==captured.digest) refused();
  return enrollColdArchive(backup.bytes,captured,policy);
}

/** Reconstitute a local execution seal only from durable coordinator admission,
 * never from an archive declaration or a copied database marker/receipt. */
export async function restoreRetainedMaterializedDatabase(lease: ColdLease, target: Target) {
  const captured=readColdLease(lease), seal=Object.freeze({});
  await dispatchColdTarget(lease);
  seals.set(seal,captured.seal);
  try { return await restoreMaterializedDatabase({bytes:captured.bytes,seal},target); }
  finally { seals.delete(seal); }
}

export async function verifyRestoreRollback(target: Target): Promise<boolean> {
  const lease=targets.get(target); if (!lease || lease.used) return false;
  try {
    await inspectArchiveDatabase(lease.database);
    equal(JSON.parse(await wire(lease.database.owner,SCHEMAS)),['local_restore_control','public']);
    equal(await wire(lease.database.owner,rowsSql('local_restore_control.lease')),lease.control);
    if (lease.original) {
      equal(await wire(lease.database.owner,ORIGINAL_CONTROL_GUARDS),lease.controlCatalog);
      equal(await wire(lease.database.owner,rowsSql(ORIGINAL_RECEIPTS)),'[]');
    }
    // Tables alone are insufficient: a partially restored function, type,
    // sequence, view or extension must also quarantine the attempt. Namespace
    // dependency records cover all public SQL object kinds, not just pg_tables.
    return (await lease.database.owner.query("SELECT 1 FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='public'::regnamespace LIMIT 1")).rows.length===0;
  } catch { return false; }
}

/** Exact wire witnesses on the caller's transaction; synthetic recovery only.
 * Keep bigint and timestamp precision in PostgreSQL text, not JS row codecs. */
export async function readMaterializedRecoveryState(q: Query) {
  return {tables:await witness(q),guards:await wire(q,GUARDS),sequences:await sequenceWitness(q)};
}

/** Read-only prepared-profile witness shared by the separate cold consumer. */
export async function readPreparedArchivePrivileges(q:Query) { return wire(q,PREPARED_PRIVILEGES); }
export { reconcileRestoredPreparedCandidate } from './restoredPreparedCandidate';

/** Direct SQL evidence after commit, not graph reconstruction or JSON import. */
export async function readRestoredMaterializedDatabase(database: DisposablePostgres) {
  await inspectArchiveDatabase(database);
  return {
    tables:Object.fromEntries(Object.entries(await witness(database.owner)).map(([name,rows]) => [name,JSON.parse(rows)])),
    sequences:Object.fromEntries(Object.entries(await sequenceWitness(database.owner)).map(([name,rows]) => [name,JSON.parse(rows)[0]])),
    guards:await wire(database.owner,GUARDS),
    relationships:{
      claims:(await database.owner.query(`SELECT c.post_id,o.operation_id,o.payload_hash,o.status,r.claim_kind
        FROM padlet_evidence_claims c JOIN operations o ON o.tenant_id=c.claimed_by_tenant_id AND o.operation_id=c.claimed_by_operation_id
        JOIN padlet_claim_digest_registry r USING(tuple_digest) ORDER BY c.post_id`)).rows,
      tombstones:(await database.owner.query("SELECT count(*)::int AS n FROM padlet_claim_digest_tombstones t JOIN padlet_claim_digest_registry r USING(tuple_digest) WHERE r.claim_kind='TOMBSTONE'")).rows,
    },
  };
}
