-- The name a class gives its tree (students see '우리 반 {name} 3호'); 1–12 characters, trimmed.
-- Apply as the migration/BYPASSRLS owner in one transaction; growth_settings grants are unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'tree name requires migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.growth_settings ADD COLUMN tree_name text NOT NULL DEFAULT '사과나무';
ALTER TABLE public.growth_settings ADD CONSTRAINT growth_settings_tree_name_check
  CHECK (tree_name = btrim(tree_name) AND char_length(tree_name) BETWEEN 1 AND 12);
