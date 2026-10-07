import 'server-only';
import type { PoolClient } from 'pg';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readMaterializedRecoveryState, type MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { pinColdExportExecution, requireColdExportReplay, requireColdExportTerminal, type ColdLease } from '@/server/db/testing/coldRestoreStore';
import { canonicalJson } from '@/server/migration/validators';
import { syntheticProductDeltaContract as c } from './syntheticProductDelta';
import { syntheticProductChainContract as chain, type ProductChainPin } from './syntheticProductChain';
import { admitCoordinatorPin, admitIntent, admitSeal, createTerminalSchema, destinationTerminal, insertTerminalRecord,
  readTerminalRecord, requireSealEntry, sourceIntent, terminalRefused as refused,
  type TerminalCoordinatorPin, type ProductChainIntent, type ProductChainSeal, type InstalledTerminal } from './syntheticProductTerminalState';
export type { TerminalCoordinatorPin } from './syntheticProductTerminalState';
const exact:typeof c.exact=c.exact;
type CoordinatorLease={profile:'SYNTHETIC_TERMINAL_COORDINATOR_V1';pin:TerminalCoordinatorPin;publicDigest:string};
type RetainedTerminal={coordinator:TerminalCoordinatorPin;seal:ProductChainSeal};
async function owned<T>(db:DisposablePostgres,action:(q:PoolClient,system:string) => Promise<T>,destination=false):Promise<T> {
  const physical=await inspectArchiveDatabase(db),q=await db.owner.connect();
  try {
    await q.query('BEGIN'); await c.lock(q,destination);
    const value=await action(q,physical.systemIdentifier);
    await q.query('COMMIT'); return value;
  } catch (error) {await q.query('ROLLBACK'); throw error;}
  finally {q.release();}
}
async function coordinatorLease(q:PoolClient,db:DisposablePostgres,pin:TerminalCoordinatorPin,system:string) {
  admitCoordinatorPin(pin);
  if (pin.databaseId!==db.runId || pin.systemIdentifier!==system) refused();
  const lease=await readTerminalRecord(q,'local_product_terminal.lease') as CoordinatorLease|null;
  if (!lease) refused();
  exact(lease,['profile','pin','publicDigest']);
  c.equal(lease,{profile:'SYNTHETIC_TERMINAL_COORDINATOR_V1',pin,publicDigest:c.sha(canonicalJson(await readMaterializedRecoveryState(q)))});
}
/** A distinct still-parent-owned synthetic PG, never a locator in an archive or
 * segment. Its immutable lease + exact Docker/PG identity authenticate the
 * coordinator channel. One chain per coordinator; no ambient endpoints/secrets. */
export async function initializeTerminalCoordinator(db:DisposablePostgres,ownerId:string):Promise<TerminalCoordinatorPin> {
  return owned(db,async (q,systemIdentifier) => {
    const pin={databaseId:db.runId,ownerId,systemIdentifier}; admitCoordinatorPin(pin);
    if (await readTerminalRecord(q,'local_product_terminal.lease')) await coordinatorLease(q,db,pin,systemIdentifier);
    else {
      const state=await readMaterializedRecoveryState(q);
      if (Object.values(state.tables).some(rows => rows!=='[]')) refused();
      await createTerminalSchema(q,'local_product_terminal');
      await insertTerminalRecord(q,'local_product_terminal.lease',
        {profile:'SYNTHETIC_TERMINAL_COORDINATOR_V1',pin,publicDigest:c.sha(canonicalJson(state))});
    }
    return pin;
  });
}
/** Before the first segment, durably declare the bounded transaction/event
 * cardinality. No mutable tip, upload metadata or reconstructed prefix is intent. */
