-- Permanent companion replay domain. No tenant FK/cascade or expiry pruning.
-- Provision a dedicated NOSUPERUSER NOBYPASSRLS NOINHERIT login whose exact role
-- name equals the registered deployment_id; no memberships/SET ROLE authority.
-- Grant only schema USAGE and this relation's SELECT/INSERT to that login.
-- Never grant this authority to the tenant runtime or share its DATABASE_URL.
CREATE TABLE migration_bridge_producer_reservations (
  nonce_digest text PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE,
  ceremony_id uuid NOT NULL,
  deployment_id text NOT NULL,
  registration_digest text NOT NULL,
  request_digest text NOT NULL,
  issued_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bridge_producer_nonce_check CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT bridge_producer_registration_check CHECK (registration_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT bridge_producer_request_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT bridge_producer_deployment_check CHECK (deployment_id = btrim(deployment_id)
    AND octet_length(deployment_id) BETWEEN 1 AND 63 AND deployment_id !~ '[[:cntrl:]]'),
  CONSTRAINT bridge_producer_lifetime_check CHECK (issued_at_ms >= 0
    AND expires_at_ms > issued_at_ms AND expires_at_ms - issued_at_ms <= 60000
    AND expires_at_ms <= 9007199254740991)
);
ALTER TABLE migration_bridge_producer_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_bridge_producer_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_producer_select ON migration_bridge_producer_reservations
  FOR SELECT USING (deployment_id = current_user::text);
CREATE POLICY bridge_producer_insert ON migration_bridge_producer_reservations
  FOR INSERT WITH CHECK (deployment_id = current_user::text);
REVOKE ALL ON migration_bridge_producer_reservations FROM PUBLIC;
CREATE FUNCTION reject_bridge_producer_mutation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Bridge producer replay tombstones are permanent' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION reject_bridge_producer_mutation() FROM PUBLIC;
CREATE TRIGGER bridge_producer_immutable BEFORE UPDATE OR DELETE
  ON migration_bridge_producer_reservations FOR EACH ROW EXECUTE FUNCTION reject_bridge_producer_mutation();
CREATE TRIGGER bridge_producer_no_truncate BEFORE TRUNCATE
  ON migration_bridge_producer_reservations FOR EACH STATEMENT EXECUTE FUNCTION reject_bridge_producer_mutation();
