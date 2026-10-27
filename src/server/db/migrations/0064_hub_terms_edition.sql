-- 딴쌤 약관 판 (2026-10-27): the hub's terms version may carry a second edition of the same day, '<date>.N'
-- (2026-10-27.2). The class still records it as given, 'hub:' || version, so the hub
-- agreement check and platform_begin_hub_teacher_session(7 args) take the edition too. The class's own versions
-- stay plain dates. Nothing is rewritten: every row kept so far already fits.
-- Apply as the migration/BYPASSRLS owner in one transaction.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'hub terms editions require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.user_agreements DROP CONSTRAINT user_agreements_version_check;
ALTER TABLE public.user_agreements ADD CONSTRAINT user_agreements_version_check
  CHECK (agreement_version ~ '^([0-9]{4}-[0-9]{2}-[0-9]{2}|hub:[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,2})?)$');

CREATE OR REPLACE FUNCTION public.platform_begin_hub_teacher_session(p_subject text, p_terms_version text, p_hub_sid text,
  p_nickname text, p_avatar jsonb, p_avatar_url text, p_avatar_from_hub boolean)
RETURNS TABLE(generation uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text; v_generation uuid; v_id uuid; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,2})?$' THEN
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
  INSERT INTO public.user_profiles(google_subject, nickname, avatar, avatar_url, avatar_from_hub)
    VALUES (p_subject, p_nickname, p_avatar, p_avatar_url, COALESCE(p_avatar_from_hub, false))
    ON CONFLICT (google_subject) DO UPDATE SET nickname=EXCLUDED.nickname, avatar=EXCLUDED.avatar,
      avatar_url=EXCLUDED.avatar_url, avatar_from_hub=EXCLUDED.avatar_from_hub, updated_at=clock_timestamp();
  DELETE FROM public.teacher_auth_sessions s WHERE s.subject_hash=v_hash AND s.expires_at<=v_now;
  INSERT INTO public.teacher_auth_sessions(subject_hash, generation, pending, authenticated_at, expires_at, hub_sid)
    VALUES (v_hash, v_generation, false, v_now, v_now + interval '30 days', p_hub_sid)
    RETURNING teacher_auth_sessions.session_id INTO v_id;
  RETURN QUERY SELECT v_generation, v_id;
END $$;
REVOKE ALL ON FUNCTION public.platform_begin_hub_teacher_session(text,text,text,text,jsonb,text,boolean) FROM PUBLIC;
