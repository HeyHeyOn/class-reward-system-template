-- Personal pets. Each student picks an egg (species and a name), cares for it once a day (warming
-- the egg, then feeding — paid from the balance), and completed tasks help it grow. When it has
-- grown up the student graduates it whenever they like: it stays in their 도감, they get the reward,
-- and they pick a new egg. Students decorate the pet's room with items bought in the 펫 상점.
-- Feeding and decor are purchases (GROWTH_SPEND, status PET_FEED / PET_DECOR); a graduation reward is
-- income (GROWTH_REWARD, status PET_GRADUATE); the operations are GROWTH, like the class tree.
-- Apply as the migration/BYPASSRLS owner in one transaction; the runtime grants are in
-- provisioning/runtimeGrants.sql.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'pets require migration/BYPASSRLS ownership';
  END IF;
END $$;

-- One row per class once the teacher saves the pet settings.
CREATE TABLE public.pet_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  pet_enabled boolean NOT NULL DEFAULT false,
  target_weeks integer NOT NULL DEFAULT 4,
  goal_override bigint,
  care_growth integer NOT NULL DEFAULT 1,
  task_growth integer NOT NULL DEFAULT 1,
  feed_price bigint NOT NULL DEFAULT 10,
  feed_daily_limit integer NOT NULL DEFAULT 2,
  -- Off: pets are always awake. On: awake only within the spans [{start:'HH:MM', end:'HH:MM'}] (Korea time).
  hours_enabled boolean NOT NULL DEFAULT false,
  hours jsonb NOT NULL DEFAULT '[]'::jsonb,
  reward_amount bigint NOT NULL DEFAULT 100,
  reward_product_id text,
  shop_enabled boolean NOT NULL DEFAULT true,
  -- {'wall:mint': {price, sell}} — decor items have no price until the teacher sets one.
  shop_prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pet_settings_reward_product_fk FOREIGN KEY (tenant_id, reward_product_id) REFERENCES public.products (tenant_id, product_id),
  CONSTRAINT pet_settings_weeks_check CHECK (target_weeks BETWEEN 1 AND 20),
  CONSTRAINT pet_settings_goal_check CHECK (goal_override IS NULL OR goal_override BETWEEN 1 AND 100000),
  CONSTRAINT pet_settings_growth_check CHECK (care_growth BETWEEN 0 AND 10 AND task_growth BETWEEN 0 AND 10),
  CONSTRAINT pet_settings_feed_check CHECK (feed_price BETWEEN 0 AND 1000000 AND feed_daily_limit BETWEEN 0 AND 3),
  CONSTRAINT pet_settings_hours_check CHECK (jsonb_typeof(hours) = 'array' AND jsonb_array_length(hours) <= 8),
  CONSTRAINT pet_settings_reward_check CHECK (reward_amount BETWEEN 0 AND 1000000),
  CONSTRAINT pet_settings_shop_check CHECK (jsonb_typeof(shop_prices) = 'object'),
  CONSTRAINT pet_settings_version_check CHECK (version >= 1)
);

-- Every pet a student has had. At most one is being raised at a time; a graduated pet keeps its record.
CREATE TABLE public.pets (
  tenant_id uuid NOT NULL,
  pet_id text NOT NULL,
  student_id text NOT NULL,
  species text NOT NULL,
  -- Picked when the egg hatches (an egg shows no color).
  color text,
  name text NOT NULL,
  stage smallint NOT NULL DEFAULT 0,
  growth bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'RAISING',
  adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  hatched_at timestamptz,
  graduated_at timestamptz,
  graduate_operation_id text,
  graduate_reward_amount bigint,
  graduate_reward_item text,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT pets_pkey PRIMARY KEY (tenant_id, pet_id),
  CONSTRAINT pets_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT pets_id_check CHECK (pet_id = btrim(pet_id) AND length(pet_id) BETWEEN 1 AND 200),
  CONSTRAINT pets_species_check CHECK (species IN ('dog', 'cat', 'rabbit', 'hamster', 'canary', 'turtle', 'lizard')),
  CONSTRAINT pets_color_check CHECK (color IS NULL OR color ~ '^[a-z]{1,20}$'),
  CONSTRAINT pets_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 8),
  CONSTRAINT pets_stage_check CHECK (stage BETWEEN 0 AND 3),
  CONSTRAINT pets_growth_check CHECK (growth BETWEEN 0 AND 9007199254740991),
  CONSTRAINT pets_status_check CHECK (status IN ('RAISING', 'GRADUATED')),
  CONSTRAINT pets_hatch_shape_check CHECK ((stage = 0) = (color IS NULL) AND (stage = 0) = (hatched_at IS NULL)),
  CONSTRAINT pets_graduate_shape_check CHECK (
    (status = 'RAISING' AND graduated_at IS NULL AND graduate_operation_id IS NULL AND graduate_reward_amount IS NULL
      AND graduate_reward_item IS NULL)
    OR (status = 'GRADUATED' AND stage = 3 AND graduated_at >= adopted_at AND graduate_operation_id IS NOT NULL
      AND graduate_reward_amount >= 0 AND graduate_reward_item IS NOT NULL)),
  CONSTRAINT pets_version_check CHECK (version >= 1)
);
CREATE UNIQUE INDEX pets_one_raising ON public.pets (tenant_id, student_id) WHERE status = 'RAISING';
CREATE INDEX pets_student_idx ON public.pets (tenant_id, student_id, adopted_at DESC);

