-- Digital product types and the 교환권.
--   A 디지털 상품 (coupon_products row) now has a type:
--     CONSUMABLE   소모품 — used up: the teacher marks it used, and one with a voucher_product_id also
--                  works as a 교환권 at a store checkout (pays for one unit of that product)
--     COLLECTIBLE  수집품 — kept, never used; the 보관함 shows its picture and description
--   A storage item (student_items) carries the same type. A harvest reward is a store product (or
--   none): a digital product lands as itself, any other product as its 교환권 (a consumable paying for
--   that product). The teacher can also put digital products into a student's storage (source
--   TEACHER) or take items back.
--   Storage items so far were all coupons and become consumables. The app from before this migration
--   still inserts kind 'COUPON' until its deploy finishes, so that value stays accepted (read as a
--   consumable); a later cleanup converts the stragglers and drops it.
-- Apply as the migration/BYPASSRLS owner in one transaction; runtime grants are in
-- provisioning/runtimeGrants.sql.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'vouchers require migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.coupon_products ADD COLUMN digital_kind text NOT NULL DEFAULT 'CONSUMABLE';
ALTER TABLE public.coupon_products ADD COLUMN voucher_product_id text;
ALTER TABLE public.coupon_products ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE public.coupon_products ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.coupon_products ADD CONSTRAINT coupon_products_kind_check CHECK (digital_kind IN ('CONSUMABLE', 'COLLECTIBLE'));
ALTER TABLE public.coupon_products ADD CONSTRAINT coupon_products_voucher_check
  CHECK ((digital_kind = 'CONSUMABLE' OR voucher_product_id IS NULL) AND voucher_product_id IS DISTINCT FROM product_id);
ALTER TABLE public.coupon_products ADD CONSTRAINT coupon_products_voucher_fk
  FOREIGN KEY (tenant_id, voucher_product_id) REFERENCES public.products (tenant_id, product_id);
ALTER TABLE public.coupon_products ADD CONSTRAINT coupon_products_description_check
  CHECK (description = btrim(description) AND char_length(description) <= 500);

ALTER TABLE public.student_items DROP CONSTRAINT student_items_kind_check;
ALTER TABLE public.student_items DROP CONSTRAINT student_items_source_check;
ALTER TABLE public.student_items DROP CONSTRAINT student_items_purchase_shape_check;
ALTER TABLE public.student_items ALTER COLUMN kind SET DEFAULT 'CONSUMABLE';
UPDATE public.student_items SET kind = 'CONSUMABLE' WHERE kind = 'COUPON';
ALTER TABLE public.student_items ADD CONSTRAINT student_items_kind_check CHECK (kind IN ('CONSUMABLE', 'COLLECTIBLE', 'COUPON'));
ALTER TABLE public.student_items ADD CONSTRAINT student_items_source_check CHECK (source IN ('TREE_HARVEST', 'STORE_PURCHASE', 'TEACHER'));
-- A store purchase item comes from its checkout transaction; a reward or a teacher's gift has none.
ALTER TABLE public.student_items ADD CONSTRAINT student_items_source_shape_check
  CHECK ((source = 'STORE_PURCHASE') = (transaction_id IS NOT NULL) AND (source <> 'STORE_PURCHASE' OR product_id IS NOT NULL));

-- The product a 교환권 pays for, and the checkout that used it (cancelling that checkout gives it back).
ALTER TABLE public.student_items ADD COLUMN voucher_product_id text;
ALTER TABLE public.student_items ADD CONSTRAINT student_items_voucher_fk
  FOREIGN KEY (tenant_id, voucher_product_id) REFERENCES public.products (tenant_id, product_id);
ALTER TABLE public.student_items ADD CONSTRAINT student_items_voucher_check CHECK (kind <> 'COLLECTIBLE' OR voucher_product_id IS NULL);
ALTER TABLE public.student_items ADD COLUMN used_transaction_id text;
ALTER TABLE public.student_items ADD CONSTRAINT student_items_used_transaction_fk
  FOREIGN KEY (tenant_id, used_transaction_id) REFERENCES public.transactions (tenant_id, transaction_id);
ALTER TABLE public.student_items ADD CONSTRAINT student_items_used_transaction_check
  CHECK (used_transaction_id IS NULL OR (voucher_product_id IS NOT NULL AND used_at IS NOT NULL));
-- A collectible is never used.
ALTER TABLE public.student_items ADD CONSTRAINT student_items_collectible_check CHECK (kind <> 'COLLECTIBLE' OR used_at IS NULL);
CREATE INDEX student_items_used_transaction_idx ON public.student_items (tenant_id, used_transaction_id) WHERE used_transaction_id IS NOT NULL;
CREATE INDEX student_items_voucher_idx ON public.student_items (tenant_id, student_id, voucher_product_id)
  WHERE voucher_product_id IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL;

-- The harvest reward: a store product (or none).
ALTER TABLE public.growth_settings ADD COLUMN reward_product_id text;
ALTER TABLE public.growth_settings ADD CONSTRAINT growth_settings_reward_product_fk
  FOREIGN KEY (tenant_id, reward_product_id) REFERENCES public.products (tenant_id, product_id);
