-- 교사 인증 (ddanssaem-hub/docs/account-protocol.md 10). The hub verifies teachers; the class keeps, for each
-- teacher it has a profile for, when that verification ends and from when the teacher must be verified, as the
-- hub sends them at each sign-in (1-3) and in verification_updated events (10-3). A teacher who must be verified
-- and is not cannot make a new class (the app decides from these and the clock). No mail address is kept.
--   verified_until              the end of the verification (null: never verified)
--   verification_required_from  from when verification is required (null: never, as long as the hub says so)
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql. The withdrawal deletes user_profiles rows, and these with them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'teacher verification requires migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.user_profiles
  ADD COLUMN verified_until timestamptz,
  ADD COLUMN verification_required_from timestamptz;

-- 1-3 and 10-3: the hub's values for a teacher the class keeps a profile for. Sessions stay.
CREATE FUNCTION public.platform_hub_verification_updated(p_subject text, p_verified_until timestamptz,
  p_required_from timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  UPDATE public.user_profiles SET verified_until=p_verified_until, verification_required_from=p_required_from,
    updated_at=clock_timestamp()
    WHERE google_subject=p_subject;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.platform_hub_verification_updated(text,timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.platform_get_teacher_verification(p_subject text)
RETURNS TABLE(verified_until timestamptz, required_from timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.platform_assert_google_subject(p_subject);
  RETURN QUERY SELECT p.verified_until, p.verification_required_from FROM public.user_profiles p WHERE p.google_subject=p_subject;
END $$;
REVOKE ALL ON FUNCTION public.platform_get_teacher_verification(text) FROM PUBLIC;
