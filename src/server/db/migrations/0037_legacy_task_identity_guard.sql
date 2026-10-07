-- Missing historical definitions are represented only by sealed, non-runnable
-- identity tombstones. UNAVAILABLE is deliberately not a domain recurrence.
-- No historical title, schedule, reward, creation or deletion time is inferred.
CREATE FUNCTION guard_legacy_task_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.current_schedule->>'legacyIdentityOnly' = 'true' THEN
    RAISE EXCEPTION 'Historical task identities are immutable';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.current_schedule ? 'legacyIdentityOnly' THEN
    IF TG_OP <> 'INSERT' OR NEW.current_schedule->'legacyIdentityOnly' IS DISTINCT FROM 'true'::jsonb
      OR NEW.deleted_at IS NULL OR NEW.is_active OR NEW.pending_schedule IS NOT NULL
      OR NEW.current_schedule->'recurrence' IS DISTINCT FROM '{"type":"UNAVAILABLE"}'::jsonb
      OR NEW.created_at IS DISTINCT FROM NEW.deleted_at OR NEW.updated_at IS DISTINCT FROM NEW.deleted_at
      OR NEW.reward <> 0 OR NEW.prerequisite_task_instance_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM public.tenants t JOIN public.migration_sources s ON s.tenant_id=t.id
        JOIN public.migration_jobs j ON j.tenant_id=s.tenant_id AND j.job_id=s.job_id
        WHERE t.id=NEW.tenant_id AND t.lifecycle IN ('DRAFT','IMPORTING')
          AND j.status IN ('VALIDATED','IMPORTING') AND s.provider='GOOGLE_SHEETS'
          AND s.source_fingerprint=NEW.current_schedule->>'sourceDigest') THEN
      RAISE EXCEPTION 'Historical task identity requires a private bound source';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_legacy_task_identity() FROM PUBLIC;
CREATE TRIGGER tasks_legacy_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_legacy_task_identity();
ALTER TABLE tasks ENABLE ALWAYS TRIGGER tasks_legacy_identity_guard;
