ALTER TABLE students
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT students_version_check
    CHECK (version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT students_deleted_chronology_check
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  ADD CONSTRAINT students_deleted_status_check
    CHECK (deleted_at IS NULL OR status = 'INACTIVE');

DROP INDEX students_active_name_idx;
CREATE INDEX students_active_name_idx
  ON students (tenant_id, name)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;

ALTER TABLE products
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT products_version_check
    CHECK (version BETWEEN 1 AND 9007199254740991);

ALTER TABLE promotions
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT promotions_version_check
    CHECK (version BETWEEN 1 AND 9007199254740991);

ALTER TABLE tasks
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT tasks_version_check
    CHECK (version BETWEEN 1 AND 9007199254740991);

ALTER TABLE tenant_settings
  ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT tenant_settings_version_check
    CHECK (version BETWEEN 1 AND 9007199254740991);
