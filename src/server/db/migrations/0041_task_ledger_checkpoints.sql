-- Exact raw-event fold checkpoints. Apply as the migration/BYPASSRLS owner in
-- one transaction. Source events remain authoritative and untouched. A normal
-- append folds one event; a backdated append rebuilds only its pair's suffix.
-- Existing append-only guards reject source UPDATE/DELETE. An owner restoring
-- source rows with triggers disabled must call refresh_tenant_task_ledger_checkpoints
-- before serving reads; checkpoints are disposable and never the restore source.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'task ledger checkpoints require migration/BYPASSRLS ownership';
  END IF;
END $$;

CREATE TABLE public.task_ledger_checkpoints (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  task_instance_id text NOT NULL,
  student_id text NOT NULL,
  event_table text NOT NULL CHECK (event_table IN ('A','C')),
  event_id text NOT NULL,
  event_at timestamptz NOT NULL,
  event_kind smallint NOT NULL CHECK (event_kind BETWEEN 0 AND 2),
  event_sequence bigint NOT NULL,
  event_source text,
  stage text NOT NULL CHECK (stage IN ('UNASSIGNED','PENDING','READY','COMPLETED')),
  since timestamptz,
  before_completion text NOT NULL CHECK (before_completion IN ('UNASSIGNED','PENDING','READY','COMPLETED')),
  before_completion_since timestamptz,
  last_completion_at timestamptz,
  latest_assignment_id text,
  latest_completion_id text,
  completion_count bigint NOT NULL CHECK (completion_count >= 0),
  PRIMARY KEY (tenant_id,event_table,event_id)
);
CREATE INDEX task_ledger_checkpoints_pair_order_idx ON public.task_ledger_checkpoints
  (tenant_id,task_instance_id,student_id,event_at DESC,event_kind DESC,event_sequence DESC);
CREATE INDEX task_assignments_ledger_pair_order_idx ON public.task_assignments
  (tenant_id,task_instance_id,student_id,created_at,event_sequence);
CREATE INDEX task_completions_ledger_pair_order_idx ON public.task_completions
  (tenant_id,task_instance_id,student_id,created_at,event_sequence)
  WHERE task_instance_id IS NOT NULL AND status IN ('COMPLETED','CANCELLED');
ALTER TABLE public.task_ledger_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_ledger_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY task_ledger_checkpoints_tenant ON public.task_ledger_checkpoints FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.task_ledger_checkpoints FROM PUBLIC;

