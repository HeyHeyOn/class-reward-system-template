-- Explicit historical provenance. An imported event is never a modern operation.
CREATE TABLE legacy_task_origins (
  tenant_id uuid NOT NULL,
  origin_id text NOT NULL CHECK (origin_id ~ '^[a-f0-9]{64}$'),
  job_id text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  target_table text NOT NULL CHECK (target_table IN ('task_assignments','task_completions')),
  target_id text NOT NULL,
  historical_operation_id text,
  historical_operation_hash text,
  source_rows jsonb NOT NULL CHECK (jsonb_typeof(source_rows)='array' AND jsonb_array_length(source_rows)>0),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection)='object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,origin_id),
  UNIQUE (tenant_id,target_table,target_id),
  UNIQUE (tenant_id,historical_operation_id),
  CHECK ((historical_operation_id IS NULL)=(historical_operation_hash IS NULL)),
  CHECK (historical_operation_id IS NULL OR
    (target_table='task_completions' AND length(btrim(historical_operation_id))>0
      AND historical_operation_hash ~ '^(sha256:)?[a-f0-9]{64}$')),
  FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id)
);
ALTER TABLE legacy_task_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_task_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_task_origins
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON legacy_task_origins FROM PUBLIC;
CREATE TRIGGER legacy_task_origins_immutable BEFORE UPDATE OR DELETE ON legacy_task_origins
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_task_origins_no_truncate BEFORE TRUNCATE ON legacy_task_origins
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
ALTER TABLE task_assignments ADD COLUMN legacy_origin_id text,
  ADD CONSTRAINT task_assignments_legacy_origin_fk FOREIGN KEY (tenant_id,legacy_origin_id)
    REFERENCES legacy_task_origins(tenant_id,origin_id);
ALTER TABLE task_completions ADD COLUMN legacy_origin_id text,
  ADD CONSTRAINT task_completions_legacy_origin_fk FOREIGN KEY (tenant_id,legacy_origin_id)
    REFERENCES legacy_task_origins(tenant_id,origin_id);
