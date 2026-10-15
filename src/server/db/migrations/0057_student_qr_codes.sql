-- Short student QR codes. A printed card now carries only 'DS1:' and a 12-hex-digit code (16 QR
-- alphanumeric characters, a 21x21 QR at error correction Q) instead of the long signed token, so a
-- folded or smudged card still scans.
--  * Every student gets a random code (48 bits from gen_random_uuid(); the version nibble is skipped),
--    existing rows included: the default is volatile, so ADD COLUMN evaluates it once per row. Every
--    insert path lists its columns, so new students get one the same way.
--  * The teacher may issue a new code; the old card then stops working. signed_qr_accepted says
--    whether the signed tokens printed before this migration (csq1) still work for the student;
--    issuing a new code turns it off for good.
-- Additive only: the code before this migration keeps working until the new deployment replaces it.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql (the new columns are covered by the existing table grants).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'student QR codes require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.students
  ADD COLUMN qr_code text NOT NULL DEFAULT upper(left(replace(gen_random_uuid()::text, '-', ''), 12)),
  ADD COLUMN signed_qr_accepted boolean NOT NULL DEFAULT true;
ALTER TABLE public.students ADD CONSTRAINT students_qr_code_check CHECK (qr_code ~ '^[0-9A-F]{12}$');
CREATE UNIQUE INDEX students_qr_code_key ON public.students (tenant_id, qr_code);
