import 'server-only';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { PoolClient } from 'pg';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, readMaterializedRecoveryState, restoreRetainedMaterializedDatabase,
  type MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import { acquireColdArchiveFromExport, bindColdTarget, coldAllocationRegistration, readColdArchiveForExport,
  readColdLease, settleColdArchive, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import { quarantineDispatchedColdExport } from '@/server/db/testing/coldSealedExportDisposition';
import { reconcileSealedProductTransitions, stageLocalSealedPreactivation } from '@/server/migration/localSealedPreactivation';
import { canonicalJson } from '@/server/migration/validators';
import { syntheticProductDeltaContract as c } from './syntheticProductDelta';
import { syntheticProductChainContract as chain, type ProductChainPin } from './syntheticProductChain';
import { installProductChainTerminal, replaySealedProductSegment, syntheticProductTerminalContract as terminal,
  verifyProductChainTerminal } from './syntheticProductTerminal';
import { admitCoordinatorPin, admitSeal, readTerminalRecord, requireSealEntry, sourceIntent,
  type ProductChainSeal, type TerminalCoordinatorPin } from './syntheticProductTerminalState';
const exact:typeof c.exact=c.exact;
const LIMIT=64_000_000, HASH=/^[0-9a-f]{64}$/;
const PROFILE={profile:'SYNTHETIC_SEALED_EXPORT_V1',authority:'NONAUTHORITY',activationAllowed:false,complete:false,
  coverage:'CONTROLLED_SYNTHETIC_PRODUCT_WRITER_ONLY',outsideWriterCoverage:'NOT_PROVEN'} as const;
export type SealedExportRef=Readonly<{sha256:string}>;
type PublicState=Awaited<ReturnType<typeof readMaterializedRecoveryState>>;
type Envelope=typeof PROFILE & {base:MaterializedArchiveExpectation;chain:ProductChainPin;coordinator:TerminalCoordinatorPin;
  archive:string;seal:ProductChainSeal;journal:{payload:string;sha256:string;requestDigest:string}[];postwrite:PublicState};
function refused():never {throw new Error('Sealed synthetic export refused.');}
function optIn() {if (process.env.RUN_REAL_POSTGRES!=='1') refused();}
function refCopy(ref:SealedExportRef) {
  optIn(); exact(ref,['sha256']);
  if (typeof ref.sha256!=='string' || ref.sha256.length!==64 || !HASH.test(ref.sha256)) refused();
  return Object.freeze({sha256:ref.sha256});
}
const root=() => resolve('.sealed-product-export');
async function directory(create=false) {
  optIn();
  if (create) await mkdir(root(),{mode:0o700}).catch(error => {if (error.code!=='EEXIST') throw error;});
  const s=await lstat(root());
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid?.() || (s.mode & 0o777)!==0o700) refused();
}
async function read(ref:SealedExportRef) {
  await directory();
  const f=await open(join(root(),`${ref.sha256}.json`),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=await f.stat();
    if (!s.isFile() || s.nlink!==1 || s.uid!==process.getuid?.() || (s.mode & 0o777)!==0o400 || s.size<1 || s.size>LIMIT) refused();
    const bytes=await f.readFile();
    if (bytes.length!==s.size || bytes.length>LIMIT || c.sha(bytes)!==ref.sha256) refused();
    return bytes;
  } finally {await f.close();}
}
/** Exclusive publication, never overwrite or repair an existing content address.
 * Permissions + pinned digest are same-UID synthetic TCB, NOT physical WORM. */
