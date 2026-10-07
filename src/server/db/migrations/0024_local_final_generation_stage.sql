-- Non-authoritative, isolated LOCAL_CANDIDATE staging. These rows are not
-- migration_sources or operational targets, and never certify external exclusion.
-- A final generation is the phase-bound source/snapshot identity: its original
-- source and PREFLIGHT snapshot remain unchanged, while its candidate acquisition
-- digest is separate from the globally unique original external source owner.
-- The existing snapshot PK alone does not bind a snapshot to this job/source.
ALTER TABLE migration_snapshots ADD CONSTRAINT migration_snapshots_final_original_binding_unique
  UNIQUE (tenant_id,job_id,source_id,snapshot_id,phase);
CREATE TABLE migration_final_generations (
  tenant_id uuid NOT NULL, job_id text NOT NULL, generation_id text NOT NULL,
  original_source_id text NOT NULL, original_snapshot_id text NOT NULL,
  original_snapshot_phase text NOT NULL DEFAULT 'PREFLIGHT',
  candidate_event_id text NOT NULL, plan_event_id text NOT NULL,
  candidate_manifest_digest text NOT NULL, candidate_sheet_digest text NOT NULL,
  expected_state_version bigint NOT NULL, phase text NOT NULL DEFAULT 'LOCAL_CANDIDATE',
  exclusion text NOT NULL DEFAULT 'NOT_PROVEN', created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_final_generations_pkey PRIMARY KEY (tenant_id,generation_id),
  CONSTRAINT migration_final_generations_job_generation_unique UNIQUE (tenant_id,job_id,generation_id),
  CONSTRAINT migration_final_generations_job_fk FOREIGN KEY (tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
  CONSTRAINT migration_final_generations_source_fk FOREIGN KEY (tenant_id,job_id,original_source_id) REFERENCES migration_sources(tenant_id,job_id,source_id),
  CONSTRAINT migration_final_generations_snapshot_fk FOREIGN KEY
    (tenant_id,job_id,original_source_id,original_snapshot_id,original_snapshot_phase)
    REFERENCES migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase),
  CONSTRAINT migration_final_generations_candidate_fk FOREIGN KEY (tenant_id,candidate_event_id) REFERENCES audit_events(tenant_id,event_id),
  CONSTRAINT migration_final_generations_plan_fk FOREIGN KEY (tenant_id,plan_event_id) REFERENCES audit_events(tenant_id,event_id),
  CONSTRAINT migration_final_generations_binding_unique UNIQUE (tenant_id,job_id,original_source_id,candidate_manifest_digest),
  CONSTRAINT migration_final_generations_phase_check CHECK (phase='LOCAL_CANDIDATE' AND exclusion='NOT_PROVEN' AND original_snapshot_phase='PREFLIGHT'),
  CONSTRAINT migration_final_generations_digest_check CHECK (candidate_manifest_digest ~ '^[0-9a-f]{64}$' AND candidate_sheet_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_final_generations_version_check CHECK (expected_state_version BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE migration_final_source_records (
  tenant_id uuid NOT NULL, job_id text NOT NULL, generation_id text NOT NULL, record_id text NOT NULL,
  source_row_number bigint NOT NULL, source_row_hash text NOT NULL,
  source_collection text NOT NULL, source_record_id text NOT NULL,
  redacted_record jsonb NOT NULL, canonical_record jsonb NOT NULL,
  CONSTRAINT migration_final_source_records_pkey PRIMARY KEY (tenant_id,record_id),
  CONSTRAINT migration_final_source_records_job_generation_unique UNIQUE (tenant_id,job_id,generation_id,record_id),
  CONSTRAINT migration_final_source_records_generation_fk FOREIGN KEY (tenant_id,job_id,generation_id) REFERENCES migration_final_generations(tenant_id,job_id,generation_id),
  CONSTRAINT migration_final_source_records_identity_unique UNIQUE (tenant_id,generation_id,source_collection,source_record_id),
  CONSTRAINT migration_final_source_records_shape_check CHECK (source_collection='Products' AND source_row_number>0 AND source_row_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(redacted_record)='object' AND jsonb_typeof(canonical_record)='object' AND NOT jsonb_has_sensitive_top_level_key(redacted_record))
);
CREATE TABLE migration_final_targets (
  tenant_id uuid NOT NULL, job_id text NOT NULL, generation_id text NOT NULL, record_id text NOT NULL,
  target_table text NOT NULL, target_id text NOT NULL, canonical_target jsonb NOT NULL,
  CONSTRAINT migration_final_targets_pkey PRIMARY KEY (tenant_id,record_id),
  CONSTRAINT migration_final_targets_record_fk FOREIGN KEY (tenant_id,job_id,generation_id,record_id) REFERENCES migration_final_source_records(tenant_id,job_id,generation_id,record_id),
  CONSTRAINT migration_final_targets_identity_unique UNIQUE (tenant_id,job_id,generation_id,target_table,target_id),
  CONSTRAINT migration_final_targets_shape_check CHECK (target_table='products' AND length(target_id)>0 AND jsonb_typeof(canonical_target)='object')
);
-- No runtime grants: provisioning of this local-only staging path is separate.
CREATE TRIGGER migration_final_generations_immutable BEFORE UPDATE OR DELETE ON migration_final_generations FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_final_source_records_immutable BEFORE UPDATE OR DELETE ON migration_final_source_records FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_final_targets_immutable BEFORE UPDATE OR DELETE ON migration_final_targets FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_final_generations_no_truncate BEFORE TRUNCATE ON migration_final_generations FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_final_source_records_no_truncate BEFORE TRUNCATE ON migration_final_source_records FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_final_targets_no_truncate BEFORE TRUNCATE ON migration_final_targets FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_final_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_final_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_final_generations_tenant_isolation ON migration_final_generations USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_final_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_final_source_records FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_final_source_records_tenant_isolation ON migration_final_source_records USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_final_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_final_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_final_targets_tenant_isolation ON migration_final_targets USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Separate immutable, non-authoritative LOCAL_CANDIDATE evidence. Do not
-- substitute these rows for job-scoped reconciliation_results or activation proof.
ALTER TABLE migration_final_generations ADD CONSTRAINT migration_final_generations_evidence_binding_unique
  UNIQUE (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,phase,exclusion);
CREATE TABLE migration_local_generation_reconciliation (
  tenant_id uuid NOT NULL, job_id text NOT NULL, generation_id text NOT NULL,
  original_source_id text NOT NULL, original_snapshot_id text NOT NULL,
  candidate_manifest_digest text NOT NULL,
  phase text NOT NULL DEFAULT 'LOCAL_CANDIDATE', exclusion text NOT NULL DEFAULT 'NOT_PROVEN',
  category text NOT NULL, expected_count bigint NOT NULL, actual_count bigint NOT NULL,
  delta bigint NOT NULL, status text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_local_generation_reconciliation_pkey PRIMARY KEY (tenant_id,job_id,generation_id,category),
  CONSTRAINT migration_local_generation_reconciliation_generation_fk FOREIGN KEY
    (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,phase,exclusion)
    REFERENCES migration_final_generations
    (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,phase,exclusion),
  CONSTRAINT migration_local_generation_reconciliation_scope_check CHECK (phase='LOCAL_CANDIDATE' AND exclusion='NOT_PROVEN'),
  CONSTRAINT migration_local_generation_reconciliation_category_check CHECK
    (category IN ('STUDENTS','BALANCES','PRODUCTS','STOCK','TRANSACTIONS','CANCELLATIONS','TASKS','ASSIGNMENTS','COMPLETIONS','PROMOTIONS','RECURRENCE','PADLET_CLAIMS','OPERATION_BINDINGS')),
  CONSTRAINT migration_local_generation_reconciliation_counts_check CHECK
    (expected_count BETWEEN 0 AND 9007199254740991 AND actual_count BETWEEN 0 AND 9007199254740991 AND delta BETWEEN -9007199254740991 AND 9007199254740991
     AND delta=actual_count-expected_count AND (status<>'MATCH' OR delta=0)),
  CONSTRAINT migration_local_generation_reconciliation_status_check CHECK (status IN ('MATCH','MISMATCH','BLOCKED'))
);
CREATE TRIGGER migration_local_generation_reconciliation_immutable BEFORE UPDATE OR DELETE ON migration_local_generation_reconciliation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_local_generation_reconciliation_no_truncate BEFORE TRUNCATE ON migration_local_generation_reconciliation FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_local_generation_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_local_generation_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_local_generation_reconciliation_tenant_isolation ON migration_local_generation_reconciliation
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
