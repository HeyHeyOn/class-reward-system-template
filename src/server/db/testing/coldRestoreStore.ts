import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MaterializedArchiveExpectation } from './materializedRestore';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson } from '@/server/migration/validators';
import { coldProcessIdentity, killedColdWorker, type ColdProcessIdentity, type ColdWorkerObservation } from './coldProcessWitness';
import type { DisposableColdRegistration, DisposablePostgres } from './disposablePostgres';
import { readColdOrphan, type ColdOwnedInventory } from './ownedPgArchive';
export { watchColdWorker } from './coldProcessWitness';

export type ColdAnchor = Readonly<{id: string; expectationSha256: string; ownerId: string}>;
export type ColdPolicy = Readonly<{retainUntil: number; expiresAt: number}>;
type Expectation = {version: 1; id: string; policy: ColdPolicy; seal: MaterializedArchiveExpectation};
type Status = 'READY' | 'IN_FLIGHT' | 'SUCCEEDED' | 'QUARANTINED' | 'DISPOSED';
type Journal = {id: string; status: Status; lastAttempt: Record<string,unknown> | null};
export type ColdLease = Readonly<{id: string}>;
export type ColdAttempt={version:1; anchor:ColdAnchor; attemptId:string; ownerId:string; worker:ColdProcessIdentity};
type Held = {anchor: ColdAnchor; expectation: Expectation; bytes: Buffer; release: () => Promise<void>; attempt:ColdAttempt; leaseSha256:string};
const held = new WeakMap<ColdLease,Held>();
export type ColdExportExecution=Readonly<{profile:'COLD_EXPORT_ORIGINAL_EXECUTION_V1';anchor:ColdAnchor;attemptId:string;
  leaseSha256:string;exportSha256:string;databaseId:string;ownerId:string;systemIdentifier:string}>;
