-- Local STARTED fact only. Not maintained exclusion, final import or activation.
-- No runtime grants: explicitly provision SELECT/INSERT only after review.
CREATE TABLE migration_start_executions (
 tenant_id uuid NOT NULL,
 ceremony_id uuid NOT NULL,
 consent_challenge_id uuid NOT NULL,
 bridge_challenge_id uuid NOT NULL,
 job_id text NOT NULL,
 audit_event_id text NOT NULL,
 binding jsonb NOT NULL,
 CONSTRAINT migration_start_executions_pkey PRIMARY KEY(tenant_id,ceremony_id),
 CONSTRAINT migration_start_executions_ceremony_unique UNIQUE(ceremony_id),
 CONSTRAINT migration_start_executions_consent_unique UNIQUE(consent_challenge_id),
 CONSTRAINT migration_start_executions_bridge_unique UNIQUE(bridge_challenge_id),
 CONSTRAINT migration_start_executions_dispatch_fk FOREIGN KEY(tenant_id,ceremony_id) REFERENCES migration_start_dispatches(tenant_id,ceremony_id),
 CONSTRAINT migration_start_executions_consent_fk FOREIGN KEY(tenant_id,consent_challenge_id) REFERENCES migration_consent_captures(tenant_id,challenge_id),
 CONSTRAINT migration_start_executions_bridge_fk FOREIGN KEY(tenant_id,bridge_challenge_id) REFERENCES migration_bridge_challenges(tenant_id,challenge_id),
 CONSTRAINT migration_start_executions_job_fk FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
 CONSTRAINT migration_start_executions_audit_fk FOREIGN KEY(tenant_id,audit_event_id) REFERENCES audit_events(tenant_id,event_id),
 CONSTRAINT migration_start_executions_binding_check CHECK ((jsonb_typeof(binding)='object' AND octet_length(binding::text)<=16384
  AND binding->>'purpose'='CLASS_STORE_START_EXECUTION_V1'
  AND binding->>'status'='STARTED' AND binding->>'exclusion'='NOT_PROVEN'
  AND binding->>'tenantId'=tenant_id::text AND binding->>'ceremonyId'=ceremony_id::text
  AND binding->>'consentChallengeId'=consent_challenge_id::text AND ceremony_id=consent_challenge_id
  AND binding->>'bridgeChallengeId'=bridge_challenge_id::text AND binding->>'migrationJobId'=job_id
  AND binding->>'auditEventId'=audit_event_id
  AND binding->>'registrationDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'requestDigest' ~ '^[0-9a-f]{64}$'
  AND binding->>'acquisitionDigest' ~ '^[0-9a-f]{64}$') IS TRUE)
);
CREATE TRIGGER migration_start_executions_immutable BEFORE UPDATE OR DELETE ON migration_start_executions
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_start_executions_no_truncate BEFORE TRUNCATE ON migration_start_executions
 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_start_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_start_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_start_executions_tenant_isolation ON migration_start_executions
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