async function publish(bytes:Buffer):Promise<SealedExportRef> {
  if (!bytes.length || bytes.length>LIMIT) refused();
  await directory(true);
  const ref=refCopy({sha256:c.sha(bytes)}),path=join(root(),`${ref.sha256}.json`),temp=join(root(),`.part-${randomUUID()}`);
  const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await f.writeFile(bytes); await f.chmod(0o400); await f.sync();} finally {await f.close();}
  try {await link(temp,path);} catch (error) {if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
  finally {await unlink(temp);}
  const d=await open(root(),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {await d.sync();} finally {await d.close();}
  if (!(await read(ref)).equals(bytes)) refused();
  return ref;
}
function decode(bytes:Buffer,base:MaterializedArchiveExpectation,pin:ProductChainPin,control:TerminalCoordinatorPin):Envelope {
  chain.admit(base,pin); admitCoordinatorPin(control);
  const e=JSON.parse(bytes.toString('utf8')) as Envelope;
  exact(e,[...Object.keys(PROFILE),'base','chain','coordinator','archive','seal','journal','postwrite']);
  for (const key of Object.keys(PROFILE) as (keyof typeof PROFILE)[]) c.equal(e[key],PROFILE[key]);
  c.equal(e.base,base); c.equal(e.chain,pin); c.equal(e.coordinator,control); admitSeal(e.seal,base,pin);
  if (typeof e.archive!=='string' || e.archive.length>21_333_336) refused();
  const archive=Buffer.from(e.archive,'base64');
  if (!archive.length || archive.length>16_000_000 || archive.toString('base64')!==e.archive || c.sha(archive)!==base.digest) refused();
  if (!Array.isArray(e.journal) || e.journal.length!==e.seal.segments.length) refused();
  let from=0,previousDigest=c.sha(canonicalJson(pin));
  const entries=e.journal.map((r,i) => {
    exact(r,['payload','sha256','requestDigest']);
    if (!c.text(r.payload,c.LIMIT) || typeof r.requestDigest!=='string' || r.requestDigest.length!==64 || !HASH.test(r.requestDigest)) refused();
    const envelope=chain.decode(Buffer.from(r.payload),r.sha256,base,pin);
    c.equal({segment:envelope.segment,from:envelope.from,previousDigest:envelope.previousDigest},{segment:i+1,from,previousDigest});
    requireSealEntry(e.seal,{segment:envelope.segment,checkpoint:envelope.through,sha256:r.sha256});
    from=envelope.through; previousDigest=r.sha256;
    return {envelope};
  });
  if (reconcileSealedProductTransitions(base,entries)!==from) refused();
  const products=entries.at(-1)!.envelope.transaction.finalProducts;
  exact(e.postwrite,['tables','sequences','guards']);
  c.stateMatches(e.postwrite,base,products); c.equal(e.postwrite.tables,{...base.tables,products});
  if (canonicalJson(e)!==bytes.toString('utf8')) refused();
  return e;
}
async function retained(q:PoolClient,coordinator:DisposablePostgres,control:TerminalCoordinatorPin,system:string,
  base:MaterializedArchiveExpectation,pin:ProductChainPin) {
  if ([base.sourceId,base.originalSourceId].includes(coordinator.runId)) refused();
  await terminal.coordinatorLease(q,coordinator,control,system);
  const value=await readTerminalRecord(q,'local_product_terminal.seal') as {coordinator:TerminalCoordinatorPin;seal:ProductChainSeal}|null;
  if (!value) refused();
  exact(value,['coordinator','seal']); c.equal(value.coordinator,control); admitSeal(value.seal,base,pin);
  if (value.seal.intent.sourceSystem===system) refused();
  return value.seal;
}
async function admitted(ref:SealedExportRef,base:MaterializedArchiveExpectation,pin:ProductChainPin,coordinator:DisposablePostgres,control:TerminalCoordinatorPin) {
  const e=decode(await read(ref),base,pin,control);
  await terminal.owned(coordinator,async (q,system) => c.equal(e.seal,await retained(q,coordinator,control,system,base,pin)));
  return e;
}
/** Only the pre-admitted source archive and allowlisted committed outbox fields
 * enter transport. No handles, process evidence, URLs, filesystem locators,
 * credential/session rows, environment or coordinator lease are serialized. */
export async function exportSealedProductRecovery(source:DisposablePostgres,rawAnchor:ColdAnchor,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin):Promise<SealedExportRef> {
  try {
    optIn(); const anchor=structuredClone(rawAnchor),base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl);
    chain.admit(base,pin); admitCoordinatorPin(control);
    if (source.runId!==base.sourceId) refused();
    const backup=await readColdArchiveForExport(anchor,base.binding); c.equal(backup.seal,base);
    return await terminal.owned(coordinator,async (cq,system) => {
      const seal=await retained(cq,coordinator,control,system,base,pin);
      return terminal.owned(source,async (q,sourceSystem) => {
        // Owner COUNTs precede full-row reads, including all private/unrelated
        // public tables that the original archive admitted as empty.
        const names=(await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
        c.equal(names,Object.keys(base.tables).sort());
        for (const name of names) if (base.tables[name]==='[]' && name!=='products'
          && (await q.query(`SELECT count(*)::text AS n FROM public.${c.ident(name)}`)).rows[0].n!=='0') refused();
        const declared=await sourceIntent(q,base,pin,sourceSystem); c.equal(declared.seal,seal);
        const stored=await chain.journal(q,chain.SOURCE,base,pin,source,sourceSystem);
        const postwrite=await readMaterializedRecoveryState(q);
        const envelope:Envelope={...PROFILE,base,chain:pin,coordinator:control,archive:backup.bytes.toString('base64'),seal,
          journal:stored.entries.map(({receipt:r}) => ({payload:r.payload,sha256:r.artifact_digest,requestDigest:r.request_digest})),postwrite};
        const bytes=Buffer.from(canonicalJson(envelope));
        if (bytes.length>LIMIT) refused();
        decode(bytes,base,pin,control);
        return publish(bytes);
      });
    });
  } catch {refused();}
}
/** Execute the exported SQL through the ORIGINAL single-consumer cold lease.
 * Each baseline/segment COMMIT remains a separate monotonic boundary; failures
 * quarantine (never READY), and the owned synthetic target is torn down. This
 * returns a handle awaiting preparation, not a complete recovery/ACTIVE receipt.
 * Caller owns successful target cleanup; no orphan discovery/adoption exists. */
export async function restoreSealedProductExport(rawRef:SealedExportRef,rawAnchor:ColdAnchor,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin) {
  try {
    const ref=refCopy(rawRef),anchor=structuredClone(rawAnchor),base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl);
    const e=await admitted(ref,base,pin,coordinator,control);
    const lease=await acquireColdArchiveFromExport(anchor,base.binding,Buffer.from(e.archive,'base64'));
    let db:DisposablePostgres|undefined,settled=false;
    try {
      c.equal(readColdLease(lease).seal,base);
      const {ownerId,registration}=coldAllocationRegistration(lease);
      db=await createDisposablePostgres(registration);
      const target=await allocateRestoreTarget(db,ownerId,base.binding);
      await bindColdTarget(lease,db);
      const restoration=await restoreRetainedMaterializedDatabase(lease,target);
      await installProductChainTerminal(db,ownerId,base,pin,coordinator,control,{lease,exportSha256:ref.sha256});
      for (const segment of e.journal) await replaySealedProductSegment(db,ownerId,base,pin,Buffer.from(segment.payload),segment.sha256);
      await verifyProductChainTerminal(db,ownerId,base,pin);
      await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false,exportSha256:ref.sha256});
      settled=true;
      return {stage:'RESTORED_AWAITING_SEALED_PREPARATION' as const,database:db,ownerId,restoration,export:ref};
    } catch {
      try {if (!settled) await settleColdArchive(lease,'QUARANTINED',{pid:process.pid,targetId:db?.runId,containerId:db?.evidence.containerId,
        rollbackVerified:false,exportSha256:ref.sha256});}
      finally {if (db) console.info('SEALED_EXPORT_FAILED_TARGET_CLEANUP',JSON.stringify(await db.close()));}
      refused();
    }
  } catch {refused();}
}
/** Executable cold-death fallback, NOT resumability. Reopen the exact export and
 * independently retained terminal under its coordinator lock, then fence the
 * original DISPATCHED attempt as QUARANTINED using its certified worker death.
 * No destination handle is accepted: we cannot safely mint lost replay/lease
 * authority from caller SQL witnesses. Dirty/partial SQL is retained untouched;
 * even a correct prefix never yields recovery or preparation acceptance here.
 */
