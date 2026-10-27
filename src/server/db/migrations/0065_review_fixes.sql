-- Fixes from the 2026-10-28 review of the class.
--  1. A hub sign-out (account-protocol 2-2) that lands while a sign-in callback for the same hub session is still
--     running must win: the ended hub session is remembered for a day (its hash only), the sign-in and the
--     sign-out take the same lock, and a sign-in for an ended hub session is refused. A sign-in that began before
--     the teacher's account was withdrawn (3) is refused too (platform_begin_hub_teacher_session with 8 arguments
--     takes when the sign-in began; the 7-argument form stays for the build being replaced, without that check).
--  2. Copying a class keeps its 디지털 상품 digital (coupon_products), so a purchase in the copy still fills the
--     보관함. Classes copied before stay as they are.
--  3. A board sync reads at most 60 students; board_link_syncs.evidence_after remembers the last student read
--     so the next sync goes on from there.
--  4. '내 학급' asks each class for its latest operation: an index for it.
-- Changes no existing row. Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'review fixes require migration/BYPASSRLS ownership';
  END IF;
END $$;

-- 1 ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.ended_hub_sessions (
  hub_sid_hash text NOT NULL,
  ended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ended_hub_sessions_pkey PRIMARY KEY (hub_sid_hash),
  CONSTRAINT ended_hub_sessions_hash_check CHECK (hub_sid_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.ended_hub_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ended_hub_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ended_hub_sessions FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.platform_end_hub_teacher_sessions(p_hub_sid text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_count integer; v_sid_hash text;
BEGIN
  IF p_hub_sid IS NULL OR p_hub_sid <> btrim(p_hub_sid) OR length(p_hub_sid) NOT BETWEEN 1 AND 200 THEN RETURN 0; END IF;
  v_sid_hash:=encode(public.digest(p_hub_sid,'sha256'),'hex');
  -- The same lock as a sign-in for this hub session: whichever comes second sees the other.
  PERFORM pg_advisory_xact_lock(hashtextextended('hub-session:'||v_sid_hash,0));
  INSERT INTO public.ended_hub_sessions(hub_sid_hash) VALUES (v_sid_hash)
    ON CONFLICT (hub_sid_hash) DO UPDATE SET ended_at=clock_timestamp();
  DELETE FROM public.ended_hub_sessions WHERE ended_at < clock_timestamp() - interval '1 day';
  PERFORM 1 FROM public.teacher_identity_generations g
    WHERE g.subject_hash IN (SELECT s.subject_hash FROM public.teacher_auth_sessions s WHERE s.hub_sid=p_hub_sid)
    ORDER BY g.subject_hash FOR UPDATE;
  DELETE FROM public.teacher_auth_sessions WHERE hub_sid=p_hub_sid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.platform_end_hub_teacher_sessions(text) FROM PUBLIC;

-- 1-4 with 9-3, as the 7-argument form, and p_signed_in_at: when the app began this sign-in (before trading the
-- code). Refused: an ended hub session, and a teacher withdrawn since the sign-in began.
CREATE FUNCTION public.platform_begin_hub_teacher_session(p_subject text, p_terms_version text, p_hub_sid text,
  p_nickname text, p_avatar jsonb, p_avatar_url text, p_avatar_from_hub boolean, p_signed_in_at timestamptz)
RETURNS TABLE(generation uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_hash text; v_sid_hash text; v_generation uuid; v_id uuid; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,2})?$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid hub terms version';
  END IF;
  IF p_hub_sid IS NULL OR p_hub_sid <> btrim(p_hub_sid) OR length(p_hub_sid) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid hub session';
  END IF;
  v_sid_hash:=encode(public.digest(p_hub_sid,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('hub-session:'||v_sid_hash,0));
  IF EXISTS (SELECT 1 FROM public.ended_hub_sessions e WHERE e.hub_sid_hash=v_sid_hash) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='hub session ended';
  END IF;
  v_hash:=encode(public.digest(p_subject,'sha256'),'hex');
  INSERT INTO public.teacher_identity_generations(subject_hash) VALUES(v_hash) ON CONFLICT DO NOTHING;
  SELECT g.generation INTO STRICT v_generation FROM public.teacher_identity_generations g WHERE g.subject_hash=v_hash FOR UPDATE;
  -- After the identity lock, which a withdrawal holds while it erases.
  IF p_signed_in_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.account_withdrawals w
      WHERE w.subject_hash=v_hash AND w.withdrawn_at >= p_signed_in_at) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='account withdrawn';
  END IF;
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
REVOKE ALL ON FUNCTION public.platform_begin_hub_teacher_session(text,text,text,text,jsonb,text,boolean,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.platform_begin_hub_teacher_session(p_subject text, p_terms_version text, p_hub_sid text,
  p_nickname text, p_avatar jsonb, p_avatar_url text, p_avatar_from_hub boolean)
RETURNS TABLE(generation uuid, session_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT * FROM public.platform_begin_hub_teacher_session(p_subject, p_terms_version, p_hub_sid, p_nickname, p_avatar,
    p_avatar_url, p_avatar_from_hub, NULL::timestamptz);
$$;
REVOKE ALL ON FUNCTION public.platform_begin_hub_teacher_session(text,text,text,text,jsonb,text,boolean) FROM PUBLIC;

-- 2 ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_manage_class(p_operation_id uuid,p_slug text,p_subject text,
  p_action text,p_name text,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_t public.tenants%ROWTYPE; v_user uuid; v_op public.class_management_operations%ROWTYPE;
  v_payload jsonb; v_result jsonb; v_new uuid; v_slug text; v_map jsonb; v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_operation_id IS NULL OR p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_slug IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR p_action IS NULL OR p_action NOT IN ('RENAME','DUPLICATE','DELETE','RESTORE')
    OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 80 OR p_name<>btrim(p_name)
    OR p_name ~ '[[:cntrl:]]' OR p_name ~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 9007199254740990 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid class management input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('class-management:'||p_operation_id::text,0));
  SELECT t.* INTO v_t FROM public.tenants t WHERE t.slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  SELECT u.id INTO v_user FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
    WHERE u.google_subject=p_subject AND m.tenant_id=v_t.id AND m.role='OWNER' FOR SHARE OF u,m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  v_payload:=jsonb_build_object('name',p_name,'expectedVersion',p_expected_version);
  SELECT o.* INTO v_op FROM public.class_management_operations o WHERE o.operation_id=p_operation_id;
  IF FOUND THEN
    IF v_op.tenant_id<>v_t.id OR v_op.user_id<>v_user OR v_op.action<>p_action OR v_op.payload<>v_payload THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='operation conflict';
    END IF;
    RETURN v_op.result||'{"replayed":true}'::jsonb;
  END IF;
  IF v_t.management_version<>p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class version changed';
  END IF;
  IF p_action='RESTORE' THEN
    IF v_t.deleted_at IS NULL OR v_t.display_name<>p_name THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class cannot be restored';
    END IF;
    UPDATE public.tenants SET lifecycle=deleted_lifecycle,deleted_at=NULL,deleted_lifecycle=NULL,
      management_version=management_version+1,credential_version=credential_version+1,updated_at=v_now WHERE id=v_t.id;
  ELSE
    IF v_t.deleted_at IS NOT NULL OR v_t.lifecycle NOT IN ('DRAFT','ACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class is not available';
    END IF;
    IF p_action='DELETE' THEN
      IF v_t.display_name<>p_name THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='confirmation mismatch'; END IF;
      UPDATE public.tenants SET deleted_at=v_now,deleted_lifecycle=lifecycle,lifecycle='SUSPENDED',
        management_version=management_version+1,credential_version=credential_version+1,updated_at=v_now WHERE id=v_t.id;
    ELSIF p_action='RENAME' THEN
      UPDATE public.tenants SET display_name=p_name,management_version=management_version+1,updated_at=v_now WHERE id=v_t.id;
      UPDATE public.tenant_settings SET settings=settings||jsonb_build_object('className',p_name),version=version+1,updated_at=v_now WHERE tenant_id=v_t.id;
    ELSE
      IF v_t.lifecycle<>'ACTIVE' THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='only active class can be copied'; END IF;
      v_new:=gen_random_uuid(); v_slug:='class-'||v_new::text;
      INSERT INTO public.tenants(id,slug,display_name,lifecycle) VALUES(v_new,v_slug,p_name,'ACTIVE');
      INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES(v_new,v_user,'OWNER');
      INSERT INTO public.tenant_settings(tenant_id,settings)
        SELECT v_new,jsonb_build_object('className',p_name,'currencyUnit',coalesce(s.settings->>'currencyUnit','원'),
          'appTitle',coalesce(s.settings->>'appTitle','학급 매점'),'bankTitle',coalesce(s.settings->>'bankTitle','학급 은행'),
          'themeColor',coalesce(s.settings->>'themeColor','white'),'fontFamily',coalesce(s.settings->>'fontFamily','default'),
          'qrManualInputEnabled',false) FROM (SELECT 1) a LEFT JOIN public.tenant_settings s ON s.tenant_id=v_t.id;
      INSERT INTO public.students(tenant_id,student_id,name,status)
        SELECT v_new,s.student_id,s.name,s.status FROM public.students s WHERE s.tenant_id=v_t.id AND s.deleted_at IS NULL;
      INSERT INTO public.accounts(tenant_id,student_id,balance) SELECT v_new,s.student_id,0 FROM public.students s WHERE s.tenant_id=v_new;
      INSERT INTO public.products(tenant_id,product_id,name,price,stock,is_active,image_url,category,sort_order)
        SELECT v_new,p.product_id,p.name,p.price,p.stock,p.is_active,p.image_url,p.category,p.sort_order
        FROM public.products p WHERE p.tenant_id=v_t.id AND p.deleted_at IS NULL;
      -- A 디지털 상품 stays digital in the copy (its type and description; a 교환권 keeps its product when copied).
      INSERT INTO public.coupon_products(tenant_id,product_id,digital_kind,voucher_product_id,description)
        SELECT v_new,c.product_id,c.digital_kind,v.product_id,c.description FROM public.coupon_products c
        JOIN public.products p ON p.tenant_id=v_new AND p.product_id=c.product_id
        LEFT JOIN public.products v ON v.tenant_id=v_new AND v.product_id=c.voucher_product_id
        WHERE c.tenant_id=v_t.id;
      INSERT INTO public.promotions(tenant_id,promotion_id,name,description,type,n_plus_one_buy_quantity,n_plus_one_free_quantity,
        promotional_price,percent_discount,fixed_discount,starts_at,ends_at,is_active,sort_order,schema_version)
        SELECT v_new,promotion_id,name,description,type,n_plus_one_buy_quantity,n_plus_one_free_quantity,
          promotional_price,percent_discount,fixed_discount,starts_at,ends_at,false,sort_order,schema_version
        FROM public.promotions WHERE tenant_id=v_t.id AND deleted_at IS NULL;
      INSERT INTO public.promotion_products(tenant_id,promotion_product_id,promotion_id,product_id,schema_version)
        SELECT v_new,l.promotion_product_id,l.promotion_id,l.product_id,l.schema_version FROM public.promotion_products l
        JOIN public.products p ON p.tenant_id=v_new AND p.product_id=l.product_id
        JOIN public.promotions q ON q.tenant_id=v_new AND q.promotion_id=l.promotion_id WHERE l.tenant_id=v_t.id;
      SELECT coalesce(jsonb_object_agg(t.task_instance_id,gen_random_uuid()::text),'{}'::jsonb) INTO v_map
        FROM public.tasks t WHERE t.tenant_id=v_t.id AND t.deleted_at IS NULL;
      INSERT INTO public.tasks(tenant_id,task_instance_id,task_id,title,description,reward,is_active,sort_order,
        available_from,available_until,due_at,prerequisite_task_instance_id,current_schedule,schedule_schema_version)
        SELECT v_new,v_map->>t.task_instance_id,t.task_id,t.title,t.description,t.reward,false,t.sort_order,
          t.available_from,t.available_until,t.due_at,v_map->>t.prerequisite_task_instance_id,
          (CASE WHEN t.pending_schedule IS NOT NULL AND (t.pending_schedule->>'effectiveFrom')::timestamptz<=v_now
            THEN t.pending_schedule ELSE t.current_schedule END)||jsonb_build_object('ruleVersion',1,
              'effectiveFrom',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),t.schedule_schema_version
        FROM public.tasks t WHERE t.tenant_id=v_t.id AND t.deleted_at IS NULL;
      INSERT INTO public.task_allowed_students(tenant_id,task_instance_id,student_id)
        SELECT v_new,v_map->>a.task_instance_id,a.student_id FROM public.task_allowed_students a
        JOIN public.students s ON s.tenant_id=v_new AND s.student_id=a.student_id
        WHERE a.tenant_id=v_t.id AND v_map ? a.task_instance_id;
    END IF;
  END IF;
  SELECT jsonb_build_object('slug',t.slug,'displayName',t.display_name,'lifecycle',t.lifecycle,
    'managementVersion',t.management_version::text,'action',p_action,'replayed',false) INTO v_result
    FROM public.tenants t WHERE t.id=coalesce(v_new,v_t.id);
  INSERT INTO public.class_management_operations(operation_id,tenant_id,user_id,action,payload,result)
    VALUES(p_operation_id,v_t.id,v_user,p_action,v_payload,v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.platform_manage_class(uuid,text,text,text,text,bigint) FROM PUBLIC;

-- 3 ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.board_link_syncs ADD COLUMN evidence_after text;
ALTER TABLE public.board_link_syncs ADD CONSTRAINT board_link_syncs_evidence_after_check
  CHECK (evidence_after IS NULL OR length(evidence_after) BETWEEN 1 AND 100);

-- 4 ------------------------------------------------------------------------------------------------------------
CREATE INDEX operations_tenant_created_at_idx ON public.operations (tenant_id, created_at DESC);
