-- Diagnostic intake only. No final authority, grants, or lifecycle changes.
-- Runtime provisioning remains explicit SELECT/INSERT. Parent cascades are
-- intentionally blocked by retained immutable children; retention is separate.
CREATE TABLE migration_reacquisition_challenges (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 job_id text NOT NULL,
 source_id text NOT NULL,
 actor_user_id uuid NOT NULL,
 start_ceremony_id uuid NOT NULL,
 preflight_snapshot_id text NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_reacquisition_challenges_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_reacquisition_challenges_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_reacquisition_challenges_source_fk FOREIGN KEY(tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id),
 CONSTRAINT migration_reacquisition_challenges_actor_fk FOREIGN KEY(actor_user_id) REFERENCES users(id),
 CONSTRAINT migration_reacquisition_challenges_start_fk FOREIGN KEY(tenant_id,start_ceremony_id) REFERENCES migration_start_executions(tenant_id,ceremony_id),
 CONSTRAINT migration_reacquisition_challenges_snapshot_fk FOREIGN KEY(tenant_id,preflight_snapshot_id) REFERENCES migration_snapshots(tenant_id,snapshot_id),
 CONSTRAINT migration_reacquisition_challenges_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->'challenge'->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND binding->'challenge'->>'bindingVersion'='1' AND binding->'challenge'->>'expectedStatus'='FREEZING'
  AND binding->'challenge'->>'tenantId'=tenant_id::text AND binding->'challenge'->>'challengeId'=challenge_id::text
  AND binding->'challenge'->>'migrationJobId'=job_id AND binding->'challenge'->>'sourceId'=source_id
  AND binding->'challenge'->>'actorUserId'=actor_user_id::text AND binding->'challenge'->>'startCeremonyId'=start_ceremony_id::text
  AND binding->'challenge'->>'preflightSnapshotId'=preflight_snapshot_id
  AND (binding->'challenge'->>'expiresAt')::bigint-(binding->'challenge'->>'issuedAt')::bigint=60000
  AND binding->>'csrfDigest' ~ '^[0-9a-f]{64}$' AND binding->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND binding->'display'->>'action'='READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE'
  AND binding->'display'->>'exclusion'='NOT_PROVEN'
  AND binding->'display'->>'automaticRetry'='false' AND binding->'display'->>'automaticEnable'='false') IS TRUE)
);
CREATE TABLE migration_reacquisition_dispatches (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_reacquisition_dispatches_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_reacquisition_dispatches_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_reacquisition_dispatches_challenge_fk FOREIGN KEY(tenant_id,challenge_id) REFERENCES migration_reacquisition_challenges(tenant_id,challenge_id),
 CONSTRAINT migration_reacquisition_dispatches_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'intentDigest' ~ '^[0-9a-f]{64}$' AND binding->>'requestDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'registrationDigest' ~ '^[0-9a-f]{64}$') IS TRUE)
);
-- Extend the CENTRAL nonce ledger, not the deployment-local producer ledger.
-- Keep every old row and old INSERT defaults. New consumers use the original
-- raw-nonce digest framing so the existing global PK rejects cross-phase replay.
ALTER TABLE migration_bridge_consumptions ALTER COLUMN challenge_id DROP NOT NULL;
ALTER TABLE migration_bridge_consumptions ADD COLUMN freezing_challenge_id uuid;
ALTER TABLE migration_bridge_consumptions ADD CONSTRAINT migration_bridge_consumptions_freezing_unique UNIQUE(tenant_id,freezing_challenge_id);
ALTER TABLE migration_bridge_consumptions ADD CONSTRAINT migration_bridge_consumptions_freezing_fk FOREIGN KEY(tenant_id,freezing_challenge_id) REFERENCES migration_reacquisition_dispatches(tenant_id,challenge_id);
ALTER TABLE migration_bridge_consumptions ADD CONSTRAINT migration_bridge_consumptions_phase_check CHECK ((challenge_id IS NOT NULL AND freezing_challenge_id IS NULL) OR (challenge_id IS NULL AND freezing_challenge_id IS NOT NULL));
ALTER TABLE migration_bridge_consumptions ADD CONSTRAINT migration_bridge_consumptions_freezing_binding_unique UNIQUE(nonce_digest,tenant_id,freezing_challenge_id);
CREATE TABLE migration_reacquisition_candidates (
 tenant_id uuid NOT NULL,
 challenge_id uuid NOT NULL,
 nonce_digest text NOT NULL,
 audit_event_id text NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_reacquisition_candidates_pkey PRIMARY KEY(tenant_id,challenge_id),
 CONSTRAINT migration_reacquisition_candidates_global_unique UNIQUE(challenge_id),
 CONSTRAINT migration_reacquisition_candidates_dispatch_fk FOREIGN KEY(tenant_id,challenge_id) REFERENCES migration_reacquisition_dispatches(tenant_id,challenge_id),
 CONSTRAINT migration_reacquisition_candidates_nonce_unique UNIQUE(nonce_digest),
 CONSTRAINT migration_reacquisition_candidates_nonce_fk FOREIGN KEY(nonce_digest,tenant_id,challenge_id) REFERENCES migration_bridge_consumptions(nonce_digest,tenant_id,freezing_challenge_id),
 CONSTRAINT migration_reacquisition_candidates_audit_fk FOREIGN KEY(tenant_id,audit_event_id) REFERENCES audit_events(tenant_id,event_id),
 CONSTRAINT migration_reacquisition_candidates_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
  AND binding->>'nonceDigest'=nonce_digest AND binding->>'auditEventId'=audit_event_id
  AND binding->>'candidateDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'authority'='NONAUTHORITY' AND binding->>'exclusion'='NOT_PROVEN'
  AND binding->>'finalImportEligible'='false') IS TRUE)
);
CREATE TRIGGER migration_reacquisition_challenges_immutable BEFORE UPDATE OR DELETE ON migration_reacquisition_challenges FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_reacquisition_challenges_no_truncate BEFORE TRUNCATE ON migration_reacquisition_challenges FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_reacquisition_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_reacquisition_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_reacquisition_challenges_tenant_isolation ON migration_reacquisition_challenges USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER migration_reacquisition_dispatches_immutable BEFORE UPDATE OR DELETE ON migration_reacquisition_dispatches FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_reacquisition_dispatches_no_truncate BEFORE TRUNCATE ON migration_reacquisition_dispatches FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_reacquisition_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_reacquisition_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_reacquisition_dispatches_tenant_isolation ON migration_reacquisition_dispatches USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER migration_reacquisition_candidates_immutable BEFORE UPDATE OR DELETE ON migration_reacquisition_candidates FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_reacquisition_candidates_no_truncate BEFORE TRUNCATE ON migration_reacquisition_candidates FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_reacquisition_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_reacquisition_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_reacquisition_candidates_tenant_isolation ON migration_reacquisition_candidates USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
