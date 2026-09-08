-- Authenticated start-confirmation storage only; never executes freeze or activation.
-- Separate from archival approval receipts. Retain consumed nonce tombstones indefinitely.
-- Provision runtime SELECT, INSERT only on these two tables; no BYPASSRLS/definer needed.
-- The global PK enforces uniqueness even when a conflicting tenant row is hidden by RLS.
CREATE TABLE migration_freezing_challenges (
  tenant_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  actor_user_id uuid NOT NULL,
  binding jsonb NOT NULL,
  CONSTRAINT migration_freezing_challenges_pkey PRIMARY KEY (tenant_id,challenge_id),
  CONSTRAINT migration_freezing_challenges_global_unique UNIQUE (challenge_id),
  CONSTRAINT migration_freezing_challenges_source_fk FOREIGN KEY (tenant_id,job_id,source_id)
    REFERENCES migration_sources(tenant_id,job_id,source_id),
  CONSTRAINT migration_freezing_challenges_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT migration_freezing_challenges_binding_check CHECK ((
    jsonb_typeof(binding)='object' AND octet_length(binding::text)<=8192
    AND binding ?& ARRAY['tenantId','challengeId','migrationJobId','sourceId','actorUserId','purpose','action']
    AND binding->>'tenantId'=tenant_id::text AND binding->>'challengeId'=challenge_id::text
    AND binding->>'migrationJobId'=job_id AND binding->>'sourceId'=source_id
    AND binding->>'actorUserId'=actor_user_id::text AND binding->>'purpose'='CLASS_STORE_START_FREEZING_APPROVAL_V1' AND binding->>'action'='START_FREEZING_APPROVAL') IS TRUE)
);
CREATE TRIGGER migration_freezing_challenges_immutable BEFORE UPDATE OR DELETE ON migration_freezing_challenges
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_freezing_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_freezing_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_freezing_challenges_tenant_isolation ON migration_freezing_challenges
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE migration_freezing_consumptions (
  replay_digest text NOT NULL,
  tenant_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  CONSTRAINT migration_freezing_consumptions_pkey PRIMARY KEY (replay_digest),
  CONSTRAINT migration_freezing_consumptions_challenge_unique UNIQUE (tenant_id,challenge_id),
  CONSTRAINT migration_freezing_consumptions_challenge_fk FOREIGN KEY (tenant_id,challenge_id)
    REFERENCES migration_freezing_challenges(tenant_id,challenge_id),
  CONSTRAINT migration_freezing_consumptions_digest_check CHECK (replay_digest ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER migration_freezing_consumptions_immutable BEFORE UPDATE OR DELETE ON migration_freezing_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE migration_freezing_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_freezing_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_freezing_consumptions_tenant_isolation ON migration_freezing_consumptions
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
