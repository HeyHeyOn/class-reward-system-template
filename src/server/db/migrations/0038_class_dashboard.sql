-- Owner-only classroom management. Deletion is reversible; financial history
-- and migration evidence are never physically deleted or copied.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'class management requires migration/BYPASSRLS ownership';
  END IF;
END $$;

ALTER TABLE public.tenants
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_lifecycle text,
  ADD COLUMN management_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT tenants_management_version_check CHECK (management_version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT tenants_deleted_state_check CHECK (
    (deleted_at IS NULL AND deleted_lifecycle IS NULL) OR
    (deleted_at IS NOT NULL AND deleted_lifecycle IS NOT NULL AND deleted_lifecycle IN ('DRAFT','ACTIVE') AND lifecycle='SUSPENDED'));

CREATE TABLE public.class_management_operations (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL CHECK (action IN ('RENAME','DUPLICATE','DELETE','RESTORE')),
  payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.class_management_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_management_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_management_operations FROM PUBLIC;
CREATE TRIGGER class_management_immutable BEFORE UPDATE OR DELETE ON public.class_management_operations
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_row();
CREATE TRIGGER class_management_no_truncate BEFORE TRUNCATE ON public.class_management_operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_immutable_row();

CREATE OR REPLACE FUNCTION public.platform_list_memberships_by_google_subject(p_google_subject text)
RETURNS TABLE(slug text,display_name text,role text,lifecycle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT t.slug,t.display_name,m.role,t.lifecycle FROM public.users u
  JOIN public.tenant_memberships m ON m.user_id=u.id JOIN public.tenants t ON t.id=m.tenant_id
  WHERE u.google_subject=p_google_subject AND t.deleted_at IS NULL ORDER BY m.created_at,t.slug
$$;

CREATE FUNCTION public.platform_list_class_dashboard(p_google_subject text)
RETURNS TABLE(slug text,display_name text,role text,lifecycle text,deleted_at timestamptz,
  management_version text,created_at timestamptz,student_count bigint,product_count bigint,task_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT t.slug,t.display_name,m.role,t.lifecycle,t.deleted_at,t.management_version::text,t.created_at,
    (SELECT count(*) FROM public.students s WHERE s.tenant_id=t.id AND s.deleted_at IS NULL),
    (SELECT count(*) FROM public.products p WHERE p.tenant_id=t.id AND p.deleted_at IS NULL),
    (SELECT count(*) FROM public.tasks q WHERE q.tenant_id=t.id AND q.deleted_at IS NULL)
  FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
  JOIN public.tenants t ON t.id=m.tenant_id
  WHERE u.google_subject=p_google_subject AND (t.deleted_at IS NULL OR m.role='OWNER')
  ORDER BY t.created_at DESC,t.slug
$$;
REVOKE ALL ON FUNCTION public.platform_list_class_dashboard(text) FROM PUBLIC;

-- Serialize ordinary writes with deletion, including requests whose tenant
-- lookup happened before the owner moved the classroom to the trash.
CREATE FUNCTION public.guard_deleted_class_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_deleted timestamptz;
BEGIN
  IF TG_TABLE_NAME='padlet_evidence_claims' THEN
    IF TG_OP='DELETE' THEN v_id:=OLD.claimed_by_tenant_id; ELSE v_id:=NEW.claimed_by_tenant_id; END IF;
  ELSE
    IF TG_OP='DELETE' THEN v_id:=OLD.tenant_id; ELSE v_id:=NEW.tenant_id; END IF;
  END IF;
  SELECT t.deleted_at INTO v_deleted FROM public.tenants t WHERE t.id=v_id FOR SHARE;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class is in trash';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION public.guard_deleted_class_write() FROM PUBLIC;
DO $$ DECLARE v_table text; BEGIN
  FOREACH v_table IN ARRAY ARRAY['students','accounts','products','promotions','promotion_products',
    'tasks','task_allowed_students','tenant_settings','operations','transactions','transaction_items',
    'adjustments','inventory_ledger','task_assignments','task_completions','padlet_evidence_claims'] LOOP
    EXECUTE format('CREATE TRIGGER classroom_trash_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_class_write()',v_table);
  END LOOP;
END $$;

CREATE FUNCTION public.platform_manage_class(p_operation_id uuid,p_slug text,p_subject text,
  p_action text,p_name text,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_t public.tenants%ROWTYPE; v_user uuid; v_op public.class_management_operations%ROWTYPE;
  v_payload jsonb; v_result jsonb; v_new uuid; v_slug text; v_map jsonb; v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_operation_id IS NULL OR p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_slug IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    OR p_action IS NULL OR p_action NOT IN ('RENAME','DUPLICATE','DELETE','RESTORE')
    OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 80 OR p_name<>btrim(p_name)
    OR p_name ~ '[[:cntrl:]]' OR p_name ~ U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 9007199254740990 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid class management input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('class-management:'||p_operation_id::text,0));
  SELECT t.* INTO v_t FROM public.tenants t WHERE t.slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  SELECT u.id INTO v_user FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
    WHERE u.google_subject=p_subject AND m.tenant_id=v_t.id AND m.role='OWNER' FOR SHARE OF u,m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owner required'; END IF;
  v_payload:=jsonb_build_object('name',p_name,'expectedVersion',p_expected_version);
  SELECT o.* INTO v_op FROM public.class_management_operations o WHERE o.operation_id=p_operation_id;
  IF FOUND THEN
    IF v_op.tenant_id<>v_t.id OR v_op.user_id<>v_user OR v_op.action<>p_action OR v_op.payload<>v_payload THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='operation conflict';
    END IF;
    RETURN v_op.result||'{"replayed":true}'::jsonb;
  END IF;
  IF v_t.management_version<>p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class version changed';
  END IF;
  IF p_action='RESTORE' THEN
    IF v_t.deleted_at IS NULL OR v_t.display_name<>p_name THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class cannot be restored';
    END IF;
    UPDATE public.tenants SET lifecycle=deleted_lifecycle,deleted_at=NULL,deleted_lifecycle=NULL,
      management_version=management_version+1,credential_version=credential_version+1,updated_at=v_now WHERE id=v_t.id;
  ELSE
    IF v_t.deleted_at IS NOT NULL OR v_t.lifecycle NOT IN ('DRAFT','ACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='class is not available';
    END IF;
    IF p_action='DELETE' THEN
      IF v_t.display_name<>p_name THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='confirmation mismatch'; END IF;
      UPDATE public.tenants SET deleted_at=v_now,deleted_lifecycle=lifecycle,lifecycle='SUSPENDED',
        management_version=management_version+1,credential_version=credential_version+1,updated_at=v_now WHERE id=v_t.id;
    ELSIF p_action='RENAME' THEN
      UPDATE public.tenants SET display_name=p_name,management_version=management_version+1,updated_at=v_now WHERE id=v_t.id;
      UPDATE public.tenant_settings SET settings=settings||jsonb_build_object('className',p_name),version=version+1,updated_at=v_now WHERE tenant_id=v_t.id;
    ELSE
      IF v_t.lifecycle<>'ACTIVE' THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='only active class can be copied'; END IF;
      v_new:=gen_random_uuid(); v_slug:='class-'||v_new::text;
      INSERT INTO public.tenants(id,slug,display_name,lifecycle) VALUES(v_new,v_slug,p_name,'ACTIVE');
      INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES(v_new,v_user,'OWNER');
      INSERT INTO public.tenant_settings(tenant_id,settings)
        SELECT v_new,jsonb_build_object('className',p_name,'currencyUnit',coalesce(s.settings->>'currencyUnit','원'),
          'appTitle',coalesce(s.settings->>'appTitle','학급 매점'),'bankTitle',coalesce(s.settings->>'bankTitle','학급 은행'),
          'themeColor',coalesce(s.settings->>'themeColor','white'),'fontFamily',coalesce(s.settings->>'fontFamily','default'),
          'qrManualInputEnabled',false) FROM (SELECT 1) a LEFT JOIN public.tenant_settings s ON s.tenant_id=v_t.id;
      INSERT INTO public.students(tenant_id,student_id,name,status)
        SELECT v_new,s.student_id,s.name,s.status FROM public.students s WHERE s.tenant_id=v_t.id AND s.deleted_at IS NULL;
      INSERT INTO public.accounts(tenant_id,student_id,balance) SELECT v_new,s.student_id,0 FROM public.students s WHERE s.tenant_id=v_new;
      INSERT INTO public.products(tenant_id,product_id,name,price,stock,is_active,image_url,category,sort_order)
        SELECT v_new,p.product_id,p.name,p.price,p.stock,p.is_active,p.image_url,p.category,p.sort_order
        FROM public.products p WHERE p.tenant_id=v_t.id AND p.deleted_at IS NULL;
      INSERT INTO public.promotions(tenant_id,promotion_id,name,description,type,n_plus_one_buy_quantity,n_plus_one_free_quantity,
        promotional_price,percent_discount,fixed_discount,starts_at,ends_at,is_active,sort_order,schema_version)
        SELECT v_new,promotion_id,name,description,type,n_plus_one_buy_quantity,n_plus_one_free_quantity,
          promotional_price,percent_discount,fixed_discount,starts_at,ends_at,false,sort_order,schema_version
        FROM public.promotions WHERE tenant_id=v_t.id AND deleted_at IS NULL;
      INSERT INTO public.promotion_products(tenant_id,promotion_product_id,promotion_id,product_id,schema_version)
        SELECT v_new,l.promotion_product_id,l.promotion_id,l.product_id,l.schema_version FROM public.promotion_products l
        JOIN public.products p ON p.tenant_id=v_new AND p.product_id=l.product_id
        JOIN public.promotions q ON q.tenant_id=v_new AND q.promotion_id=l.promotion_id WHERE l.tenant_id=v_t.id;
      SELECT coalesce(jsonb_object_agg(t.task_instance_id,gen_random_uuid()::text),'{}'::jsonb) INTO v_map
        FROM public.tasks t WHERE t.tenant_id=v_t.id AND t.deleted_at IS NULL;
      INSERT INTO public.tasks(tenant_id,task_instance_id,task_id,title,description,reward,is_active,sort_order,
        available_from,available_until,due_at,prerequisite_task_instance_id,current_schedule,schedule_schema_version)
        SELECT v_new,v_map->>t.task_instance_id,t.task_id,t.title,t.description,t.reward,false,t.sort_order,
          t.available_from,t.available_until,t.due_at,v_map->>t.prerequisite_task_instance_id,
          (CASE WHEN t.pending_schedule IS NOT NULL AND (t.pending_schedule->>'effectiveFrom')::timestamptz<=v_now
            THEN t.pending_schedule ELSE t.current_schedule END)||jsonb_build_object('ruleVersion',1,
              'effectiveFrom',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),t.schedule_schema_version
        FROM public.tasks t WHERE t.tenant_id=v_t.id AND t.deleted_at IS NULL;
      INSERT INTO public.task_allowed_students(tenant_id,task_instance_id,student_id)
        SELECT v_new,v_map->>a.task_instance_id,a.student_id FROM public.task_allowed_students a
        JOIN public.students s ON s.tenant_id=v_new AND s.student_id=a.student_id
        WHERE a.tenant_id=v_t.id AND v_map ? a.task_instance_id;
    END IF;
  END IF;
  SELECT jsonb_build_object('slug',t.slug,'displayName',t.display_name,'lifecycle',t.lifecycle,
    'managementVersion',t.management_version::text,'action',p_action,'replayed',false) INTO v_result
    FROM public.tenants t WHERE t.id=coalesce(v_new,v_t.id);
  INSERT INTO public.class_management_operations(operation_id,tenant_id,user_id,action,payload,result)
    VALUES(p_operation_id,v_t.id,v_user,p_action,v_payload,v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.platform_manage_class(uuid,text,text,text,text,bigint) FROM PUBLIC;
