-- Withdrawal records are kept for one year, then erased (통합 개인정보처리방침 2026-12-05: 클래스 탈퇴
-- 기록은 1년 보관 후 파기). A year after a withdrawal everything left about that teacher goes:
--  * the withdrawal record (account_withdrawals);
--  * the anonymous class shells it left ('withdrawn-<id>'), and the teacher's earlier class-erasure
--    records (class_purges) with their tombstones ('purged-<id>');
--  * the unlinked account row ('withdrawn:<id>');
--  * the hash of the Google identifier (teacher_identity_generations), unless that Google account is
--    in use again. Sessions last 30 days at most, so none can come back after the year.
-- A shell still named by another class's records (for example an audit row from a class the teacher
-- helped run) stays: it holds no name, address or content.
-- Withdrawals now keep that hash (subject_hash) so the identity row can be found a year later. Those
-- recorded before this migration have none: their identity rows go with every other identity row
-- nothing uses (no session, no account, no withdrawal record), once the last of those older records
-- has had its year.
-- The class's Vercel cron runs platform_expire_withdrawal_records() once a day. It takes no arguments:
-- the runtime can only ask for what is due.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'withdrawal retention requires migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.account_withdrawals ADD COLUMN subject_hash text;
ALTER TABLE public.account_withdrawals ADD CONSTRAINT account_withdrawals_subject_hash_check
  CHECK (subject_hash IS NULL OR subject_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX account_withdrawals_withdrawn_at_idx ON public.account_withdrawals(withdrawn_at);
CREATE INDEX account_withdrawals_subject_hash_idx ON public.account_withdrawals(subject_hash) WHERE subject_hash IS NOT NULL;

-- 0053's withdrawal, now also recording the identifier hash with the withdrawal.
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
  INSERT INTO public.account_withdrawals(user_id, tenant_ids, withdrawn_at, subject_hash)
    VALUES (v_user.id, v_tenants, v_now, v_hash) RETURNING id INTO v_withdrawal_id;
  PERFORM public.platform_purge_withdrawal(v_withdrawal_id);
  DELETE FROM public.teacher_auth_sessions WHERE subject_hash=v_hash;
  UPDATE public.teacher_identity_generations SET generation=gen_random_uuid() WHERE subject_hash=v_hash;
  RETURN cardinality(v_tenants);
END $$;
REVOKE ALL ON FUNCTION public.platform_withdraw_user(text) FROM PUBLIC;

-- Whether a Google identifier hash still belongs to someone: an account, an agreement or a profile.
CREATE FUNCTION public.platform_identity_in_use(p_subject_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE encode(public.digest(u.google_subject,'sha256'),'hex')=p_subject_hash)
    OR EXISTS (SELECT 1 FROM public.user_agreements a WHERE encode(public.digest(a.google_subject,'sha256'),'hex')=p_subject_hash)
    OR EXISTS (SELECT 1 FROM public.user_profiles p WHERE encode(public.digest(p.google_subject,'sha256'),'hex')=p_subject_hash);
$$;
REVOKE ALL ON FUNCTION public.platform_identity_in_use(text) FROM PUBLIC;

CREATE FUNCTION public.platform_expire_withdrawal_records() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_cutoff timestamptz := clock_timestamp() - interval '1 year';
  v_w public.account_withdrawals%ROWTYPE;
  v_purge public.class_purges%ROWTYPE;
  v_id uuid;
  v_n integer;
  v_records integer := 0;
  v_classes integer := 0;
  v_accounts integer := 0;
  v_identities integer := 0;
BEGIN
  FOR v_w IN SELECT * FROM public.account_withdrawals w
    WHERE w.withdrawn_at < v_cutoff AND w.residual_purged_at IS NOT NULL
    ORDER BY w.withdrawn_at, w.id FOR UPDATE SKIP LOCKED LOOP
    DELETE FROM public.account_withdrawals WHERE id=v_w.id;
    v_records := v_records + 1;
    FOREACH v_id IN ARRAY v_w.tenant_ids LOOP
      BEGIN
        DELETE FROM public.tenants t WHERE t.id=v_id AND t.slug='withdrawn-'||t.id::text;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_classes := v_classes + v_n;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    IF v_w.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_withdrawals o WHERE o.user_id=v_w.user_id) THEN
      FOR v_purge IN DELETE FROM public.class_purges p WHERE p.user_id=v_w.user_id
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id=p.user_id AND u.google_subject='withdrawn:'||u.id::text) RETURNING * LOOP
        BEGIN
          DELETE FROM public.tenants t WHERE t.id=v_purge.class_id AND t.slug='purged-'||t.id::text;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_classes := v_classes + v_n;
        EXCEPTION WHEN foreign_key_violation THEN NULL;
        END;
      END LOOP;
      BEGIN
        DELETE FROM public.users u WHERE u.id=v_w.user_id AND u.google_subject='withdrawn:'||u.id::text;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_accounts := v_accounts + v_n;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END IF;
    IF v_w.subject_hash IS NOT NULL THEN
      DELETE FROM public.teacher_identity_generations g WHERE g.subject_hash=v_w.subject_hash
        AND NOT EXISTS (SELECT 1 FROM public.teacher_auth_sessions s WHERE s.subject_hash=g.subject_hash)
        AND NOT EXISTS (SELECT 1 FROM public.account_withdrawals o WHERE o.subject_hash=g.subject_hash)
        AND NOT public.platform_identity_in_use(g.subject_hash);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_identities := v_identities + v_n;
    END IF;
  END LOOP;
  -- Withdrawals from before 0059 named no hash: once none of them is left, identity rows that nothing
  -- uses any more are past every withdrawal's year and go too.
  IF NOT EXISTS (SELECT 1 FROM public.account_withdrawals w WHERE w.subject_hash IS NULL) THEN
    DELETE FROM public.teacher_identity_generations g
      WHERE NOT EXISTS (SELECT 1 FROM public.teacher_auth_sessions s WHERE s.subject_hash=g.subject_hash)
        AND NOT EXISTS (SELECT 1 FROM public.account_withdrawals o WHERE o.subject_hash=g.subject_hash)
        AND g.subject_hash NOT IN (
          SELECT encode(public.digest(u.google_subject,'sha256'),'hex') FROM public.users u
          UNION SELECT encode(public.digest(a.google_subject,'sha256'),'hex') FROM public.user_agreements a
          UNION SELECT encode(public.digest(p.google_subject,'sha256'),'hex') FROM public.user_profiles p);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_identities := v_identities + v_n;
  END IF;
  RETURN jsonb_build_object('records',v_records,'classes',v_classes,'accounts',v_accounts,'identities',v_identities);
END $$;
REVOKE ALL ON FUNCTION public.platform_expire_withdrawal_records() FROM PUBLIC;
