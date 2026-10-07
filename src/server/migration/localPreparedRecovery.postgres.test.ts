// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mutableFixture, cleanupMutableFixture, TENANT, JOB, OTHER } from '../../../test-support/task19MutableFixture';
import { APPLICATION, witness, denyWrites } from '../../../test-support/task19MixedCold';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupMutableFixture);
const suite = process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
async function fixture() {
  const f = await mutableFixture();
  await materializeLocalCandidate(f.binding,f.run());
  const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`,[f.binding.generationId])).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = {binding:f.binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
    expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
  const lease = (db:typeof f.source) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:f.ownerId,
    queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  return {...f,intent,sourceLease:lease(f.source),destinationLease:lease(f.destination),
    state:async () => ({source:await witness(f.source),destination:await witness(f.destination)})};
}
async function cold(f:Awaited<ReturnType<typeof fixture>>,accepted=true) {
  mkdirSync('.task19-prepared-recovery',{recursive:true});
  const id = randomUUID(),path = `.task19-prepared-recovery/${id}-request.json`;
  writeFileSync(path,JSON.stringify({...f.request,intent:f.intent,accepted}));
  const log = execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19PreparedRecoveryChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=.task19-prepared-recovery/${id}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',PREPARED_RECOVERY_REQUEST:path},
      timeout:150_000,encoding:'utf8',maxBuffer:4*1024*1024});
  writeFileSync(`.task19-prepared-recovery/${id}-child.log`,log);
  const result = JSON.parse(readFileSync(path.replace('-request.json','-result.json'),'utf8'));
  expect(result.pid).not.toBe(process.pid);
  for (const db of [f.source,f.destination]) expect((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[APPLICATION])).rows).toEqual([]);
  return result;
}
suite('Task19 prepared uncertainty read-only recovery',() => {
  it.each(['lost-response','source-outer-failure'] as const)('cold determines committed PREPARED STOP after %s without replay',async failure => {
    const f = await fixture(),before = await f.state();
    expect((await f.source.owner.query('SELECT id,lifecycle FROM tenants ORDER BY id')).rows)
      .toEqual([{id:TENANT,lifecycle:'IMPORTING'},{id:OTHER,lifecycle:'DRAFT'}]);
    expect((await f.source.runTenantTransaction(TENANT,tx => tx.execute(sql`SELECT id FROM tenants`))).rows).toEqual([{id:TENANT}]);
    let destinationCommit = false,sourceReached = false;
    const source = {...f.sourceLease,runTransaction:(async (tenant,callback) => f.sourceLease.runTransaction(tenant,async tx => {
      const value = await callback(tx); sourceReached = true;
      if (failure==='source-outer-failure') throw new Error('synthetic source outer finalization failure');
      return value;
    })) as typeof f.sourceLease.runTransaction};
    const destination = {...f.destinationLease,runTransaction:(async (tenant,callback) => {
      const value = await f.destinationLease.runTransaction(tenant,callback);
      destinationCommit = true;
      if (failure==='lost-response') throw new Error('synthetic response lost after destination COMMIT');
      return value;
    }) as typeof f.destinationLease.runTransaction};
    await expect(prepareLocalCandidateTransition(f.intent,createOwnedLocalMaterializationRunner(TENANT,JOB,source,destination)))
      .rejects.toThrow('Local prepared transition refused.');
    expect(destinationCommit).toBe(true); expect(sourceReached).toBe(failure==='source-outer-failure');
    const durable = await f.state(); expect(durable.source).toBe(before.source); expect(durable.destination).not.toBe(before.destination);
    expect((await f.destination.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows).toEqual([{status:'RECONCILING',version:'3'}]);
    const audit = (await f.destination.owner.query('SELECT event_id,redacted_details FROM audit_events')).rows[0];
    expect(audit.redacted_details).toMatchObject({intent:f.intent,preparation:'PREPARED_STOP_REQUIRED',authority:'NONAUTHORITY'});
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow();
    await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow();
    const recovered = await cold(f);
    expect(recovered.outcome).toMatchObject({accepted:true,frozen:true,value:{disposition:'DURABLE_PREPARED_STOP',
      scope:'LOCAL_PREPARED_RECONCILIATION',preparation:'PREPARED_STOP_REQUIRED',authority:'NONAUTHORITY',
      activationAllowed:false,complete:false,exclusion:'NOT_PROVEN',repeatMutationAllowed:false,rollbackAllowed:false,
      status:'RECONCILING',stateVersion:'3',intent:f.intent,auditEventId:audit.event_id,receipt:audit.redacted_details}});
    expect(recovered.before).toEqual(durable); expect(recovered.after).toEqual(durable);
    expect(await f.state()).toEqual(durable);
    console.info('TASK19_PREPARED_RECOVERY_READBACK',JSON.stringify({failure,destinationCommit,sourceReached,request:f.request,intent:f.intent,audit,recovered}));
  },240_000);

  it('cold refuses a destination transaction rolled back before COMMIT',async () => {
    const f = await fixture(),before = await f.state();
    const destination = {...f.destinationLease,runTransaction:(async (tenant,callback) => f.destinationLease.runTransaction(tenant,async tx => {
      await callback(tx); throw new Error('synthetic before destination COMMIT');
    })) as typeof f.destinationLease.runTransaction};
    await expect(prepareLocalCandidateTransition(f.intent,createOwnedLocalMaterializationRunner(TENANT,JOB,f.sourceLease,destination))).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    await cold(f,false); expect(await f.state()).toEqual(before);
  },240_000);

  it.each(['foreign-domain','foreign-private'] as const)('refuses source contamination %s hidden from runtime',async kind => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    if (kind==='foreign-domain') {
      await f.source.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'source-foreign','Synthetic',1,1)",[OTHER]);
      expect((await f.source.runTenantTransaction(TENANT,tx => tx.execute(sql`SELECT product_id FROM products WHERE tenant_id=${OTHER}`))).rows).toEqual([]);
      expect((await f.source.owner.query('SELECT count(*)::text AS count FROM products WHERE tenant_id=$1',[OTHER])).rows).toEqual([{count:'1'}]);
    } else {
      await f.source.owner.query(`INSERT INTO generator_grant_claims(grant_id_hash,subject_hash,email_hash,client_fingerprint,expires_at)
        VALUES(repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),now()+interval '1 hour')`);
      expect((await f.source.runtime.query("SELECT has_table_privilege(current_user,'public.generator_grant_claims','SELECT') AS readable")).rows).toEqual([{readable:false}]);
      expect((await f.source.owner.query('SELECT count(*)::text AS count FROM generator_grant_claims')).rows).toEqual([{count:'1'}]);
    }
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state();
    const outcome = await reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)
      .then(value => ({accepted:true,value}),error => ({accepted:false,error:(error as Error).message}));
    const after = await f.state(); expect(after).toEqual(before);
    console.info('TASK19_SOURCE_CONTAMINATION',JSON.stringify({kind,request:f.request,before,after,outcome}));
    expect(outcome).toEqual({accepted:false,error:'Local prepared reconciliation refused.'});
  },120_000);

  it.each(['foreign-importing-shell','foreign-audit','extra-audit','extra-snapshot','extra-generation',
    'changed-source-domain','changed-source-acquisition','source-ready-final'] as const)('refuses source evidence %s outside exact original readback',async kind => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const src = f.source.owner;
    if (kind==='foreign-importing-shell') await src.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1",[OTHER]);
    else if (kind==='foreign-audit' || kind==='extra-audit') await src.query(
      "INSERT INTO audit_events(tenant_id,event_id,event_type) VALUES($1,'unrelated-source-evidence','SYNTHETIC_UNRELATED')",[kind==='foreign-audit' ? OTHER : TENANT]);
    else if (kind==='extra-snapshot') await src.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      SELECT tenant_id,job_id,source_id,'unrelated-source-snapshot','ROLLBACK_EXPORT',artifact_digest,'{}',0 FROM migration_snapshots`);
    else if (kind==='extra-generation') await src.query(`INSERT INTO migration_full_generations
      (tenant_id,migration_job_id,generation_id,candidate_generation_id,original_generation_id,plan_id,expected_state_version,source_fingerprint,manifest_digest)
      SELECT tenant_id,migration_job_id,'unrelated-generation',candidate_generation_id,original_generation_id,plan_id,expected_state_version,source_fingerprint,manifest_digest
      FROM migration_full_generations`);
    else if (kind==='changed-source-domain') await src.query("UPDATE products SET name='source mutated after prepare' WHERE tenant_id=$1 AND product_id='P1'",[TENANT]);
    else if (kind==='source-ready-final') {
      await src.query('ALTER TABLE migration_jobs DISABLE TRIGGER USER');
      await src.query("UPDATE migration_jobs SET final_fingerprint=repeat('c',64)");
      await src.query('ALTER TABLE migration_jobs ENABLE TRIGGER USER');
    } else {
      await src.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await src.query(`UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{acquisition,sheets,digest}',to_jsonb(repeat('a',64)))
        WHERE event_type='MIGRATION_PREPARATION_ORIGINAL'`);
      await src.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
    }
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state();
    const outcome = await reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)
      .then(value => ({accepted:true,value}),error => ({accepted:false,error:(error as Error).message}));
    const after = await f.state(); expect(after).toEqual(before);
    console.info('TASK19_SOURCE_EVIDENCE',JSON.stringify({kind,request:f.request,before,after,outcome}));
    expect(outcome).toEqual({accepted:false,error:'Local prepared reconciliation refused.'});
  },120_000);

  it('refuses unknown source owner counts and incomplete inventory without reading private fields',async () => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state();
    const countRows = [[],[{}],[{count:null}],[{count:0}],[{count:'-1'}],[{count:'unknown'}],[{count:'0'},{count:'0'}]];
    for (const rows of countRows) {
      let reached = false;
      const source = {...f.sourceLease,queryOwner:async (text:string,values?:unknown[]) => {
        if (text==='SELECT count(*)::text AS count FROM "generator_grant_claims"') { reached = true; return {rows}; }
        return f.sourceLease.queryOwner(text,values);
      }};
      await expect(reconcileLocalPreparedTransition(f.intent,source,f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
      expect(reached).toBe(true);
    }
    for (const fault of ['empty','missing-required','duplicate','missing-private'] as const) {
      let reached = false;
      const source = {...f.sourceLease,queryOwner:async (text:string,values?:unknown[]) => {
        const result = await f.sourceLease.queryOwner(text,values);
        if (text.includes('pg_catalog.pg_tables')) {
          reached = true;
          return {rows:fault==='empty' ? [] : fault==='missing-required' ? result.rows.filter(row => row.tablename!=='products')
            : fault==='missing-private' ? result.rows.filter(row => row.tablename!=='generator_grant_claims') : [...result.rows,result.rows[0]]};
        }
        return result;
      }};
      await expect(reconcileLocalPreparedTransition(f.intent,source,f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
      expect(reached).toBe(true);
    }
    const queries:string[] = [];
    const source = {...f.sourceLease,queryOwner:async (text:string,values?:unknown[]) => {queries.push(text); return f.sourceLease.queryOwner(text,values);}};
    expect((await reconcileLocalPreparedTransition(f.intent,source,f.destinationLease)).disposition).toBe('DURABLE_PREPARED_STOP');
    expect(queries.filter(text => text.includes('generator_grant_claims'))).toEqual(['SELECT count(*)::text AS count FROM "generator_grant_claims"']);
    expect(await f.state()).toEqual(before);
    console.info('TASK19_SOURCE_UNKNOWN_COUNTS',JSON.stringify({request:f.request,before,after:await f.state(),queries}));
  },120_000);

  it('refuses every changed intent and transport/runner uncertainty without returning a disposition',async () => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state();
    const changes = [
      ...['ownerId','sourceDatabaseId','destinationDatabaseId'].map(key => ({...f.intent,[key]:randomUUID()})),
      ...['expectedReportDigest','expectedMaterializationDigest'].map(key => ({...f.intent,[key]:sha256('different')})),
      {...f.intent,expectedDestinationStateVersion:'3'},
      ...Object.keys(f.binding).map(key => ({...f.intent,binding:{...f.binding,[key]:key==='tenantId' ? OTHER
        : key==='expectedStateVersion' ? '5' : key==='sourceFingerprint' || key==='manifestDigest' ? sha256('wrong') : 'wrong'}})),
    ];
    for (const intent of changes) await expect(reconcileLocalPreparedTransition(intent,f.sourceLease,f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    for (const key of ['queryOwner','runTransaction'] as const) for (const position of ['source','destination']) {
      const fault = {...(position==='source' ? f.sourceLease : f.destinationLease),[key]:async () => { throw new Error('synthetic uncertain transport'); }};
      await expect(reconcileLocalPreparedTransition(f.intent,position==='source' ? fault : f.sourceLease,position==='destination' ? fault : f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    }
    for (const db of ['source','destination']) {
      const lease = db==='source' ? f.sourceLease : f.destinationLease;
      const fault = {...lease,runTransaction:(async (tenant,callback) => { await lease.runTransaction(tenant,callback); throw new Error('readback response lost'); }) as typeof lease.runTransaction};
      await expect(reconcileLocalPreparedTransition(f.intent,db==='source' ? fault : f.sourceLease,db==='destination' ? fault : f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    }
    expect(await f.state()).toEqual(before);
  },120_000);

  it.each(['missing-audit','partial-audit','changed-audit','wrong-event-id','receipt-only','state-only',
    'absent-report','changed-report','absent-materialization','changed-materialization','changed-domain',
    'stale-source','stale-destination','conflicting-source','conflicting-destination','foreign-domain','foreign-private',
    'source-marker','destination-marker','source-capture','foreign-importing-shell'] as const)('refuses durable %s without repairs',async kind => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const dest = f.destination.owner,src = f.source.owner;
    if (['missing-audit','partial-audit','changed-audit','wrong-event-id','state-only'].includes(kind)) {
      await dest.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await dest.query(kind==='missing-audit' || kind==='state-only' ? 'DELETE FROM audit_events'
        : kind==='partial-audit' ? "UPDATE audit_events SET redacted_details=redacted_details-'intent'"
        : kind==='wrong-event-id' ? "UPDATE audit_events SET event_id='different'"
        : "UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{validatedReadbackDigest}',to_jsonb(repeat('a',64)))");
      await dest.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
    } else if (kind==='receipt-only') {
      await dest.query('ALTER TABLE migration_jobs DISABLE TRIGGER USER');
      await dest.query("UPDATE migration_jobs SET status='IMPORTING',state_version=2");
      await dest.query('ALTER TABLE migration_jobs ENABLE TRIGGER USER');
    } else if (kind.includes('report')) {
      await src.query('ALTER TABLE migration_full_reconciliation DISABLE TRIGGER USER');
      await src.query(kind==='absent-report' ? "DELETE FROM migration_full_reconciliation WHERE category='products'"
        : "UPDATE migration_full_reconciliation SET expected_digest=repeat('b',64),observed_digest=repeat('b',64) WHERE category='products'");
      await src.query('ALTER TABLE migration_full_reconciliation ENABLE TRIGGER USER');
    } else if (kind.includes('materialization')) {
      await dest.query('ALTER TABLE migration_local_materializations DISABLE TRIGGER USER');
      await dest.query(kind==='absent-materialization' ? 'DELETE FROM migration_local_materializations' : "UPDATE migration_local_materializations SET domain_readback='{}'");
      await dest.query('ALTER TABLE migration_local_materializations ENABLE TRIGGER USER');
    } else if (kind==='changed-domain') await dest.query("UPDATE products SET name='stale' WHERE product_id='P1'");
    else if (kind==='stale-source') await src.query("UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1");
    else if (kind==='stale-destination') await dest.query("UPDATE migration_jobs SET status='READY',state_version=state_version+1");
    else if (kind.startsWith('conflicting')) await (kind==='conflicting-source' ? src : dest).query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'conflict','VALIDATED')",[TENANT]);
    else if (kind==='foreign-domain') await dest.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'foreign','Synthetic',1,1)",[OTHER]);
    else if (kind==='foreign-private') await dest.query("INSERT INTO users(google_subject,canonical_email) VALUES('synthetic','synthetic@example.invalid')");
    else if (kind==='foreign-importing-shell') await dest.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1",[OTHER]);
    else if (kind.endsWith('marker')) {
      const db = kind==='source-marker' ? src : dest;
      await db.query('ALTER TABLE migration_local_disposable_database DISABLE TRIGGER USER');
      await db.query('UPDATE migration_local_disposable_database SET role=$1',[kind==='source-marker' ? 'DESTINATION' : 'SOURCE']);
      await db.query('ALTER TABLE migration_local_disposable_database ENABLE TRIGGER USER');
    } else {
      await src.query('ALTER TABLE migration_full_targets DISABLE TRIGGER USER');
      await src.query("UPDATE migration_full_targets SET canonical_value=jsonb_set(canonical_value,'{name}','\"wrong\"') WHERE target_table='products'");
      await src.query('ALTER TABLE migration_full_targets ENABLE TRIGGER USER');
    }
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state();
    await expect(reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    expect(await f.state()).toEqual(before);
  },120_000);

  it.each(['source','destination'] as const)('refuses native %s readback transport loss after the determination callback',async position => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state(),db = position==='source' ? f.source : f.destination;
    const lease = position==='source' ? f.sourceLease : f.destinationLease;
    let determined = false,nativeError:unknown,killedPid:number | undefined;
    const fault = {...lease,runTransaction:(async (tenant,callback) => {
      try {
        return await lease.runTransaction(tenant,async tx => {
          const value = await callback(tx); determined = true;
          const {rows} = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          killedPid = Number(rows[0].pid);
          // Exact checked-out backend in our still-owned disposable container.
          // This is an actual server disconnect before read-transaction COMMIT,
          // not a constructed driver error or a gateway/process lifecycle action.
          expect((await db.owner.query('SELECT pg_terminate_backend($1) AS terminated',[killedPid])).rows)
            .toEqual([{terminated:true}]);
          return value;
        });
      } catch (error) {
        nativeError = error;
        throw error;
      }
    }) as typeof lease.runTransaction};
    await expect(reconcileLocalPreparedTransition(f.intent,position==='source' ? fault : f.sourceLease,
      position==='destination' ? fault : f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    expect(determined).toBe(true); expect(nativeError).toBeInstanceOf(Error);
    // The killed socket may fail the relay's pending COMMIT write first:
    // pgStdioRelay.c returns 9 specifically when drain(fd, &inbound) fails.
    // Keep the real termination, determination, absent-backend and no-write
    // witnesses; do not accept arbitrary relay/setup failures as this fault.
    expect((nativeError as Error).message).toMatch(/terminat|connection|queryable|^Owned PostgreSQL relay exited 9$/i);
    expect((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[killedPid])).rows).toEqual([]);
    expect(await f.state()).toEqual(before);
    console.info('TASK19_PREPARED_NATIVE_READBACK_LOSS',JSON.stringify({position,determined,killedPid,
      error:{name:(nativeError as Error).name,message:(nativeError as Error).message,stack:(nativeError as Error).stack},
      before,after:await f.state()}));
    // Explicit later readback is permitted; it is not an automatic mutation retry.
    expect((await reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)).disposition).toBe('DURABLE_PREPARED_STOP');
    expect(await f.state()).toEqual(before);
  },120_000);

  it('detaches admitted intent and rejects executable inputs or skipped/doubled/substituted callbacks',async () => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const calls = vi.fn(),accessor = {...f.intent}; Object.defineProperty(accessor,'ownerId',{get:calls});
    for (const raw of [new Proxy(f.intent,{get:calls}),accessor,{...f.intent,extra:true}])
      await expect(reconcileLocalPreparedTransition(raw,f.sourceLease,f.destinationLease)).rejects.toThrow();
    expect(calls).not.toHaveBeenCalled();
    for (const runTransaction of [async () => undefined as never,
      (async (tenant,callback) => f.destinationLease.runTransaction(tenant,async tx => { await callback(tx); return callback(tx); })) as typeof f.destinationLease.runTransaction,
      (async (tenant,callback) => { await f.destinationLease.runTransaction(tenant,callback); return {} as never; }) as typeof f.destinationLease.runTransaction])
      await expect(reconcileLocalPreparedTransition(f.intent,f.sourceLease,{...f.destinationLease,runTransaction})).rejects.toThrow();
    const detached = structuredClone(f.intent);
    const source = {...f.sourceLease,queryOwner:async (text:string,values?:unknown[]) => {
      f.intent.binding = {...f.binding,generationId:'changed after admission'}; return f.sourceLease.queryOwner(text,values);
    }};
    const result = await reconcileLocalPreparedTransition(f.intent,source,f.destinationLease);
    expect(result.intent).toEqual(detached); expect(Object.isFrozen(result.intent.binding)).toBe(true);
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`DELETE FROM audit_events`))).rejects.toThrow();
  },120_000);
});
