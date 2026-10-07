import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';

// Test-only independent encoder/oracle. No production projector, delta builder,
// reconciliation helper, digest implementation or reported MATCH is trusted.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const rowsDigest = (rows: unknown[]) => hash(rows.map(canonical).sort());
export async function sqlImage(db: DisposablePostgres) {
  const image: Record<string,string[]> = {};
  for (const {tablename} of (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected fixture table');
    image[tablename] = (await db.owner.query(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`))
      .rows.map(row => row.value);
  }
  return image;
}
export type Image = Awaited<ReturnType<typeof sqlImage>>;
export const rows = (image: Image, table: string): Record<string,unknown>[] => image[table].map(value => JSON.parse(value));
const NORMALIZED = ['students','accounts','products','settings','tasks','task_allowed_students','promotions','promotion_products',
  'transactions','transaction_items','adjustments','task_assignments','task_completions','legacy_operation_bindings',
  'padlet_evidence_claims','padlet_claim_digest_tombstones'];
function productGraph(manifest: LegacyNormalizationManifest, id: string) {
  const target = manifest.records.products.find(row => row.productId === id);
  if (!target) return null;
  const sources = manifest.sourceRecords.flatMap((sourceValue,sourceOrdinal) => sourceValue.targetTable === 'products'
    && sourceValue.targetId === id ? [{sourceOrdinal,sourceValue}] : []);
  const mappings = manifest.mappings.flatMap((mappingValue,mappingOrdinal) => mappingValue.targetTable === 'products'
    && mappingValue.targetId === id ? [{mappingOrdinal,mappingValue}] : []);
  expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
  expect(sources[0].sourceValue.source).toMatchObject({kind:'SHEET',tab:'Products',artifactDigest:manifest.sourceArtifacts.sheets.digest});
  return {target,sources,mappings,contributors:[{mappingOrdinal:mappings[0].mappingOrdinal,sourceOrdinal:sources[0].sourceOrdinal}]};
}
export function verifySource(image: Image, original: LegacyNormalizationManifest, candidate: LegacyNormalizationManifest) {
  const delta = rows(image,'migration_full_delta_entries').sort((a,b) => String(a.target_id).localeCompare(String(b.target_id)));
  expect(delta).toHaveLength(2);
  for (const [index,id,kind] of [[0,'P1','MUTATED'],[1,'PX','REMOVED']] as const) {
    const before = productGraph(original,id), after = productGraph(candidate,id);
    expect(delta[index]).toMatchObject({tenant_id:candidate.tenantId,migration_job_id:candidate.migrationJobId,
      target_table:'products',target_id:id,change_kind:kind,entry_value:{table:'products',identity:canonical([id]),kind,
        beforeDigest:before ? hash(before.target) : null,afterDigest:after ? hash(after.target) : null,before,after}});
  }
  const targets = rows(image,'migration_full_targets').filter(row => row.target_table === 'products');
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({target_id:'P1',canonical_value:{productId:'P1',name:'Publication pencil',price:31,stock:8}});
  const productDelta = delta[0].entry_value as {before:{target:unknown};after:{target:unknown}};
  expect(productDelta.before.target).toMatchObject({productId:'P1',name:'Pencil',price:20,stock:5});
  expect(productDelta.after.target).toMatchObject({productId:'P1',name:'Publication pencil',price:31,stock:8});
  expect((delta[1].entry_value as {after:unknown}).after).toBeNull();
  const stripBinding = (table: string) => rows(image,table).map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['tenant_id','migration_job_id','generation_id'].includes(key))));
  const categories: Record<string,unknown[]> = {
    SOURCE_RECORDS:stripBinding('migration_full_sources'), MAPPINGS:stripBinding('migration_full_mappings'),
    CONTRIBUTORS:stripBinding('migration_full_contributors'), DELTA_ENTRIES:stripBinding('migration_full_delta_entries'),
  };
  for (const table of NORMALIZED) categories[table] = stripBinding('migration_full_targets').filter(row => row.target_table === table);
  const reports = rows(image,'migration_full_reconciliation');
  expect(reports.map(row => row.category).sort()).toEqual(Object.keys(categories).sort());
  for (const report of reports) {
    const actual = categories[String(report.category)];
    expect(report).toMatchObject({expected_count:actual.length,observed_count:actual.length,
      expected_digest:rowsDigest(actual),observed_digest:rowsDigest(actual),status:'MATCH'});
  }
  return {delta,reports,categoryCount:reports.length,sourceGraphDigest:hash(image)};
}
export function verifyDestination(image: Image, binding: Record<string,string>, sourceId: string, destinationId: string, ownerId: string) {
  const products = rows(image,'products');
  expect(products).toHaveLength(1);
  expect(products[0]).toMatchObject({tenant_id:binding.tenantId,product_id:'P1',name:'Publication pencil',price:31,stock:8});
  expect(rows(image,'migration_jobs')).toMatchObject([{tenant_id:binding.tenantId,job_id:binding.migrationJobId,
    status:'IMPORTING',state_version:2,source_fingerprint:binding.sourceFingerprint,final_fingerprint:null,
    freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  expect(rows(image,'tenants')).toMatchObject([{id:binding.tenantId,lifecycle:'IMPORTING'}]);
  const receipts = rows(image,'migration_local_materializations'); expect(receipts).toHaveLength(1);
  const receipt = receipts[0];
  expect(receipt).toMatchObject({tenant_id:binding.tenantId,job_id:binding.migrationJobId,generation_id:binding.generationId,
    expected_state_version:Number(binding.expectedStateVersion),source_fingerprint:binding.sourceFingerprint,
    manifest_digest:binding.manifestDigest,source_database_id:sourceId,destination_database_id:destinationId,owner_id:ownerId,
    scope:'LOCAL_DISPOSABLE_DOMAIN',authority:'NONAUTHORITY',activation_allowed:false});
  for (const [table,value] of Object.entries(receipt.domain_readback as Record<string,{count:number;digest:string}>)) {
    expect(value,table).toEqual({count:image[table].length,digest:rowsDigest(rows(image,table))});
  }
  // This destination-only archive intentionally retains candidate domain and
  // binding, NOT a copied original source graph/report. Do not claim otherwise.
  for (const table of Object.keys(image).filter(name => name.startsWith('migration_full_'))) expect(image[table]).toEqual([]);
  return {products,receipt};
}
