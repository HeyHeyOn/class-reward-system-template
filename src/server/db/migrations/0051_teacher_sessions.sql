-- Google identity has a durable lifetime, including pending agreement and withdrawal.
-- Only the migration/BYPASSRLS owner can access the tables. Runtime receives exact function EXECUTE.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'teacher sessions require migration/BYPASSRLS ownership';
  END IF;
END $$;

-- Retain only an irreversible subject digest for the revocation generation, never email or name.
CREATE TABLE public.teacher_identity_generations (
  subject_hash text PRIMARY KEY CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  generation uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE public.teacher_auth_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_hash text NOT NULL REFERENCES public.teacher_identity_generations(subject_hash),
  generation uuid NOT NULL,
  pending boolean NOT NULL,
  authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > authenticated_at)
);
CREATE INDEX teacher_auth_sessions_subject_idx ON public.teacher_auth_sessions(subject_hash);
ALTER TABLE public.teacher_identity_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_identity_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_auth_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.teacher_identity_generations,public.teacher_auth_sessions FROM PUBLIC;

CREATE FUNCTION public.platform_begin_teacher_session(p_subject text,p_version text)
RETURNS TABLE(generation uuid,session_id uuid,agreed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text; v_generation uuid; v_id uuid; v_agreed boolean; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_version IS NULL OR p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'invalid agreement version'; END IF;
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  INSERT INTO public.teacher_identity_generations(subject_hash) VALUES(v_hash) ON CONFLICT DO NOTHING;
  SELECT g.generation INTO STRICT v_generation FROM public.teacher_identity_generations g WHERE g.subject_hash=v_hash FOR UPDATE;
  v_agreed:=public.platform_has_user_agreement(p_subject,p_version);
  DELETE FROM public.teacher_auth_sessions s WHERE s.subject_hash=v_hash AND s.expires_at<=v_now;
  INSERT INTO public.teacher_auth_sessions(subject_hash,generation,pending,authenticated_at,expires_at)
    VALUES(v_hash,v_generation,NOT v_agreed,v_now,v_now+CASE WHEN v_agreed THEN interval '30 days' ELSE interval '30 minutes' END)
    RETURNING teacher_auth_sessions.session_id INTO v_id;
  RETURN QUERY SELECT v_generation,v_id,v_agreed;
END $$;
REVOKE ALL ON FUNCTION public.platform_begin_teacher_session(text,text) FROM PUBLIC;

CREATE FUNCTION public.platform_validate_teacher_session(p_subject text,p_generation uuid,p_session_id uuid,p_pending boolean,p_version text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  RETURN EXISTS(SELECT 1 FROM public.teacher_identity_generations g JOIN public.teacher_auth_sessions s
    ON s.subject_hash=g.subject_hash AND s.generation=g.generation
    WHERE g.subject_hash=v_hash AND g.generation=p_generation AND s.session_id=p_session_id
      AND s.pending=p_pending AND s.expires_at>statement_timestamp())
    AND (p_version IS NULL OR (NOT p_pending AND public.platform_has_user_agreement(p_subject,p_version)));
END $$;
REVOKE ALL ON FUNCTION public.platform_validate_teacher_session(text,uuid,uuid,boolean,text) FROM PUBLIC;

-- Serialize each account action with withdrawal and login issuance. Identity must still be live at mutation time.
CREATE FUNCTION public.platform_mutate_teacher_account(p_action text,p_subject text,p_generation uuid,p_session_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text; v_session public.teacher_auth_sessions%ROWTYPE; v_version text; v_at timestamptz; v_closed integer;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  PERFORM 1 FROM public.teacher_identity_generations g WHERE g.subject_hash=v_hash AND g.generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='teacher session expired'; END IF;
  SELECT * INTO v_session FROM public.teacher_auth_sessions s WHERE s.subject_hash=v_hash
    AND s.generation=p_generation AND s.session_id=p_session_id AND s.expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='teacher session expired'; END IF;
  IF p_action='AGREE' THEN
    v_version:=p_payload->>'version';
    v_at:=public.platform_record_user_agreement(p_subject,v_version);
    UPDATE public.teacher_auth_sessions SET pending=false,expires_at=authenticated_at+interval '30 days' WHERE session_id=p_session_id;
    RETURN jsonb_build_object('agreedAt',v_at);
  ELSIF p_action='PROFILE' THEN
    v_version:=p_payload->>'version';
    IF v_session.pending OR v_version IS NULL OR NOT public.platform_has_user_agreement(p_subject,v_version) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='agreement required';
    END IF;
    PERFORM public.platform_save_user_profile(p_subject,p_payload->>'nickname',p_payload->'avatar');
    RETURN '{}'::jsonb;
  ELSIF p_action='WITHDRAW' THEN
    -- 0053 extends this existing function with audited identity erasure. Keep one withdrawal implementation.
    v_closed:=public.platform_withdraw_user(p_subject);
    DELETE FROM public.teacher_auth_sessions WHERE subject_hash=v_hash;
    -- 0053 also revokes in the underlying function for the transitional old app.
    -- Keep 0051 safe standalone without rotating a generation already changed there.
    UPDATE public.teacher_identity_generations SET generation=gen_random_uuid() WHERE subject_hash=v_hash AND generation=p_generation;
    RETURN jsonb_build_object('closedClasses',v_closed);
  END IF;
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid account action';
END $$;
REVOKE ALL ON FUNCTION public.platform_mutate_teacher_account(text,text,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.platform_end_teacher_session(p_subject text,p_generation uuid,p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  -- Same lock order as mutation/withdrawal; ending one device does not end other active devices.
  PERFORM 1 FROM public.teacher_identity_generations WHERE subject_hash=v_hash FOR UPDATE;
  DELETE FROM public.teacher_auth_sessions WHERE subject_hash=v_hash AND generation=p_generation AND session_id=p_session_id;
END $$;
REVOKE ALL ON FUNCTION public.platform_end_teacher_session(text,uuid,uuid) FROM PUBLIC;

-- A request admitted before withdrawal must not recreate or change an account afterwards.
-- Keep the generation lock through the entire class mutation, before user/tenant row locks.
CREATE FUNCTION public.platform_lock_teacher_session(p_subject text,p_generation uuid,p_session_id uuid,p_required_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text;
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  PERFORM 1 FROM public.teacher_identity_generations WHERE subject_hash=v_hash AND generation=p_generation FOR UPDATE;
  IF NOT FOUND OR p_required_version IS NULL
    OR NOT public.platform_validate_teacher_session(p_subject,p_generation,p_session_id,false,p_required_version)
    OR NOT EXISTS (SELECT 1 FROM public.teacher_auth_sessions WHERE session_id=p_session_id AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='28000',MESSAGE='teacher session expired or agreement required';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.platform_lock_teacher_session(text,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.platform_create_draft_class_authenticated(p_operation_id uuid,p_subject text,p_email text,p_name text,
  p_generation uuid,p_session_id uuid,p_required_version text)
RETURNS TABLE(slug text,display_name text,lifecycle text,role text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_lock_teacher_session(p_subject,p_generation,p_session_id,p_required_version);
  RETURN QUERY SELECT * FROM public.platform_create_draft_class(p_operation_id,p_subject,p_email,p_name);
END $$;
REVOKE ALL ON FUNCTION public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.platform_manage_class_authenticated(p_operation_id uuid,p_slug text,p_subject text,p_action text,p_name text,
  p_expected_version bigint,p_generation uuid,p_session_id uuid,p_required_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_lock_teacher_session(p_subject,p_generation,p_session_id,p_required_version);
  RETURN public.platform_manage_class(p_operation_id,p_slug,p_subject,p_action,p_name,p_expected_version);
END $$;
REVOKE ALL ON FUNCTION public.platform_manage_class_authenticated(uuid,text,text,text,text,bigint,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.platform_start_new_class_authenticated(p_operation_id uuid,p_slug text,p_subject text,
  p_generation uuid,p_session_id uuid,p_required_version text)
RETURNS TABLE(slug text,display_name text,lifecycle text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_lock_teacher_session(p_subject,p_generation,p_session_id,p_required_version);
  RETURN QUERY SELECT * FROM public.platform_start_new_class(p_operation_id,p_slug,p_subject);
END $$;
REVOKE ALL ON FUNCTION public.platform_start_new_class_authenticated(uuid,text,text,uuid,uuid,text) FROM PUBLIC;
