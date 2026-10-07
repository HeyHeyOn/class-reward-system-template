-- Non-authoritative delta evidence for immutable 0025 candidate generations.
-- A REMOVED entry is a staged tombstone, not an operational DELETE. Both images
-- retain target bytes and the exact typed source/mapping/contributor graph.
-- No operational grants, ACTIVE receipt or existing immutable-table changes.
CREATE TABLE migration_full_delta_entries (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  target_table text NOT NULL CHECK (target_table IN (
    'students','accounts','products','transactions','transaction_items','adjustments',
    'tasks','task_allowed_students','task_assignments','task_completions','promotions',
    'promotion_products','settings','padlet_evidence_claims','padlet_claim_digest_tombstones','legacy_operation_bindings')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 1024),
  change_kind text NOT NULL CHECK (change_kind IN ('ADDED','MUTATED','REMOVED')),
  entry_value jsonb NOT NULL CHECK (jsonb_typeof(entry_value) = 'object'),
  PRIMARY KEY (tenant_id,migration_job_id,generation_id,target_table,target_id),
  FOREIGN KEY (tenant_id,migration_job_id,generation_id)
    REFERENCES migration_full_generations(tenant_id,migration_job_id,generation_id),
  CHECK (change_kind = 'ADDED' OR target_table IN (
    'students','accounts','products','settings','tasks','task_allowed_students','promotions','promotion_products')),
  CHECK (entry_value ?& ARRAY['table','identity','kind','beforeDigest','afterDigest','before','after']),
  CHECK ((entry_value->>'table') IS NOT NULL AND entry_value->>'table' = target_table),
  CHECK ((entry_value->>'kind') IS NOT NULL AND entry_value->>'kind' = change_kind),
  CHECK (jsonb_typeof(entry_value->'identity') = 'string'),
  CHECK (CASE WHEN change_kind = 'ADDED'
    THEN entry_value->'before' = 'null'::jsonb AND entry_value->'beforeDigest' = 'null'::jsonb
    ELSE jsonb_typeof(entry_value->'before') = 'object'
      AND jsonb_typeof(entry_value->'beforeDigest') = 'string'
      AND entry_value->>'beforeDigest' ~ '^[0-9a-f]{64}$' END),
  CHECK (CASE WHEN change_kind = 'REMOVED'
    THEN entry_value->'after' = 'null'::jsonb AND entry_value->'afterDigest' = 'null'::jsonb
    ELSE jsonb_typeof(entry_value->'after') = 'object'
      AND jsonb_typeof(entry_value->'afterDigest') = 'string'
      AND entry_value->>'afterDigest' ~ '^[0-9a-f]{64}$' END)
);
ALTER TABLE migration_full_delta_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_full_delta_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_full_delta_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE TRIGGER migration_full_delta_entries_immutable
  BEFORE UPDATE OR DELETE ON migration_full_delta_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_local_full_generation_mutation();
CREATE TRIGGER migration_full_delta_entries_no_truncate
  BEFORE TRUNCATE ON migration_full_delta_entries
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_full_generation_mutation();
