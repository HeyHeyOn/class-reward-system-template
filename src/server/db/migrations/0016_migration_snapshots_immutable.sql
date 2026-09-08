-- Snapshot evidence is append-only, including identical-value UPDATEs.
-- Existing rows, FK actions and artifact/phase idempotency are unchanged.
-- Parent CASCADE deletion is intentionally refused when it reaches retained snapshots.
CREATE TRIGGER migration_snapshots_immutable
  BEFORE UPDATE OR DELETE ON migration_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();
CREATE TRIGGER migration_snapshots_no_truncate
  BEFORE TRUNCATE ON migration_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row();

-- Provision runtime as nonowner NOSUPERUSER NOBYPASSRLS, without DDL,
-- trigger-disable or TRUNCATE authority. SELECT/INSERT and column-level UPDATE
-- needed for locking do not authorize mutation through these triggers.
-- Retention deletion requires a separately approved procedure, not a runtime bypass.
