-- The teacher adjusts growth directly: drops on the class tree and a student's pet growth, up or down.
-- Both are new append-only rows with source 'ADJUST' (any sign, no student on the tree, no money).
-- Task rewards now count toward the daily watering/feeding limits, so today's TASK rows per student
-- get an index like the waterings have.
-- Relaxes checks only: the code before this migration keeps working until the new deployment replaces it.
-- Apply as the migration/BYPASSRLS owner in one transaction; the existing grants cover it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'growth adjustments require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.tree_drops DROP CONSTRAINT tree_drops_source_check;
ALTER TABLE public.tree_drops ADD CONSTRAINT tree_drops_source_check CHECK (source IN ('WATER', 'TASK', 'SUN', 'CANCEL', 'ADJUST'));
ALTER TABLE public.tree_drops DROP CONSTRAINT tree_drops_amount_check;
ALTER TABLE public.tree_drops ADD CONSTRAINT tree_drops_amount_check CHECK (amount <> 0 AND amount BETWEEN -1000000 AND 1000000
  AND (source <> 'CANCEL' OR amount < 0) AND (source NOT IN ('WATER', 'TASK', 'SUN') OR amount > 0));
ALTER TABLE public.tree_drops DROP CONSTRAINT tree_drops_student_shape_check;
ALTER TABLE public.tree_drops ADD CONSTRAINT tree_drops_student_shape_check CHECK ((source IN ('SUN', 'ADJUST')) = (student_id IS NULL));
CREATE INDEX tree_drops_student_task_day_idx ON public.tree_drops (tenant_id, student_id, created_at) WHERE source = 'TASK';

ALTER TABLE public.pet_growth DROP CONSTRAINT pet_growth_source_check;
ALTER TABLE public.pet_growth ADD CONSTRAINT pet_growth_source_check CHECK (source IN ('CARE', 'TASK', 'CANCEL', 'ADJUST'));
ALTER TABLE public.pet_growth DROP CONSTRAINT pet_growth_amount_check;
ALTER TABLE public.pet_growth ADD CONSTRAINT pet_growth_amount_check CHECK (amount <> 0 AND amount BETWEEN -1000000 AND 1000000
  AND (source <> 'CANCEL' OR amount < 0) AND (source NOT IN ('CARE', 'TASK') OR amount > 0));
CREATE INDEX pet_growth_student_task_day_idx ON public.pet_growth (tenant_id, student_id, created_at) WHERE source = 'TASK';
