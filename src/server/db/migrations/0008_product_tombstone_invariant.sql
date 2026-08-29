UPDATE products
SET is_active = false
WHERE deleted_at IS NOT NULL AND is_active;

ALTER TABLE products
  ADD CONSTRAINT products_deleted_status_check
  CHECK (deleted_at IS NULL OR NOT is_active);
