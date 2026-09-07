-- Storage consistency ONLY. No row in these tables is authenticated authority.
-- No runtime grants or forward-cutover consumer are provisioned by this migration.
-- Trusted action-specific approval/OAuth intake is a separate, currently unsupported gate.
CREATE TABLE migration_authority_receipts (
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  provider text NOT NULL,
  external_source_id text NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_subject text NOT NULL,
  action text NOT NULL,
  expected_status text NOT NULL,
  expected_state_version bigint NOT NULL,
  source_fingerprint text NOT NULL,
  issued_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  issuer_digest text NOT NULL,
  content_digest text NOT NULL,
  final_sheet_digest text,
  final_redis_digest text,
  final_report_digest text,
  CONSTRAINT migration_authority_receipts_pkey PRIMARY KEY (tenant_id,receipt_id),
  CONSTRAINT migration_authority_receipts_source_fk FOREIGN KEY (tenant_id,job_id,source_id)
    REFERENCES migration_sources(tenant_id,job_id,source_id),
  CONSTRAINT migration_authority_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT migration_authority_receipts_ids_check CHECK (
    length(job_id) BETWEEN 1 AND 1024 AND job_id=btrim(job_id)
    AND length(source_id) BETWEEN 1 AND 1024 AND source_id=btrim(source_id)
    AND length(external_source_id) BETWEEN 1 AND 1024 AND external_source_id=btrim(external_source_id)
    AND length(actor_subject) BETWEEN 1 AND 255 AND actor_subject=btrim(actor_subject)
    AND provider='GOOGLE_SHEETS'),
  CONSTRAINT migration_authority_receipts_version_check CHECK (expected_state_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT migration_authority_receipts_time_check CHECK (
    issued_at_ms BETWEEN 0 AND 9007199254140991
    AND expires_at_ms>issued_at_ms AND expires_at_ms<=issued_at_ms+600000),
  CONSTRAINT migration_authority_receipts_digest_check CHECK (
    source_fingerprint ~ '^[0-9a-f]{64}$' AND issuer_digest ~ '^[0-9a-f]{64}$' AND content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_authority_receipts_action_check CHECK (
    (action IN ('START_FREEZING_APPROVAL','FREEZING_CONSENT') AND expected_status='READY'
      AND final_sheet_digest IS NULL AND final_redis_digest IS NULL AND final_report_digest IS NULL)
    OR (action='ACTIVATE_APPROVAL' AND expected_status='FINAL_IMPORT'
      AND final_sheet_digest IS NOT NULL AND final_sheet_digest ~ '^[0-9a-f]{64}$'
      AND final_redis_digest IS NOT NULL AND final_redis_digest ~ '^[0-9a-f]{64}$'
      AND final_report_digest IS NOT NULL AND final_report_digest ~ '^[0-9a-f]{64}$'))
);
CREATE TRIGGER migration_authority_receipts_immutable BEFORE UPDATE OR DELETE ON migration_authority_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_authority_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_authority_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_authority_receipts_tenant_isolation ON migration_authority_receipts
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE migration_authority_replays (
  replay_digest text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  CONSTRAINT migration_authority_replays_receipt_unique UNIQUE (tenant_id,receipt_id),
  CONSTRAINT migration_authority_replays_receipt_fk FOREIGN KEY (tenant_id,receipt_id)
    REFERENCES migration_authority_receipts(tenant_id,receipt_id),
  CONSTRAINT migration_authority_replays_digest_check CHECK (replay_digest ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER migration_authority_replays_immutable BEFORE UPDATE OR DELETE ON migration_authority_replays
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_authority_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_authority_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_authority_replays_tenant_isolation ON migration_authority_replays
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
