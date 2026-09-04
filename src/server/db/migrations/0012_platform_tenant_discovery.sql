-- These SECURITY DEFINER functions bypass FORCE RLS only when their owner has
-- BYPASSRLS (or is a superuser). An ordinary table owner is not sufficient.
-- Task18 must keep them owned by the migration/BYPASSRLS role and grant only
-- EXECUTE on these exact signatures to the NOBYPASSRLS application runtime role.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'platform tenant discovery functions require a migration role with BYPASSRLS';
  END IF;
END;
$$;

CREATE FUNCTION public.platform_find_tenant_by_slug(p_slug text)
RETURNS TABLE (
  id uuid,
  slug text,
  display_name text,
  lifecycle text,
  timezone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, t.slug, t.display_name, t.lifecycle, t.timezone
  FROM public.tenants AS t
  WHERE t.slug = p_slug
  LIMIT 1
$$;

CREATE FUNCTION public.platform_find_membership_by_tenant_and_google_subject(
  p_tenant_id uuid,
  p_google_subject text
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  user_id uuid,
  google_subject text,
  role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT tm.id, tm.tenant_id, tm.user_id, u.google_subject, tm.role
  FROM public.tenant_memberships AS tm
  INNER JOIN public.users AS u ON u.id = tm.user_id
  WHERE tm.tenant_id = p_tenant_id
    AND u.google_subject = p_google_subject
  LIMIT 1
$$;

CREATE FUNCTION public.platform_list_memberships_by_google_subject(p_google_subject text)
RETURNS TABLE (
  slug text,
  display_name text,
  role text,
  lifecycle text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.slug, t.display_name, tm.role, t.lifecycle
  FROM public.users AS u
  INNER JOIN public.tenant_memberships AS tm ON tm.user_id = u.id
  INNER JOIN public.tenants AS t ON t.id = tm.tenant_id
  WHERE u.google_subject = p_google_subject
  ORDER BY tm.created_at, t.slug
$$;

REVOKE ALL ON FUNCTION public.platform_find_tenant_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_list_memberships_by_google_subject(text) FROM PUBLIC;

COMMENT ON FUNCTION public.platform_find_tenant_by_slug(text) IS
  'Task18 provisioning contract: keep migration/BYPASSRLS ownership; GRANT EXECUTE on this function to the NOBYPASSRLS runtime role.';
COMMENT ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid, text) IS
  'Task18 provisioning contract: keep migration/BYPASSRLS ownership; GRANT EXECUTE on this function to the NOBYPASSRLS runtime role.';
COMMENT ON FUNCTION public.platform_list_memberships_by_google_subject(text) IS
  'Task18 provisioning contract: keep migration/BYPASSRLS ownership; GRANT EXECUTE on this function to the NOBYPASSRLS runtime role.';
