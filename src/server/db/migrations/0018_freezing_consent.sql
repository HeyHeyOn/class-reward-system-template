-- Fresh consent only: no freeze, writer exclusion, activation or recoverable authority.
-- Runtime provisioning: SELECT/INSERT only; nonowner NOSUPERUSER NOBYPASSRLS.
-- Rows and replay tombstones are retained. Parent deletion is intentionally blocked;
-- retention needs a separately approved procedure, not a runtime bypass.
CREATE TABLE migration_consent_challenges (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 job_id text NOT NULL,
 source_id text NOT NULL,
 actor_user_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_consent_challenges_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_consent_challenges_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_consent_challenges_source_fk FOREIGN KEY(tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id),
 CONSTRAINT migration_consent_challenges_actor_fk FOREIGN KEY(actor_user_id) REFERENCES users(id),
 CONSTRAINT migration_consent_challenges_binding_check CHECK ((
  jsonb_typeof(binding)='object' AND octet_length(binding::text)<=8192
  AND binding->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'migrationJobId'=job_id AND binding->>'sourceId'=source_id AND binding->>'actorUserId'=actor_user_id::text
  AND binding->>'sessionBinding' ~ '^[0-9a-f]{64}$' AND binding->>'csrfDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'externalSourceId' ~ '^[0-9a-f]{64}$'
  AND binding->>'jobSemanticFingerprint' ~ '^[0-9a-f]{64}$'
  AND binding->>'sourceAcquisitionDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'preflightDigest' ~ '^[0-9a-f]{64}$'
 ) IS TRUE)
);
CREATE TABLE migration_consent_confirmations (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_consent_confirmations_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_consent_confirmations_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_consent_confirmations_parent_fk FOREIGN KEY(tenant_id,challenge_id) REFERENCES migration_consent_challenges(tenant_id,challenge_id),
 CONSTRAINT migration_consent_confirmations_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE)
);
CREATE TABLE migration_consent_attempts (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_consent_attempts_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_consent_attempts_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_consent_attempts_parent_fk FOREIGN KEY(tenant_id,challenge_id) REFERENCES migration_consent_confirmations(tenant_id,challenge_id),
 CONSTRAINT migration_consent_attempts_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE)
);
CREATE TABLE migration_consent_captures (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 binding jsonb NOT NULL,
 capture jsonb NOT NULL,
 CONSTRAINT migration_consent_captures_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_consent_captures_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_consent_captures_parent_fk FOREIGN KEY(tenant_id,challenge_id) REFERENCES migration_consent_attempts(tenant_id,challenge_id),
 CONSTRAINT migration_consent_captures_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE),
 CONSTRAINT migration_consent_captures_capture_check CHECK ((jsonb_typeof(capture)='object' AND octet_length(capture::text)<=9000000
  AND binding->>'captureDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'scope'='CONSENT_AND_SHEET_CAPTURE_ONLY') IS TRUE)
);
CREATE TRIGGER migration_consent_challenges_immutable BEFORE UPDATE OR DELETE ON migration_consent_challenges
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_consent_challenges_no_truncate BEFORE TRUNCATE ON migration_consent_challenges
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_consent_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_consent_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_consent_challenges_tenant_isolation ON migration_consent_challenges
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER migration_consent_confirmations_immutable BEFORE UPDATE OR DELETE ON migration_consent_confirmations
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_consent_confirmations_no_truncate BEFORE TRUNCATE ON migration_consent_confirmations
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_consent_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_consent_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_consent_confirmations_tenant_isolation ON migration_consent_confirmations
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER migration_consent_attempts_immutable BEFORE UPDATE OR DELETE ON migration_consent_attempts
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_consent_attempts_no_truncate BEFORE TRUNCATE ON migration_consent_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_consent_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_consent_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_consent_attempts_tenant_isolation ON migration_consent_attempts
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER migration_consent_captures_immutable BEFORE UPDATE OR DELETE ON migration_consent_captures
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_consent_captures_no_truncate BEFORE TRUNCATE ON migration_consent_captures
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_consent_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_consent_captures FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_consent_captures_tenant_isolation ON migration_consent_captures
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
