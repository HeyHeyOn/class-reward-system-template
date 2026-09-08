-- Add a distinct acquisition binding without rewriting retained 0013 receipts.
-- NULL identifies the legacy single-fingerprint archival contract; never backfill.
-- source_fingerprint remains the job semantic binding. Both contracts are NON_AUTHORITY.
ALTER TABLE migration_authority_receipts ADD COLUMN source_acquisition_digest text;
ALTER TABLE migration_authority_receipts ADD CONSTRAINT migration_authority_receipts_acquisition_digest_check
  CHECK (source_acquisition_digest IS NULL OR source_acquisition_digest ~ '^[0-9a-f]{64}$');