// This map is deliberately NOT durable authority. SQL carries a provenance pin,
// never a serializable successor capability. Death destroys replay permission.
const exportExecutions=new WeakMap<DisposablePostgres,{lease:ColdLease;execution:ColdExportExecution}>();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const LIMIT=16_000_000;
const digest=(b: Buffer) => createHash('sha256').update(b).digest('hex');
const roots=() => ({control:resolve('.cold-restore-control'),transport:resolve('.cold-restore-transport')});
export function coldRefused(): never { throw new Error('Cold restore refused.'); }
function optIn() { if (process.env.RUN_REAL_POSTGRES!=='1') coldRefused(); }
function anchorCopy(a: ColdAnchor): ColdAnchor {
  optIn();
  if (!a || !UUID.test(a.id) || !UUID.test(a.ownerId) || !HASH.test(a.expectationSha256)) coldRefused();
  return Object.freeze({id:a.id,ownerId:a.ownerId,expectationSha256:a.expectationSha256});
}
async function privateDirectory(path: string, create=false) {
  if (create) await mkdir(path,{mode:0o700}).catch(error => { if (error.code!=='EEXIST') throw error; });
  const stat=await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || (stat.mode & 0o777)!==0o700) coldRefused();
}
async function syncDirectory(path: string) {
  const file=await open(path,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function readPrivate(path: string): Promise<Buffer> {
  // A FIFO can block open before fstat rejects it (including crash residue).
  // Nonblocking open does not relax the existing regular-file/owner checks.
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if (!stat.isFile() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode & 0o777)!==0o600 || stat.size>LIMIT) coldRefused();
    const bytes=await file.readFile();
    if (bytes.length!==stat.size || bytes.length>LIMIT) coldRefused();
    return bytes;
  } finally { await file.close(); }
}
async function publish(directory: string,name: string,bytes: Buffer) {
  if (!bytes.length || bytes.length>LIMIT) coldRefused();
  const temporary=join(directory,`.part-${randomUUID()}`);
  const file=await open(temporary,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary,join(directory,name)); await syncDirectory(directory);
  } finally {
    // Only this invocation's exclusively created temporary file. Do not roll
    // back an already published journal in existing recovery call paths.
    await unlink(temporary).catch(error => { if (error.code!=='ENOENT') throw error; });
  }
}
function location(a: ColdAnchor) { return join(roots().control,a.id); }
async function writeState(a: ColdAnchor,status: Status,lastAttempt: Journal['lastAttempt']) {
  await publish(location(a),'state.json',Buffer.from(JSON.stringify({id:a.id,status,lastAttempt})));
}
async function readState(a: ColdAnchor): Promise<Journal> {
  const journal=JSON.parse((await readPrivate(join(location(a),'state.json'))).toString('utf8')) as Journal;
  if (journal.id!==a.id || !['READY','IN_FLIGHT','SUCCEEDED','QUARANTINED','DISPOSED'].includes(journal.status)) coldRefused();
  return journal;
}
async function lock(a: ColdAnchor) {
  await privateDirectory(roots().control); await privateDirectory(roots().transport); await privateDirectory(location(a));
  const path=join(location(a),'lock');
  // Deliberately no stale-lock theft: a killed coordinator never authorizes retry.
  await mkdir(path,{mode:0o700}); await syncDirectory(location(a));
  const release=async () => { await rmdir(path); await syncDirectory(location(a)); };
  try {
    // READY can already be durable while recovery still owns its gate. The
    // publication tail is not permission to restore or dispose the transport.
    try { await lstat(join(location(a),'recovery-lock')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return release; throw error; }
    coldRefused();
  } catch (error) { await release(); throw error; }
}
async function authenticated(a: ColdAnchor): Promise<Expectation> {
  const bytes=await readPrivate(join(location(a),'expectation.json'));
  if (digest(bytes)!==a.expectationSha256) coldRefused();
  const e=JSON.parse(bytes.toString('utf8')) as Expectation;
  if (e.version!==1 || e.id!==a.id || e.seal.sourceOwner!==a.ownerId) coldRefused();
  return e;
}
/** Trusted enrollment only, called after the existing source admission. There is
 * no SQL upload route and no reconstruction of this pin from the archive. */
export async function enrollColdArchive(bytes: Buffer, seal: MaterializedArchiveExpectation, policy: ColdPolicy): Promise<ColdAnchor> {
  optIn();
  bytes=Buffer.from(bytes); seal=structuredClone(seal); policy=Object.freeze({...policy});
  if (!Number.isSafeInteger(policy.retainUntil) || policy.retainUntil<0 || !Number.isSafeInteger(policy.expiresAt)
    || policy.expiresAt<=policy.retainUntil || policy.expiresAt<=Date.now() || digest(bytes)!==seal.digest || !UUID.test(seal.sourceOwner)) coldRefused();
  await privateDirectory(roots().control,true); await privateDirectory(roots().transport,true);
  const id=randomUUID(), dir=join(roots().control,id);
  const expectation=Buffer.from(JSON.stringify({version:1,id,policy,seal} satisfies Expectation));
  if (!bytes.length || bytes.length>LIMIT || expectation.length>LIMIT) coldRefused();
  const anchor=Object.freeze({id,ownerId:seal.sourceOwner,expectationSha256:digest(expectation)});
  // Enrollment is new authority, not a retry/adoption of an old directory.
  // Reserve both names exclusively before publication so failure cleanup can
  // never remove an existing ORIGINAL or CANDIDATE archive on UUID collision.
  await mkdir(dir,{mode:0o700});
  const transport=join(roots().transport,`${id}.sql`);
  let ownsTransport=false;
  try {
    await privateDirectory(dir); await syncDirectory(roots().control);
    const reserved=await open(transport,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600);
    ownsTransport=true; await reserved.close();
    await publish(roots().transport,`${id}.sql`,bytes);
    await publish(dir,'expectation.json',expectation);
    // READY is last; all readbacks must succeed before the anchor can escape.
    await writeState(anchor,'READY',null);
    await authenticated(anchor);
    if (digest(await readPrivate(transport))!==seal.digest || (await readState(anchor)).status!=='READY') coldRefused();
    return anchor;
  } catch (error) {
    // No anchor escaped. Invalidate the new authority first, then remove only
    // this enrollment's owned artifacts. This is not abandoned-worker recovery.
    const paths=[join(dir,'state.json'),join(dir,'expectation.json'),...(ownsTransport ? [transport] : [])];
    const failures:unknown[]=[];
    for (const path of paths) {
      try { await unlink(path); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code!=='ENOENT') failures.push(failure); }
    }
    try { await rmdir(dir); await syncDirectory(roots().control); await syncDirectory(roots().transport); }
    catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error,...failures],'Cold enrollment cleanup failed.');
    throw error;
  }
}
/** Read-only export snapshot under the ORIGINAL coordinator gate. This does not
 * mint an attempt, copy a lease, enroll a second archive or rewrite READY. */
