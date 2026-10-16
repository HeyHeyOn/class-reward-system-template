-- 딴쌤 계정 아이콘과 이름 (ddanssaem-hub/docs/account-protocol.md 9). The icon belongs to the 딴쌤 account and is
-- chosen only on the hub's '내 계정'; the class keeps the name, the icon value and its picture address the hub
-- sends at each sign-in (1-3) and in profile_updated events (9-3).
--   avatar_url       the hub's picture address for the icon (null until the hub sent one)
--   avatar_from_hub  the icon follows the hub. False only while an icon the teacher picked in the class is still
--                    to be handed to the hub once (9-4); the app decides and sends, then saves with true.
-- '내 학급' sorts by 최근 활동순 (ddanssaem-brand README '목록 화면'): platform_list_class_dashboard_v2 adds
-- last_activity_at, the latest of the class's creation, its own changes, its transactions and its operations.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql. platform_begin_hub_teacher_session(5 args) and platform_list_class_dashboard
-- stay for the build being replaced.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'hub profiles require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.user_profiles
  ADD COLUMN avatar_url text,
  ADD COLUMN avatar_from_hub boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT user_profiles_avatar_url_check
    CHECK (avatar_url IS NULL OR (length(avatar_url) <= 400 AND avatar_url ~ '^https?://[^[:space:]"''<>]+$'));

CREATE FUNCTION public.platform_get_hub_profile(p_subject text)
RETURNS TABLE(nickname text, avatar jsonb, avatar_url text, avatar_from_hub boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN QUERY SELECT p.nickname, p.avatar, p.avatar_url, p.avatar_from_hub FROM public.user_profiles p WHERE p.google_subject=p_subject;
END $$;
REVOKE ALL ON FUNCTION public.platform_get_hub_profile(text) FROM PUBLIC;

-- 1-4 with 9-3: as the 5-argument form, and the name and icon are the hub's at every sign-in.
CREATE FUNCTION public.platform_begin_hub_teacher_session(p_subject text, p_terms_version text, p_hub_sid text,
  p_nickname text, p_avatar jsonb, p_avatar_url text, p_avatar_from_hub boolean)
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

-- 9-3: the name or icon changed on the hub. Only a teacher the class keeps a profile for; sessions stay.
CREATE FUNCTION public.platform_hub_profile_updated(p_subject text, p_nickname text, p_avatar jsonb, p_avatar_url text,
  p_avatar_from_hub boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  UPDATE public.user_profiles SET nickname=p_nickname, avatar=p_avatar, avatar_url=p_avatar_url,
    avatar_from_hub=COALESCE(p_avatar_from_hub, false), updated_at=clock_timestamp()
    WHERE google_subject=p_subject;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.platform_hub_profile_updated(text,text,jsonb,text,boolean) FROM PUBLIC;

CREATE FUNCTION public.platform_list_class_dashboard_v2(p_google_subject text)
RETURNS TABLE(slug text,display_name text,role text,lifecycle text,deleted_at timestamptz,
  management_version text,created_at timestamptz,student_count bigint,product_count bigint,task_count bigint,
  last_activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT t.slug,t.display_name,m.role,t.lifecycle,t.deleted_at,t.management_version::text,t.created_at,
    (SELECT count(*) FROM public.students s WHERE s.tenant_id=t.id AND s.deleted_at IS NULL),
    (SELECT count(*) FROM public.products p WHERE p.tenant_id=t.id AND p.deleted_at IS NULL),
    (SELECT count(*) FROM public.tasks q WHERE q.tenant_id=t.id AND q.deleted_at IS NULL),
    GREATEST(t.created_at, t.updated_at,
      (SELECT max(x.occurred_at) FROM public.transactions x WHERE x.tenant_id=t.id),
      (SELECT max(o.created_at) FROM public.operations o WHERE o.tenant_id=t.id))
  FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
  JOIN public.tenants t ON t.id=m.tenant_id
  WHERE u.google_subject=p_google_subject AND (t.deleted_at IS NULL OR m.role='OWNER')
  ORDER BY t.created_at DESC,t.slug
$$;
REVOKE ALL ON FUNCTION public.platform_list_class_dashboard_v2(text) FROM PUBLIC;
