-- Administrator compatibility security. Run as the migration/BYPASSRLS owner.
-- The runtime needs EXECUTE on the two exact function signatures below only;
-- it must not receive direct access to the private attempt counters.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'administrator session security requires migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.tenant_admin_login_limits (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  short_started_at timestamptz NOT NULL,
  short_attempts integer NOT NULL CHECK (short_attempts BETWEEN 0 AND 10),
  hour_started_at timestamptz NOT NULL,
  hour_attempts integer NOT NULL CHECK (hour_attempts BETWEEN 0 AND 30)
);
ALTER TABLE public.tenant_admin_login_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_admin_login_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_admin_login_limits FROM PUBLIC;

-- All attempts, including successful ones, consume the same budget. Windows
-- start on admission and are never extended by blocked requests. One bounded
-- row per tenant, no IP addresses or credentials. Google login is unaffected.
CREATE FUNCTION public.platform_consume_tenant_login_attempt(p_tenant_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.tenant_admin_login_limits%ROWTYPE; v_now timestamptz; v_retry integer:=0;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id::text IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='tenant context required';
  END IF;
  v_now:=clock_timestamp();
  INSERT INTO public.tenant_admin_login_limits VALUES(p_tenant_id,v_now,0,v_now,0) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v FROM public.tenant_admin_login_limits WHERE tenant_id=p_tenant_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF v_now>=v.short_started_at+interval '5 minutes' THEN v.short_started_at:=v_now; v.short_attempts:=0; END IF;
  IF v_now>=v.hour_started_at+interval '1 hour' THEN v.hour_started_at:=v_now; v.hour_attempts:=0; END IF;
  IF v.short_attempts>=10 THEN v_retry:=greatest(v_retry,ceil(extract(epoch FROM v.short_started_at+interval '5 minutes'-v_now))::integer); END IF;
  IF v.hour_attempts>=30 THEN v_retry:=greatest(v_retry,ceil(extract(epoch FROM v.hour_started_at+interval '1 hour'-v_now))::integer); END IF;
  IF v_retry>0 THEN RETURN v_retry; END IF;
  UPDATE public.tenant_admin_login_limits SET short_started_at=v.short_started_at,short_attempts=v.short_attempts+1,
    hour_started_at=v.hour_started_at,hour_attempts=v.hour_attempts+1 WHERE tenant_id=p_tenant_id;
  RETURN 0;
END $$;
REVOKE ALL ON FUNCTION public.platform_consume_tenant_login_attempt(uuid) FROM PUBLIC;

-- Global logout cannot recover a tenant UUID from an opaque cookie. This
-- capability-only function can revoke exactly the matching random bearer hash
-- and version; it returns neither a tenant identifier nor whether a row exists.
CREATE FUNCTION public.platform_revoke_tenant_session(p_token_hash text,p_session_version integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_session_version IS NULL OR p_session_version<1 THEN
    RETURN;
  END IF;
  UPDATE public.tenant_sessions SET revoked_at=greatest(clock_timestamp(),created_at)
    WHERE token_hash=p_token_hash AND session_version=p_session_version AND revoked_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.platform_revoke_tenant_session(text,integer) FROM PUBLIC;
