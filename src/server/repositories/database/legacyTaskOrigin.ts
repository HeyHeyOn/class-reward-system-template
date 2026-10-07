/** Only persisted PostgreSQL rows may call this. The foreign key and ALWAYS
 * insert trigger bind this marker to an immutable source projection while the
 * tenant is private. It never supplies modern operation/actor authority. */
export function hasLegacyTaskOrigin(row: Record<string, unknown>): boolean {
  if (row.legacy_origin_id === undefined || row.legacy_origin_id === null) return false;
  if (typeof row.legacy_origin_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.legacy_origin_id)
    || ['operation_id', 'operation_hash', 'admin_operation_id', 'admin_operation_hash',
      'evidence_provider', 'evidence_board_id', 'evidence_post_id', 'evidence_created_at', 'evidence_author_full_name']
      .some(key => row[key] !== undefined && row[key] !== null)) {
    throw new Error('Historical task provenance cannot carry modern authority.');
  }
  return true;
}
