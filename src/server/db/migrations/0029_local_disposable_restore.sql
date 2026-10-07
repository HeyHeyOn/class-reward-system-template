-- Synthetic restoration provenance only: no operational markers or grants.
CREATE TABLE migration_local_restore_databases (
  singleton boolean PRIMARY KEY CHECK (singleton),
  database_id uuid NOT NULL UNIQUE,
  owner_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  state text NOT NULL CHECK (state='RESTORED_NONAUTHORITY'),
  UNIQUE(database_id,owner_id,tenant_id,job_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id)
);
CREATE TABLE migration_local_restorations (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  source_database_id uuid NOT NULL,
  destination_database_id uuid NOT NULL,
  source_owner_id uuid NOT NULL,
  destination_owner_id uuid NOT NULL,
  backup_digest text NOT NULL CHECK (backup_digest ~ '^[0-9a-f]{64}$'),
  source_readback_digest text NOT NULL CHECK (source_readback_digest ~ '^[0-9a-f]{64}$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  authority text NOT NULL CHECK (authority='NONAUTHORITY'),
  activation_allowed boolean NOT NULL CHECK (NOT activation_allowed),
  PRIMARY KEY(tenant_id,job_id),
  CHECK (source_database_id<>destination_database_id AND source_owner_id<>destination_owner_id),
  CHECK ((provenance->'marker'->>'database_id'=source_database_id::text) IS TRUE),
  CHECK ((provenance->'marker'->>'owner_id'=source_owner_id::text) IS TRUE),
  CHECK ((provenance->'materialization'->>'destination_database_id'=source_database_id::text) IS TRUE),
  CHECK ((provenance->'materialization'->>'tenant_id'=tenant_id::text) IS TRUE),
  CHECK ((provenance->'materialization'->>'job_id'=job_id) IS TRUE),
  CHECK ((provenance->'materialization'->>'authority'='NONAUTHORITY') IS TRUE),
  CHECK ((provenance->'materialization'->>'activation_allowed'='false') IS TRUE),
  FOREIGN KEY(tenant_id,job_id) REFERENCES migration_jobs(tenant_id,job_id),
  FOREIGN KEY(destination_database_id,destination_owner_id,tenant_id,job_id)
    REFERENCES migration_local_restore_databases(database_id,owner_id,tenant_id,job_id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['migration_local_restore_databases','migration_local_restorations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_local_full_generation_mutation()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_full_generation_mutation()',t||'_no_truncate',t);
  END LOOP;
END $$;