export async function registerProductChainIntent(db:DisposablePostgres,rawBase:MaterializedArchiveExpectation,rawPin:ProductChainPin,rawCounts:number[]) {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),counts=structuredClone(rawCounts); chain.admit(base,pin);
  if (db.runId!==base.sourceId) refused();
  return owned(db,async (q,sourceSystem) => {
    const intent:ProductChainIntent={profile:'SYNTHETIC_PRODUCT_INTENT_V1',...pin,sourceSystem,counts}; admitIntent(intent,base,pin,sourceSystem);
    if ((await q.query("SELECT to_regnamespace('local_product_delta') AS name")).rows[0].name) refused();
    const stored=await chain.journal(q,chain.SOURCE,base,pin,db,sourceSystem),tip=stored.entries.at(-1);
    const actual=await readMaterializedRecoveryState(q),products=tip?.envelope.transaction.finalProducts ?? base.tables.products;
    c.stateMatches(actual,base,products); c.equal(actual.tables,{...base.tables,products});
    const prior=await sourceIntent(q,base,pin,sourceSystem);
    if (prior.intent) c.equal(prior.intent,intent);
    else {
      if (stored.exists || prior.seal) refused();
      await createTerminalSchema(q,'local_product_chain'); await insertTerminalRecord(q,'local_product_chain.intent',intent);
    }
    return intent;
  });
}
async function sealSource(source:DisposablePostgres,base:MaterializedArchiveExpectation,pin:ProductChainPin) {
  if (source.runId!==base.sourceId) refused();
  return owned(source,async (q,system) => {
    const declared=await sourceIntent(q,base,pin,system);
    if (!declared.intent) refused();
    const stored=await chain.journal(q,chain.SOURCE,base,pin,source,system),tip=stored.entries.at(-1);
    if (!tip || stored.entries.length!==declared.intent.counts.length) refused();
    const seal:ProductChainSeal={profile:'SYNTHETIC_PRODUCT_TERMINAL_V1',intent:declared.intent,
      segments:stored.entries.map(({envelope:e,receipt:r}) => ({segment:e.segment,checkpoint:e.through,sha256:r.artifact_digest}))};
    admitSeal(seal,base,pin);
    const actual=await readMaterializedRecoveryState(q),products=tip.envelope.transaction.finalProducts;
    c.stateMatches(actual,base,products); c.equal(actual.tables,{...base.tables,products});
    if (declared.seal) c.equal(declared.seal,seal);
    else await insertTerminalRecord(q,'local_product_chain.terminal',seal);
    return seal;
  });
}
/** Source commit then coordinator commit, deliberately not a distributed atomic
 * commit. Both are monotonic/immutable and retryable. Never delete the source
 * until this returns successfully AND coordinator SQL is independently read back. */
export async function retainProductChainTerminal(coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin,source:DisposablePostgres,
  rawBase:MaterializedArchiveExpectation,rawPin:ProductChainPin):Promise<ProductChainSeal> {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl); chain.admit(base,pin); admitCoordinatorPin(control);
  if ([base.sourceId,base.originalSourceId].includes(coordinator.runId)) refused();
  return owned(coordinator,async (q,system) => {
    await coordinatorLease(q,coordinator,control,system);
    const seal=await sealSource(source,base,pin);
    if (seal.intent.sourceSystem===system) refused();
    const retained:RetainedTerminal={coordinator:control,seal},prior=await readTerminalRecord(q,'local_product_terminal.seal');
    if (prior) c.equal(prior,retained);
    else await insertTerminalRecord(q,'local_product_terminal.seal',retained);
    return seal;
  });
}
async function destinationView(q:PoolClient,db:DisposablePostgres,ownerId:string,base:MaterializedArchiveExpectation,pin:ProductChainPin,system:string) {
  if ([base.sourceId,base.originalSourceId].includes(db.runId) || ownerId===base.sourceOwner) refused();
  await chain.admitDestination(q,db,ownerId,base,system);
  if ((await q.query("SELECT to_regclass('local_restore_control.product_delta_checkpoint') AS name")).rows[0].name) refused();
  const stored=await chain.journal(q,chain.DESTINATION,base,pin,db,system),tip=stored.entries.at(-1),actual=await readMaterializedRecoveryState(q);
  c.equal(actual.tables.migration_local_disposable_database,'[]'); c.equal(actual.tables.migration_local_materializations,'[]');
  c.stateMatches(actual,base,tip?.envelope.transaction.finalProducts ?? base.tables.products);
  return stored;
}
// Internal synthetic composition only. The migration preparation holds BOTH
// transactions through its private append; it must not trust a prior verifier
// receipt or open a new unchecked transaction after verification.
export const syntheticProductTerminalContract={owned,coordinatorLease,destinationView};
/** No raw seal argument exists. The caller separately retains the exact owned
 * coordinator handle + owner/PG identity; neither is resolved from transport.
 * Installation before any replay pins all segment hashes, not just a short tip. */
