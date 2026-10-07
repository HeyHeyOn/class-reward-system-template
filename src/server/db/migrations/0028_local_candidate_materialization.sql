-- Local synthetic destination only. No grants, no operational generation model,
-- no activation/fence capability. Ownership markers are installed by the trusted
-- disposable DB owner, NEVER by the materialization service/runtime role.
CREATE TABLE migration_local_disposable_database (
  singleton boolean PRIMARY KEY CHECK (singleton),
  database_id uuid NOT NULL UNIQUE,
  owner_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('SOURCE','DESTINATION')),
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  UNIQUE(database_id,owner_id,tenant_id,job_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id)
);
CREATE TABLE migration_local_materializations (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  generation_id text NOT NULL,
  source_database_id uuid NOT NULL,
  destination_database_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  expected_state_version bigint NOT NULL CHECK (expected_state_version > 0),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  domain_readback jsonb NOT NULL CHECK (jsonb_typeof(domain_readback)='object'),
  scope text NOT NULL CHECK (scope='LOCAL_DISPOSABLE_DOMAIN'),
  authority text NOT NULL CHECK (authority='NONAUTHORITY'),
  activation_allowed boolean NOT NULL CHECK (NOT activation_allowed),
  PRIMARY KEY(tenant_id,job_id),
  CHECK (source_database_id<>destination_database_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
  FOREIGN KEY(destination_database_id,owner_id,tenant_id,job_id)
    REFERENCES migration_local_disposable_database(database_id,owner_id,tenant_id,job_id)
);
ALTER TABLE migration_local_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_local_materializations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_local_materializations
  USING (tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['migration_local_disposable_database','migration_local_materializations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_local_full_generation_mutation()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_full_generation_mutation()',t||'_no_truncate',t);
  END LOOP;
END $$;
