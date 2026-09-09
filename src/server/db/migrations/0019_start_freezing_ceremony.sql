-- Pending explicit start is NOT authority. No lifecycle mutation or acquisition duplication.
-- Retained immutable rows; parent cascades blocked. Runtime SELECT/INSERT only.
CREATE TABLE migration_start_intents (
 tenant_id uuid NOT NULL,
 ceremony_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_start_intents_pkey PRIMARY KEY(tenant_id,ceremony_id),
 CONSTRAINT migration_start_intents_global_unique UNIQUE(ceremony_id),
 CONSTRAINT migration_start_intents_parent_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_consent_challenges(tenant_id,challenge_id),
 CONSTRAINT migration_start_intents_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'ceremonyId'=ceremony_id::text
  AND binding->>'consentChallengeDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'sessionBinding' ~ '^[0-9a-f]{64}$'
  AND binding->'display'->>'action'='DISABLE_LOCAL_WRITER_AND_START_FREEZING'
  AND binding->'display'->>'automaticEnable'='false'
  AND length(binding->'display'->>'deploymentId') BETWEEN 1 AND 128
  AND binding->'display'->>'registrationVersion' ~ '^[1-9][0-9]{0,15}$'
  AND binding->'display'->>'registrationDigest' ~ '^[0-9a-f]{64}$'
  AND (binding->>'expiresAt')::bigint-(binding->>'issuedAt')::bigint=300000) IS TRUE)
);
CREATE TRIGGER migration_start_intents_immutable BEFORE UPDATE OR DELETE ON migration_start_intents
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_start_intents_no_truncate BEFORE TRUNCATE ON migration_start_intents
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_start_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_start_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_start_intents_tenant_isolation ON migration_start_intents
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE migration_start_confirmations (
 tenant_id uuid NOT NULL,
 ceremony_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_start_confirmations_pkey PRIMARY KEY(tenant_id,ceremony_id),
 CONSTRAINT migration_start_confirmations_global_unique UNIQUE(ceremony_id),
 CONSTRAINT migration_start_confirmations_parent_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_start_intents(tenant_id,ceremony_id),
 CONSTRAINT migration_start_confirmations_consent_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_consent_confirmations(tenant_id,challenge_id),
 CONSTRAINT migration_start_confirmations_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'ceremonyId'=ceremony_id::text
  AND binding->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'stateDigest' ~ '^[0-9a-f]{64}$') IS TRUE)
);
CREATE TRIGGER migration_start_confirmations_immutable BEFORE UPDATE OR DELETE ON migration_start_confirmations
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_start_confirmations_no_truncate BEFORE TRUNCATE ON migration_start_confirmations
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_start_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_start_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_start_confirmations_tenant_isolation ON migration_start_confirmations
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE migration_start_dispatches (
 tenant_id uuid NOT NULL,
 ceremony_id uuid NOT NULL,
 binding jsonb NOT NULL,
 bridge_challenge_id uuid NOT NULL,
 CONSTRAINT migration_start_dispatches_pkey PRIMARY KEY(tenant_id,ceremony_id),
 CONSTRAINT migration_start_dispatches_global_unique UNIQUE(ceremony_id),
 CONSTRAINT migration_start_dispatches_parent_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_start_confirmations(tenant_id,ceremony_id),
 CONSTRAINT migration_start_dispatches_capture_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_consent_captures(tenant_id,challenge_id),
 CONSTRAINT migration_start_dispatches_bridge_unique UNIQUE(bridge_challenge_id),
 CONSTRAINT migration_start_dispatches_bridge_fk FOREIGN KEY(tenant_id,bridge_challenge_id) REFERENCES migration_bridge_challenges(tenant_id,challenge_id),
 CONSTRAINT migration_start_dispatches_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'ceremonyId'=ceremony_id::text
  AND binding->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'bridgeChallengeId'=bridge_challenge_id::text
  AND binding->>'registrationDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'requestDigest' ~ '^[0-9a-f]{64}$') IS TRUE)
);
CREATE TRIGGER migration_start_dispatches_immutable BEFORE UPDATE OR DELETE ON migration_start_dispatches
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_start_dispatches_no_truncate BEFORE TRUNCATE ON migration_start_dispatches
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_start_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_start_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_start_dispatches_tenant_isolation ON migration_start_dispatches
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
