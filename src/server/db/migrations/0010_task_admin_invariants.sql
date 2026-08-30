ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY;

ALTER TABLE operations ENABLE ALWAYS TRIGGER operations_update_guard;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_updated_chronology_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_deleted_chronology_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_deleted_status_check;

UPDATE tasks
SET updated_at = created_at
WHERE updated_at < created_at;

UPDATE tasks
SET deleted_at = GREATEST(deleted_at, updated_at, created_at)
WHERE deleted_at IS NOT NULL
  AND (deleted_at < updated_at OR deleted_at < created_at);

UPDATE tasks
SET is_active = false
WHERE deleted_at IS NOT NULL AND is_active;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_updated_chronology_check
    CHECK (updated_at >= created_at),
  ADD CONSTRAINT tasks_deleted_chronology_check
    CHECK (deleted_at IS NULL OR deleted_at >= updated_at),
  ADD CONSTRAINT tasks_deleted_status_check
    CHECK (deleted_at IS NULL OR NOT is_active);

ALTER TABLE task_assignments
  ADD COLUMN admin_operation_id text,
  ADD COLUMN admin_operation_hash text,
  ADD CONSTRAINT task_assignments_admin_operation_fk
    FOREIGN KEY (tenant_id, admin_operation_id)
    REFERENCES operations (tenant_id, operation_id),
  ADD CONSTRAINT task_assignments_admin_operation_pair_check
    CHECK ((admin_operation_id IS NULL) = (admin_operation_hash IS NULL)),
  ADD CONSTRAINT task_assignments_admin_operation_id_check
    CHECK (admin_operation_id IS NULL OR
      (admin_operation_id = btrim(admin_operation_id) AND length(admin_operation_id) > 0)),
  ADD CONSTRAINT task_assignments_admin_operation_hash_check
    CHECK (admin_operation_hash IS NULL OR admin_operation_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE task_completions
  ADD COLUMN admin_operation_id text,
  ADD COLUMN admin_operation_hash text,
  ADD CONSTRAINT task_completions_admin_operation_fk
    FOREIGN KEY (tenant_id, admin_operation_id)
    REFERENCES operations (tenant_id, operation_id),
  ADD CONSTRAINT task_completions_admin_operation_pair_check
    CHECK ((admin_operation_id IS NULL) = (admin_operation_hash IS NULL)),
  ADD CONSTRAINT task_completions_admin_operation_id_check
    CHECK (admin_operation_id IS NULL OR
      (admin_operation_id = btrim(admin_operation_id) AND length(admin_operation_id) > 0)),
  ADD CONSTRAINT task_completions_admin_operation_hash_check
    CHECK (admin_operation_hash IS NULL OR admin_operation_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION validate_task_admin_event_binding() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  binding_required boolean;
  operation_matches boolean;
BEGIN
  IF TG_TABLE_NAME = 'task_assignments' THEN
    binding_required := NEW.source IN ('ADMIN', 'QR');
  ELSIF TG_TABLE_NAME = 'task_completions' THEN
    binding_required := NEW.source IN ('ADMIN', 'ADMIN_RESET');
  ELSE
    RAISE EXCEPTION 'unsupported task event table %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF binding_required IS TRUE THEN
    IF NEW.admin_operation_id IS NULL OR NEW.admin_operation_hash IS NULL THEN
      RAISE EXCEPTION 'task administrator event in % requires an admin operation binding',
        TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.operations
      WHERE tenant_id = NEW.tenant_id
        AND operation_id = NEW.admin_operation_id
        AND operation_kind = 'TASK_ADMIN'
        AND payload_hash = NEW.admin_operation_hash
    ) INTO operation_matches;

    IF NOT operation_matches THEN
      RAISE EXCEPTION 'invalid task administrator operation binding in %', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.admin_operation_id IS NOT NULL OR NEW.admin_operation_hash IS NOT NULL THEN
    RAISE EXCEPTION 'non-administrator task event in % cannot have an admin operation binding',
      TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_assignments_admin_binding
BEFORE INSERT ON task_assignments
FOR EACH ROW EXECUTE FUNCTION validate_task_admin_event_binding();

ALTER TABLE task_assignments
  ENABLE ALWAYS TRIGGER task_assignments_admin_binding;

CREATE TRIGGER task_completions_admin_binding
BEFORE INSERT ON task_completions
FOR EACH ROW EXECUTE FUNCTION validate_task_admin_event_binding();

ALTER TABLE task_completions
  ENABLE ALWAYS TRIGGER task_completions_admin_binding;

CREATE FUNCTION reject_task_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only task event row in % cannot be changed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER task_assignments_append_only
BEFORE UPDATE OR DELETE ON task_assignments
FOR EACH ROW EXECUTE FUNCTION reject_task_event_change();

ALTER TABLE task_assignments
  ENABLE ALWAYS TRIGGER task_assignments_append_only;

CREATE TRIGGER task_completions_append_only
BEFORE UPDATE OR DELETE ON task_completions
FOR EACH ROW EXECUTE FUNCTION reject_task_event_change();

ALTER TABLE task_completions
  ENABLE ALWAYS TRIGGER task_completions_append_only;

ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