export async function readColdArchiveForExport(raw:ColdAnchor,binding:LocalCandidateBinding) {
  const anchor=anchorCopy(raw), expectedBinding=canonicalJson(binding);
  const release=await lock(anchor);
  try {
    const expectation=await authenticated(anchor),state=await readState(anchor);
    if (state.status!=='READY' || Date.now()>=expectation.policy.expiresAt
      || canonicalJson(expectation.seal.binding)!==expectedBinding) coldRefused();
    const bytes=await readPrivate(join(roots().transport,`${anchor.id}.sql`));
    if (digest(bytes)!==expectation.seal.digest) coldRefused();
    return {bytes,seal:structuredClone(expectation.seal)};
  } finally {await release();}
}
export async function acquireColdArchive(raw: ColdAnchor,binding: LocalCandidateBinding): Promise<ColdLease> {
  return acquireArchive(raw,binding);
}

/** Separate test-only post-restore gate. The callback is trusted infrastructure,
 * not a request callback or a capability to mutate/promote SQL. A successful
 * restore remains SUCCEEDED even if candidate inspection quarantines. A crash
 * leaves the lock/IN_FLIGHT intact; there is no stale-lock stealing or replay. */
export async function inspectSettledPreparedCandidate<T>(rawAnchor:ColdAnchor,raw:unknown,
  inspect:(seal:MaterializedArchiveExpectation,inventory:ColdOwnedInventory,anchor:ColdAnchor) => Promise<T>):Promise<T> {
  const own=(value:unknown,keys:string[]):Record<string,unknown> => {
    if (!value || typeof value!=='object' || types.isProxy(value) || Object.getPrototypeOf(value)!==Object.prototype
      || Reflect.ownKeys(value).length!==keys.length) coldRefused();
    const result:Record<string,unknown>={};
    for (const key of keys) {
      const d=Object.getOwnPropertyDescriptor(value,key);
      if (!d || !d.enumerable || !('value' in d)) coldRefused();
      result[key]=d.value;
    }
    return result;
  };
  // Snapshot only data descriptors before any await or getter/coercion. The
  // request narrows the authenticated pin; it cannot supply a replacement seal.
  const a=own(rawAnchor,['id','expectationSha256','ownerId']);
  if (Object.values(a).some(v => typeof v!=='string')) coldRefused();
  const anchor=anchorCopy(a as ColdAnchor);
  const request=own(raw,['binding','stopIntentDigest','sourceGenerationDigest','restoreOwnerId','restoreDatabaseId',
    'restoreAttemptId','restoreSystemIdentifier','authority','activationAllowed']);
  const binding=own(request.binding,['tenantId','migrationJobId','generationId','expectedStateVersion','sourceFingerprint','manifestDigest']);
  if (Object.values(binding).some(v => typeof v!=='string') || Object.entries(request).some(([k,v]) =>
    !['binding','activationAllowed'].includes(k) && typeof v!=='string') || request.authority!=='NONAUTHORITY' || request.activationAllowed!==false) coldRefused();
  request.binding=binding;
  const release=await lock(anchor);
  let started=false;
  const journal='candidate-reconciliation.json';
  try {
    const e=await authenticated(anchor),state=await readState(anchor),original=await attemptFromState(anchor,state);
    const seal=e.seal,p=seal.prepared;
    if (!p || p.contract!=='LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1' || state.status!=='SUCCEEDED'
      || Date.now()>=e.policy.expiresAt || original.attempt.ownerId===seal.sourceOwner) coldRefused();
    const inventory=JSON.parse((await readPrivate(join(location(anchor),'inventory.json'))).toString('utf8')) as ColdOwnedInventory;
    if (!coldInventoryMatches(inventory,original.attempt,original.leaseSha256) || inventory.phase!=='DISPATCHED'
      || state.lastAttempt?.targetId!==inventory.runId || state.lastAttempt?.containerId!==inventory.containerId
      || state.lastAttempt?.pid!==original.attempt.worker.pid || state.lastAttempt?.rollbackVerified!==false) coldRefused();
    sameExecution(request,{binding:seal.binding,stopIntentDigest:digest(Buffer.from(canonicalJson(p.intent))),
      sourceGenerationDigest:p.sourceGenerationDigest,restoreOwnerId:inventory.ownerId,restoreDatabaseId:inventory.runId,
      restoreAttemptId:inventory.attemptId,restoreSystemIdentifier:inventory.systemIdentifier,authority:'NONAUTHORITY',activationAllowed:false});
    const bytes=await readPrivate(join(roots().transport,`${anchor.id}.sql`));
    if (digest(bytes)!==seal.digest) coldRefused();
    await absentControlPath(anchor,journal);
    const pending={status:'IN_FLIGHT',pid:process.pid,request};
    await publish(location(anchor),journal,Buffer.from(JSON.stringify(pending)));
    started=true;
    const result=await inspect(structuredClone(seal),structuredClone(inventory),anchor);
    // Reauthenticate control, settled lineage, deadline and immutable transport
    // after both SQL readbacks. Observed stability is NOT a continuous fence.
    sameExecution(await authenticated(anchor),e); sameExecution(await readState(anchor),state);
    sameExecution(JSON.parse((await readPrivate(join(location(anchor),'inventory.json'))).toString('utf8')),inventory);
    sameExecution(JSON.parse((await readPrivate(join(location(anchor),journal))).toString('utf8')),pending);
    if (Date.now()>=e.policy.expiresAt || digest(await readPrivate(join(roots().transport,`${anchor.id}.sql`)))!==seal.digest) coldRefused();
    await publish(location(anchor),journal,Buffer.from(JSON.stringify({status:'VALIDATED',pid:process.pid,request,
      candidateDigest:digest(Buffer.from(canonicalJson(result)))})));
    return result;
  } catch {
    if (started) await publish(location(anchor),journal,Buffer.from(JSON.stringify({status:'QUARANTINED',pid:process.pid,request})));
    coldRefused();
  } finally { await release(); }
}
/** Alternate BYTES, not alternate authority. The same original anchor, lock,
 * deadline, journal, attempt and allocation inventory authorize execution. */