export async function installProductChainTerminal(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,rawPin:ProductChainPin,
  coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin,cold?:{lease:ColdLease;exportSha256:string}):Promise<InstalledTerminal> {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl); chain.admit(base,pin); admitCoordinatorPin(control);
  if ([base.sourceId,base.originalSourceId,db.runId].includes(coordinator.runId)) refused();
  const retained=await owned(coordinator,async (q,system) => {
    await coordinatorLease(q,coordinator,control,system);
    const value=await readTerminalRecord(q,'local_product_terminal.seal') as RetainedTerminal|null;
    if (!value) refused();
    exact(value,['coordinator','seal']); c.equal(value.coordinator,control); admitSeal(value.seal,base,pin);
    if (system===value.seal.intent.sourceSystem) refused();
    return value;
  });
  return owned(db,async (q,systemIdentifier) => {
    if (systemIdentifier===retained.seal.intent.sourceSystem || systemIdentifier===control.systemIdentifier) refused();
    const stored=await destinationView(q,db,ownerId,base,pin,systemIdentifier),destination={databaseId:db.runId,ownerId,systemIdentifier};
    admitCoordinatorPin(destination);
    const execution=cold ? await pinColdExportExecution(cold.lease,db,ownerId,base,systemIdentifier,cold.exportSha256) : undefined;
    const value:InstalledTerminal={...retained,destination,...(execution ? {execution} : {})},prior=await destinationTerminal(q,base,pin,destination);
    if (prior) {
      if (prior.execution) await requireColdExportReplay(db,prior.execution,base);
      c.equal(prior,value);
      for (const {envelope:e,receipt:r} of stored.entries) requireSealEntry(prior.seal,{segment:e.segment,checkpoint:e.through,sha256:r.artifact_digest});
    } else {
      if (stored.exists) refused();
      if (execution) await insertTerminalRecord(q,'local_restore_control.sealed_export_execution',execution);
      await insertTerminalRecord(q,'local_restore_control.product_chain_terminal',value);
    }
    return value;
  },true);
}
/** Read-only explicit completion, relative ONLY to the durable independent seal.
 * A valid prefix and caller-chosen tip cannot satisfy this gate. */
export async function verifyProductChainTerminal(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,rawPin:ProductChainPin) {
  const base=structuredClone(rawBase),pin=structuredClone(rawPin); chain.admit(base,pin);
  return owned(db,async (q,systemIdentifier) => {
    const stored=await destinationView(q,db,ownerId,base,pin,systemIdentifier),terminal=await destinationTerminal(q,base,pin,{databaseId:db.runId,ownerId,systemIdentifier});
    if (!terminal || stored.entries.length!==terminal.seal.segments.length) refused();
    if (terminal.execution) await requireColdExportTerminal(db,terminal.execution,base,ownerId,systemIdentifier);
    for (const {envelope:e,receipt:r} of stored.entries) requireSealEntry(terminal.seal,{segment:e.segment,checkpoint:e.through,sha256:r.artifact_digest});
    return {kind:'SEALED_TERMINAL_VERIFIED' as const,...terminal.seal.segments.at(-1)!,sealDigest:c.sha(canonicalJson(terminal.seal))};
  },true);
}
export async function replaySealedProductSegment(db:DisposablePostgres,ownerId:string,base:MaterializedArchiveExpectation,pin:ProductChainPin,bytes:Buffer,digest:string) {
  return chain.replayProductSegment(db,ownerId,base,pin,bytes,digest,true);
}
