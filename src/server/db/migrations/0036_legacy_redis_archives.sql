CREATE TABLE legacy_redis_snapshot_archives (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,job_id,source_id),
  FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id)
);
CREATE TABLE legacy_claim_publications (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  tombstone_count integer NOT NULL CHECK (tombstone_count>=0),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,job_id,source_id),
  FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES legacy_redis_snapshot_archives(tenant_id,job_id,source_id)
);
ALTER TABLE legacy_redis_snapshot_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_redis_snapshot_archives FORCE ROW LEVEL SECURITY;
ALTER TABLE legacy_claim_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_claim_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_redis_snapshot_archives
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON legacy_claim_publications
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON legacy_redis_snapshot_archives,legacy_claim_publications FROM PUBLIC;
CREATE TRIGGER legacy_redis_snapshot_archives_immutable BEFORE UPDATE OR DELETE ON legacy_redis_snapshot_archives
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_redis_snapshot_archives_no_truncate BEFORE TRUNCATE ON legacy_redis_snapshot_archives
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_claim_publications_immutable BEFORE UPDATE OR DELETE ON legacy_claim_publications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_claim_publications_no_truncate BEFORE TRUNCATE ON legacy_claim_publications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