export async function acquireColdArchiveFromExport(raw:ColdAnchor,binding:LocalCandidateBinding,rawBytes:Buffer):Promise<ColdLease> {
  if (!Buffer.isBuffer(rawBytes) || !rawBytes.length || rawBytes.length>LIMIT) coldRefused();
  return acquireArchive(raw,binding,Buffer.from(rawBytes));
}
async function acquireArchive(raw: ColdAnchor,binding: LocalCandidateBinding,exportedBytes?:Buffer): Promise<ColdLease> {
  const anchor=anchorCopy(raw), expectedBinding=canonicalJson(binding);
  let release: (() => Promise<void>) | undefined;
  try {
    release=await lock(anchor);
    const expectation=await authenticated(anchor), state=await readState(anchor);
    if (state.status!=='READY' || Date.now()>=expectation.policy.expiresAt
      || canonicalJson(expectation.seal.binding)!==expectedBinding) coldRefused();
    const bytes=exportedBytes ?? await readPrivate(join(roots().transport,`${anchor.id}.sql`));
    if (digest(bytes)!==expectation.seal.digest) coldRefused();
    const attempt:ColdAttempt={version:1,anchor,attemptId:randomUUID(),ownerId:randomUUID(),worker:await coldProcessIdentity()};
    const durable=Buffer.from(JSON.stringify(attempt)), leaseSha256=digest(durable);
    await publish(location(anchor),`attempt-${attempt.attemptId}.json`,durable);
    await writeState(anchor,'IN_FLIGHT',{pid:process.pid,startedAt:Date.now(),attemptId:attempt.attemptId,leaseSha256});
    const lease=Object.freeze({id:anchor.id});
    held.set(lease,{anchor,expectation,bytes,release,attempt,leaseSha256});
    return lease;
  } catch { if (release) await release(); coldRefused(); }
}
/** This capability is minted in the NEW process only after durable admission.
 * Serialized metadata cannot stand in for it. Never exported to an HTTP client. */
