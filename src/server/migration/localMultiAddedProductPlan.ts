import 'server-only';
import type { LegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';

type Change = Readonly<{ table: string; identity: string; kind: 'ADDED' | 'REMOVED' | 'MUTATED'; beforeDigest: string | null; afterDigest: string | null }>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Pure, non-authoritative guard for a local multiple-product delta. Does not prove writer exclusion or permit activation. */
export function inspectLocalMultiAddedProducts(original: LegacyNormalizationManifest, candidate: LegacyNormalizationManifest,
  changes: readonly Change[]) {
  if (original.status !== 'READY_FOR_IMPORT' || candidate.status !== 'READY_FOR_IMPORT'
    || original.tenantId !== candidate.tenantId || original.migrationJobId !== candidate.migrationJobId
    || changes.length < 2 || changes.some((change) => change.table !== 'products' || change.kind !== 'ADDED'
      || change.beforeDigest !== null || typeof change.afterDigest !== 'string')) throw new Error('multi-product scope');
  const ids = changes.map((change) => {
    let parsed: unknown;
    try { parsed = JSON.parse(change.identity); } catch { throw new Error('identity'); }
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'string' || !parsed[0]) throw new Error('identity');
    return parsed[0];
  });
  if (new Set(ids).size !== ids.length) throw new Error('duplicate product');
  // Recompute product changes rather than trusting the caller's plan. A missing
  // change must not disappear merely because its source and target were omitted
  // from the retained-row comparison below.
  const index = (manifest: LegacyNormalizationManifest) => {
    const result = new Map<string, string>();
    for (const row of manifest.records.products ?? []) {
      if (typeof row.productId !== 'string' || !row.productId || result.has(row.productId)) throw new Error('product delta');
      result.set(row.productId, sha256(canonicalJson(row)));
    }
    return result;
  };
  const before = index(original); const after = index(candidate);
  const computed: Change[] = [...new Set([...before.keys(), ...after.keys()])].flatMap((id): Change[] => {
    const prior = before.get(id) ?? null; const next = after.get(id) ?? null;
    return prior === next ? [] : [{ table: 'products', identity: canonicalJson([id]),
      kind: prior === null ? 'ADDED' : next === null ? 'REMOVED' : 'MUTATED', beforeDigest: prior, afterDigest: next }];
  });
  const ordered = (items: readonly Change[]) => items.map((item) => canonicalJson(item)).sort();
  if (!same(ordered(computed), ordered(changes))) throw new Error('product delta');
  const added = new Set(ids);
  const products = changes.map((change, index) => {
    const productId = ids[index];
    if ((original.records.products ?? []).some((row) => row.productId === productId)) throw new Error('not added');
    const targets = (candidate.records.products ?? []).filter((row) => row.productId === productId);
    const sources = candidate.sourceRecords.filter((record) => record.source.kind === 'SHEET' && record.source.tab === 'Products'
      && record.mappingStatus === 'STAGED' && record.targetTable === 'products' && record.targetId === productId
      && record.canonicalRecord !== null && record.errorCodes.length === 0);
    if (targets.length !== 1 || sources.length !== 1 || sha256(canonicalJson(targets[0])) !== change.afterDigest) throw new Error('target');
    const source = sources[0];
    const pointer = source.source;
    const productMappings = candidate.mappings.filter((mapping) => mapping.targetTable === 'products'
      && mapping.targetId === productId);
    if (pointer.kind !== 'SHEET' || pointer.artifactDigest !== candidate.sourceArtifacts.sheets.digest
      || !same(targets[0], { tenantId: candidate.tenantId, ...source.canonicalRecord })
      || productMappings.length !== 1 || productMappings[0].sourceDigest !== pointer.rowHash
      || original.sourceRecords.some((record) => record.source.kind === 'SHEET'
        && record.source.tab === 'Products' && record.source.rowHash === pointer.rowHash)) throw new Error('source projection');
    return { productId, afterDigest: change.afterDigest, sourceRowHash: pointer.rowHash,
      sourceRowNumber: pointer.rowNumber };
  });
  // Distinct added targets must not claim the same source sheet row. This guard
  // remains local/non-authoritative and is not evidence of a fresh capture.
  if (new Set(products.map((product) => product.sourceRowHash)).size !== products.length
    || new Set(products.map((product) => product.sourceRowNumber)).size !== products.length) throw new Error('duplicate source row');
  const retainedRecords = (manifest: LegacyNormalizationManifest) => Object.fromEntries(Object.entries(manifest.records)
    .map(([table, rows]) => [table, rows.filter((row) => table !== 'products' || !added.has(String(row.productId)))
      .map((row) => canonicalJson(row)).sort()]));
  const retainedSources = (manifest: LegacyNormalizationManifest) => manifest.sourceRecords
    .filter((record) => !(record.source.kind === 'SHEET' && record.source.tab === 'Products' && added.has(record.targetId ?? '')))
    .map((record) => canonicalJson({ ...record, source: Object.fromEntries(Object.entries(record.source)
      .filter(([key]) => key !== 'artifactDigest')) })).sort();
  const retainedMappings = (manifest: LegacyNormalizationManifest) => manifest.mappings
    .filter((mapping) => !(mapping.targetTable === 'products' && added.has(mapping.targetId)))
    .map((mapping) => canonicalJson(mapping)).sort();
  if (!same(retainedRecords(original), retainedRecords(candidate)) || !same(retainedSources(original), retainedSources(candidate))
    || !same(retainedMappings(original), retainedMappings(candidate))
    || candidate.sourceRecords.length !== original.sourceRecords.length + ids.length
    || (candidate.records.products ?? []).length !== (original.records.products ?? []).length + ids.length) throw new Error('retained data');
  return { authority: 'NONAUTHORITY' as const, activationAllowed: false as const, complete: false as const,
    scope: 'MULTI_ADDED_PRODUCTS' as const, products: products.sort((a, b) => a.productId.localeCompare(b.productId)) };
}

/** Pure NONAUTHORITY payload selection, not persistence or capture authentication.
 * Returns existing source/target objects without modifying either manifest. */
export function buildLocalMultiAddedProductPayload(original: LegacyNormalizationManifest,
  candidate: LegacyNormalizationManifest, changes: readonly Change[]) {
  const inspected = inspectLocalMultiAddedProducts(original, candidate, changes);
  return { ...inspected, products: inspected.products.map((product) => {
    const source = candidate.sourceRecords.find((record) => record.source.kind === 'SHEET'
      && record.source.tab === 'Products' && record.mappingStatus === 'STAGED'
      && record.targetTable === 'products' && record.targetId === product.productId
      && record.source.rowHash === product.sourceRowHash && record.source.rowNumber === product.sourceRowNumber
      && record.canonicalRecord !== null && record.errorCodes.length === 0);
    const target = candidate.records.products.find((row) => row.productId === product.productId);
    if (!source || !target) throw new Error('payload');
    return { ...product, source, target };
  }) };
}
