ALTER TABLE promotions NO FORCE ROW LEVEL SECURITY;

UPDATE promotions
SET is_active = false
WHERE deleted_at IS NOT NULL AND is_active;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_deleted_status_check
  CHECK (deleted_at IS NULL OR NOT is_active);

ALTER TABLE promotions FORCE ROW LEVEL SECURITY;
