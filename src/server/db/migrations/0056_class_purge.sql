-- The owner of a class in the trash can erase it for good: every row the class has is deleted
-- through the same reviewed manifest as account withdrawal, so nothing can bring it back. Like
-- withdrawal, only a private, transaction-bound context opens the immutable tables to DELETE; no
-- caller-set GUC or disabled trigger is used. The class row itself stays only as an anonymous
-- tombstone (no name, no address) so nothing else that names its id breaks.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'class purge requires migration/BYPASSRLS ownership';
  END IF;
END $$;

-- Which class this transaction is erasing (see platform_withdrawal_erasure_allowed).
CREATE TABLE public.class_erasure_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  class_id uuid NOT NULL REFERENCES public.tenants(id),
  PRIMARY KEY (backend_pid, transaction_id, class_id)
);
ALTER TABLE public.class_erasure_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_erasure_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_erasure_context FROM PUBLIC;

-- Who erased which class and when, so a retried request gets the same answer. Holds no content of
-- the class (not even its name). Named class_id, not tenant_id: it is the record of the erasure,
-- not class data the erasure manifest must delete.
CREATE TABLE public.class_purges (
  operation_id uuid PRIMARY KEY,
  class_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.class_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_purges FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_purges FROM PUBLIC;

-- The FK-ordered list of every table that holds class rows, shared by withdrawal and class purge.
-- An added tenant table must join it; both erasures fail closed until it does.
CREATE FUNCTION public.platform_class_erasure_tables() RETURNS text[]
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
REVOKE ALL ON FUNCTION public.platform_class_erasure_tables() FROM PUBLIC;

-- The immutable-table triggers ask this before letting a DELETE through: a recorded withdrawal, or
-- now also the owner's purge of this very class in the trash, in this very transaction.
CREATE OR REPLACE FUNCTION public.platform_withdrawal_erasure_allowed(p_tenant uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.withdrawal_erasure_context c
    JOIN public.account_withdrawals w ON w.id=c.withdrawal_id
    JOIN public.tenants t ON t.id=c.class_id
    WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=txid_current()
      AND c.class_id=p_tenant AND c.class_id=ANY(w.tenant_ids)
      AND w.residual_purged_at IS NULL AND t.lifecycle='SUSPENDED'
  ) OR EXISTS (
    SELECT 1 FROM public.class_erasure_context c
    JOIN public.tenants t ON t.id=c.class_id
    WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=txid_current()
      AND c.class_id=p_tenant AND t.lifecycle='SUSPENDED' AND t.deleted_at IS NOT NULL
  );
$$;
REVOKE ALL ON FUNCTION public.platform_withdrawal_erasure_allowed(uuid) FROM PUBLIC;

-- Withdrawal now reads the shared manifest (same tables, same order as 0054), skipping a table a
-- later cleanup has dropped.
CREATE OR REPLACE FUNCTION public.platform_purge_withdrawal(p_withdrawal uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_withdrawal public.account_withdrawals%ROWTYPE;
  v_tenant uuid;
  v_table text;
  v_column text;
  v_unknown text;
  v_tables text[] := public.platform_class_erasure_tables();
BEGIN
  SELECT * INTO STRICT v_withdrawal FROM public.account_withdrawals WHERE id=p_withdrawal FOR UPDATE;
  IF v_withdrawal.residual_purged_at IS NOT NULL THEN RETURN 0; END IF;
  IF cardinality(v_withdrawal.tenant_ids)>0 AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id=v_withdrawal.user_id AND u.google_subject='withdrawn:'||u.id::text
  ) THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='recorded withdrawn owner required'; END IF;

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
      -- A table a later cleanup dropped (reward_vouchers is due to go) holds nothing to erase.
      CONTINUE WHEN to_regclass(format('public.%I',v_table)) IS NULL;
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

-- The owner erases one class that is in the trash. The class name typed again is the confirmation.
CREATE FUNCTION public.platform_purge_class(p_operation_id uuid,p_slug text,p_subject text,p_name text,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_t public.tenants%ROWTYPE;
  v_user uuid;
  v_done public.class_purges%ROWTYPE;
  v_tables text[] := public.platform_class_erasure_tables();
  v_table text;
  v_column text;
  v_unknown text;
BEGIN
  IF p_operation_id IS NULL OR p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_slug IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 80 OR p_name<>btrim(p_name)
    OR p_name ~ '[[:cntrl:]]' OR p_name ~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 9007199254740990 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid class purge input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('class-management:'||p_operation_id::text,0));
  -- A retry of a purge that already went through: the class is gone, give the same answer.
  SELECT * INTO v_done FROM public.class_purges WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=v_done.user_id AND u.google_subject=p_subject) THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='operation conflict';
    END IF;
    RETURN jsonb_build_object('slug',p_slug,'displayName',p_name,'lifecycle','SUSPENDED',
      'managementVersion',(p_expected_version+1)::text,'action','PURGE','replayed',true);
  END IF;
  SELECT t.* INTO v_t FROM public.tenants t WHERE t.slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  SELECT u.id INTO v_user FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
    WHERE u.google_subject=p_subject AND m.tenant_id=v_t.id AND m.role='OWNER' FOR SHARE OF u,m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  IF v_t.management_version<>p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class version changed';
  END IF;
  IF v_t.deleted_at IS NULL OR v_t.lifecycle<>'SUSPENDED' THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='only a class in the trash can be erased';
  END IF;
  IF v_t.display_name<>p_name THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='confirmation mismatch'; END IF;

  SELECT c.relname INTO v_unknown FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND a.attname IN ('tenant_id','claimed_by_tenant_id') AND NOT a.attisdropped
      AND NOT (c.relname::text=ANY(v_tables)) LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='class erasure manifest needs schema update';
  END IF;

  INSERT INTO public.class_erasure_context(backend_pid,transaction_id,class_id)
    VALUES (pg_backend_pid(),txid_current(),v_t.id);
  FOREACH v_table IN ARRAY v_tables LOOP
    CONTINUE WHEN to_regclass(format('public.%I',v_table)) IS NULL;
    v_column := CASE WHEN v_table='padlet_evidence_claims' THEN 'claimed_by_tenant_id' ELSE 'tenant_id' END;
    EXECUTE format('DELETE FROM public.%I WHERE %I=$1',v_table,v_column) USING v_t.id;
  END LOOP;
  DELETE FROM public.class_erasure_context
    WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND class_id=v_t.id;
  UPDATE public.tenants SET slug='purged-'||id::text, display_name='삭제된 학급',
    management_version=management_version+1, credential_version=credential_version+1, updated_at=clock_timestamp()
    WHERE id=v_t.id;
  INSERT INTO public.class_purges(operation_id,class_id,user_id) VALUES (p_operation_id,v_t.id,v_user);
  RETURN jsonb_build_object('slug',p_slug,'displayName',p_name,'lifecycle','SUSPENDED',
    'managementVersion',(v_t.management_version+1)::text,'action','PURGE','replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.platform_purge_class(uuid,text,text,text,bigint) FROM PUBLIC;

CREATE FUNCTION public.platform_purge_class_authenticated(p_operation_id uuid,p_slug text,p_subject text,p_name text,
  p_expected_version bigint,p_generation uuid,p_session_id uuid,p_required_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_lock_teacher_session(p_subject,p_generation,p_session_id,p_required_version);
  RETURN public.platform_purge_class(p_operation_id,p_slug,p_subject,p_name,p_expected_version);
END $$;
REVOKE ALL ON FUNCTION public.platform_purge_class_authenticated(uuid,text,text,text,bigint,uuid,uuid,text) FROM PUBLIC;