export function readColdLease(lease: ColdLease) {
  const value=held.get(lease); if (!value) coldRefused();
  return {bytes:Buffer.from(value.bytes),seal:structuredClone(value.expectation.seal)};
}
export async function settleColdArchive(lease: ColdLease,status: 'READY' | 'SUCCEEDED' | 'QUARANTINED',attempt: Record<string,unknown>) {
  const value=held.get(lease); if (!value) coldRefused();
  // Persist terminal/rollback status BEFORE releasing. A write failure keeps the
  // IN_FLIGHT lock quarantined; never silently reset to READY in a finally block.
  await writeState(value.anchor,status,{...attempt,attemptId:value.attempt.attemptId,leaseSha256:value.leaseSha256});
  held.delete(lease); await value.release();
}
export async function disposeColdArchive(raw: ColdAnchor) {
  const anchor=anchorCopy(raw); let release: (() => Promise<void>) | undefined;
  try {
    release=await lock(anchor);
    const e=await authenticated(anchor), state=await readState(anchor);
    if (Date.now()<e.policy.retainUntil || state.status==='IN_FLIGHT') coldRefused();
    // Tombstone first: even an interrupted unlink cannot revive restoration.
    await writeState(anchor,'DISPOSED',state.lastAttempt);
    const path=join(roots().transport,`${anchor.id}.sql`);
    try { await readPrivate(path); await unlink(path); await syncDirectory(roots().transport); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  } catch { coldRefused(); }
  finally { if (release) await release(); }
}

async function attemptFromState(anchor:ColdAnchor,state:Journal) {
  const id=state.lastAttempt?.attemptId, hash=state.lastAttempt?.leaseSha256;
  if (typeof id!=='string' || !UUID.test(id) || typeof hash!=='string' || !HASH.test(hash)) coldRefused();
  const bytes=await readPrivate(join(location(anchor),`attempt-${id}.json`));
  if (digest(bytes)!==hash) coldRefused();
  const attempt=JSON.parse(bytes.toString('utf8')) as ColdAttempt;
  if (attempt.version!==1 || attempt.attemptId!==id || !UUID.test(attempt.ownerId) || canonicalJson(attempt.anchor)!==canonicalJson(anchor)) coldRefused();
  return {attempt,leaseSha256:hash};
}
async function currentHeld(lease:ColdLease) {
  const value=held.get(lease); if (!value) coldRefused();
  const state=await readState(value.anchor), current=await attemptFromState(value.anchor,state);
  if (state.status!=='IN_FLIGHT' || current.leaseSha256!==value.leaseSha256) coldRefused();
  return value;
}
async function inventoryFor(value:Held) {
  const inventory=JSON.parse((await readPrivate(join(location(value.anchor),'inventory.json'))).toString('utf8')) as ColdOwnedInventory;
  if (!coldInventoryMatches(inventory,value.attempt,value.leaseSha256)) coldRefused();
  return inventory;
}
function sameExecution(a:unknown,b:unknown) {if (canonicalJson(a)!==canonicalJson(b)) coldRefused();}
async function absentControlPath(anchor:ColdAnchor,name:string) {
  try {await lstat(join(location(anchor),name));}
  catch (error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error;}
  coldRefused();
}
/** Pin only the actual live original archive capability to this exact handle.
 * Not a restart API: no PID, copied lease/SQL, witness, or JSON can enroll a new
 * original/successor. Pin and terminal are installed in one destination SQL tx. */
export async function pinColdExportExecution(lease:ColdLease,db:DisposablePostgres,ownerId:string,
  base:MaterializedArchiveExpectation,systemIdentifier:string,exportSha256:string):Promise<ColdExportExecution> {
  if (!HASH.test(exportSha256)) coldRefused();
  const value=await currentHeld(lease),inventory=await inventoryFor(value);
  sameExecution(value.expectation.seal,base); sameExecution(await coldProcessIdentity(),value.attempt.worker);
  await privateDirectory(join(location(value.anchor),'lock')); await absentControlPath(value.anchor,'recovery-lock');
  if (inventory.phase!=='DISPATCHED' || inventory.runId!==db.runId || inventory.ownerId!==ownerId
    || inventory.containerId!==db.evidence.containerId || inventory.imageId!==db.evidence.imageId
    || inventory.systemIdentifier!==systemIdentifier) coldRefused();
  const execution:ColdExportExecution={profile:'COLD_EXPORT_ORIGINAL_EXECUTION_V1',anchor:value.anchor,attemptId:value.attempt.attemptId,
    leaseSha256:value.leaseSha256,exportSha256,databaseId:db.runId,ownerId,systemIdentifier};
  const existing=exportExecutions.get(db);
  if (existing) {if (existing.lease!==lease) coldRefused(); sameExecution(existing.execution,execution);}
  else exportExecutions.set(db,{lease,execution:structuredClone(execution)});
  return execution;
}
/** Executed under the destination transaction lock BEFORE idempotency acceptance
 * or any suffix DML. There is intentionally no durable successor grant today. */
export async function requireColdExportReplay(db:DisposablePostgres,execution:ColdExportExecution,base:MaterializedArchiveExpectation) {
  const original=exportExecutions.get(db);
  if (!original) throw new Error('Sealed export successor refused: durable successor capability not enrolled.');
  sameExecution(original.execution,execution);
  sameExecution(await pinColdExportExecution(original.lease,db,execution.ownerId,base,execution.systemIdentifier,execution.exportSha256),execution);
}
export async function requireColdExportTerminal(db:DisposablePostgres,execution:ColdExportExecution,base:MaterializedArchiveExpectation,
  ownerId:string,systemIdentifier:string) {
  const original=exportExecutions.get(db);
  if (original && held.has(original.lease)) return requireColdExportReplay(db,execution,base);
  return requireColdExportCompletion(db,execution,base,ownerId,systemIdentifier);
}
/** Preparation may cross processes ONLY after the original explicitly settled
 * SUCCEEDED and released its lease. Complete SQL after death is NOT settlement.
 * This check authorizes no replay and cannot clear quarantine/recovery gates. */
export async function requireColdExportCompletion(db:DisposablePostgres,execution:ColdExportExecution,base:MaterializedArchiveExpectation,
  ownerId:string,systemIdentifier:string,exportSha256?:string) {
  const anchor=anchorCopy(execution.anchor);
  await privateDirectory(roots().control); await privateDirectory(location(anchor));
  const expectation=await authenticated(anchor),state=await readState(anchor),original=await attemptFromState(anchor,state);
  sameExecution(expectation.seal,base);
  sameExecution(execution,{profile:'COLD_EXPORT_ORIGINAL_EXECUTION_V1',anchor,attemptId:original.attempt.attemptId,
    leaseSha256:original.leaseSha256,exportSha256:exportSha256 ?? execution.exportSha256,databaseId:db.runId,ownerId,systemIdentifier});
  if (!HASH.test(execution.exportSha256) || original.attempt.ownerId!==ownerId || state.status!=='SUCCEEDED'
    || state.lastAttempt?.exportSha256!==execution.exportSha256 || state.lastAttempt?.targetId!==db.runId
    || state.lastAttempt?.containerId!==db.evidence.containerId || state.lastAttempt?.pid!==original.attempt.worker.pid
    || state.lastAttempt?.rollbackVerified!==false) coldRefused();
  const inventory=JSON.parse((await readPrivate(join(location(anchor),'inventory.json'))).toString('utf8')) as ColdOwnedInventory;
  if (!coldInventoryMatches(inventory,original.attempt,original.leaseSha256) || inventory.phase!=='DISPATCHED'
    || inventory.runId!==db.runId || inventory.containerId!==db.evidence.containerId || inventory.imageId!==db.evidence.imageId
    || inventory.systemIdentifier!==systemIdentifier) coldRefused();
  await absentControlPath(anchor,'lock'); await absentControlPath(anchor,'recovery-lock');
}
export function coldInventoryMatches(i:ColdOwnedInventory,a:ColdAttempt,leaseSha256:string) {
  return !!i && i.version===1 && i.packetId===a.anchor.id && i.attemptId===a.attemptId && i.ownerId===a.ownerId && i.leaseSha256===leaseSha256
    && UUID.test(i.runId) && /^sha256:[a-f0-9]{64}$/.test(i.imageId) && ['PLANNED','CREATED','STARTING','ALLOCATED','DISPATCHED'].includes(i.phase)
    && (i.phase==='PLANNED' || (typeof i.containerId==='string' && HASH.test(i.containerId)
      && (['CREATED','STARTING'].includes(i.phase) || (typeof i.systemIdentifier==='string'
        && /^[0-9]+$/.test(i.systemIdentifier) && Array.isArray(i.control) && i.control.length===1 && Array.isArray(i.controlGuards) && i.controlGuards.length>0))));
}
/** Create intent cannot be published from a copied lease or target receipt. */
export function coldAllocationRegistration(lease:ColdLease):{ownerId:string;registration:DisposableColdRegistration} {
  const value=held.get(lease); if (!value) coldRefused();
  let planned=false;
  return {ownerId:value.attempt.ownerId,registration:{packetId:value.anchor.id,attemptId:value.attempt.attemptId,beforeCreate:async ({runId,imageId}) => {
    await currentHeld(lease);
    if (planned || !UUID.test(runId) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) coldRefused();
    planned=true;
    const inventory:ColdOwnedInventory={version:1,packetId:value.anchor.id,attemptId:value.attempt.attemptId,leaseSha256:value.leaseSha256,
      ownerId:value.attempt.ownerId,runId,imageId,phase:'PLANNED'};
    await publish(location(value.anchor),'inventory.json',Buffer.from(JSON.stringify(inventory)));
  },afterCreate:async ({containerId}) => {
    const current=await currentHeld(lease), inventory=await inventoryFor(current);
    if (!planned || inventory.phase!=='PLANNED' || !HASH.test(containerId)) coldRefused();
    await publish(location(value.anchor),'inventory.json',Buffer.from(JSON.stringify({...inventory,phase:'CREATED',containerId})));
  },beforeStart:async () => {
    const current=await currentHeld(lease), inventory=await inventoryFor(current);
    if (inventory.phase!=='CREATED') coldRefused();
    // Must be durable BEFORE the Docker client can dispatch a start request.
    await publish(location(value.anchor),'inventory.json',Buffer.from(JSON.stringify({...inventory,phase:'STARTING'})));
  }}};
}
export async function bindColdTarget(lease:ColdLease,db:DisposablePostgres) {
  const value=await currentHeld(lease), planned=await inventoryFor(value);
  if (planned.phase!=='STARTING' || planned.containerId!==db.evidence.containerId || planned.runId!==db.runId || planned.imageId!==db.evidence.imageId
    || typeof db.evidence.containerId!=='string' || !HASH.test(db.evidence.containerId)) coldRefused();
  const inventory={...planned,containerId:db.evidence.containerId};
  const readback=await readColdOrphan(inventory), binding=value.expectation.seal.binding;
  const control=[{singleton:true,database_id:db.runId,owner_id:value.attempt.ownerId,tenant_id:binding.tenantId,
    job_id:binding.migrationJobId,system_identifier:readback.systemIdentifier,state:'EMPTY_LEASE'}];
  if (canonicalJson(readback.control)!==canonicalJson(control) || readback.publicObjects.length
    || canonicalJson(readback.schemas)!==canonicalJson(['local_restore_control','public']) || !readback.controlGuards.length) coldRefused();
  await publish(location(value.anchor),'inventory.json',Buffer.from(JSON.stringify({...inventory,phase:'ALLOCATED',
    systemIdentifier:readback.systemIdentifier,control,controlGuards:readback.controlGuards})));
}
export async function dispatchColdTarget(lease:ColdLease) {
  const value=await currentHeld(lease), inventory=await inventoryFor(value);
  if (inventory.phase!=='ALLOCATED') coldRefused();
  // Must survive even a kill before psql returns an acknowledgement.
  await publish(location(value.anchor),'inventory.json',Buffer.from(JSON.stringify({...inventory,phase:'DISPATCHED'})));
}
export async function certifyColdWorkerExit(raw:ColdAnchor,observation:ColdWorkerObservation) {
  const anchor=anchorCopy(raw);
  await privateDirectory(roots().control); await privateDirectory(location(anchor)); await authenticated(anchor);
  const state=await readState(anchor), value=await attemptFromState(anchor,state), exit=await killedColdWorker(observation);
  if (state.status!=='IN_FLIGHT' || canonicalJson(exit.worker)!==canonicalJson(value.attempt.worker)) coldRefused();
  await privateDirectory(join(location(anchor),'lock'));
  await publish(location(anchor),'worker-exit.json',Buffer.from(JSON.stringify({version:1,attemptId:value.attempt.attemptId,
    leaseSha256:value.leaseSha256,anchor,...exit})));
}
export type ColdRecoveryResult={status:'BLOCKED'|'QUARANTINED'|'DISPOSED_EMPTY';blocker?:string;attemptId?:string;
  readback?:unknown;cleanup?:{containerRemoved:true;id:string}};
export type ColdRecoveryContext={anchor:ColdAnchor;seal:MaterializedArchiveExpectation;state:Journal;attempt?:ColdAttempt;leaseSha256?:string;inventory?:ColdOwnedInventory;
  exit?:Record<string,unknown>;previous?:ColdRecoveryResult;
  leaseIntact:() => Promise<boolean>;
  finish:(result:ColdRecoveryResult) => Promise<ColdRecoveryResult>;
  block:(blocker:string) => Promise<ColdRecoveryResult>};
async function blockedRecoveryGate(anchor:ColdAnchor,gate:string):Promise<ColdRecoveryResult> {
  let blocker='RECOVERY_GATE_UNPROVEN';
  try {
    await privateDirectory(gate);
    const owner=JSON.parse((await readPrivate(join(gate,'owner.json'))).toString('utf8'));
    if (owner.version===1 && UUID.test(owner.id) && canonicalJson(owner.anchor)===canonicalJson(anchor)
      && canonicalJson(await coldProcessIdentity(owner.coordinator.pid))===canonicalJson(owner.coordinator)) blocker='RECOVERY_BUSY';
  } catch { /* Missing, partial, dead, reused or changed-scope owner is unproved. */ }
  // Diagnostic identity/absence is NOT a trusted exit observation and never
  // grants release authority. Keep the gate, original lease and journal intact.
  const result:ColdRecoveryResult={status:'BLOCKED',blocker};
  await publish(location(anchor),`blocked-${randomUUID()}.json`,Buffer.from(JSON.stringify({result,pid:process.pid,anchor})));
  return result;
}
/** A recovery gate never takes over the worker lock. Saved final disposition
 * is published before READY; interrupted publication leaves an explicit lock. */
export async function withColdRecovery(raw:ColdAnchor,binding:LocalCandidateBinding,action:(c:ColdRecoveryContext) => Promise<ColdRecoveryResult>):Promise<ColdRecoveryResult> {
  const anchor=anchorCopy(raw);
  try {
    await privateDirectory(roots().control); await privateDirectory(roots().transport); await privateDirectory(location(anchor));
    const expectation=await authenticated(anchor);
    if (canonicalJson(binding)!==canonicalJson(expectation.seal.binding)) coldRefused();
  } catch { coldRefused(); }
  const gate=join(location(anchor),'recovery-lock');
  try { await mkdir(gate,{mode:0o700}); await syncDirectory(location(anchor)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='EEXIST') return blockedRecoveryGate(anchor,gate); throw error; }
  const gatePin=await lstat(gate), ownerPath=join(gate,'owner.json');
  const ownerBytes=Buffer.from(JSON.stringify({version:1,id:randomUUID(),anchor,coordinator:await coldProcessIdentity()}));
  let ownerPin:Awaited<ReturnType<typeof lstat>>|undefined, gateLost=false;
  const ownsGate=async () => {
    if (!ownerPin || gateLost) return false;
    try {
      await privateDirectory(gate);
      const currentGate=await lstat(gate), currentOwner=await lstat(ownerPath);
      if (currentGate.dev===gatePin.dev && currentGate.ino===gatePin.ino
        && currentOwner.dev===ownerPin.dev && currentOwner.ino===ownerPin.ino
        && (await readPrivate(ownerPath)).equals(ownerBytes)) return true;
    } catch { /* Lost or substituted owner evidence cannot authorize release. */ }
    gateLost=true;
    return false;
  };
  const requireGate=async () => { if (!await ownsGate()) coldRefused(); };
  try {
    await publish(gate,'owner.json',ownerBytes);
    ownerPin=await lstat(ownerPath);
    await requireGate();
    const state=await readState(anchor);
    const value=await attemptFromState(anchor,state).catch(() => undefined);
    const optional=async (name:string) => {
      try { return JSON.parse((await readPrivate(join(location(anchor),name))).toString('utf8')); } catch { return undefined; }
    };
    const saved=await optional('recovery.json');
    const context:ColdRecoveryContext={anchor,seal:(await authenticated(anchor)).seal,state,...value,inventory:await optional('inventory.json'),exit:await optional('worker-exit.json'),
      previous:value && saved?.attemptId===value.attempt.attemptId && saved?.leaseSha256===value.leaseSha256 ? saved.result : undefined,
      leaseIntact:async () => {
        try {
          await requireGate();
          await privateDirectory(join(location(anchor),'lock'));
          const current=await readState(anchor), pinned=await attemptFromState(anchor,current);
          return current.status==='IN_FLIGHT' && !!value && pinned.leaseSha256===value.leaseSha256;
        } catch { return false; }
      },
      block:async blocker => {
        const result:ColdRecoveryResult={status:'BLOCKED',blocker};
        await publish(location(anchor),`blocked-${randomUUID()}.json`,Buffer.from(JSON.stringify({result,pid:process.pid,attemptId:value?.attempt.attemptId})));
        return result;
      },
      finish:async result => {
        // Native removal/absence can complete while the coordinator's gate is
        // lost. Exact absence is not permission to publish READY or unlink a
        // replacement gate, even when copied owner bytes look identical.
        if (!value || !await context.leaseIntact()) coldRefused();
        result={...result,attemptId:value.attempt.attemptId};
        await publish(location(anchor),'recovery.json',Buffer.from(JSON.stringify({attemptId:value.attempt.attemptId,leaseSha256:value.leaseSha256,result})));
        await requireGate();
        await writeState(anchor,result.status==='DISPOSED_EMPTY' ? 'READY' : 'QUARANTINED',{...state.lastAttempt,recovery:result});
        if (result.status==='DISPOSED_EMPTY') { await requireGate(); await rmdir(join(location(anchor),'lock')); await syncDirectory(location(anchor)); }
        return result;
      }};
    return await action(context);
  } finally {
    // Only the still-owning live coordinator may release its own gate. No
    // stale-gate takeover, JSON reconstruction, PID absence or age fallback.
    if (await ownsGate()) {
      await unlink(ownerPath);
      await rmdir(gate); await syncDirectory(location(anchor));
    }
  }
}
