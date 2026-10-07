-- Historical financial facts retain their original cells and source binding.
-- They are not authenticated modern commands and never mint operation receipts.
CREATE TABLE legacy_transaction_origins (
  tenant_id uuid NOT NULL,
  transaction_id text NOT NULL,
  job_id text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_row_number integer NOT NULL CHECK (source_row_number > 1),
  source_row_digest text NOT NULL CHECK (source_row_digest ~ '^[a-f0-9]{64}$'),
  original_cells jsonb NOT NULL CHECK (jsonb_typeof(original_cells)='array'),
  reverses_transaction_id text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,transaction_id),
  UNIQUE (tenant_id,job_id,source_id,source_row_number),
  FOREIGN KEY (tenant_id,transaction_id) REFERENCES transactions(tenant_id,transaction_id),
  FOREIGN KEY (tenant_id,job_id,source_id) REFERENCES migration_sources(tenant_id,job_id,source_id),
  FOREIGN KEY (tenant_id,reverses_transaction_id) REFERENCES transactions(tenant_id,transaction_id),
  CHECK (reverses_transaction_id IS NULL OR reverses_transaction_id <> transaction_id)
);
CREATE UNIQUE INDEX legacy_transaction_one_reversal ON legacy_transaction_origins(tenant_id,reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
ALTER TABLE legacy_transaction_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_transaction_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_transaction_origins
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON legacy_transaction_origins FROM PUBLIC;
CREATE TRIGGER legacy_transaction_origins_immutable BEFORE UPDATE OR DELETE
  ON legacy_transaction_origins FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER legacy_transaction_origins_no_truncate BEFORE TRUNCATE
  ON legacy_transaction_origins FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();
COMMENT ON TABLE legacy_transaction_origins IS
  'Immutable provenance for imported financial history, including original cells and historical reversal links. No modern command authority. Grant INSERT only to the trusted migration executor, SELECT as required under tenant RLS.';
