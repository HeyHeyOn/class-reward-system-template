-- New, empty classrooms have no legacy data to reconcile. This path requires
-- the dedicated creation receipt and must never activate an imported tenant.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'new class start requires a migration role with BYPASSRLS';
  END IF;
END $$;

CREATE TABLE public.new_class_start_operations (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.new_class_start_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.new_class_start_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.new_class_start_operations FROM PUBLIC;
CREATE TRIGGER new_class_start_immutable BEFORE UPDATE OR DELETE
  ON public.new_class_start_operations FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_row();
CREATE TRIGGER new_class_start_no_truncate BEFORE TRUNCATE
  ON public.new_class_start_operations FOR EACH STATEMENT EXECUTE FUNCTION public.reject_immutable_row();

CREATE FUNCTION public.platform_get_new_class_setup(p_slug text, p_google_subject text)
RETURNS TABLE (slug text, display_name text, lifecycle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.slug, t.display_name, t.lifecycle
  FROM public.tenants t
  JOIN public.class_creation_operations c ON c.tenant_id=t.id
  JOIN public.users u ON u.id=c.user_id
  JOIN public.tenant_memberships m ON m.tenant_id=t.id AND m.user_id=u.id
  WHERE t.slug=p_slug AND u.google_subject=p_google_subject AND m.role='OWNER'
    AND NOT EXISTS (SELECT 1 FROM public.migration_jobs j WHERE j.tenant_id=t.id)
    AND (t.lifecycle='DRAFT' OR (t.lifecycle='ACTIVE' AND EXISTS (
      SELECT 1 FROM public.new_class_start_operations s WHERE s.tenant_id=t.id AND s.user_id=u.id)))
$$;
REVOKE ALL ON FUNCTION public.platform_get_new_class_setup(text,text) FROM PUBLIC;

CREATE FUNCTION public.platform_start_new_class(p_operation_id uuid, p_slug text, p_google_subject text)
RETURNS TABLE (slug text, display_name text, lifecycle text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_user_id uuid;
  v_operation public.new_class_start_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_slug IS NULL OR p_google_subject IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid class start input';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('class-start:' || p_operation_id::text, 0));
  -- Serializes starts and prevents concurrent FK-backed writes while checking
  -- emptiness. The membership lock also prevents revocation during the commit.
  SELECT t.* INTO v_tenant FROM public.tenants t WHERE t.slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='class start refused';
  END IF;
  SELECT u.id INTO v_user_id FROM public.class_creation_operations c
    JOIN public.users u ON u.id=c.user_id
    JOIN public.tenant_memberships m ON m.tenant_id=c.tenant_id AND m.user_id=u.id
    WHERE c.tenant_id=v_tenant.id AND u.google_subject=p_google_subject AND m.role='OWNER'
    FOR SHARE OF m, c, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='class start refused';
  END IF;
  IF EXISTS (SELECT 1 FROM public.migration_jobs j WHERE j.tenant_id=v_tenant.id) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='class has migration history';
  END IF;

  SELECT s.* INTO v_operation FROM public.new_class_start_operations s WHERE s.operation_id=p_operation_id;
  IF FOUND THEN
    IF v_operation.tenant_id<>v_tenant.id OR v_operation.user_id<>v_user_id OR v_tenant.lifecycle<>'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='class start conflict';
    END IF;
    RETURN QUERY SELECT v_tenant.slug, v_operation.display_name, 'ACTIVE'::text, true;
    RETURN;
  END IF;
  IF v_tenant.lifecycle<>'DRAFT' OR EXISTS (
    SELECT 1 FROM public.new_class_start_operations s WHERE s.tenant_id=v_tenant.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='class start conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_settings x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.tenant_setting_extras x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.tenant_auth_secrets x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.students x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.accounts x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.products x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.promotions x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.tasks x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.transactions x WHERE x.tenant_id=v_tenant.id)
    OR EXISTS (SELECT 1 FROM public.operations x WHERE x.tenant_id=v_tenant.id) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='class is not empty';
  END IF;

  INSERT INTO public.tenant_settings (tenant_id, schema_version, settings) VALUES (v_tenant.id, 1,
    pg_catalog.jsonb_build_object('className', v_tenant.display_name, 'currencyUnit', '원',
      'appTitle', '학급 매점', 'bankTitle', '학급 은행', 'themeColor', 'white',
      'fontFamily', 'default', 'qrManualInputEnabled', false));
  INSERT INTO public.new_class_start_operations (operation_id, tenant_id, user_id, display_name)
    VALUES (p_operation_id, v_tenant.id, v_user_id, v_tenant.display_name);
  UPDATE public.tenants SET lifecycle='ACTIVE', updated_at=now() WHERE id=v_tenant.id;
  RETURN QUERY SELECT v_tenant.slug, v_tenant.display_name, 'ACTIVE'::text, false;
END $$;
REVOKE ALL ON FUNCTION public.platform_start_new_class(uuid,text,text) FROM PUBLIC;
COMMENT ON FUNCTION public.platform_start_new_class(uuid,text,text) IS
  'Grant exact EXECUTE to NOBYPASSRLS runtime; keep migration/BYPASSRLS ownership. Only authenticated creator/OWNER of an empty new DRAFT without any migration job. Settings, immutable receipt and ACTIVE commit together.';
