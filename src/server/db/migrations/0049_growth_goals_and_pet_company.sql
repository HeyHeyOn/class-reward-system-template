-- Growth goals the teacher sets, every feeding growing the pet, pet accessories and graduated pets
-- keeping the current one company.
--  * The tree and the pets no longer derive their goal from a number of weeks: the teacher sets the
--    goal itself (kept in goal_override, now always written; target_weeks is no longer read) and the
--    screen only estimates how long it takes, from how many tasks a student completes a week
--    (tasks_per_week, a teacher's estimate). Existing classes keep the goal they have now.
--  * Every feeding adds the care growth, not only the first of the day (the egg is still warmed once
--    a day; the daily limit counts that), so a day may have several CARE growth rows.
--  * A pet wears one accessory (pets.accessory, null for none); bought accessories are pet_decor rows
--    with keys 'acc:<id>'.
--  * Up to two graduated pets can come back to the room (pet_rooms.companions, their pet ids).
-- Additive only: the code before this migration keeps working until the new deployment replaces it.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql (the new columns are covered by the existing table grants).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'growth goals require migration/BYPASSRLS ownership';
  END IF;
END $$;

-- The tree: the goal the growing tree has now, or what the weeks would have given.
UPDATE public.growth_settings g SET goal_override = COALESCE(
  (SELECT t.goal FROM public.class_trees t WHERE t.tenant_id = g.tenant_id AND t.status = 'GROWING'),
  LEAST(1000000, GREATEST(1,
    GREATEST(1, (SELECT count(*) FROM public.students s WHERE s.tenant_id = g.tenant_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL))
    * GREATEST(1, g.water_daily_limit + g.task_drops) * 5 * g.target_weeks)))
WHERE g.goal_override IS NULL;
ALTER TABLE public.growth_settings ADD COLUMN tasks_per_week integer NOT NULL DEFAULT 5;
ALTER TABLE public.growth_settings ADD CONSTRAINT growth_settings_tasks_per_week_check CHECK (tasks_per_week BETWEEN 0 AND 100);

-- The pets: the goal the class has now.
UPDATE public.pet_settings SET goal_override = LEAST(100000, GREATEST(1, GREATEST(1, care_growth + task_growth) * 5 * target_weeks))
WHERE goal_override IS NULL;
ALTER TABLE public.pet_settings ADD COLUMN tasks_per_week integer NOT NULL DEFAULT 5;
ALTER TABLE public.pet_settings ADD CONSTRAINT pet_settings_tasks_per_week_check CHECK (tasks_per_week BETWEEN 0 AND 100);

DROP INDEX public.pet_growth_one_care_a_day;

ALTER TABLE public.pets ADD COLUMN accessory text;
ALTER TABLE public.pets ADD CONSTRAINT pets_accessory_check CHECK (accessory IS NULL OR accessory ~ '^[a-z]{1,20}$');

ALTER TABLE public.pet_rooms ADD COLUMN companions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.pet_rooms ADD CONSTRAINT pet_rooms_companions_check
  CHECK (jsonb_typeof(companions) = 'array' AND jsonb_array_length(companions) <= 2);