CREATE FUNCTION public.refresh_task_ledger_checkpoints(p_tenant uuid,p_task text,p_student text,p_from timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_from timestamptz; s public.task_ledger_checkpoints%ROWTYPE; e record; v_stage text;
BEGIN
  -- Covers old and new app writers; no new application lock is required for
  -- correctness of the derived state. Different pairs use independent locks.
  PERFORM pg_advisory_xact_lock(hashtextextended('task-ledger-state:'||p_tenant::text||':'||p_task||':'||p_student,0));
  SELECT (result_snapshot->>'ledgerFrom')::timestamptz INTO v_from FROM public.operations
    WHERE tenant_id=p_tenant AND operation_id='task-ledger:v1' AND status='SUCCEEDED';
  IF v_from IS NULL THEN
    DELETE FROM public.task_ledger_checkpoints WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student;
    RETURN;
  END IF;
  -- Rebuild the whole equal-time group: assignment/completion sequences belong
  -- to different tables, and kind wins over sequence for timestamp ties.
  SELECT * INTO s FROM public.task_ledger_checkpoints
    WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
      AND p_from IS NOT NULL AND event_at < greatest(p_from,v_from)
    ORDER BY event_at DESC,event_kind DESC,event_sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    s.stage:='UNASSIGNED'; s.before_completion:='UNASSIGNED'; s.completion_count:=0;
  END IF;
  DELETE FROM public.task_ledger_checkpoints
    WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
      AND (p_from IS NULL OR event_at >= greatest(p_from,v_from));
  FOR e IN
    SELECT 'A'::text AS k,assignment_id AS id,created_at AS at,0::smallint AS kind,event_sequence,
      source,event_type,note,NULL::text AS status
    FROM public.task_assignments WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
      AND created_at>=v_from AND (p_from IS NULL OR created_at>=p_from)
    UNION ALL
    SELECT 'C',completion_id,created_at,(CASE WHEN status='COMPLETED' THEN 1 ELSE 2 END)::smallint,event_sequence,
      source,NULL,NULL,status
    FROM public.task_completions WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
      AND status IN ('COMPLETED','CANCELLED') AND created_at>=v_from AND (p_from IS NULL OR created_at>=p_from)
    ORDER BY at,kind,event_sequence
  LOOP
    IF e.kind=0 THEN
      v_stage:=CASE WHEN e.event_type='UNASSIGNED' THEN 'UNASSIGNED'
        WHEN e.note='stage:pending' THEN 'PENDING' ELSE 'READY' END;
      IF s.stage<>v_stage THEN s.since:=e.at; END IF;
      s.stage:=v_stage; s.last_completion_at:=NULL;
      IF e.event_type<>'UNASSIGNED' THEN s.latest_assignment_id:=e.id; END IF;
    ELSIF e.kind=1 THEN
      IF s.stage<>'COMPLETED' THEN
        s.before_completion:=s.stage; s.before_completion_since:=s.since; s.since:=e.at;
      END IF;
      s.stage:='COMPLETED'; s.last_completion_at:=e.at;
      s.latest_completion_id:=e.id; s.completion_count:=s.completion_count+1;
    ELSIF s.stage='COMPLETED' THEN
      s.stage:=s.before_completion; s.since:=coalesce(s.before_completion_since,e.at); s.last_completion_at:=NULL;
    END IF;
    INSERT INTO public.task_ledger_checkpoints VALUES
      (p_tenant,p_task,p_student,e.k,e.id,e.at,e.kind,e.event_sequence,e.source,s.stage,s.since,
       s.before_completion,s.before_completion_since,s.last_completion_at,s.latest_assignment_id,s.latest_completion_id,s.completion_count);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.refresh_task_ledger_checkpoints(uuid,text,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.capture_task_ledger_checkpoint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record;
BEGIN
  -- One suffix per pair per SQL statement, including bulk legacy imports.
  -- Row triggers would rebuild an N-row inserted batch N times.
  FOR p IN SELECT tenant_id,task_instance_id,student_id,min(created_at) AS from_at
    FROM ledger_inserted WHERE task_instance_id IS NOT NULL
    GROUP BY tenant_id,task_instance_id,student_id ORDER BY tenant_id,task_instance_id,student_id
  LOOP
    PERFORM public.refresh_task_ledger_checkpoints(p.tenant_id,p.task_instance_id,p.student_id,p.from_at);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.capture_task_ledger_checkpoint() FROM PUBLIC;
CREATE TRIGGER task_assignments_checkpoint AFTER INSERT ON public.task_assignments
  REFERENCING NEW TABLE AS ledger_inserted FOR EACH STATEMENT EXECUTE FUNCTION public.capture_task_ledger_checkpoint();
CREATE TRIGGER task_completions_checkpoint AFTER INSERT ON public.task_completions
  REFERENCING NEW TABLE AS ledger_inserted FOR EACH STATEMENT EXECUTE FUNCTION public.capture_task_ledger_checkpoint();

CREATE FUNCTION public.refresh_tenant_task_ledger_checkpoints(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record;
BEGIN
  DELETE FROM public.task_ledger_checkpoints WHERE tenant_id=p_tenant;
  FOR p IN SELECT task_instance_id,student_id FROM public.task_assignments WHERE tenant_id=p_tenant
    UNION SELECT task_instance_id,student_id FROM public.task_completions WHERE tenant_id=p_tenant AND task_instance_id IS NOT NULL
    ORDER BY task_instance_id,student_id
  LOOP
    PERFORM public.refresh_task_ledger_checkpoints(p_tenant,p.task_instance_id,p.student_id,NULL);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.refresh_tenant_task_ledger_checkpoints(uuid) FROM PUBLIC;

CREATE FUNCTION public.capture_task_ledger_marker_checkpoint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.operation_id='task-ledger:v1' AND (TG_OP='INSERT' OR
    (OLD.status,OLD.result_snapshot->>'ledgerFrom') IS DISTINCT FROM (NEW.status,NEW.result_snapshot->>'ledgerFrom')) THEN
    PERFORM public.refresh_tenant_task_ledger_checkpoints(NEW.tenant_id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.capture_task_ledger_marker_checkpoint() FROM PUBLIC;
CREATE TRIGGER operations_task_ledger_checkpoint AFTER INSERT OR UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.capture_task_ledger_marker_checkpoint();

-- Initial derivation happens in the same transaction as trigger installation.
-- PostgreSQL's DDL locks exclude concurrent source writes until commit.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tenant_id FROM public.operations WHERE operation_id='task-ledger:v1' AND status='SUCCEEDED'
    ORDER BY tenant_id
  LOOP PERFORM public.refresh_tenant_task_ledger_checkpoints(t.tenant_id); END LOOP;
END $$;
-- Provision the current runtime with SELECT on task_ledger_checkpoints only.
-- Never grant refresh-function EXECUTE or direct checkpoint writes to runtime.
