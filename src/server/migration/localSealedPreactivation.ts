import 'server-only';
import { requireColdExportCompletion } from '@/server/db/testing/coldRestoreStore';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readMaterializedRecoveryState, type MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
import { syntheticProductDeltaContract as c } from '@/server/exports/syntheticProductDelta';
import { syntheticProductChainContract as chain, type ProductChainPin } from '@/server/exports/syntheticProductChain';
import { syntheticProductTerminalContract as terminal } from '@/server/exports/syntheticProductTerminal';
import { admitCoordinatorPin, admitSeal, destinationTerminal, insertTerminalRecord, readTerminalRecord, requireSealEntry,
  type TerminalCoordinatorPin, type ProductChainSeal } from '@/server/exports/syntheticProductTerminalState';
import { canonicalJson } from './validators';
import { deepFreeze } from './sensitiveRedaction';
const exact:typeof c.exact=c.exact;
const TABLE='local_restore_control.sealed_preactivation';
function refused():never {throw new Error('Local sealed preactivation preparation refused.');}
type Entries=Awaited<ReturnType<typeof chain.journal>>['entries'];
/** Recompute post-write effects, not just digests and terminal cardinality.
 * Only product rows admitted by the existing bounded safe-integer codec enter
 * JS. Full public SQL/sequence/guard wire strings remain PostgreSQL exact. */
export function reconcileSealedProductTransitions(base:MaterializedArchiveExpectation,entries:Pick<Entries[number],'envelope'>[]) {
  const rows=JSON.parse(base.tables.products);
  if (!Array.isArray(rows) || rows.length>1000) refused();
  const current=new Map<string,unknown>();
  for (const raw of rows) {
    const id=raw.product_id;
    if (!c.text(id) || id.trim()!==id || current.has(id)) refused();
    current.set(id,c.row(JSON.stringify(raw),base.binding.tenantId,id));
  }
  const sorted=(values:unknown[]) => values.map(v => canonicalJson(v)).sort();
  let events=0;
  for (const {envelope} of entries) {
    for (const event of envelope.transaction.events) {
      c.equal(current.get(event.id) ?? null,event.before===null ? null : JSON.parse(event.before));
      if (event.after===null) current.delete(event.id);
      else current.set(event.id,JSON.parse(event.after));
      events++;
    }
    c.equal(sorted([...current.values()]),sorted(JSON.parse(envelope.transaction.finalProducts)));
  }
  return events;
}
/** Task19 NONPRODUCTION sibling preparation, NOT the READY/original-capture
 * importer gate, which cannot safely consume an IMPORTING post-write restore.
 * All six arguments are mandatory trusted internal launcher capabilities; no
 * ambient DB, callback, uploaded seal or caller MATCH result can bypass checks.
 * Coordinator -> destination lock order, held through the private append. No
 * lifecycle/authority/pointer write, source fence or activation code exists.
 * Response loss after destination COMMIT requires cold retry, not rollback claims.
 */
export async function stageLocalSealedPreactivation(db:DisposablePostgres,ownerId:string,rawBase:MaterializedArchiveExpectation,
  rawPin:ProductChainPin,coordinator:DisposablePostgres,rawControl:TerminalCoordinatorPin,expectedExportSealDigest?:string,expectedExportSha256?:string) {
  try {
    const base=structuredClone(rawBase),pin=structuredClone(rawPin),control=structuredClone(rawControl);
    chain.admit(base,pin); admitCoordinatorPin(control);
    if ([base.sourceId,base.originalSourceId,db.runId].includes(coordinator.runId)) refused();
    return await terminal.owned(coordinator,async (cq,system) => {
      await terminal.coordinatorLease(cq,coordinator,control,system);
      const retained=await readTerminalRecord(cq,'local_product_terminal.seal') as {coordinator:TerminalCoordinatorPin;seal:ProductChainSeal}|null;
      if (!retained) refused();
      exact(retained,['coordinator','seal']); c.equal(retained.coordinator,control); admitSeal(retained.seal,base,pin);
      // Optional export composition can ONLY restrict this existing gate. Check
      // under the same coordinator lock held through destination preparation.
      if (expectedExportSealDigest!==undefined) c.equal(c.sha(canonicalJson(retained.seal)),expectedExportSealDigest);
      if (retained.seal.intent.sourceSystem===system) refused();
      return terminal.owned(db,async (q,destinationSystem) => {
        const destination={databaseId:db.runId,ownerId,systemIdentifier:destinationSystem};
        const stored=await terminal.destinationView(q,db,ownerId,base,pin,destinationSystem);
        const installed=await destinationTerminal(q,base,pin,destination);
        if (!installed) refused();
        if (expectedExportSha256!==undefined && !installed.execution) refused();
        if (installed.execution) await requireColdExportCompletion(db,installed.execution,base,ownerId,destinationSystem,expectedExportSha256);
        c.equal(installed,{...retained,destination,...(installed.execution ? {execution:installed.execution} : {})});
        if (stored.entries.length!==retained.seal.segments.length) refused();
        for (const {envelope:e,receipt:r} of stored.entries) requireSealEntry(retained.seal,
          {segment:e.segment,checkpoint:e.through,sha256:r.artifact_digest});
        const tip=stored.entries.at(-1);
        if (!tip) refused();
        const endpoint={segment:tip.envelope.segment,checkpoint:tip.envelope.through,sha256:tip.receipt.artifact_digest};
        c.equal(endpoint,retained.seal.segments.at(-1));
        const productEvents=reconcileSealedProductTransitions(base,stored.entries);
        if (productEvents!==endpoint.checkpoint) refused();
        const actual=await readMaterializedRecoveryState(q);
        const preparation=deepFreeze({scope:'LOCAL_SEALED_PREACTIVATION_PREPARATION_ONLY' as const,authority:'NONAUTHORITY' as const,
          activationAllowed:false as const,complete:false as const,coverage:'CONTROLLED_SYNTHETIC_PRODUCT_WRITER_ONLY' as const,
          outsideWriterCoverage:'NOT_PROVEN' as const,binding:base.binding,chain:pin,coordinator:control,destination,terminal:endpoint,
          sealDigest:c.sha(canonicalJson(retained.seal)),publicReadbackDigest:c.sha(canonicalJson(actual)),
          productEvents,finalProductsDigest:c.sha(tip.envelope.transaction.finalProducts)});
        const existing=await readTerminalRecord(q,TABLE);
        if (existing) c.equal(existing,preparation);
        // This is the FIRST mutation; every preceding rejection is read-only.
        // The schema/immutable function already belong to the admitted restore.
        else await insertTerminalRecord(q,TABLE,preparation);
        return deepFreeze({kind:existing ? 'ALREADY_PREPARED' as const : 'PREPARED' as const,preparation});
      },true);
    });
  } catch {refused();}
}
