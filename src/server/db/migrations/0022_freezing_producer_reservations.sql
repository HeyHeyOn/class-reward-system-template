-- One permanent replay domain across READY-start and FREEZING-read producers.
-- Existing PK(nonce_digest) and UNIQUE(challenge_id) remain GLOBAL, including
-- rows written by old application versions. No second registry/backfill race.
-- The constant default labels historical/old-writer rows without UPDATE/backfill.
-- No row is deleted or rewritten by DML; prior migration bytes are unchanged.
ALTER TABLE migration_bridge_producer_reservations
  ADD COLUMN purpose text NOT NULL DEFAULT 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST',
  ADD COLUMN start_ceremony_id uuid,
  ADD COLUMN execution_digest text,
  -- One atomic ALTER: never expose weakened old nullability before its CHECK.
  -- Only the new discriminated variant may omit the old ceremony field.
  ALTER COLUMN ceremony_id DROP NOT NULL,
  ADD CONSTRAINT bridge_producer_phase_check CHECK (
    (purpose = 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST'
      AND ceremony_id IS NOT NULL AND start_ceremony_id IS NULL AND execution_digest IS NULL)
    OR (purpose = 'CLASS_STORE_REGISTERED_FREEZING_REACQUISITION_REQUEST'
      AND ceremony_id IS NULL AND start_ceremony_id IS NOT NULL
      AND execution_digest IS NOT NULL AND execution_digest ~ '^[0-9a-f]{64}$')
  );
-- 0020's FORCE RLS, deployment current_user policies, immutable UPDATE/DELETE
-- and statement TRUNCATE guards remain unchanged. SELECT/INSERT only; no grants
-- added. No tenant/start FK: this is a deployment-local replay ledger, not a
-- central authority database. Signed start bindings are opaque provenance here.
-- Permanent retention remains in force for BOTH variants, including uncertain
-- commits, expired requests and old-version writes. No expiry cleanup/cascade.
