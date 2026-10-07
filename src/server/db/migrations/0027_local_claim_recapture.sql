-- Non-authoritative, additive capture-only evidence; never UPDATE an old claim.
-- 0026's mutation allowlist and all operational claim/ledger guards stay intact.
CREATE TABLE migration_full_claim_recaptures (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  target_table text NOT NULL CHECK (target_table = 'padlet_evidence_claims'),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 1024),
  entry_value jsonb NOT NULL CHECK (jsonb_typeof(entry_value) = 'object'),
  PRIMARY KEY (tenant_id,migration_job_id,generation_id,target_table,target_id),
  FOREIGN KEY (tenant_id,migration_job_id,generation_id,target_table,target_id)
    REFERENCES migration_full_targets(tenant_id,migration_job_id,generation_id,target_table,target_id),
  CHECK (entry_value ?& ARRAY['table','identity','kind','beforeDigest','afterDigest','before','after']),
  CHECK (entry_value->>'table' IS NOT NULL AND entry_value->>'table' = target_table),
  CHECK (entry_value->>'kind' IS NOT NULL AND entry_value->>'kind' = 'RECAPTURED'),
  CHECK (jsonb_typeof(entry_value->'identity') = 'string'),
  CHECK (jsonb_typeof(entry_value->'beforeDigest') = 'string' AND entry_value->>'beforeDigest' ~ '^[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(entry_value->'afterDigest') = 'string' AND entry_value->>'afterDigest' ~ '^[0-9a-f]{64}$'),
  CHECK (entry_value->>'beforeDigest' <> entry_value->>'afterDigest'),
  CHECK (jsonb_typeof(entry_value->'before') = 'object' AND jsonb_typeof(entry_value->'after') = 'object'),
  CHECK ((entry_value #> '{before,target}') IS NOT NULL AND jsonb_typeof(entry_value #> '{before,target}') = 'object'),
  CHECK ((entry_value #> '{after,target}') IS NOT NULL AND jsonb_typeof(entry_value #> '{after,target}') = 'object'),
  -- SQL does not certify capture provenance; the application re-reads full images.
  -- It independently refuses business-field changes disguised as recapture.
  CHECK ((entry_value #> '{before,target}') - 'provenances' = (entry_value #> '{after,target}') - 'provenances')
);
ALTER TABLE migration_full_claim_recaptures ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_full_claim_recaptures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_full_claim_recaptures
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE TRIGGER migration_full_claim_recaptures_immutable
  BEFORE UPDATE OR DELETE ON migration_full_claim_recaptures
  FOR EACH ROW EXECUTE FUNCTION prevent_local_full_generation_mutation();
CREATE TRIGGER migration_full_claim_recaptures_no_truncate
  BEFORE TRUNCATE ON migration_full_claim_recaptures
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_full_generation_mutation();