-- Every change to a pet's growth, append-only. A cancelled feeding or task reward adds a CANCEL row.
-- The first care of a Korea-time day adds CARE growth (once per pet per day).
CREATE TABLE public.pet_growth (
  tenant_id uuid NOT NULL,
  growth_id text NOT NULL,
  pet_id text NOT NULL,
  event_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
  source text NOT NULL,
  student_id text NOT NULL,
  amount integer NOT NULL,
  care_date date,
  transaction_id text,
  operation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pet_growth_pkey PRIMARY KEY (tenant_id, growth_id),
  CONSTRAINT pet_growth_sequence_unique UNIQUE (tenant_id, event_sequence),
  CONSTRAINT pet_growth_pet_fk FOREIGN KEY (tenant_id, pet_id) REFERENCES public.pets (tenant_id, pet_id),
  CONSTRAINT pet_growth_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT pet_growth_transaction_fk FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions (tenant_id, transaction_id),
  CONSTRAINT pet_growth_id_check CHECK (growth_id = btrim(growth_id) AND length(growth_id) BETWEEN 1 AND 200),
  CONSTRAINT pet_growth_source_check CHECK (source IN ('CARE', 'TASK', 'CANCEL')),
  CONSTRAINT pet_growth_amount_check CHECK (amount <> 0 AND amount BETWEEN -1000000 AND 1000000
    AND (source = 'CANCEL') = (amount < 0)),
  CONSTRAINT pet_growth_care_shape_check CHECK ((source = 'CARE') = (care_date IS NOT NULL))
);
CREATE UNIQUE INDEX pet_growth_one_care_a_day ON public.pet_growth (tenant_id, pet_id, care_date) WHERE source = 'CARE';
CREATE INDEX pet_growth_pet_idx ON public.pet_growth (tenant_id, pet_id, event_sequence);
CREATE INDEX pet_growth_transaction_idx ON public.pet_growth (tenant_id, transaction_id) WHERE transaction_id IS NOT NULL;
CREATE TRIGGER pet_growth_immutable BEFORE UPDATE OR DELETE ON public.pet_growth
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();

-- Every care, append-only: warming an egg (free) or feeding (its purchase when it has a price).
-- The daily limit counts these by Korea-time day.
CREATE TABLE public.pet_cares (
  tenant_id uuid NOT NULL,
  care_id text NOT NULL,
  pet_id text NOT NULL,
  student_id text NOT NULL,
  kind text NOT NULL,
  care_date date NOT NULL,
  transaction_id text,
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pet_cares_pkey PRIMARY KEY (tenant_id, care_id),
  CONSTRAINT pet_cares_pet_fk FOREIGN KEY (tenant_id, pet_id) REFERENCES public.pets (tenant_id, pet_id),
  CONSTRAINT pet_cares_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT pet_cares_transaction_fk FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions (tenant_id, transaction_id),
  CONSTRAINT pet_cares_id_check CHECK (care_id = btrim(care_id) AND length(care_id) BETWEEN 1 AND 200),
  CONSTRAINT pet_cares_kind_check CHECK (kind IN ('WARM', 'FEED')),
  CONSTRAINT pet_cares_warm_free_check CHECK (kind = 'FEED' OR transaction_id IS NULL)
);
CREATE INDEX pet_cares_student_day_idx ON public.pet_cares (tenant_id, student_id, care_date);
CREATE INDEX pet_cares_pet_idx ON public.pet_cares (tenant_id, pet_id, created_at DESC);
CREATE TRIGGER pet_cares_immutable BEFORE UPDATE OR DELETE ON public.pet_cares
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row();

-- Decor a student owns. Cancelling its purchase takes it back (revoked_at).
CREATE TABLE public.pet_decor (
  tenant_id uuid NOT NULL,
  decor_id text NOT NULL,
  student_id text NOT NULL,
  item_key text NOT NULL,
  price bigint NOT NULL,
  transaction_id text,
  operation_id text NOT NULL,
  bought_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT pet_decor_pkey PRIMARY KEY (tenant_id, decor_id),
  CONSTRAINT pet_decor_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT pet_decor_transaction_fk FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions (tenant_id, transaction_id),
  CONSTRAINT pet_decor_id_check CHECK (decor_id = btrim(decor_id) AND length(decor_id) BETWEEN 1 AND 200),
  CONSTRAINT pet_decor_key_check CHECK (item_key ~ '^[a-z]{1,20}:[a-z]{1,20}$'),
  CONSTRAINT pet_decor_price_check CHECK (price BETWEEN 0 AND 1000000 AND (price > 0) = (transaction_id IS NOT NULL)),
  CONSTRAINT pet_decor_revoked_check CHECK (revoked_at IS NULL OR revoked_at >= bought_at)
);
CREATE UNIQUE INDEX pet_decor_owned ON public.pet_decor (tenant_id, student_id, item_key) WHERE revoked_at IS NULL;
CREATE INDEX pet_decor_transaction_idx ON public.pet_decor (tenant_id, transaction_id) WHERE transaction_id IS NOT NULL;

-- The room each student has set up ({wall, rug, bed, plant, frame, toy}); it stays across pets.
CREATE TABLE public.pet_rooms (
  tenant_id uuid NOT NULL,
  student_id text NOT NULL,
  decor jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pet_rooms_pkey PRIMARY KEY (tenant_id, student_id),
  CONSTRAINT pet_rooms_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT pet_rooms_decor_check CHECK (jsonb_typeof(decor) = 'object'),
  CONSTRAINT pet_rooms_version_check CHECK (version >= 1)
);

-- A graduation reward product lands in the 보관함 like a harvest reward.
ALTER TABLE public.student_items DROP CONSTRAINT student_items_source_check;
ALTER TABLE public.student_items ADD CONSTRAINT student_items_source_check
  CHECK (source IN ('TREE_HARVEST', 'STORE_PURCHASE', 'TEACHER', 'PET_GRADUATION'));

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pet_settings', 'pets', 'pet_growth', 'pet_cares', 'pet_decor', 'pet_rooms']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
  END LOOP;
END
$rls$;
