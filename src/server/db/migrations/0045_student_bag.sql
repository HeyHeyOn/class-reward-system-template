-- Student bag: the items each student keeps (coupons for now; badges and collectibles later).
-- Coupons arrive from a class tree harvest or from buying a store product marked as a coupon,
-- and only the teacher marks one used. The 0044 reward_vouchers rows are copied here; that table is
-- left in place (unused by the new app) so the app still running during the deploy keeps working,
-- and goes in a later cleanup migration.
-- Apply as the migration/BYPASSRLS owner in one transaction; runtime grants are in
-- provisioning/runtimeGrants.sql.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'student bag requires migration/BYPASSRLS ownership';
  END IF;
END $$;

-- Store products whose purchase puts coupons into the buyer's bag (one per unit bought). Kept
-- beside products so the product records and their write checks stay as they are.
CREATE TABLE public.coupon_products (
  tenant_id uuid NOT NULL,
  product_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT coupon_products_pkey PRIMARY KEY (tenant_id, product_id),
  CONSTRAINT coupon_products_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, product_id)
);

CREATE TABLE public.student_items (
  tenant_id uuid NOT NULL,
  item_id text NOT NULL,
  student_id text NOT NULL,
  kind text NOT NULL DEFAULT 'COUPON',
  title text NOT NULL,
  source text NOT NULL,
  source_ref text NOT NULL,
  product_id text,
  transaction_id text,
  operation_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT student_items_pkey PRIMARY KEY (tenant_id, item_id),
  CONSTRAINT student_items_student_fk FOREIGN KEY (tenant_id, student_id) REFERENCES public.students (tenant_id, student_id),
  CONSTRAINT student_items_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, product_id),
  CONSTRAINT student_items_transaction_fk FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions (tenant_id, transaction_id),
  CONSTRAINT student_items_id_check CHECK (item_id = btrim(item_id) AND length(item_id) BETWEEN 1 AND 200),
  CONSTRAINT student_items_kind_check CHECK (kind IN ('COUPON')),
  CONSTRAINT student_items_title_check CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 60),
  CONSTRAINT student_items_source_check CHECK (source IN ('TREE_HARVEST', 'STORE_PURCHASE')),
  CONSTRAINT student_items_purchase_shape_check CHECK ((source = 'STORE_PURCHASE') = (product_id IS NOT NULL AND transaction_id IS NOT NULL)),
  CONSTRAINT student_items_used_check CHECK (used_at IS NULL OR used_at >= issued_at),
  -- A cancelled purchase takes back its unused coupons; a used one cannot be taken back.
  CONSTRAINT student_items_revoked_check CHECK (revoked_at IS NULL OR (revoked_at >= issued_at AND used_at IS NULL))
);
CREATE INDEX student_items_student_idx ON public.student_items (tenant_id, student_id, issued_at DESC);
CREATE INDEX student_items_transaction_idx ON public.student_items (tenant_id, transaction_id) WHERE transaction_id IS NOT NULL;

INSERT INTO public.student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, operation_id, issued_at, used_at)
  SELECT tenant_id, voucher_id, student_id, 'COUPON', title, source, source_ref, operation_id, issued_at, used_at
  FROM public.reward_vouchers
  ON CONFLICT (tenant_id, item_id) DO NOTHING;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['coupon_products', 'student_items']
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
