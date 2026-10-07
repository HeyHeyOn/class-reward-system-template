import type { MutableChildRequest } from './task19MutableFixture';
import type { MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';

/** Test-only process protocol. Recovery never accepts captures, manifests, rows,
 * a source URL or an original-source connection. Pins are held by the allocator. */
export type ArchiveDisposalRequest = { phase: 'produce' } | (MutableChildRequest & {
  phase: 'rebuild' | 'retry'; pin: MutableRetentionPin;
});
export const ARCHIVE_DISPOSAL_RESULTS = '.task19-archive-disposal-results';
export const PRODUCT_REPORTS = ['students','accounts','products','settings','tasks','task_allowed_students',
  'promotions','promotion_products','transactions','transaction_items','adjustments','task_assignments',
  'task_completions','legacy_operation_bindings','padlet_evidence_claims','padlet_claim_digest_tombstones',
  'SOURCE_RECORDS','MAPPINGS','CONTRIBUTORS','DELTA_ENTRIES'];
