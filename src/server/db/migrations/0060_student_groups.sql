-- 모둠 (student groups). A teacher groups the class's students; each student is in at most one group,
-- and a student who is rested or deleted leaves their group. Groups are names only: deleting one leaves
-- its students as they are (no group). The 딴쌤 board reads them with the roster (app-links 5).
--   student_groups      one row per group (name unique in the class, 1–30 characters).
--   students.group_id   the student's group, or NULL.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql. The erasure manifest (0056) gains student_groups after students.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'student groups require migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.student_groups (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT student_groups_pkey PRIMARY KEY (tenant_id, group_id),
  CONSTRAINT student_groups_name_check CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 30
    AND name !~ '[[:cntrl:]]')
);
CREATE UNIQUE INDEX student_groups_name_key ON public.student_groups (tenant_id, name);

ALTER TABLE public.students ADD COLUMN group_id uuid;
ALTER TABLE public.students ADD CONSTRAINT students_group_fk FOREIGN KEY (tenant_id, group_id)
  REFERENCES public.student_groups(tenant_id, group_id) ON DELETE SET NULL (group_id);
ALTER TABLE public.students ADD CONSTRAINT students_group_active_check
  CHECK (group_id IS NULL OR (status = 'ACTIVE' AND deleted_at IS NULL));
CREATE INDEX students_group_idx ON public.students (tenant_id, group_id) WHERE group_id IS NOT NULL;

-- A student who is rested or deleted leaves their group (whatever command does it).
CREATE FUNCTION public.leave_student_group_when_inactive() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.deleted_at IS NOT NULL THEN NEW.group_id := NULL; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.leave_student_group_when_inactive() FROM PUBLIC;
CREATE TRIGGER students_leave_group_when_inactive BEFORE INSERT OR UPDATE ON public.students
  FOR EACH ROW EXECUTE FUNCTION public.leave_student_group_when_inactive();

ALTER TABLE public.student_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY student_groups_tenant_isolation ON public.student_groups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON public.student_groups FROM PUBLIC;
CREATE TRIGGER classroom_trash_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.student_groups
  FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_class_write();

CREATE OR REPLACE FUNCTION public.platform_class_erasure_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY[
    'padlet_post_uses',
    'padlet_board_syncs',
    'task_padlet_links',
    'padlet_settings',
    'accounts',
    'adjustments',
    'class_creation_operations',
    'class_management_operations',
    'coupon_products',
    'exports',
    'growth_settings',
    'inventory_ledger',
    'legacy_claim_publications',
    'legacy_full_snapshot_archives',
    'legacy_transaction_origins',
    'migration_authority_replays',
    'migration_final_targets',
    'migration_freezing_consumptions',
    'migration_full_claim_recaptures',
    'migration_full_contributors',
    'migration_full_delta_entries',
    'migration_full_reconciliation',
    'migration_local_generation_reconciliation',
    'migration_local_materializations',
    'migration_local_restorations',
    'migration_reacquisition_candidates',
    'migration_source_records',
    'new_class_start_operations',
    'padlet_evidence_claims',
    'pet_cares',
    'pet_decor',
    'pet_growth',
    'pet_rooms',
    'pet_settings',
    'promotion_products',
    'reconciliation_results',
    'reward_vouchers',
    'student_items',
    'task_allowed_students',
    'task_completions',
    'task_history_entries',
    'task_history_prefixes',
    'task_history_revisions',
    'task_ledger_checkpoints',
    'tenant_admin_login_limits',
    'tenant_auth_secrets',
    'tenant_sessions',
    'tenant_setting_extras',
    'tenant_settings',
    'transaction_items',
    'tree_drops',
    'class_trees',
    'legacy_redis_snapshot_archives',
    'migration_authority_receipts',
    'migration_bridge_consumptions',
    'migration_final_source_records',
    'migration_freezing_challenges',
    'migration_full_mappings',
    'migration_full_sources',
    'migration_local_disposable_database',
    'migration_local_restore_databases',
    'pets',
    'products',
    'promotions',
    'task_assignments',
    'tenant_memberships',
    'transactions',
    'legacy_task_origins',
    'migration_final_generations',
    'migration_full_targets',
    'migration_reacquisition_dispatches',
    'students',
    'student_groups',
    'tasks',
    'migration_full_generations',
    'migration_reacquisition_challenges',
    'migration_snapshots',
    'migration_start_executions',
    'audit_events',
    'migration_start_dispatches',
    'migration_bridge_challenges',
    'migration_consent_captures',
    'migration_start_confirmations',
    'operations',
    'migration_consent_attempts',
    'migration_start_intents',
    'migration_consent_confirmations',
    'migration_consent_challenges',
    'migration_sources',
    'migration_jobs'
  ]::text[];
$$;
