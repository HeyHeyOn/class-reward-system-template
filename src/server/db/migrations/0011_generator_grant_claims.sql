CREATE TABLE generator_grant_claims (
  grant_id_hash text PRIMARY KEY,
  subject_hash text NOT NULL,
  email_hash text NOT NULL,
  client_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generator_grant_claims_grant_hash_check CHECK (grant_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generator_grant_claims_subject_hash_check CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generator_grant_claims_email_hash_check CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generator_grant_claims_client_fingerprint_check CHECK (client_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generator_grant_claims_chronology_check CHECK (expires_at > consumed_at)
);

CREATE FUNCTION reject_generator_grant_claim_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only generator grant claim cannot be changed'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER generator_grant_claims_append_only
BEFORE UPDATE OR DELETE ON generator_grant_claims
FOR EACH ROW EXECUTE FUNCTION reject_generator_grant_claim_change();

ALTER TABLE generator_grant_claims
  ENABLE ALWAYS TRIGGER generator_grant_claims_append_only;
