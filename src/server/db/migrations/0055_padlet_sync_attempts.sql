-- Board reads happen outside transactions. A leased attempt fences every result,
-- including ledger stage changes, so an older request cannot replace a newer one.
ALTER TABLE public.padlet_board_syncs
  ADD COLUMN sync_attempt_id uuid,
  ADD COLUMN sync_lease_until timestamptz,
  ADD COLUMN retry_after timestamptz,
  ADD CONSTRAINT padlet_board_syncs_lease_attempt_check
    CHECK (sync_lease_until IS NULL OR sync_attempt_id IS NOT NULL);

COMMENT ON COLUMN public.padlet_board_syncs.sync_attempt_id IS
  'Latest claimed board-read token. Retained after completion; a non-null lease marks an unfinished attempt.';
COMMENT ON COLUMN public.padlet_board_syncs.sync_lease_until IS
  'Another request may replace the attempt after this deadline. No transaction spans the external fetch.';
COMMENT ON COLUMN public.padlet_board_syncs.retry_after IS
  'Both manual and automatic reads respect the board rate-limit cooldown.';
