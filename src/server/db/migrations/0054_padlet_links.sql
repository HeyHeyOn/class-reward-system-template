-- Padlet links. A teacher links a task to one Padlet board (optionally one of its sections); when a
-- post by a student appears there while the task is open, that student's 미완료 becomes 완료 가능.
-- Linked tasks that are chained by 선행 과제 share posts: each post moves only the first task of the
-- chain that the student has not reached yet. The class's Padlet API key is sealed by the app.
--   padlet_settings      one row per class: the sealed API key and its last four characters.
--   task_padlet_links    one row per linked task (titles are kept as Padlet showed them when linked).
--   padlet_post_uses     which post moved which student on which task (a post is used once per task).
--   padlet_board_syncs   when each linked board was last read, the last error, and a short summary of
--                        recent posts for the teacher.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql. Withdrawal erasure (0053) lists every tenant table, so its manifest
-- is redefined below with these tables first (they reference tasks and students).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'padlet links require migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.padlet_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  api_key_sealed text NOT NULL,
  api_key_hint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT padlet_settings_sealed_check CHECK (length(api_key_sealed) BETWEEN 16 AND 4096),
  CONSTRAINT padlet_settings_hint_check CHECK (length(api_key_hint) BETWEEN 1 AND 8)
);

CREATE TABLE public.task_padlet_links (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  board_id text NOT NULL,
  board_title text NOT NULL DEFAULT '',
  board_url text NOT NULL DEFAULT '',
  section_id text,
  section_title text,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_padlet_links_pkey PRIMARY KEY (tenant_id, task_instance_id),
  CONSTRAINT task_padlet_links_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE,
  CONSTRAINT task_padlet_links_board_check CHECK (board_id ~ '^[A-Za-z0-9]{8,32}$'),
  CONSTRAINT task_padlet_links_section_check CHECK (section_id IS NULL OR section_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT task_padlet_links_text_check CHECK (length(board_title) <= 300 AND length(board_url) <= 500
    AND (section_title IS NULL OR length(section_title) <= 300))
);
CREATE INDEX task_padlet_links_board_idx ON public.task_padlet_links (tenant_id, board_id);

CREATE TABLE public.padlet_post_uses (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  post_id text NOT NULL,
  board_id text NOT NULL,
  student_id text NOT NULL,
  post_created_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation_id uuid NOT NULL,
  CONSTRAINT padlet_post_uses_pkey PRIMARY KEY (tenant_id, task_instance_id, post_id),
  CONSTRAINT padlet_post_uses_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE,
  CONSTRAINT padlet_post_uses_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES public.students(tenant_id, student_id),
  CONSTRAINT padlet_post_uses_post_check CHECK (post_id ~ '^[A-Za-z0-9_-]{3,128}$'),
  CONSTRAINT padlet_post_uses_board_check CHECK (board_id ~ '^[A-Za-z0-9]{8,32}$')
);
CREATE INDEX padlet_post_uses_board_idx ON public.padlet_post_uses (tenant_id, board_id, post_id);

CREATE TABLE public.padlet_board_syncs (
  tenant_id uuid NOT NULL,
  board_id text NOT NULL,
  checked_at timestamptz,
  succeeded_at timestamptz,
  error_code text,
  summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT padlet_board_syncs_pkey PRIMARY KEY (tenant_id, board_id),
  CONSTRAINT padlet_board_syncs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT padlet_board_syncs_board_check CHECK (board_id ~ '^[A-Za-z0-9]{8,32}$'),
  CONSTRAINT padlet_board_syncs_error_check CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,40}$'),
  CONSTRAINT padlet_board_syncs_summary_check CHECK (jsonb_typeof(summary) = 'array' AND jsonb_array_length(summary) <= 40)
);

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['padlet_settings', 'task_padlet_links', 'padlet_post_uses', 'padlet_board_syncs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION public.platform_purge_withdrawal(p_withdrawal uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_withdrawal public.account_withdrawals%ROWTYPE;
  v_tenant uuid;
  v_table text;
  v_column text;
  v_unknown text;
  v_tables text[] := ARRAY[
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
  ];
BEGIN
  SELECT * INTO STRICT v_withdrawal FROM public.account_withdrawals WHERE id=p_withdrawal FOR UPDATE;
  IF v_withdrawal.residual_purged_at IS NOT NULL THEN RETURN 0; END IF;
  IF cardinality(v_withdrawal.tenant_ids)>0 AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id=v_withdrawal.user_id AND u.google_subject='withdrawn:'||u.id::text
  ) THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='recorded withdrawn owner required'; END IF;

  -- An added tenant table must explicitly join this reviewed FK-ordered manifest. Fail closed on
  -- schema evolution rather than claiming complete erasure while silently retaining new payloads.
  SELECT c.relname INTO v_unknown FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND a.attname IN ('tenant_id','claimed_by_tenant_id') AND NOT a.attisdropped
      AND NOT (c.relname::text=ANY(v_tables)) LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='withdrawal erasure manifest needs schema update';
  END IF;

  FOREACH v_tenant IN ARRAY v_withdrawal.tenant_ids LOOP
    PERFORM 1 FROM public.tenants WHERE id=v_tenant AND lifecycle='SUSPENDED' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='withdrawn class must be closed'; END IF;
    INSERT INTO public.withdrawal_erasure_context(backend_pid,transaction_id,class_id,withdrawal_id)
      VALUES (pg_backend_pid(),txid_current(),v_tenant,p_withdrawal);
    FOREACH v_table IN ARRAY v_tables LOOP
      v_column := CASE WHEN v_table='padlet_evidence_claims' THEN 'claimed_by_tenant_id' ELSE 'tenant_id' END;
      EXECUTE format('DELETE FROM public.%I WHERE %I=$1',v_table,v_column) USING v_tenant;
    END LOOP;
    UPDATE public.tenants SET slug='withdrawn-'||id::text, display_name='탈퇴로 삭제된 학급', updated_at=clock_timestamp()
      WHERE id=v_tenant;
    DELETE FROM public.withdrawal_erasure_context
      WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND class_id=v_tenant;
  END LOOP;
  UPDATE public.account_withdrawals SET residual_purged_at=greatest(clock_timestamp(),withdrawn_at)
    WHERE id=p_withdrawal;
  RETURN cardinality(v_withdrawal.tenant_ids);
END $$;
REVOKE ALL ON FUNCTION public.platform_purge_withdrawal(uuid) FROM PUBLIC;
