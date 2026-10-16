-- 딴쌤 accounts (ddanssaem-hub/docs/account-protocol.md). With DDANSSAEM_LOGIN=1 the hub signs
-- teachers in, takes their agreement to the terms, signs them out and deletes accounts; the class keeps
-- its own sessions. Additive: the Google sign-in and the class's own agreement keep working unchanged.
--  * A hub agreement is recorded apart from the class's own: version 'hub:YYYY-MM-DD' in
--    user_agreements, so withdrawal erases it with the rest. The class asks for the version 'hub'
--    (any hub agreement) when it runs in hub mode; class versions never match it, and the class's
--    latest agreement ignores hub rows.
--  * A class session made from a hub session keeps the hub session id (hub_sid), so the hub's logout
--    event ends exactly those sessions (other devices stay signed in).
--  * platform_hub_account_deleted erases a teacher by Google subject alone. The runtime may call it only
--    from the hub event route, after checking the hub's HMAC signature: it is the account_deleted event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '딴쌤 accounts require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.user_agreements DROP CONSTRAINT user_agreements_version_check;
ALTER TABLE public.user_agreements ADD CONSTRAINT user_agreements_version_check
  CHECK (agreement_version ~ '^(hub:)?[0-9]{4}-[0-9]{2}-[0-9]{2}$');

ALTER TABLE public.teacher_auth_sessions ADD COLUMN hub_sid text;
ALTER TABLE public.teacher_auth_sessions ADD CONSTRAINT teacher_auth_sessions_hub_sid_check
  CHECK (hub_sid IS NULL OR (hub_sid = btrim(hub_sid) AND length(hub_sid) BETWEEN 1 AND 200));
CREATE INDEX teacher_auth_sessions_hub_sid_idx ON public.teacher_auth_sessions(hub_sid) WHERE hub_sid IS NOT NULL;

-- 'hub' asks for any hub agreement; every other version is the class's own, as before.
CREATE OR REPLACE FUNCTION public.platform_has_user_agreement(p_subject text, p_version text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_version = 'hub' THEN
    RETURN EXISTS (SELECT 1 FROM public.user_agreements a WHERE a.google_subject=p_subject AND a.agreement_version LIKE 'hub:%');
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.user_agreements a WHERE a.google_subject=p_subject AND a.agreement_version=p_version);
END $$;

-- The class's own latest agreement (the notices and the profile page compare class versions only).
CREATE OR REPLACE FUNCTION public.platform_latest_user_agreement(p_subject text)
RETURNS TABLE(agreement_version text, agreed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN QUERY SELECT a.agreement_version, a.agreed_at FROM public.user_agreements a
    WHERE a.google_subject=p_subject AND a.agreement_version NOT LIKE 'hub:%' ORDER BY a.agreement_version DESC LIMIT 1;
END $$;

-- 1-4: the hub vouched for this teacher. Records the hub agreement, sets the nickname to the 딴쌤
-- account name (the avatar is kept, or p_avatar for a new profile) and starts an agreed class session
-- bound to the hub session.
CREATE FUNCTION public.platform_begin_hub_teacher_session(p_subject text, p_terms_version text, p_hub_sid text,
  p_nickname text, p_avatar jsonb)
RETURNS TABLE(generation uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text; v_generation uuid; v_id uuid; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid hub terms version';
  END IF;
  IF p_hub_sid IS NULL OR p_hub_sid <> btrim(p_hub_sid) OR length(p_hub_sid) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid hub session';
  END IF;
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  INSERT INTO public.teacher_identity_generations(subject_hash) VALUES(v_hash) ON CONFLICT DO NOTHING;
  SELECT g.generation INTO STRICT v_generation FROM public.teacher_identity_generations g WHERE g.subject_hash=v_hash FOR UPDATE;
  INSERT INTO public.user_agreements(google_subject, agreement_version) VALUES (p_subject, 'hub:' || p_terms_version)
    ON CONFLICT (google_subject, agreement_version) DO NOTHING;
  INSERT INTO public.user_profiles(google_subject, nickname, avatar) VALUES (p_subject, p_nickname, p_avatar)
    ON CONFLICT (google_subject) DO UPDATE SET nickname=EXCLUDED.nickname, updated_at=clock_timestamp();
  DELETE FROM public.teacher_auth_sessions s WHERE s.subject_hash=v_hash AND s.expires_at<=v_now;
  INSERT INTO public.teacher_auth_sessions(subject_hash, generation, pending, authenticated_at, expires_at, hub_sid)
    VALUES (v_hash, v_generation, false, v_now, v_now + interval '30 days', p_hub_sid)
    RETURNING teacher_auth_sessions.session_id INTO v_id;
  RETURN QUERY SELECT v_generation, v_id;
END $$;
REVOKE ALL ON FUNCTION public.platform_begin_hub_teacher_session(text,text,text,text,jsonb) FROM PUBLIC;

-- 2-2: the hub signed this session out; end the class sessions made from it. Same lock order as
-- platform_end_teacher_session (the identity generation first).
CREATE FUNCTION public.platform_end_hub_teacher_sessions(p_hub_sid text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_count integer;
BEGIN
  IF p_hub_sid IS NULL OR p_hub_sid <> btrim(p_hub_sid) OR length(p_hub_sid) NOT BETWEEN 1 AND 200 THEN RETURN 0; END IF;
  PERFORM 1 FROM public.teacher_identity_generations g
    WHERE g.subject_hash IN (SELECT s.subject_hash FROM public.teacher_auth_sessions s WHERE s.hub_sid=p_hub_sid)
    ORDER BY g.subject_hash FOR UPDATE;
  DELETE FROM public.teacher_auth_sessions WHERE hub_sid=p_hub_sid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.platform_end_hub_teacher_sessions(text) FROM PUBLIC;

-- 3: the 딴쌤 account was deleted. The class withdraws the teacher by its own rules (platform_withdraw_user:
-- classes closed and erased, profile and agreements removed, sessions ended). A teacher the class never
-- saw only has any stray sessions ended. Returns the number of classes closed.
CREATE FUNCTION public.platform_hub_account_deleted(p_subject text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.google_subject=p_subject)
    AND NOT EXISTS (SELECT 1 FROM public.user_agreements a WHERE a.google_subject=p_subject)
    AND NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.google_subject=p_subject) THEN
    DELETE FROM public.teacher_auth_sessions WHERE subject_hash=encode(public.digest(p_subject,'sha256'),'hex');
    RETURN 0;
  END IF;
  RETURN public.platform_withdraw_user(p_subject);
END $$;
REVOKE ALL ON FUNCTION public.platform_hub_account_deleted(text) FROM PUBLIC;