export async function quarantineSealedProductExport(rawRef:SealedExportRef,rawAnchor:ColdAnchor,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin) {
  try {
    const ref=refCopy(rawRef),anchor=structuredClone(rawAnchor),base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl);
    const e=decode(await read(ref),base,pin,control);
    return await terminal.owned(coordinator,async (q,system) => {
      c.equal(e.seal,await retained(q,coordinator,control,system,base,pin));
      const disposition=await quarantineDispatchedColdExport(anchor,base,ref.sha256);
      return {scope:'SEALED_EXPORT_CRASH_DISPOSITION_ONLY' as const,authority:'NONAUTHORITY' as const,
        accepted:false as const,activationAllowed:false as const,complete:false as const,disposition};
    });
  } catch {refused();}
}
/** Cold exact retry reopens bytes + independent coordinator and revalidates all
 * SQL/checkpoints/transitions. The export seal constraint is checked again under
 * the Task19 coordinator lock held through its first/only private receipt write. */
export async function prepareSealedProductExport(db:DisposablePostgres,ownerId:string,rawRef:SealedExportRef,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin) {
  try {
    const ref=refCopy(rawRef),base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl);
    const e=await admitted(ref,base,pin,coordinator,control);
    return await stageLocalSealedPreactivation(db,ownerId,base,pin,coordinator,control,c.sha(canonicalJson(e.seal)),ref.sha256);
  } catch {refused();}
}
