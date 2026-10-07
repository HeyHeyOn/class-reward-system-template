-- Additive, non-authoritative full normalized generation storage. No runtime
-- grants, operational writes, ACTIVE receipt or existing Products-stage changes.
-- Apply only to an approved disposable database until separately reviewed.
CREATE TABLE migration_full_generations (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  candidate_generation_id text NOT NULL,
  original_generation_id text NOT NULL,
  plan_id text NOT NULL,
  expected_state_version bigint NOT NULL CHECK (expected_state_version > 0),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL DEFAULT 'LOCAL_CANDIDATE' CHECK (scope = 'LOCAL_CANDIDATE'),
  writer_exclusion_status text NOT NULL DEFAULT 'NOT_PROVEN' CHECK (writer_exclusion_status = 'NOT_PROVEN'),
  PRIMARY KEY (tenant_id, migration_job_id, generation_id),
  FOREIGN KEY (tenant_id, migration_job_id) REFERENCES migration_jobs(tenant_id, job_id),
  FOREIGN KEY (tenant_id, candidate_generation_id) REFERENCES audit_events(tenant_id, event_id),
  FOREIGN KEY (tenant_id, original_generation_id) REFERENCES audit_events(tenant_id, event_id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES audit_events(tenant_id, event_id)
);

-- source_value retains the typed SHEET or REDIS pointer and redacted canonical
-- payload. An ordinal deliberately permits fan-out records sharing one digest.
CREATE TABLE migration_full_sources (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal >= 0),
  source_value jsonb NOT NULL CHECK (jsonb_typeof(source_value) = 'object'),
  PRIMARY KEY (tenant_id, migration_job_id, generation_id, source_ordinal),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id)
    REFERENCES migration_full_generations(tenant_id, migration_job_id, generation_id),
  CHECK ((source_value #>> '{source,kind}') IS NOT NULL AND
    (source_value #>> '{source,kind}') IN ('SHEET', 'REDIS'))
);

CREATE TABLE migration_full_targets (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  target_table text NOT NULL CHECK (target_table IN (
    'students','accounts','products','transactions','transaction_items','adjustments',
    'tasks','task_allowed_students','task_assignments','task_completions','promotions',
    'promotion_products','settings','padlet_evidence_claims','padlet_claim_digest_tombstones','legacy_operation_bindings')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 1024),
  canonical_value jsonb NOT NULL CHECK (jsonb_typeof(canonical_value) = 'object'),
  PRIMARY KEY (tenant_id, migration_job_id, generation_id, target_table, target_id),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id)
    REFERENCES migration_full_generations(tenant_id, migration_job_id, generation_id)
);

CREATE TABLE migration_full_mappings (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  mapping_ordinal integer NOT NULL CHECK (mapping_ordinal >= 0),
  target_table text NOT NULL,
  target_id text NOT NULL,
  mapping_value jsonb NOT NULL CHECK (jsonb_typeof(mapping_value) = 'object'),
  PRIMARY KEY (tenant_id, migration_job_id, generation_id, mapping_ordinal),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id, target_table, target_id)
    REFERENCES migration_full_targets(tenant_id, migration_job_id, generation_id, target_table, target_id),
  CHECK (mapping_value->>'targetTable' IS NOT NULL AND mapping_value->>'targetTable' = target_table),
  CHECK (mapping_value->>'targetId' IS NOT NULL AND mapping_value->>'targetId' = target_id)
);

CREATE TABLE migration_full_contributors (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  mapping_ordinal integer NOT NULL,
  source_ordinal integer NOT NULL,
  PRIMARY KEY (tenant_id, migration_job_id, generation_id, mapping_ordinal, source_ordinal),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id, mapping_ordinal)
    REFERENCES migration_full_mappings(tenant_id, migration_job_id, generation_id, mapping_ordinal),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id, source_ordinal)
    REFERENCES migration_full_sources(tenant_id, migration_job_id, generation_id, source_ordinal)
);

CREATE TABLE migration_full_reconciliation (
  tenant_id uuid NOT NULL,
  migration_job_id text NOT NULL,
  generation_id text NOT NULL,
  category text NOT NULL,
  expected_count integer NOT NULL CHECK (expected_count >= 0),
  observed_count integer NOT NULL CHECK (observed_count = expected_count),
  expected_digest text NOT NULL CHECK (expected_digest ~ '^[0-9a-f]{64}$'),
  observed_digest text NOT NULL CHECK (observed_digest = expected_digest),
  status text NOT NULL DEFAULT 'MATCH' CHECK (status = 'MATCH'),
  PRIMARY KEY (tenant_id, migration_job_id, generation_id, category),
  FOREIGN KEY (tenant_id, migration_job_id, generation_id)
    REFERENCES migration_full_generations(tenant_id, migration_job_id, generation_id)
);

CREATE FUNCTION prevent_local_full_generation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Local full generation is immutable' USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['migration_full_generations','migration_full_sources',
    'migration_full_targets','migration_full_mappings','migration_full_contributors','migration_full_reconciliation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_local_full_generation_mutation()', table_name || '_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_full_generation_mutation()', table_name || '_no_truncate', table_name);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION prevent_local_full_generation_mutation() FROM PUBLIC;
