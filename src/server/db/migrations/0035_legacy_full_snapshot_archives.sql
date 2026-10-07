CREATE TABLE legacy_full_snapshot_archives (
  tenant_id uuid NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^[a-f0-9]{64}$'),
  grid_json text NOT NULL CHECK (octet_length(grid_json)<=32000000),
  physical_rows integer NOT NULL CHECK (physical_rows>=0),
  business_rows integer NOT NULL CHECK (business_rows>=0 AND business_rows<=physical_rows),
  captured_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,job_id,source_id),
  FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id)
);
ALTER TABLE legacy_full_snapshot_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_full_snapshot_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_full_snapshot_archives
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON legacy_full_snapshot_archives FROM PUBLIC;
CREATE TRIGGER legacy_full_snapshot_archives_immutable BEFORE UPDATE OR DELETE ON legacy_full_snapshot_archives
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_full_snapshot_archives_no_truncate BEFORE TRUNCATE ON legacy_full_snapshot_archives
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
COMMENT ON TABLE legacy_full_snapshot_archives IS
  'Private complete source archive, including historical settings. No public API exposure. Trusted migration executor SELECT/INSERT only, under tenant RLS. Does not attest writer exclusion or Redis coverage.';
