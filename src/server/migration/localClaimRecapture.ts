import 'server-only';
import { types } from 'node:util';
import type { FinalGenerationPreparationInput, stageLegacyFinalGeneration } from './finalGeneration';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { projectLegacyStagingGraph } from './importer';
import { verifyLocalCapturedSourceCoverage } from './localCapturedSourceCoverage';
import { verifyLocalFullCategoryDeltaCoverage, verifyLocalMutableCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import { assertNormalizationInput, canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Generation = Readonly<{ acquisition: FinalGenerationPreparationInput['original']; manifest: LegacyNormalizationManifest }>;
type Plan = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>['plan'];
const CLAIMS = 'padlet_evidence_claims';
const EMPTY: Plan = { status: 'DIFF_VALIDATED', changes: [], blockers: [] };

/** Separate capture-bound contract, NOT a relaxation of either records-only gate.
 * Rebuild both manifests from independently admitted captures, validate the actual
 * importer graph, then account for every non-claim delta and every ADDED claim
 * through the unchanged gates. Retained claims must remain byte-exact, except a
 * single REDIS v2 contributor's whole-capture artifactDigest. The business row,
 * source payload/identity, mapping and contributor multiplicity remain exact.
 * SHEET/union recapture is deliberately unsupported (BANK authority is not ready).
 * Comparison projections never replace stored captures, manifests or row digests.
 * All bounds are inherited local bounds; this is not an ingress or authority gate.
 */
export function verifyLocalCaptureBoundDeltaCoverage(original: Generation, candidate: Generation, plan: Plan) {
  try {
    // Admit descriptors before any caller-controlled property reads. The pointer
    // checker additionally enforces its narrower local capture/manifest bounds.
    for (const generation of [original, candidate]) {
      admit(generation);
      if (Object.keys(generation).sort().join(',') !== 'acquisition,manifest'
        || Object.keys(generation.acquisition).sort().join(',') !== 'redis,sheets') refused();
      const { manifest, acquisition } = generation;
      const report = verifyLocalCapturedSourceCoverage({ capture: {
        tenantId: manifest.tenantId, migrationJobId: manifest.migrationJobId, ...acquisition }, manifest });
      if (report.status !== 'CAPTURE_POINTERS_ACCOUNTED' || report.normalizationStatus !== 'READY_FOR_IMPORT') refused();
      const rebuilt = createLegacyNormalizationManifest({ tenantId: manifest.tenantId,
        migrationJobId: manifest.migrationJobId, ...acquisition });
      if (canonicalJson(rebuilt) !== canonicalJson(manifest)) refused();
      // Retain the original records-only aggregate bounds, even when partitioning
      // claims below. Neither the input records nor any digest is rewritten.
      verifyLocalMutableCategoryDeltaCoverage(manifest.records, manifest.records, EMPTY);
    }
    const before = original.manifest, after = candidate.manifest;
    if (before.tenantId !== after.tenantId || before.migrationJobId !== after.migrationJobId
      || original.acquisition.sheets.spreadsheetId !== candidate.acquisition.sheets.spreadsheetId
      || canonicalJson(before.sourceArtifacts.sheets.credentialHashes) !== canonicalJson(after.sourceArtifacts.sheets.credentialHashes)) refused();
    const beforeGraph = projectLegacyStagingGraph(before), afterGraph = projectLegacyStagingGraph(after);
    admit(plan);
    if (Object.keys(plan).sort().join(',') !== 'blockers,changes,status' || !Array.isArray(plan.changes)
      || plan.changes.length > 4_000) refused();
    // Disjoint accounting, not a provenance-stripped manifest fed to a legacy gate.
    const withoutClaims = (manifest: LegacyNormalizationManifest) => Object.fromEntries(
      Object.entries(manifest.records).filter(([table]) => table !== CLAIMS));
    verifyLocalMutableCategoryDeltaCoverage(withoutClaims(before), withoutClaims(after),
      { ...plan, changes: plan.changes.filter(change => change.table !== CLAIMS) });
    const prior = new Map((before.records[CLAIMS] ?? []).map(row => [row.tupleDigest, row]));
    const next = new Map((after.records[CLAIMS] ?? []).map(row => [row.tupleDigest, row]));
    const recaptures: Array<{ table: string; identity: string; kind: 'RECAPTURED'; beforeDigest: string; afterDigest: string }> = [];
    for (const [identity, row] of prior) {
      const retained = next.get(identity);
      if (!retained) refused();
      const a = canonicalJson(row), b = canonicalJson(retained);
      // Validate typed retained contributor bytes even for an unchanged target.
      const compare = (manifest: LegacyNormalizationManifest, graph: typeof beforeGraph, value: typeof row) => {
        const target = graph.targets.find(t => t.table === CLAIMS && t.value.tupleDigest === identity);
        if (!target) refused();
        const mappings = manifest.mappings.flatMap((m, i) => m.targetTable === CLAIMS && m.targetId === target.id ? [{ m, i }] : []);
        const edges = graph.contributors.filter(edge => mappings.some(m => m.i === edge.mappingOrdinal));
        const sources = edges.map(edge => manifest.sourceRecords[edge.sourceOrdinal]);
        const { provenances, ...business } = value;
        if (mappings.length !== 1 || edges.length !== 1 || sources.length !== 1
          || !Array.isArray(provenances) || provenances.length !== 1) refused();
        const source = sources[0];
        if (source.source.kind !== 'REDIS' || source.source.provenance !== 'upstash:padlet:evidence-bindings:v2'
          || source.source.artifactDigest !== manifest.sourceArtifacts.redis?.digest
          || canonicalJson(provenances[0]) !== canonicalJson(source.source)
          || canonicalJson(source.canonicalRecord) !== canonicalJson(value)
          || source.targetTable !== CLAIMS || source.targetId !== target.id || source.mappingStatus !== 'STAGED'
          || source.errorCodes.length || mappings[0].m.sourceDigest !== source.source.sourceDigest) refused();
        const { artifactDigest, ...pointer } = source.source;
        if (!artifactDigest) refused();
        return canonicalJson({ business, mapping: mappings[0].m,
          source: { ...source, source: pointer, canonicalRecord: business } });
      };
      if (compare(before, beforeGraph, row) !== compare(after, afterGraph, retained)) refused();
      if (a !== b) recaptures.push({ table: CLAIMS, identity: canonicalJson([identity]), kind: 'RECAPTURED',
        beforeDigest: sha256(a), afterDigest: sha256(b) });
    }
    const added = (after.records[CLAIMS] ?? []).filter(row => !prior.has(row.tupleDigest));
    verifyLocalFullCategoryDeltaCoverage({ [CLAIMS]: [] }, { [CLAIMS]: added },
      { ...plan, changes: plan.changes.filter(change => change.table === CLAIMS) });
    return deepFreeze({ scope: 'LOCAL_CAPTURE_BOUND_REDIS_CLAIM_RECAPTURE_ONLY' as const,
      authority: 'NONAUTHORITY' as const, exclusion: 'NOT_PROVEN' as const, complete: false as const,
      activationAllowed: false as const, recaptures });
  } catch { refused(); }
}
// The legacy unbudgeted validator checks descriptors but does not reject every
// Proxy before inspecting its prototype. Reject executable wrappers first; never
// let a trap run while building the capture checker's own bounded input shell.
function admit(value: unknown): void {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 100_000 || item.depth > 24) refused();
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (types.isProxy(item.value)) refused();
    const keys = Reflect.ownKeys(item.value);
    if (keys.length > (Array.isArray(item.value) ? 4_097 : 256)) refused();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key)!;
      if (!('value' in descriptor)) refused();
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  assertNormalizationInput(value);
}
function refused(): never { throw new Error('Local capture-bound claim recapture refused.'); }
