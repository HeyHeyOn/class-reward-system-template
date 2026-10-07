-- Pre-tenant idempotency cannot use operations (which requires an existing
-- tenant FK). Keep exact operation/subject/payload binding without changing it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'class creation requires a migration role with BYPASSRLS';
  END IF;
END;
$$;

CREATE TABLE public.class_creation_operations (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80 AND display_name = btrim(display_name)),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.class_creation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_creation_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.class_creation_operations FROM PUBLIC;

CREATE FUNCTION public.platform_create_draft_class(
  p_operation_id uuid, p_google_subject text, p_canonical_email text, p_display_name text
)
RETURNS TABLE (slug text, display_name text, lifecycle text, role text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user_id uuid;
  v_email text;
  v_tenant_id uuid;
  v_slug text;
  v_operation public.class_creation_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_google_subject IS NULL OR length(p_google_subject) NOT BETWEEN 1 AND 255
    OR p_google_subject <> btrim(p_google_subject) OR p_google_subject ~ '[[:cntrl:]]'
    OR p_canonical_email IS NULL OR length(p_canonical_email) NOT BETWEEN 3 AND 320
    OR p_canonical_email <> lower(btrim(p_canonical_email)) OR p_canonical_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    OR p_display_name IS NULL OR length(p_display_name) NOT BETWEEN 1 AND 80
    OR p_display_name <> btrim(p_display_name) OR p_display_name ~ '[[:cntrl:]]'
    OR p_display_name ~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid class creation input';
  END IF;

  -- Serialize identical operation IDs before checking or writing, including races.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('class-creation:' || p_operation_id::text, 0));
  SELECT o.* INTO v_operation FROM public.class_creation_operations o WHERE o.operation_id = p_operation_id;
  IF FOUND THEN
    IF v_operation.display_name <> p_display_name OR NOT EXISTS (
      SELECT 1 FROM public.users u JOIN public.tenants t ON t.id = v_operation.tenant_id
      JOIN public.tenant_memberships m ON m.tenant_id = t.id AND m.user_id = u.id
      WHERE u.id = v_operation.user_id AND u.google_subject = p_google_subject
        AND u.canonical_email = p_canonical_email AND m.role = 'OWNER' AND t.lifecycle = 'DRAFT'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'class creation conflict';
    END IF;
    RETURN QUERY SELECT t.slug, t.display_name, 'DRAFT'::text, 'OWNER'::text, true
      FROM public.tenants t WHERE t.id = v_operation.tenant_id;
    RETURN;
  END IF;

  -- Never merge by email or overwrite an existing identity/profile.
  INSERT INTO public.users (google_subject, canonical_email)
    VALUES (p_google_subject, p_canonical_email) ON CONFLICT (google_subject) DO NOTHING;
  SELECT u.id, u.canonical_email INTO v_user_id, v_email FROM public.users u WHERE u.google_subject = p_google_subject;
  IF v_user_id IS NULL OR v_email <> p_canonical_email THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'class creation conflict';
  END IF;
  v_tenant_id := pg_catalog.gen_random_uuid();
  v_slug := 'class-' || v_tenant_id::text;
  INSERT INTO public.tenants (id, slug, display_name, lifecycle, timezone)
    VALUES (v_tenant_id, v_slug, p_display_name, 'DRAFT', 'Asia/Seoul');
  INSERT INTO public.tenant_memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, v_user_id, 'OWNER');
  INSERT INTO public.class_creation_operations (operation_id, tenant_id, user_id, display_name)
    VALUES (p_operation_id, v_tenant_id, v_user_id, p_display_name);
  RETURN QUERY SELECT v_slug, p_display_name, 'DRAFT'::text, 'OWNER'::text, false;
END;
$$;
REVOKE ALL ON FUNCTION public.platform_create_draft_class(uuid, text, text, text) FROM PUBLIC;
COMMENT ON FUNCTION public.platform_create_draft_class(uuid, text, text, text) IS
  'Provisioning contract: retain migration/BYPASSRLS ownership and search_path=pg_catalog. Grant only EXECUTE on this exact signature to the NOSUPERUSER NOBYPASSRLS runtime. No table grants. Ordinary identity must be decrypted server-side; no activation.';
