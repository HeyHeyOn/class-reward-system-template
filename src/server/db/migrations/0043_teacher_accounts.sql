-- Teacher accounts: agreement to the terms and privacy policy, profile (nickname and a preset avatar),
-- and withdrawal. Run as the migration/BYPASSRLS owner. The runtime receives EXECUTE on the
-- functions below only; it never reads or writes these tables directly.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'teacher accounts require migration/BYPASSRLS ownership';
  END IF;
END $$;

-- One row per (Google account, document version) agreed to: the proof of consent. A new version of
-- the terms or the privacy policy needs a new row before the teacher keeps using the service.
CREATE TABLE public.user_agreements (
  google_subject text NOT NULL,
  agreement_version text NOT NULL,
  agreed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_agreements_pkey PRIMARY KEY (google_subject, agreement_version),
  CONSTRAINT user_agreements_subject_check
    CHECK (google_subject = btrim(google_subject) AND length(google_subject) BETWEEN 1 AND 255),
  CONSTRAINT user_agreements_version_check CHECK (agreement_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

CREATE TABLE public.user_profiles (
  google_subject text PRIMARY KEY,
  nickname text NOT NULL,
  avatar jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_profiles_subject_check
    CHECK (google_subject = btrim(google_subject) AND length(google_subject) BETWEEN 1 AND 255),
  CONSTRAINT user_profiles_nickname_check
    CHECK (nickname = btrim(nickname) AND char_length(nickname) BETWEEN 1 AND 20),
  CONSTRAINT user_profiles_avatar_check
    CHECK (jsonb_typeof(avatar) = 'object' AND length(avatar::text) <= 400)
);

-- What a withdrawal did, without the teacher's identity: the classes it closed, for the operator's
-- follow-up destruction of protected records (e.g. archives copied from Google Sheets).
CREATE TABLE public.account_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id),
  tenant_ids uuid[] NOT NULL DEFAULT '{}',
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  residual_purged_at timestamptz,
  CONSTRAINT account_withdrawals_purge_chronology_check
    CHECK (residual_purged_at IS NULL OR residual_purged_at >= withdrawn_at)
);

ALTER TABLE public.user_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_agreements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.account_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_withdrawals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_agreements, public.user_profiles, public.account_withdrawals FROM PUBLIC;

CREATE FUNCTION public.platform_assert_google_subject(p_subject text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF p_subject IS NULL OR p_subject <> btrim(p_subject) OR length(p_subject) NOT BETWEEN 1 AND 255
    OR p_subject LIKE 'withdrawn:%' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid google subject';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.platform_assert_google_subject(text) FROM PUBLIC;

-- The latest agreement of an account (version and time), or no row.
CREATE FUNCTION public.platform_latest_user_agreement(p_subject text)
RETURNS TABLE(agreement_version text, agreed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN QUERY SELECT a.agreement_version, a.agreed_at FROM public.user_agreements a
    WHERE a.google_subject=p_subject ORDER BY a.agreement_version DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION public.platform_latest_user_agreement(text) FROM PUBLIC;

CREATE FUNCTION public.platform_has_user_agreement(p_subject text, p_version text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN EXISTS (SELECT 1 FROM public.user_agreements a WHERE a.google_subject=p_subject AND a.agreement_version=p_version);
END $$;
REVOKE ALL ON FUNCTION public.platform_has_user_agreement(text,text) FROM PUBLIC;

-- Idempotent: agreeing twice to the same version keeps the first time.
CREATE FUNCTION public.platform_record_user_agreement(p_subject text, p_version text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_at timestamptz;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_version IS NULL OR p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid agreement version';
  END IF;
  INSERT INTO public.user_agreements(google_subject, agreement_version) VALUES (p_subject, p_version)
    ON CONFLICT (google_subject, agreement_version) DO NOTHING;
  SELECT a.agreed_at INTO STRICT v_at FROM public.user_agreements a
    WHERE a.google_subject=p_subject AND a.agreement_version=p_version;
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION public.platform_record_user_agreement(text,text) FROM PUBLIC;

CREATE FUNCTION public.platform_get_user_profile(p_subject text)
RETURNS TABLE(nickname text, avatar jsonb, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN QUERY SELECT p.nickname, p.avatar, p.updated_at FROM public.user_profiles p WHERE p.google_subject=p_subject;
END $$;
REVOKE ALL ON FUNCTION public.platform_get_user_profile(text) FROM PUBLIC;

-- Only an account that has agreed to some version may keep a profile. The application validates the
-- avatar's parts; the table bounds its shape and size.
CREATE FUNCTION public.platform_save_user_profile(p_subject text, p_nickname text, p_avatar jsonb) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_at timestamptz;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF NOT EXISTS (SELECT 1 FROM public.user_agreements a WHERE a.google_subject=p_subject) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='agreement required';
  END IF;
  INSERT INTO public.user_profiles(google_subject, nickname, avatar) VALUES (p_subject, p_nickname, p_avatar)
    ON CONFLICT (google_subject) DO UPDATE SET nickname=EXCLUDED.nickname, avatar=EXCLUDED.avatar, updated_at=clock_timestamp()
    RETURNING user_profiles.updated_at INTO v_at;
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION public.platform_save_user_profile(text,text,jsonb) FROM PUBLIC;

-- Withdrawal, in one transaction:
--  * every class the account owns closes at once: student names are erased (students become inactive
--    and deleted), the class name and settings are cleared, the class moves to the trash (or is
--    suspended), and its sessions end;
--  * the account leaves every class, its profile and agreements are deleted, and the account row is
--    unlinked from the Google account (identifiers replaced), so signing in again starts a new account.
-- Ledger rows are immutable and keep only identifiers and amounts; archives and other protected
-- records listed in account_withdrawals are destroyed later by the operator.
CREATE FUNCTION public.platform_withdraw_user(p_subject text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_tenants uuid[] := '{}';
  v_tenant public.tenants%ROWTYPE;
  v_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
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
    VALUES (v_user.id, v_tenants, v_now);
  RETURN cardinality(v_tenants);
END $$;
REVOKE ALL ON FUNCTION public.platform_withdraw_user(text) FROM PUBLIC;
