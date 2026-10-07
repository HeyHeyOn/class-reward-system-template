-- Install before serving the history-aware application or admitting imports.
ALTER TABLE task_assignments ADD CONSTRAINT task_assignments_legacy_operation_check CHECK
  (legacy_origin_id IS NULL OR (admin_operation_id IS NULL AND admin_operation_hash IS NULL));
ALTER TABLE task_completions ADD CONSTRAINT task_completions_legacy_operation_check CHECK
  (legacy_origin_id IS NULL OR (admin_operation_id IS NULL AND admin_operation_hash IS NULL
    AND operation_id IS NULL AND operation_hash IS NULL));

CREATE FUNCTION validate_legacy_task_event_binding() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE origin public.legacy_task_origins; expected jsonb; actual jsonb; private_lifecycle text;
BEGIN
  SELECT lifecycle INTO private_lifecycle FROM public.tenants WHERE id=NEW.tenant_id FOR SHARE;
  IF private_lifecycle IS NULL OR private_lifecycle NOT IN ('DRAFT','IMPORTING') THEN
    RAISE EXCEPTION 'legacy task events require a private migration target' USING ERRCODE='23514';
  END IF;
  SELECT o.* INTO origin FROM public.legacy_task_origins o
    JOIN public.migration_sources s ON s.tenant_id=o.tenant_id AND s.job_id=o.job_id AND s.source_id=o.source_id
    JOIN public.migration_jobs j ON j.tenant_id=o.tenant_id AND j.job_id=o.job_id
    WHERE o.tenant_id=NEW.tenant_id AND o.origin_id=NEW.legacy_origin_id
      AND s.provider='GOOGLE_SHEETS' AND s.source_fingerprint=o.source_digest
      AND j.status IN ('VALIDATED','IMPORTING') FOR SHARE OF s,j;
  IF NOT FOUND OR origin.target_table<>TG_TABLE_NAME THEN
    RAISE EXCEPTION 'legacy task origin binding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='task_assignments' THEN
    IF origin.target_id<>NEW.assignment_id THEN RAISE EXCEPTION 'legacy task target mismatch'; END IF;
    SELECT to_jsonb(r) INTO expected FROM jsonb_populate_record(NULL::public.task_assignments,origin.projection) r;
  ELSE
    IF origin.target_id<>NEW.completion_id THEN RAISE EXCEPTION 'legacy task target mismatch'; END IF;
    SELECT to_jsonb(r) INTO expected FROM jsonb_populate_record(NULL::public.task_completions,origin.projection) r;
  END IF;
  actual:=to_jsonb(NEW)-'event_sequence'-'legacy_origin_id';
  expected:=expected-'event_sequence'-'legacy_origin_id';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'legacy task event differs from source projection' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Existing authenticated writers keep their original checks in full.
DROP TRIGGER task_assignments_admin_binding ON task_assignments;
CREATE TRIGGER task_assignments_admin_binding BEFORE INSERT ON task_assignments
  FOR EACH ROW WHEN (NEW.legacy_origin_id IS NULL) EXECUTE FUNCTION validate_task_admin_event_binding();
DROP TRIGGER task_completions_admin_binding ON task_completions;
CREATE TRIGGER task_completions_admin_binding BEFORE INSERT ON task_completions
  FOR EACH ROW WHEN (NEW.legacy_origin_id IS NULL) EXECUTE FUNCTION validate_task_admin_event_binding();
CREATE TRIGGER task_assignments_legacy_binding BEFORE INSERT ON task_assignments
  FOR EACH ROW WHEN (NEW.legacy_origin_id IS NOT NULL) EXECUTE FUNCTION validate_legacy_task_event_binding();
CREATE TRIGGER task_completions_legacy_binding BEFORE INSERT ON task_completions
  FOR EACH ROW WHEN (NEW.legacy_origin_id IS NOT NULL) EXECUTE FUNCTION validate_legacy_task_event_binding();
ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_admin_binding;
ALTER TABLE task_completions ENABLE ALWAYS TRIGGER task_completions_admin_binding;
ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_legacy_binding;
ALTER TABLE task_completions ENABLE ALWAYS TRIGGER task_completions_legacy_binding;
