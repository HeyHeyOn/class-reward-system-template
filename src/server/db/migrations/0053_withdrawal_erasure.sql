-- Withdrawal erases owned classroom data atomically, including immutable snapshots and archives.
-- Live/trash classes keep their ordinary immutability. Only the owner-owned withdrawal routine can
-- open the private, transaction-bound DELETE exception; no caller-set GUC or disabled trigger is used.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'withdrawal erasure requires migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.withdrawal_erasure_context (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  class_id uuid NOT NULL,
  withdrawal_id uuid NOT NULL REFERENCES public.account_withdrawals(id),
  PRIMARY KEY (backend_pid, transaction_id, class_id)
);
ALTER TABLE public.withdrawal_erasure_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawal_erasure_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawal_erasure_context FROM PUBLIC;

CREATE FUNCTION public.platform_withdrawal_erasure_allowed(p_tenant uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.withdrawal_erasure_context c
    JOIN public.account_withdrawals w ON w.id=c.withdrawal_id
    JOIN public.tenants t ON t.id=c.class_id
    WHERE c.backend_pid=pg_backend_pid() AND c.transaction_id=txid_current()
      AND c.class_id=p_tenant AND c.class_id=ANY(w.tenant_ids)
      AND w.residual_purged_at IS NULL AND t.lifecycle='SUSPENDED'
  );
$$;
REVOKE ALL ON FUNCTION public.platform_withdrawal_erasure_allowed(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reject_immutable_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;
 RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END $$;
REVOKE ALL ON FUNCTION public.reject_immutable_row() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reject_immutable_ledger_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;

  RAISE EXCEPTION 'immutable ledger row in % cannot be changed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_immutable_ledger_change() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reject_task_event_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;

  RAISE EXCEPTION 'append-only task event row in % cannot be changed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_task_event_change() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.prevent_local_full_generation_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;

  RAISE EXCEPTION 'Local full generation is immutable' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_local_full_generation_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_legacy_task_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;

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
REVOKE ALL ON FUNCTION public.guard_legacy_task_identity() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_deleted_class_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_deleted timestamptz;
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.platform_withdrawal_erasure_allowed(
      coalesce(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'claimed_by_tenant_id')::uuid
    ) THEN RETURN OLD; END IF;
  END IF;

  IF TG_TABLE_NAME='padlet_evidence_claims' THEN
    IF TG_OP='DELETE' THEN v_id:=OLD.claimed_by_tenant_id; ELSE v_id:=NEW.claimed_by_tenant_id; END IF;
  ELSE
    IF TG_OP='DELETE' THEN v_id:=OLD.tenant_id; ELSE v_id:=NEW.tenant_id; END IF;
  END IF;
  SELECT t.deleted_at INTO v_deleted FROM public.tenants t WHERE t.id=v_id FOR SHARE;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class is in trash';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION public.guard_deleted_class_write() FROM PUBLIC;

-- Operator-only backlog entry point. Only a recorded withdrawal of an anonymized user qualifies;
-- a normal deleted classroom must remain recoverable and is rejected here.
CREATE FUNCTION public.platform_purge_withdrawal(p_withdrawal uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_withdrawal public.account_withdrawals%ROWTYPE;
  v_tenant uuid;
  v_table text;
  v_column text;
  v_unknown text;
  v_tables text[] := ARRAY[
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

CREATE OR REPLACE FUNCTION public.platform_withdraw_user(p_subject text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_hash text;
  v_user public.users%ROWTYPE;
  v_tenants uuid[] := '{}';
  v_tenant public.tenants%ROWTYPE;
  v_id uuid;
  v_withdrawal_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  -- Also protect legacy callers during rolling promotion: serialize before user/tenant locks
  -- and revoke all newly issued durable sessions in the same transaction as erasure.
  v_hash := encode(public.digest(p_subject,'sha256'),'hex');
  INSERT INTO public.teacher_identity_generations(subject_hash) VALUES(v_hash) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.teacher_identity_generations WHERE subject_hash=v_hash FOR UPDATE;
  SELECT * INTO v_user FROM public.users u WHERE u.google_subject=p_subject FOR UPDATE;
  IF FOUND THEN
    SELECT coalesce(array_agg(m.tenant_id ORDER BY m.tenant_id), '{}') INTO v_tenants
      FROM public.tenant_memberships m WHERE m.user_id=v_user.id AND m.role='OWNER';
    FOREACH v_id IN ARRAY v_tenants LOOP
      SELECT * INTO STRICT v_tenant FROM public.tenants t WHERE t.id=v_id FOR UPDATE;
      -- The trash guard refuses writes to a deleted class: take it out of the trash for this
      -- transaction, erase, then close it again.
      IF v_tenant.deleted_at IS NOT NULL THEN
        UPDATE public.tenants SET lifecycle=v_tenant.deleted_lifecycle, deleted_at=NULL, deleted_lifecycle=NULL WHERE id=v_id;
      END IF;
      UPDATE public.students SET name='삭제된 학생', status='INACTIVE', deleted_at=coalesce(deleted_at, greatest(v_now, created_at)),
        version=version+1, updated_at=v_now WHERE tenant_id=v_id;
      UPDATE public.tenant_settings SET settings='{}'::jsonb, updated_at=v_now WHERE tenant_id=v_id;
      DELETE FROM public.tenant_setting_extras WHERE tenant_id=v_id;
      UPDATE public.tenant_sessions SET revoked_at=greatest(v_now, created_at) WHERE tenant_id=v_id AND revoked_at IS NULL;
      SELECT * INTO STRICT v_tenant FROM public.tenants t WHERE t.id=v_id;
      IF v_tenant.lifecycle IN ('DRAFT','ACTIVE') THEN
        UPDATE public.tenants SET display_name='탈퇴로 삭제된 학급', deleted_at=v_now, deleted_lifecycle=lifecycle,
          lifecycle='SUSPENDED', management_version=management_version+1, updated_at=v_now WHERE id=v_id;
      ELSE
        UPDATE public.tenants SET display_name='탈퇴로 삭제된 학급', lifecycle='SUSPENDED',
          management_version=management_version+1, updated_at=v_now WHERE id=v_id;
      END IF;
    END LOOP;
    DELETE FROM public.tenant_memberships WHERE user_id=v_user.id;
    UPDATE public.users SET google_subject='withdrawn:' || v_user.id::text,
      canonical_email='withdrawn-' || v_user.id::text || '@withdrawn.invalid', display_name=NULL, updated_at=v_now
      WHERE id=v_user.id;
  END IF;
  DELETE FROM public.user_profiles WHERE google_subject=p_subject;
  DELETE FROM public.user_agreements WHERE google_subject=p_subject;
  INSERT INTO public.account_withdrawals(user_id, tenant_ids, withdrawn_at)
    VALUES (v_user.id, v_tenants, v_now) RETURNING id INTO v_withdrawal_id;
  PERFORM public.platform_purge_withdrawal(v_withdrawal_id);
  DELETE FROM public.teacher_auth_sessions WHERE subject_hash=v_hash;
  UPDATE public.teacher_identity_generations SET generation=gen_random_uuid() WHERE subject_hash=v_hash;
  RETURN cardinality(v_tenants);
END $$;
REVOKE ALL ON FUNCTION public.platform_withdraw_user(text) FROM PUBLIC;
