CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION jsonb_has_sensitive_top_level_key(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_object_keys(value) AS key
    WHERE key ~* '(^|_)(recovery|password|secret|token|plaintext|credential|raw)(_|$)'
  )
$$;

CREATE TABLE operations (
  tenant_id uuid NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  result_snapshot jsonb,
  failure_code text,
  attempt_count bigint NOT NULL DEFAULT 1,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_pkey PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT operations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT operations_id_check CHECK (operation_id=btrim(operation_id) AND length(operation_id)>0),
  CONSTRAINT operations_kind_check CHECK (operation_kind IN ('CHECKOUT','CANCELLATION','ADMIN_ADJUSTMENT','TASK_REWARD','MIGRATION_IMPORT','CUTOVER','EXPORT')),
  CONSTRAINT operations_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operations_status_check CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  CONSTRAINT operations_failure_code_check CHECK (failure_code IS NULL OR length(btrim(failure_code))>0),
  CONSTRAINT operations_attempt_count_check CHECK (attempt_count BETWEEN 1 AND 9007199254740991),
  CONSTRAINT operations_result_shape_check CHECK (result_snapshot IS NULL OR jsonb_typeof(result_snapshot)='object'),
  CONSTRAINT operations_terminal_shape_check CHECK (
    (status='PENDING' AND result_snapshot IS NULL AND failure_code IS NULL AND finished_at IS NULL) OR
    (status='SUCCEEDED' AND result_snapshot IS NOT NULL AND failure_code IS NULL AND finished_at IS NOT NULL) OR
    (status='FAILED' AND result_snapshot IS NULL AND failure_code IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT operations_chronology_check CHECK (updated_at>=COALESCE(finished_at,started_at,created_at) AND (started_at IS NULL OR started_at>=created_at) AND (finished_at IS NULL OR finished_at>=COALESCE(started_at,created_at)))
);

CREATE FUNCTION enforce_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.operation_id,NEW.operation_kind,NEW.payload_hash)
     IS DISTINCT FROM ROW(OLD.tenant_id,OLD.operation_id,OLD.operation_kind,OLD.payload_hash) THEN
    RAISE EXCEPTION 'operation binding is immutable';
  END IF;
  IF OLD.status<>'PENDING' AND ROW(NEW.status,NEW.result_snapshot,NEW.failure_code,NEW.finished_at)
     IS DISTINCT FROM ROW(OLD.status,OLD.result_snapshot,OLD.failure_code,OLD.finished_at) THEN
    RAISE EXCEPTION 'terminal operation is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operations_update_guard BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION enforce_operation_update();

CREATE TABLE padlet_claim_digest_registry (
  tuple_digest text PRIMARY KEY,
  claim_kind text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT padlet_claim_digest_registry_digest_check CHECK (tuple_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT padlet_claim_digest_registry_kind_check CHECK (claim_kind IN ('CLAIM','TOMBSTONE'))
);

CREATE TABLE padlet_evidence_claims (
  provider text NOT NULL,
  board_id text NOT NULL,
  post_id text NOT NULL,
  tuple_digest text NOT NULL,
  claimed_by_tenant_id uuid NOT NULL,
  claimed_by_operation_id text NOT NULL,
  evidence_created_at timestamptz NOT NULL,
  evidence_author_full_name text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT padlet_evidence_claims_pkey PRIMARY KEY (provider, board_id, post_id),
  CONSTRAINT padlet_evidence_claims_digest_unique UNIQUE (tuple_digest),
  CONSTRAINT padlet_evidence_claims_registry_fk FOREIGN KEY (tuple_digest) REFERENCES padlet_claim_digest_registry(tuple_digest),
  CONSTRAINT padlet_evidence_claims_operation_fk FOREIGN KEY (claimed_by_tenant_id, claimed_by_operation_id) REFERENCES operations(tenant_id, operation_id),
  CONSTRAINT padlet_evidence_claims_provider_check CHECK (provider='PADLET'),
  CONSTRAINT padlet_evidence_claims_board_check CHECK (board_id=btrim(board_id) AND length(board_id)>0),
  CONSTRAINT padlet_evidence_claims_post_check CHECK (post_id=btrim(post_id) AND length(post_id)>0),
  CONSTRAINT padlet_evidence_claims_digest_check CHECK (tuple_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT padlet_evidence_claims_author_check CHECK (evidence_author_full_name=btrim(evidence_author_full_name) AND length(evidence_author_full_name)>0),
  CONSTRAINT padlet_evidence_claims_chronology_check CHECK (claimed_at>=evidence_created_at)
);

CREATE TABLE padlet_claim_digest_tombstones (
  tuple_digest text PRIMARY KEY,
  owner_digest text,
  source_provenance text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT padlet_claim_digest_tombstones_registry_fk FOREIGN KEY (tuple_digest) REFERENCES padlet_claim_digest_registry(tuple_digest),
  CONSTRAINT padlet_claim_digest_tombstones_digest_check CHECK (tuple_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT padlet_claim_digest_tombstones_owner_check CHECK (owner_digest IS NULL OR owner_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT padlet_claim_digest_tombstones_source_check CHECK (length(btrim(source_provenance))>0)
);

CREATE FUNCTION register_padlet_claim_digest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_digest text;
BEGIN
  IF TG_TABLE_NAME='padlet_evidence_claims' THEN
    canonical_digest := encode(digest(convert_to(NEW.board_id,'UTF8') || decode('00','hex') || convert_to(NEW.post_id,'UTF8'), 'sha256'), 'hex');
    IF NEW.tuple_digest <> canonical_digest THEN
      RAISE EXCEPTION 'Padlet tuple digest mismatch';
    END IF;
    INSERT INTO padlet_claim_digest_registry(tuple_digest, claim_kind) VALUES (NEW.tuple_digest, 'CLAIM');
  ELSE
    INSERT INTO padlet_claim_digest_registry(tuple_digest, claim_kind) VALUES (NEW.tuple_digest, 'TOMBSTONE');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER padlet_evidence_claims_register BEFORE INSERT ON padlet_evidence_claims
  FOR EACH ROW EXECUTE FUNCTION register_padlet_claim_digest();
CREATE TRIGGER padlet_claim_digest_tombstones_register BEFORE INSERT ON padlet_claim_digest_tombstones
  FOR EACH ROW EXECUTE FUNCTION register_padlet_claim_digest();

CREATE FUNCTION reject_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END $$;
CREATE TRIGGER padlet_evidence_claims_immutable BEFORE UPDATE OR DELETE ON padlet_evidence_claims
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER padlet_claim_digest_tombstones_immutable BEFORE UPDATE OR DELETE ON padlet_claim_digest_tombstones
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER padlet_claim_digest_registry_immutable BEFORE UPDATE OR DELETE ON padlet_claim_digest_registry
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();

CREATE TABLE migration_jobs (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  status text NOT NULL DEFAULT 'DISCOVERED',
  state_version bigint NOT NULL DEFAULT 1,
  source_fingerprint text,
  final_fingerprint text,
  freeze_started_at timestamptz,
  freeze_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT migration_jobs_pkey PRIMARY KEY (tenant_id,job_id),
  CONSTRAINT migration_jobs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT migration_jobs_id_check CHECK (job_id=btrim(job_id) AND length(job_id)>0),
  CONSTRAINT migration_jobs_status_check CHECK (status IN ('DISCOVERED','VALIDATED','IMPORTING','RECONCILING','READY','FREEZING','FINAL_IMPORT','ACTIVE','FAILED','ABORTED')),
  CONSTRAINT migration_jobs_state_version_check CHECK (state_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT migration_jobs_hashes_check CHECK ((source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$') AND (final_fingerprint IS NULL OR final_fingerprint ~ '^[0-9a-f]{64}$')),
  CONSTRAINT migration_jobs_freeze_shape_check CHECK (freeze_verified_at IS NULL OR (freeze_started_at IS NOT NULL AND freeze_verified_at>=freeze_started_at)),
  CONSTRAINT migration_jobs_terminal_shape_check CHECK (
    (status='ACTIVE' AND final_fingerprint IS NOT NULL AND freeze_started_at IS NOT NULL AND freeze_verified_at IS NOT NULL AND completed_at IS NOT NULL) OR
    (status IN ('FAILED','ABORTED') AND completed_at IS NOT NULL) OR
    (status NOT IN ('ACTIVE','FAILED','ABORTED') AND completed_at IS NULL)),
  CONSTRAINT migration_jobs_chronology_check CHECK (updated_at>=COALESCE(completed_at,freeze_verified_at,freeze_started_at,created_at) AND (freeze_started_at IS NULL OR freeze_started_at>=created_at) AND (completed_at IS NULL OR completed_at>=COALESCE(freeze_verified_at,freeze_started_at,created_at)))
);

CREATE FUNCTION enforce_migration_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.state_version <> OLD.state_version + 1 THEN RAISE EXCEPTION 'migration state_version must increment'; END IF;
    IF NOT (
      (OLD.status='DISCOVERED' AND NEW.status IN ('VALIDATED','FAILED','ABORTED')) OR
      (OLD.status='VALIDATED' AND NEW.status IN ('IMPORTING','FAILED','ABORTED')) OR
      (OLD.status='IMPORTING' AND NEW.status IN ('RECONCILING','FAILED','ABORTED')) OR
      (OLD.status='RECONCILING' AND NEW.status IN ('READY','IMPORTING','FAILED','ABORTED')) OR
      (OLD.status='READY' AND NEW.status IN ('FREEZING','FAILED','ABORTED')) OR
      (OLD.status='FREEZING' AND NEW.status IN ('FINAL_IMPORT','FAILED','ABORTED')) OR
      (OLD.status='FINAL_IMPORT' AND NEW.status IN ('RECONCILING','ACTIVE','FAILED','ABORTED'))
    ) THEN RAISE EXCEPTION 'invalid migration state transition'; END IF;
  ELSIF NEW.state_version <> OLD.state_version THEN
    RAISE EXCEPTION 'state_version may change only with status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER migration_jobs_transition BEFORE UPDATE ON migration_jobs FOR EACH ROW EXECUTE FUNCTION enforce_migration_job_transition();

CREATE TABLE migration_sources (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  provider text NOT NULL,
  external_source_id text NOT NULL,
  ownership_subject_hash text,
  schema_version integer,
  source_fingerprint text NOT NULL,
  grant_expires_at timestamptz,
  grant_deleted_at timestamptz,
  bound_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_sources_pkey PRIMARY KEY (tenant_id,source_id),
  CONSTRAINT migration_sources_job_binding_unique UNIQUE (tenant_id,job_id,source_id),
  CONSTRAINT migration_sources_global_owner_unique UNIQUE (provider,external_source_id),
  CONSTRAINT migration_sources_job_fk FOREIGN KEY (tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id) ON DELETE CASCADE,
  CONSTRAINT migration_sources_ids_check CHECK (source_id=btrim(source_id) AND length(source_id)>0 AND external_source_id=btrim(external_source_id) AND length(external_source_id)>0),
  CONSTRAINT migration_sources_provider_check CHECK (provider IN ('GOOGLE_SHEETS','LEGACY_REDIS_BRIDGE')),
  CONSTRAINT migration_sources_hashes_check CHECK (source_fingerprint ~ '^[0-9a-f]{64}$' AND (ownership_subject_hash IS NULL OR ownership_subject_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT migration_sources_schema_version_check CHECK (schema_version IS NULL OR schema_version>=1),
  CONSTRAINT migration_sources_chronology_check CHECK ((grant_expires_at IS NULL OR grant_expires_at>=bound_at) AND (grant_deleted_at IS NULL OR grant_deleted_at>=bound_at))
);

CREATE TABLE migration_source_records (
  tenant_id uuid NOT NULL, job_id text NOT NULL, source_id text NOT NULL, record_id text NOT NULL,
  source_collection text NOT NULL, source_record_id text NOT NULL, source_row_number bigint,
  source_row_hash text NOT NULL, redacted_record jsonb NOT NULL, canonical_record jsonb,
  mapping_status text NOT NULL DEFAULT 'STAGED', target_table text, target_id text,
  warning_details jsonb NOT NULL DEFAULT '[]', error_details jsonb NOT NULL DEFAULT '[]',
  staged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_source_records_pkey PRIMARY KEY (tenant_id,record_id),
  CONSTRAINT migration_source_records_source_record_unique UNIQUE (tenant_id,source_id,source_collection,source_record_id),

  CONSTRAINT migration_source_records_source_fk FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id) ON DELETE CASCADE,
  CONSTRAINT migration_source_records_ids_check CHECK (record_id=btrim(record_id) AND length(record_id)>0 AND source_collection=btrim(source_collection) AND length(source_collection)>0 AND source_record_id=btrim(source_record_id) AND length(source_record_id)>0),
  CONSTRAINT migration_source_records_row_number_check CHECK (source_row_number IS NULL OR source_row_number BETWEEN 1 AND 9007199254740991),
  CONSTRAINT migration_source_records_hash_check CHECK (source_row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_source_records_json_check CHECK (jsonb_typeof(redacted_record)='object' AND (canonical_record IS NULL OR jsonb_typeof(canonical_record)='object') AND jsonb_typeof(warning_details)='array' AND jsonb_typeof(error_details)='array'),
  CONSTRAINT migration_source_records_sensitive_keys_check CHECK (NOT jsonb_has_sensitive_top_level_key(redacted_record)),
  CONSTRAINT migration_source_records_status_check CHECK (mapping_status IN ('STAGED','IMPORTED','QUARANTINED','SKIPPED')),
  CONSTRAINT migration_source_records_target_check CHECK ((mapping_status='IMPORTED' AND target_table IS NOT NULL AND length(btrim(target_table))>0 AND target_id IS NOT NULL AND length(btrim(target_id))>0) OR (mapping_status<>'IMPORTED' AND target_table IS NULL AND target_id IS NULL))
);

CREATE FUNCTION enforce_migration_source_record_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.job_id,NEW.source_id,NEW.record_id,NEW.source_collection,
         NEW.source_record_id,NEW.source_row_number,NEW.source_row_hash,NEW.redacted_record,NEW.staged_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id,OLD.job_id,OLD.source_id,OLD.record_id,OLD.source_collection,
         OLD.source_record_id,OLD.source_row_number,OLD.source_row_hash,OLD.redacted_record,OLD.staged_at) THEN
    RAISE EXCEPTION 'migration source evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER migration_source_records_evidence_guard BEFORE UPDATE ON migration_source_records
  FOR EACH ROW EXECUTE FUNCTION enforce_migration_source_record_evidence();

CREATE TABLE migration_snapshots (
  tenant_id uuid NOT NULL, job_id text NOT NULL, source_id text NOT NULL, snapshot_id text NOT NULL,
  phase text NOT NULL, artifact_digest text NOT NULL, redacted_manifest jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(), source_max_modified_at timestamptz, row_count bigint NOT NULL,
  CONSTRAINT migration_snapshots_pkey PRIMARY KEY (tenant_id,snapshot_id),
  CONSTRAINT migration_snapshots_idempotency_unique UNIQUE (tenant_id,source_id,phase,artifact_digest),
  CONSTRAINT migration_snapshots_source_fk FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id) ON DELETE CASCADE,
  CONSTRAINT migration_snapshots_id_check CHECK (snapshot_id=btrim(snapshot_id) AND length(snapshot_id)>0),
  CONSTRAINT migration_snapshots_phase_check CHECK (phase IN ('PREFLIGHT','FINAL_FROZEN','ROLLBACK_EXPORT')),
  CONSTRAINT migration_snapshots_digest_check CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_snapshots_manifest_check CHECK (jsonb_typeof(redacted_manifest)='object' AND NOT jsonb_has_sensitive_top_level_key(redacted_manifest)),
  CONSTRAINT migration_snapshots_count_check CHECK (row_count BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE reconciliation_results (
  tenant_id uuid NOT NULL, job_id text NOT NULL, result_id text NOT NULL, category text NOT NULL,
  expected_count bigint NOT NULL, actual_count bigint NOT NULL, delta bigint NOT NULL,
  status text NOT NULL, diagnostics jsonb NOT NULL DEFAULT '[]', checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_results_pkey PRIMARY KEY (tenant_id,result_id),
  CONSTRAINT reconciliation_results_job_category_unique UNIQUE (tenant_id,job_id,category),
  CONSTRAINT reconciliation_results_job_fk FOREIGN KEY (tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id) ON DELETE CASCADE,
  CONSTRAINT reconciliation_results_id_check CHECK (result_id=btrim(result_id) AND length(result_id)>0),
  CONSTRAINT reconciliation_results_category_check CHECK (category IN ('STUDENTS','BALANCES','PRODUCTS','STOCK','TRANSACTIONS','CANCELLATIONS','TASKS','ASSIGNMENTS','COMPLETIONS','PROMOTIONS','RECURRENCE','PADLET_CLAIMS','OPERATION_BINDINGS')),
  CONSTRAINT reconciliation_results_safe_check CHECK (expected_count BETWEEN 0 AND 9007199254740991 AND actual_count BETWEEN 0 AND 9007199254740991 AND delta BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT reconciliation_results_status_check CHECK (status IN ('MATCH','MISMATCH','BLOCKED')),
  CONSTRAINT reconciliation_results_arithmetic_check CHECK (delta=actual_count-expected_count AND (status<>'MATCH' OR (delta=0 AND expected_count=actual_count))),
  CONSTRAINT reconciliation_results_diagnostics_check CHECK (jsonb_typeof(diagnostics)='array')
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL, event_id text NOT NULL, operation_id text, job_id text, actor_user_id uuid,
  event_type text NOT NULL, entity_type text, entity_id text, redacted_details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_pkey PRIMARY KEY (tenant_id,event_id),
  CONSTRAINT audit_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT audit_events_operation_fk FOREIGN KEY (tenant_id,operation_id) REFERENCES operations(tenant_id,operation_id),
  CONSTRAINT audit_events_job_fk FOREIGN KEY (tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT audit_events_id_type_check CHECK (event_id=btrim(event_id) AND length(event_id)>0 AND length(btrim(event_type))>0),
  CONSTRAINT audit_events_entity_check CHECK ((entity_type IS NULL)=(entity_id IS NULL) AND (entity_type IS NULL OR (length(btrim(entity_type))>0 AND length(btrim(entity_id))>0))),
  CONSTRAINT audit_events_details_check CHECK (jsonb_typeof(redacted_details)='object' AND NOT jsonb_has_sensitive_top_level_key(redacted_details))
);
CREATE INDEX audit_events_tenant_chronology_idx ON audit_events(tenant_id,occurred_at DESC,event_id);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();

CREATE TABLE exports (
  tenant_id uuid NOT NULL, export_id text NOT NULL, job_id text, kind text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', artifact_digest text, artifact_path text,
  redacted_metadata jsonb NOT NULL DEFAULT '{}', expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT exports_pkey PRIMARY KEY (tenant_id,export_id),
  CONSTRAINT exports_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT exports_job_fk FOREIGN KEY (tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
  CONSTRAINT exports_id_check CHECK (export_id=btrim(export_id) AND length(export_id)>0),
  CONSTRAINT exports_kind_check CHECK (kind IN ('MIGRATION_REPORT','ROLLBACK_DELTA','CSV','XLSX','SHEETS_COMPATIBLE')),
  CONSTRAINT exports_status_check CHECK (status IN ('PENDING','READY','FAILED','EXPIRED')),
  CONSTRAINT exports_artifact_check CHECK ((artifact_digest IS NULL)=(artifact_path IS NULL) AND ((status='READY' AND artifact_digest ~ '^[0-9a-f]{64}$' AND length(btrim(artifact_path))>0) OR (status<>'READY' AND artifact_digest IS NULL))),
  CONSTRAINT exports_terminal_shape_check CHECK ((status='PENDING' AND completed_at IS NULL) OR (status IN ('READY','FAILED') AND completed_at IS NOT NULL) OR (status='EXPIRED' AND completed_at IS NOT NULL AND expires_at IS NOT NULL AND completed_at>=expires_at)),
  CONSTRAINT exports_metadata_check CHECK (jsonb_typeof(redacted_metadata)='object' AND NOT jsonb_has_sensitive_top_level_key(redacted_metadata)),
  CONSTRAINT exports_chronology_check CHECK ((completed_at IS NULL OR completed_at>=created_at) AND (expires_at IS NULL OR expires_at>=created_at))
);

ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_tenant_isolation ON operations USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_jobs_tenant_isolation ON migration_jobs USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_sources_tenant_isolation ON migration_sources USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_source_records FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_source_records_tenant_isolation ON migration_source_records USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE migration_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_snapshots_tenant_isolation ON migration_snapshots USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_results FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_results_tenant_isolation ON reconciliation_results USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
CREATE POLICY exports_tenant_isolation ON exports USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
