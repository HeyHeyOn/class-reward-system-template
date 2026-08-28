-- Operational monetary values use signed bigint values constrained to JavaScript's
-- safe-integer range. `legacy_total_amount` preserves the historical UI convention;
-- `balance_delta` is canonical and always satisfies after - before = delta.

CREATE TABLE students (
  tenant_id uuid NOT NULL,
  student_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT students_pkey PRIMARY KEY (tenant_id, student_id),
  CONSTRAINT students_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT students_id_check CHECK (student_id = btrim(student_id) AND length(student_id) > 0),
  CONSTRAINT students_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT students_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE accounts (
  tenant_id uuid NOT NULL,
  student_id text NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_pkey PRIMARY KEY (tenant_id, student_id),
  CONSTRAINT accounts_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES students (tenant_id, student_id),
  CONSTRAINT accounts_balance_safe_check CHECK (balance BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT accounts_version_check CHECK (version >= 1 AND version <= 9007199254740991)
);

CREATE TABLE products (
  tenant_id uuid NOT NULL,
  product_id text NOT NULL,
  name text NOT NULL,
  price bigint NOT NULL,
  stock bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  image_url text,
  category text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT products_pkey PRIMARY KEY (tenant_id, product_id),
  CONSTRAINT products_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT products_id_check CHECK (product_id = btrim(product_id) AND length(product_id) > 0),
  CONSTRAINT products_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT products_price_check CHECK (price BETWEEN 0 AND 9007199254740991),
  CONSTRAINT products_stock_check CHECK (stock BETWEEN 0 AND 9007199254740991),
  CONSTRAINT products_deleted_chronology_check CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE TABLE promotions (
  tenant_id uuid NOT NULL,
  promotion_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  type text NOT NULL,
  n_plus_one_buy_quantity bigint,
  n_plus_one_free_quantity bigint,
  promotional_price bigint,
  percent_discount numeric,
  fixed_discount bigint,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT promotions_pkey PRIMARY KEY (tenant_id, promotion_id),
  CONSTRAINT promotions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT promotions_id_check CHECK (promotion_id = btrim(promotion_id) AND length(promotion_id) > 0),
  CONSTRAINT promotions_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT promotions_type_check CHECK (type IN ('N_PLUS_ONE', 'PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT')),
  CONSTRAINT promotions_variant_check CHECK (COALESCE((
    (type = 'N_PLUS_ONE'
      AND n_plus_one_buy_quantity BETWEEN 1 AND 9007199254740991
      AND n_plus_one_free_quantity BETWEEN 1 AND 9007199254740991
      AND promotional_price IS NULL AND percent_discount IS NULL AND fixed_discount IS NULL)
    OR (type = 'PROMOTIONAL_PRICE'
      AND promotional_price BETWEEN 0 AND 9007199254740991
      AND n_plus_one_buy_quantity IS NULL AND n_plus_one_free_quantity IS NULL
      AND percent_discount IS NULL AND fixed_discount IS NULL)
    OR (type = 'PERCENT_DISCOUNT'
      AND percent_discount > 0 AND percent_discount <= 100
      AND n_plus_one_buy_quantity IS NULL AND n_plus_one_free_quantity IS NULL
      AND promotional_price IS NULL AND fixed_discount IS NULL)
    OR (type = 'FIXED_DISCOUNT'
      AND fixed_discount BETWEEN 1 AND 9007199254740991
      AND n_plus_one_buy_quantity IS NULL AND n_plus_one_free_quantity IS NULL
      AND promotional_price IS NULL AND percent_discount IS NULL)
  ), false)),
  CONSTRAINT promotions_window_check CHECK (ends_at > starts_at),
  CONSTRAINT promotions_schema_version_check CHECK (schema_version >= 1),
  CONSTRAINT promotions_deleted_chronology_check CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE TABLE promotion_products (
  tenant_id uuid NOT NULL,
  promotion_product_id text NOT NULL,
  promotion_id text NOT NULL,
  product_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL DEFAULT 1,
  CONSTRAINT promotion_products_pkey PRIMARY KEY (tenant_id, promotion_product_id),
  CONSTRAINT promotion_products_link_unique UNIQUE (tenant_id, promotion_id, product_id),
  CONSTRAINT promotion_products_promotion_fk FOREIGN KEY (tenant_id, promotion_id)
    REFERENCES promotions (tenant_id, promotion_id),
  CONSTRAINT promotion_products_product_fk FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, product_id),
  CONSTRAINT promotion_products_id_check CHECK (promotion_product_id = btrim(promotion_product_id) AND length(promotion_product_id) > 0),
  CONSTRAINT promotion_products_schema_version_check CHECK (schema_version >= 1)
);

CREATE TABLE tasks (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  task_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  reward bigint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  available_from timestamptz,
  available_until timestamptz,
  due_at timestamptz,
  prerequisite_task_instance_id text,
  padlet_board_id text,
  current_schedule jsonb NOT NULL,
  pending_schedule jsonb,
  schedule_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT tasks_pkey PRIMARY KEY (tenant_id, task_instance_id),
  CONSTRAINT tasks_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tasks_prerequisite_fk FOREIGN KEY (tenant_id, prerequisite_task_instance_id)
    REFERENCES tasks (tenant_id, task_instance_id),
  CONSTRAINT tasks_id_check CHECK (task_id = btrim(task_id) AND length(task_id) > 0),
  CONSTRAINT tasks_instance_id_check CHECK (task_instance_id = btrim(task_instance_id) AND length(task_instance_id) > 0),
  CONSTRAINT tasks_title_check CHECK (length(btrim(title)) > 0),
  CONSTRAINT tasks_reward_safe_check CHECK (reward BETWEEN 0 AND 9007199254740991),
  CONSTRAINT tasks_availability_check CHECK (available_until IS NULL OR available_from IS NULL OR available_until > available_from),
  CONSTRAINT tasks_schedule_schema_version_check CHECK (schedule_schema_version >= 1),
  CONSTRAINT tasks_current_schedule_check CHECK (COALESCE((
    jsonb_typeof(current_schedule) = 'object'
    AND jsonb_typeof(current_schedule -> 'ruleVersion') = 'number'
    AND (current_schedule ->> 'ruleVersion') ~ '^[1-9][0-9]*$'
    AND (current_schedule ->> 'ruleVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND jsonb_typeof(current_schedule -> 'effectiveFrom') = 'string'
    AND current_schedule ->> 'timeZone' = 'Asia/Seoul'
    AND jsonb_typeof(current_schedule -> 'recurrence') = 'object'
    AND jsonb_typeof(current_schedule -> 'resetCompletionOnCycle') = 'boolean'
    AND jsonb_typeof(current_schedule -> 'resetAssignmentOnCycle') = 'boolean'
  ), false)),
  CONSTRAINT tasks_pending_schedule_check CHECK (
    pending_schedule IS NULL OR COALESCE((
      jsonb_typeof(pending_schedule) = 'object'
      AND jsonb_typeof(pending_schedule -> 'ruleVersion') = 'number'
      AND (pending_schedule ->> 'ruleVersion') ~ '^[1-9][0-9]*$'
      AND (pending_schedule ->> 'ruleVersion')::numeric BETWEEN 1 AND 9007199254740991
      AND jsonb_typeof(pending_schedule -> 'effectiveFrom') = 'string'
      AND pending_schedule ->> 'timeZone' = 'Asia/Seoul'
      AND jsonb_typeof(pending_schedule -> 'recurrence') = 'object'
      AND jsonb_typeof(pending_schedule -> 'resetCompletionOnCycle') = 'boolean'
      AND jsonb_typeof(pending_schedule -> 'resetAssignmentOnCycle') = 'boolean'
    ), false)
  ),
  CONSTRAINT tasks_not_self_prerequisite_check CHECK (prerequisite_task_instance_id IS NULL OR prerequisite_task_instance_id <> task_instance_id),
  CONSTRAINT tasks_deleted_chronology_check CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);
CREATE UNIQUE INDEX tasks_active_business_id_unique
  ON tasks (tenant_id, task_id) WHERE deleted_at IS NULL;

CREATE TABLE task_allowed_students (
  tenant_id uuid NOT NULL,
  task_instance_id text NOT NULL,
  student_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_allowed_students_pkey PRIMARY KEY (tenant_id, task_instance_id, student_id),
  CONSTRAINT task_allowed_students_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES tasks (tenant_id, task_instance_id),
  CONSTRAINT task_allowed_students_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES students (tenant_id, student_id)
);

CREATE TABLE task_assignments (
  tenant_id uuid NOT NULL,
  assignment_id text NOT NULL,
  event_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
  task_id_snapshot text NOT NULL,
  task_instance_id text NOT NULL,
  cycle_id text NOT NULL,
  cycle_start_at timestamptz NOT NULL,
  cycle_end_at timestamptz,
  rule_version integer NOT NULL,
  timezone text NOT NULL,
  student_id text NOT NULL,
  event_type text NOT NULL,
  source text NOT NULL,
  previous_assignment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL DEFAULT 1,
  note text,
  CONSTRAINT task_assignments_pkey PRIMARY KEY (tenant_id, assignment_id),
  CONSTRAINT task_assignments_event_sequence_unique UNIQUE (tenant_id, event_sequence),
  CONSTRAINT task_assignments_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES tasks (tenant_id, task_instance_id),
  CONSTRAINT task_assignments_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES students (tenant_id, student_id),
  CONSTRAINT task_assignments_previous_fk FOREIGN KEY (tenant_id, previous_assignment_id)
    REFERENCES task_assignments (tenant_id, assignment_id),
  CONSTRAINT task_assignments_id_check CHECK (assignment_id = btrim(assignment_id) AND length(assignment_id) > 0),
  CONSTRAINT task_assignments_task_id_snapshot_check
    CHECK (task_id_snapshot = btrim(task_id_snapshot) AND length(task_id_snapshot) > 0),
  CONSTRAINT task_assignments_previous_id_check CHECK (previous_assignment_id IS NULL OR (previous_assignment_id = btrim(previous_assignment_id) AND length(previous_assignment_id) > 0)),
  CONSTRAINT task_assignments_not_self_previous_check
    CHECK (previous_assignment_id IS NULL OR previous_assignment_id <> assignment_id),
  CONSTRAINT task_assignments_cycle_check CHECK (cycle_end_at IS NULL OR cycle_end_at > cycle_start_at),
  CONSTRAINT task_assignments_rule_version_check CHECK (rule_version >= 1),
  CONSTRAINT task_assignments_timezone_check CHECK (timezone = 'Asia/Seoul'),
  CONSTRAINT task_assignments_event_type_check CHECK (event_type IN ('ASSIGNED', 'UNASSIGNED')),
  CONSTRAINT task_assignments_source_check CHECK (source IN ('ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD')),
  CONSTRAINT task_assignments_schema_version_check CHECK (schema_version >= 1)
);

CREATE TABLE transactions (
  tenant_id uuid NOT NULL,
  transaction_id text NOT NULL,
  event_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
  occurred_at timestamptz NOT NULL,
  student_id text NOT NULL,
  student_name_snapshot text NOT NULL,
  kind text NOT NULL,
  legacy_total_amount bigint NOT NULL,
  balance_delta bigint NOT NULL,
  balance_before bigint NOT NULL,
  balance_after bigint NOT NULL,
  operator_snapshot text NOT NULL,
  legacy_status_snapshot text,
  reverses_transaction_id text,
  operation_id text,
  operation_hash text,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_pkey PRIMARY KEY (tenant_id, transaction_id),
  CONSTRAINT transactions_event_sequence_unique UNIQUE (tenant_id, event_sequence),
  CONSTRAINT transactions_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES students (tenant_id, student_id),
  CONSTRAINT transactions_reversal_fk FOREIGN KEY (tenant_id, reverses_transaction_id)
    REFERENCES transactions (tenant_id, transaction_id),
  CONSTRAINT transactions_kind_check CHECK (kind IN ('CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT', 'TASK_REWARD', 'LEGACY')),
  CONSTRAINT transactions_id_check CHECK (transaction_id = btrim(transaction_id) AND length(transaction_id) > 0),
  CONSTRAINT transactions_reversal_id_check CHECK (reverses_transaction_id IS NULL OR (reverses_transaction_id = btrim(reverses_transaction_id) AND length(reverses_transaction_id) > 0)),
  CONSTRAINT transactions_not_self_reversal_check
    CHECK (reverses_transaction_id IS NULL OR reverses_transaction_id <> transaction_id),
  CONSTRAINT transactions_operation_id_check CHECK (operation_id IS NULL OR (operation_id = btrim(operation_id) AND length(operation_id) > 0)),
  CONSTRAINT transactions_safe_money_check CHECK (
    legacy_total_amount BETWEEN -9007199254740991 AND 9007199254740991
    AND balance_delta BETWEEN -9007199254740991 AND 9007199254740991
    AND balance_before BETWEEN -9007199254740991 AND 9007199254740991
    AND balance_after BETWEEN -9007199254740991 AND 9007199254740991
  ),
  CONSTRAINT transactions_balance_delta_check CHECK (balance_after - balance_before = balance_delta),
  CONSTRAINT transactions_reversal_shape_check CHECK (
    (kind = 'CANCELLATION' AND reverses_transaction_id IS NOT NULL)
    OR (kind <> 'CANCELLATION' AND reverses_transaction_id IS NULL)
  ),
  CONSTRAINT transactions_operation_pair_check CHECK ((operation_id IS NULL) = (operation_hash IS NULL)),
  CONSTRAINT transactions_operation_hash_check CHECK (operation_hash IS NULL OR length(btrim(operation_hash)) > 0),
  CONSTRAINT transactions_schema_version_check CHECK (schema_version >= 1)
);

CREATE TABLE transaction_items (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_id text NOT NULL,
  line_number integer NOT NULL DEFAULT 1,
  product_id_snapshot text NOT NULL,
  current_product_id text,
  product_name_snapshot text NOT NULL,
  quantity bigint NOT NULL,
  unit_price_snapshot bigint NOT NULL,
  subtotal_snapshot bigint NOT NULL,
  regular_unit_price bigint,
  regular_total bigint,
  total_quantity bigint,
  paid_quantity bigint,
  free_quantity bigint,
  final_total bigint,
  total_discount bigint,
  adjustments_snapshot jsonb,
  applied_promotions_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_items_pkey PRIMARY KEY (tenant_id, item_id),
  CONSTRAINT transaction_items_transaction_line_unique UNIQUE (tenant_id, transaction_id, line_number),
  CONSTRAINT transaction_items_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES transactions (tenant_id, transaction_id),
  CONSTRAINT transaction_items_current_product_fk FOREIGN KEY (tenant_id, current_product_id)
    REFERENCES products (tenant_id, product_id),
  CONSTRAINT transaction_items_product_snapshot_check CHECK (product_id_snapshot = btrim(product_id_snapshot) AND length(product_id_snapshot) > 0),
  CONSTRAINT transaction_items_base_check CHECK (
    quantity BETWEEN 1 AND 9007199254740991
    AND unit_price_snapshot BETWEEN -9007199254740991 AND 9007199254740991
    AND subtotal_snapshot BETWEEN -9007199254740991 AND 9007199254740991
  ),
  CONSTRAINT transaction_items_extended_shape_check CHECK (
    num_nonnulls(regular_unit_price, regular_total, total_quantity, paid_quantity,
      free_quantity, final_total, total_discount, adjustments_snapshot,
      applied_promotions_snapshot) IN (0, 9)
  ),
  CONSTRAINT transaction_items_extended_values_check CHECK (
    total_quantity IS NULL OR (
      regular_unit_price BETWEEN 0 AND 9007199254740991
      AND regular_total BETWEEN 0 AND 9007199254740991
      AND total_quantity BETWEEN 1 AND 9007199254740991
      AND paid_quantity BETWEEN 0 AND 9007199254740991
      AND free_quantity BETWEEN 0 AND 9007199254740991
      AND final_total BETWEEN 0 AND 9007199254740991
      AND total_discount BETWEEN 0 AND 9007199254740991
      AND paid_quantity + free_quantity = total_quantity
      AND jsonb_typeof(adjustments_snapshot) = 'array'
      AND jsonb_typeof(applied_promotions_snapshot) = 'array'
    )
  )
);

CREATE TABLE adjustments (
  tenant_id uuid NOT NULL,
  adjustment_id text NOT NULL,
  transaction_id text NOT NULL,
  mode text NOT NULL,
  requested_amount bigint NOT NULL,
  operator_snapshot text NOT NULL,
  legacy_adjustment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adjustments_pkey PRIMARY KEY (tenant_id, adjustment_id),
  CONSTRAINT adjustments_transaction_unique UNIQUE (tenant_id, transaction_id),
  CONSTRAINT adjustments_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES transactions (tenant_id, transaction_id),
  CONSTRAINT adjustments_mode_check CHECK (mode IN ('add', 'subtract', 'set')),
  CONSTRAINT adjustments_id_check CHECK (adjustment_id = btrim(adjustment_id) AND length(adjustment_id) > 0),
  CONSTRAINT adjustments_amount_safe_check CHECK (requested_amount BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE TABLE inventory_ledger (
  tenant_id uuid NOT NULL,
  inventory_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
  product_id text NOT NULL,
  transaction_id text,
  quantity_delta bigint NOT NULL,
  stock_before bigint NOT NULL,
  stock_after bigint NOT NULL,
  reason text NOT NULL,
  operation_id text,
  operation_hash text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_ledger_pkey PRIMARY KEY (tenant_id, inventory_event_id),
  CONSTRAINT inventory_ledger_event_sequence_unique UNIQUE (tenant_id, event_sequence),
  CONSTRAINT inventory_ledger_product_fk FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, product_id),
  CONSTRAINT inventory_ledger_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES transactions (tenant_id, transaction_id),
  CONSTRAINT inventory_ledger_stock_check CHECK (
    quantity_delta BETWEEN -9007199254740991 AND 9007199254740991
    AND stock_before BETWEEN 0 AND 9007199254740991
    AND stock_after BETWEEN 0 AND 9007199254740991
    AND stock_after - stock_before = quantity_delta
  ),
  CONSTRAINT inventory_ledger_reason_check CHECK (reason IN ('CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT', 'LEGACY_IMPORT')),
  CONSTRAINT inventory_ledger_operation_id_check CHECK (operation_id IS NULL OR (operation_id = btrim(operation_id) AND length(operation_id) > 0)),
  CONSTRAINT inventory_ledger_operation_pair_check CHECK ((operation_id IS NULL) = (operation_hash IS NULL)),
  CONSTRAINT inventory_ledger_operation_hash_check CHECK (operation_hash IS NULL OR length(btrim(operation_hash)) > 0)
);

CREATE TABLE task_completions (
  tenant_id uuid NOT NULL,
  completion_id text NOT NULL,
  event_sequence bigint GENERATED BY DEFAULT AS IDENTITY,
  completed_at timestamptz NOT NULL,
  task_instance_id text,
  task_id_snapshot text NOT NULL,
  task_name_snapshot text NOT NULL,
  student_id text NOT NULL,
  student_name_snapshot text NOT NULL,
  reward_snapshot bigint NOT NULL,
  balance_before bigint NOT NULL,
  balance_after bigint NOT NULL,
  status text NOT NULL,
  note text,
  cycle_id text,
  cycle_start_at timestamptz,
  cycle_end_at timestamptz,
  rule_version integer,
  timezone text,
  source text,
  assignment_id text,
  transaction_id text,
  operation_id text,
  operation_hash text,
  schema_version integer NOT NULL DEFAULT 1,
  evidence_provider text,
  evidence_board_id text,
  evidence_post_id text,
  evidence_created_at timestamptz,
  evidence_author_full_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_completions_pkey PRIMARY KEY (tenant_id, completion_id),
  CONSTRAINT task_completions_event_sequence_unique UNIQUE (tenant_id, event_sequence),
  CONSTRAINT task_completions_task_fk FOREIGN KEY (tenant_id, task_instance_id)
    REFERENCES tasks (tenant_id, task_instance_id),
  CONSTRAINT task_completions_student_fk FOREIGN KEY (tenant_id, student_id)
    REFERENCES students (tenant_id, student_id),
  CONSTRAINT task_completions_assignment_fk FOREIGN KEY (tenant_id, assignment_id)
    REFERENCES task_assignments (tenant_id, assignment_id),
  CONSTRAINT task_completions_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES transactions (tenant_id, transaction_id),
  CONSTRAINT task_completions_id_check
    CHECK (completion_id = btrim(completion_id) AND length(completion_id) > 0),
  CONSTRAINT task_completions_task_id_snapshot_check
    CHECK (task_id_snapshot = btrim(task_id_snapshot) AND length(task_id_snapshot) > 0),
  CONSTRAINT task_completions_status_check CHECK (length(btrim(status)) > 0),
  CONSTRAINT task_completions_source_check
    CHECK (source IS NULL OR source IN ('BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET')),
  CONSTRAINT task_completions_reward_check CHECK (reward_snapshot BETWEEN 0 AND 9007199254740991),
  CONSTRAINT task_completions_balances_check CHECK (
    balance_before BETWEEN -9007199254740991 AND 9007199254740991
    AND balance_after BETWEEN -9007199254740991 AND 9007199254740991
  ),
  CONSTRAINT task_completions_carry_forward_check
    CHECK (source IS DISTINCT FROM 'CARRY_FORWARD' OR reward_snapshot = 0),
  CONSTRAINT task_completions_cycle_metadata_check
    CHECK (num_nonnulls(task_instance_id, cycle_id, cycle_start_at, rule_version, timezone, source) IN (0, 6)),
  CONSTRAINT task_completions_cycle_window_check
    CHECK (cycle_end_at IS NULL OR (cycle_start_at IS NOT NULL AND cycle_end_at > cycle_start_at)),
  CONSTRAINT task_completions_rule_version_check CHECK (rule_version IS NULL OR rule_version >= 1),
  CONSTRAINT task_completions_timezone_check CHECK (timezone IS NULL OR timezone = 'Asia/Seoul'),
  CONSTRAINT task_completions_operation_id_check
    CHECK (operation_id IS NULL OR (operation_id = btrim(operation_id) AND length(operation_id) > 0)),
  CONSTRAINT task_completions_operation_pair_check CHECK ((operation_id IS NULL) = (operation_hash IS NULL)),
  CONSTRAINT task_completions_operation_hash_check CHECK (operation_hash IS NULL OR length(btrim(operation_hash)) > 0),
  CONSTRAINT task_completions_schema_version_check CHECK (schema_version >= 1),
  CONSTRAINT task_completions_evidence_check CHECK (
    num_nonnulls(evidence_provider, evidence_board_id, evidence_post_id,
      evidence_created_at, evidence_author_full_name) = 0
    OR (
      num_nonnulls(evidence_provider, evidence_board_id, evidence_post_id,
        evidence_created_at, evidence_author_full_name) = 5
      AND evidence_provider = 'PADLET'
      AND length(btrim(evidence_board_id)) > 0
      AND length(btrim(evidence_post_id)) > 0
      AND length(btrim(evidence_author_full_name)) > 0
    )
  )
);

CREATE INDEX students_active_name_idx ON students (tenant_id, name) WHERE status = 'ACTIVE';
CREATE INDEX products_active_sort_idx ON products (tenant_id, sort_order, product_id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX promotions_active_sort_idx ON promotions (tenant_id, sort_order, promotion_id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX tasks_active_sort_idx ON tasks (tenant_id, sort_order, task_id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX task_assignments_cycle_student_event_idx ON task_assignments (tenant_id, task_instance_id, cycle_id, student_id, event_sequence);
CREATE INDEX task_completions_cycle_student_event_idx ON task_completions (tenant_id, task_instance_id, cycle_id, student_id, event_sequence);
CREATE INDEX transactions_student_history_idx ON transactions (tenant_id, student_id, occurred_at DESC, event_sequence DESC);
CREATE UNIQUE INDEX transactions_operation_unique ON transactions (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX task_completions_operation_unique ON task_completions (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX inventory_ledger_product_event_idx ON inventory_ledger (tenant_id, product_id, event_sequence);
CREATE UNIQUE INDEX inventory_ledger_operation_unique ON inventory_ledger (tenant_id, operation_id) WHERE operation_id IS NOT NULL;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'students', 'accounts', 'products', 'promotions', 'promotion_products',
    'tasks', 'task_allowed_students', 'task_assignments', 'task_completions',
    'transactions', 'transaction_items', 'adjustments', 'inventory_ledger'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END
$rls$;
