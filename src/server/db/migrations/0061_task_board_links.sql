-- 딴쌤 보드 links (ddanssaem-hub/docs/app-links.md 8). A teacher links a task to one of their 딴쌤 boards
-- (optionally one group of a group board) instead of a Padlet board; a student's public post there (or a
-- submission, on a quiz or survey board) while the task is open makes their 미완료 into 완료 가능, by the
-- same chain rule as Padlet. The board server answers for the students the class lent it (app links 2).
--   task_board_links     one row per linked task: the board, its address code, title and kind, the group,
--                        and the 딴쌤 account sub of the teacher who linked it (the board answers for them).
--   board_evidence_uses  which post or submission moved which student on which task (used once per task).
--   board_link_syncs     when each (board, group) was last read, and the last error.
-- A task has one link: linking a board removes its Padlet link and the other way round (the app does it).
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql. The erasure manifest gains the three tables first (they reference tasks).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'board links require migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.task_board_links (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  board_id text NOT NULL,
  board_code text NOT NULL,
  board_title text NOT NULL DEFAULT '',
  board_format text NOT NULL,
  group_id text,
  group_name text,
  linked_by_sub text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_board_links_pkey PRIMARY KEY (tenant_id, task_instance_id),
  CONSTRAINT task_board_links_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE,
  CONSTRAINT task_board_links_board_check CHECK (board_id ~ '^[A-Za-z0-9_-]{1,64}$' AND board_code ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT task_board_links_format_check CHECK (board_format IN ('mini', 'group', 'quiz', 'survey')),
  CONSTRAINT task_board_links_group_check CHECK ((group_id IS NULL) = (group_name IS NULL)
    AND (group_id IS NULL OR (group_id ~ '^[A-Za-z0-9_-]{1,64}$' AND board_format = 'group'))),
  CONSTRAINT task_board_links_text_check CHECK (length(board_title) <= 300 AND (group_name IS NULL OR length(group_name) <= 100)
    AND linked_by_sub = btrim(linked_by_sub) AND length(linked_by_sub) BETWEEN 1 AND 255)
);
CREATE INDEX task_board_links_board_idx ON public.task_board_links (tenant_id, board_id, group_id);

CREATE TABLE public.board_evidence_uses (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  evidence_id text NOT NULL,
  board_id text NOT NULL,
  student_id text NOT NULL,
  evidence_created_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation_id uuid NOT NULL,
  CONSTRAINT board_evidence_uses_pkey PRIMARY KEY (tenant_id, task_instance_id, evidence_id),
  CONSTRAINT board_evidence_uses_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE,
  CONSTRAINT board_evidence_uses_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES public.students(tenant_id, student_id),
  CONSTRAINT board_evidence_uses_evidence_check CHECK (evidence_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  CONSTRAINT board_evidence_uses_board_check CHECK (board_id ~ '^[A-Za-z0-9_-]{1,64}$')
);

CREATE TABLE public.board_link_syncs (
  tenant_id uuid NOT NULL,
  board_key text NOT NULL,
  checked_at timestamptz,
  succeeded_at timestamptz,
  error_code text,
  sync_attempt_id uuid,
  sync_lease_until timestamptz,
  retry_after timestamptz,
  CONSTRAINT board_link_syncs_pkey PRIMARY KEY (tenant_id, board_key),
  CONSTRAINT board_link_syncs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT board_link_syncs_key_check CHECK (board_key ~ '^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{0,64}$'),
  CONSTRAINT board_link_syncs_error_check CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,40}$')
);

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['task_board_links', 'board_evidence_uses', 'board_link_syncs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    EXECUTE format('CREATE TRIGGER classroom_trash_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_class_write()', table_name);
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION public.platform_class_erasure_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY[
    'board_evidence_uses',
    'board_link_syncs',
    'task_board_links',
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
