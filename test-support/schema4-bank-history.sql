-- ISOLATED DEVELOPMENT ONLY. Not part of src/server/db/migrations.
-- Immutable observed history, never a modern operation or account mutation.
CREATE SCHEMA schema4_history;
CREATE TABLE schema4_history.captures (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  grid_json text NOT NULL,
  authority text NOT NULL DEFAULT 'OFFLINE_NONAUTHORITY' CHECK (authority = 'OFFLINE_NONAUTHORITY'),
  PRIMARY KEY (tenant_id, source_digest)
);
CREATE TABLE schema4_history.source_rows (
  tenant_id uuid NOT NULL,
  source_digest text NOT NULL,
  tab text NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  row_digest text NOT NULL CHECK (row_digest ~ '^[a-f0-9]{64}$'),
  cells jsonb NOT NULL CHECK (jsonb_typeof(cells) = 'array'),
  PRIMARY KEY (tenant_id, source_digest, tab, row_number),
  FOREIGN KEY (tenant_id, source_digest) REFERENCES schema4_history.captures(tenant_id, source_digest)
);
CREATE TABLE schema4_history.reward_groups (
  tenant_id uuid NOT NULL,
  source_digest text NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) > 0),
  transaction_id text NOT NULL CHECK (length(transaction_id) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  reward bigint NOT NULL CHECK (reward > 0 AND reward <= 9007199254740991),
  signed_total bigint NOT NULL CHECK (signed_total = -reward),
  balance_before bigint NOT NULL CHECK (balance_before BETWEEN -9007199254740991 AND 9007199254740991),
  balance_after bigint NOT NULL CHECK (balance_after BETWEEN -9007199254740991 AND 9007199254740991),
  CHECK (balance_before + reward = balance_after),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, transaction_id),
  FOREIGN KEY (tenant_id, source_digest) REFERENCES schema4_history.captures(tenant_id, source_digest)
);
-- One read-only signed ledger projection per original logical reward, not per
-- checkpoint. security_invoker keeps the underlying tenant RLS in effect.
CREATE VIEW schema4_history.reward_ledger WITH (security_invoker = true) AS
SELECT tenant_id, source_digest, operation_id AS legacy_operation_id,
       transaction_id, signed_total, reward AS balance_delta, balance_before, balance_after,
       'TASK_REWARD'::text AS kind, 'OFFLINE_NONAUTHORITY'::text AS authority
FROM schema4_history.reward_groups;

CREATE FUNCTION schema4_history.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SCHEMA4_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['captures', 'source_rows', 'reward_groups'] LOOP
    EXECUTE format('ALTER TABLE schema4_history.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE schema4_history.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON schema4_history.%I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name);
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON schema4_history.%I FOR EACH ROW EXECUTE FUNCTION schema4_history.reject_change()', table_name);
    EXECUTE format('CREATE TRIGGER immutable_table BEFORE TRUNCATE ON schema4_history.%I FOR EACH STATEMENT EXECUTE FUNCTION schema4_history.reject_change()', table_name);
  END LOOP;
END;
$$;
GRANT USAGE ON SCHEMA schema4_history TO app_runtime;
GRANT SELECT, INSERT ON schema4_history.captures, schema4_history.source_rows, schema4_history.reward_groups TO app_runtime;
GRANT SELECT ON schema4_history.reward_ledger TO app_runtime;
