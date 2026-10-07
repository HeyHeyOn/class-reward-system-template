-- Read projections only: source assignments/completions remain authoritative.
-- Apply as the migration/BYPASSRLS owner. Runtime receives SELECT, never writes
-- or EXECUTE on maintenance functions. Ordinary appends project one event;
-- backdated events and schedule edits rebuild the affected historical suffix.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'task history projection requires migration/BYPASSRLS ownership';
  END IF;
END $$;
CREATE SEQUENCE public.task_history_version_seq;
CREATE TABLE public.task_history_revisions (
  tenant_id uuid NOT NULL, task_instance_id text NOT NULL, revision bigint NOT NULL DEFAULT nextval('public.task_history_version_seq'),
  PRIMARY KEY (tenant_id, task_instance_id, revision),
  FOREIGN KEY (tenant_id, task_instance_id) REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE
);
CREATE TABLE public.task_history_prefixes (
  tenant_id uuid NOT NULL, task_instance_id text NOT NULL, student_id text NOT NULL,
  event_table text NOT NULL CHECK(event_table IN ('A','C')), event_id text NOT NULL,
  event_at timestamptz NOT NULL, kind_order smallint NOT NULL, event_sequence bigint NOT NULL,
  event_version bigint NOT NULL, stage text NOT NULL, before_completion text NOT NULL,
  PRIMARY KEY (tenant_id, event_table, event_id),
  FOREIGN KEY (tenant_id, task_instance_id) REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE
);
CREATE INDEX task_history_prefix_pair_idx ON public.task_history_prefixes
  (tenant_id, task_instance_id, student_id, event_at DESC, kind_order DESC, event_sequence DESC);
CREATE INDEX task_history_prefix_version_idx ON public.task_history_prefixes
  (tenant_id, task_instance_id, event_version DESC);
CREATE TABLE public.task_history_entries (
  tenant_id uuid NOT NULL, task_instance_id text NOT NULL, entry_key text COLLATE "C" NOT NULL,
  id text NOT NULL, student_id text NOT NULL, display_at timestamptz NOT NULL,
  event_at timestamptz NOT NULL, event_version bigint NOT NULL,
  stage text NOT NULL, previous_stage text NOT NULL, cause text NOT NULL, reward bigint,
  PRIMARY KEY (tenant_id, task_instance_id, entry_key),
  FOREIGN KEY (tenant_id, task_instance_id) REFERENCES public.tasks(tenant_id, task_instance_id) ON DELETE CASCADE
);
CREATE INDEX task_history_page_idx ON public.task_history_entries
  (tenant_id, task_instance_id, display_at DESC, entry_key DESC);
CREATE INDEX task_history_student_page_idx ON public.task_history_entries
  (tenant_id, task_instance_id, student_id, display_at DESC, entry_key DESC);
CREATE INDEX task_history_entry_version_idx ON public.task_history_entries(tenant_id, task_instance_id, event_version);

ALTER TABLE public.task_history_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_history_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_history_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_history_prefixes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_history_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_history_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY task_history_revisions_read ON public.task_history_revisions FOR SELECT
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY task_history_prefixes_read ON public.task_history_prefixes FOR SELECT
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY task_history_entries_read ON public.task_history_entries FOR SELECT
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.task_history_revisions, public.task_history_prefixes, public.task_history_entries FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.task_history_version_seq FROM PUBLIC;

-- Task storage requires Asia/Seoul. Invalid legacy schedules use the same NONE
-- fallback as readLedgerTasks; an invalid pending schedule still bounds current.
CREATE FUNCTION public.task_history_schedule(p jsonb, p_created timestamptz) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE r jsonb; k text; d jsonb; seen integer[]:='{}'; n integer; at timestamptz;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p)<>'object' OR p->>'timeZone'<>'Asia/Seoul'
    OR coalesce((p->>'ruleVersion')::numeric,0)<1
    OR jsonb_typeof(p->'resetAssignmentOnCycle')<>'boolean'
    OR jsonb_typeof(p->'resetCompletionOnCycle')<>'boolean'
    OR NOT coalesce(p->>'effectiveFrom' ~ '^([0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$',false) THEN RAISE EXCEPTION 'invalid'; END IF;
  at:=date_trunc('milliseconds',(p->>'effectiveFrom')::timestamptz);
  r:=p->'recurrence'; k:=r->>'type';
  IF k NOT IN ('NONE','DAILY','WEEKLY','MONTHLY') OR k IS NULL THEN RAISE EXCEPTION 'invalid'; END IF;
  IF k<>'NONE' AND NOT coalesce(r->>'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',false) THEN RAISE EXCEPTION 'invalid'; END IF;
  IF k='WEEKLY' THEN
    IF jsonb_typeof(r->'weekdays') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'weekdays') NOT BETWEEN 1 AND 7 THEN RAISE EXCEPTION 'invalid'; END IF;
    FOR d IN SELECT value FROM jsonb_array_elements(r->'weekdays') LOOP
      IF jsonb_typeof(d)<>'number' OR d::text !~ '^[1-7]$' THEN RAISE EXCEPTION 'invalid'; END IF;
      n:=d::text::integer; IF n=ANY(seen) THEN RAISE EXCEPTION 'invalid'; END IF; seen:=array_append(seen,n);
    END LOOP;
  END IF;
  IF k='MONTHLY' AND NOT coalesce(jsonb_typeof(r->'dayOfMonth')='number' AND r->>'dayOfMonth' ~ '^([1-9]|[12][0-9]|3[01])$',false) THEN RAISE EXCEPTION 'invalid'; END IF;
  RETURN jsonb_set(p,'{effectiveFrom}',to_jsonb(at));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('effectiveFrom',p_created,'timeZone','Asia/Seoul','recurrence',jsonb_build_object('type','NONE'),
    'resetAssignmentOnCycle',false,'resetCompletionOnCycle',false);
END $$;

CREATE FUNCTION public.task_history_next_boundary(p jsonb, p_after timestamptz) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text:=p->>'type'; local_day date:=(p_after AT TIME ZONE 'Asia/Seoul')::date;
  day date; month_start date; candidate timestamptz; i integer; hour integer; minute integer;
BEGIN
  IF k='NONE' THEN RETURN NULL; END IF;
  hour:=split_part(p->>'time',':',1)::integer; minute:=split_part(p->>'time',':',2)::integer;
  FOR i IN 0..7 LOOP
    IF k='MONTHLY' THEN
      month_start:=(date_trunc('month',local_day::timestamp)+make_interval(months=>i))::date;
      day:=month_start+(least((p->>'dayOfMonth')::integer,extract(day FROM month_start+interval '1 month - 1 day')::integer)-1);
    ELSE day:=local_day+i; END IF;
    IF k='WEEKLY' AND NOT (p->'weekdays' @> to_jsonb(extract(isodow FROM day)::integer)) THEN CONTINUE; END IF;
    candidate:=(day::timestamp+make_interval(hours=>hour,mins=>minute)) AT TIME ZONE 'Asia/Seoul';
    IF candidate>p_after THEN RETURN candidate; END IF;
  END LOOP;
  RAISE EXCEPTION 'invalid history recurrence';
END $$;

-- Identical to ledgerTimeline.applyResets: exclusive before actual events,
-- inclusive at a frozen read time; one state change per schedule window.
CREATE FUNCTION public.task_history_reset_steps(p_current jsonb,p_pending jsonb,p_created timestamptz,
  p_last timestamptz,p_stage text,p_before text,p_until timestamptz,p_ledger_from timestamptz,p_inclusive boolean)
RETURNS TABLE(at timestamptz,stage text,previous_stage text,before_completion text)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE cur jsonb:=public.task_history_schedule(p_current,p_created); pend jsonb:=public.task_history_schedule(p_pending,p_created);
  windows jsonb; w jsonb; chosen jsonb; candidate timestamptz; next_at timestamptz; cursor_at timestamptz:=p_last;
  from_at timestamptz; until_at timestamptz; target text; current_stage text:=p_stage; before_stage text:=p_before; guard integer;
BEGIN
  IF p_last IS NULL OR p_ledger_from IS NULL OR p_last<p_ledger_from THEN RETURN; END IF;
  windows:=jsonb_build_array(jsonb_build_object('schedule',cur,'until',pend->>'effectiveFrom'));
  IF pend IS NOT NULL THEN windows:=windows||jsonb_build_array(jsonb_build_object('schedule',pend,'until',NULL)); END IF;
  FOR guard IN 1..8 LOOP
    IF current_stage='UNASSIGNED' THEN RETURN; END IF;
    next_at:=NULL; chosen:=NULL;
    FOR w IN SELECT value FROM jsonb_array_elements(windows) ORDER BY (value->'schedule'->>'effectiveFrom')::timestamptz LOOP
      cur:=w->'schedule'; from_at:=(cur->>'effectiveFrom')::timestamptz; until_at:=(w->>'until')::timestamptz;
      target:=CASE WHEN cur->'recurrence'->>'type'='NONE' THEN NULL
        WHEN cur ? 'resetStage' THEN CASE WHEN cur->>'resetStage' IN ('UNASSIGNED','PENDING','READY','COMPLETED') THEN cur->>'resetStage' END
        WHEN (cur->>'resetAssignmentOnCycle')::boolean THEN 'UNASSIGNED'
        WHEN (cur->>'resetCompletionOnCycle')::boolean THEN 'READY' END;
      IF target IS NULL OR (until_at IS NOT NULL AND until_at<=cursor_at) THEN CONTINUE; END IF;
      candidate:=public.task_history_next_boundary(cur->'recurrence',greatest(cursor_at,from_at));
      IF candidate IS NULL OR candidate>p_until OR (NOT p_inclusive AND candidate=p_until)
        OR (until_at IS NOT NULL AND candidate>=until_at) THEN CONTINUE; END IF;
      IF next_at IS NULL OR candidate<next_at THEN next_at:=candidate; chosen:=w||jsonb_build_object('target',target); END IF;
    END LOOP;
    IF next_at IS NULL THEN RETURN; END IF;
    target:=chosen->>'target'; until_at:=(chosen->>'until')::timestamptz;
    IF target=current_stage THEN
      IF until_at IS NULL THEN RETURN; END IF;
      cursor_at:=until_at; CONTINUE;
    END IF;
    at:=next_at; previous_stage:=current_stage;
    IF target='COMPLETED' THEN before_stage:=current_stage; END IF;
    current_stage:=target; stage:=current_stage; before_completion:=before_stage; RETURN NEXT;
    cursor_at:=next_at;
  END LOOP;
  RAISE EXCEPTION 'history reset iteration invariant';
END $$;

CREATE FUNCTION public.task_history_rebuild_pair(p_tenant uuid,p_task text,p_student text,
  p_at timestamptz DEFAULT NULL,p_kind smallint DEFAULT NULL,p_sequence bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task public.tasks%ROWTYPE; prior public.task_history_prefixes%ROWTYPE; e record; reset record;
  stage_now text:='UNASSIGNED'; before_now text:='UNASSIGNED'; previous text; last_at timestamptz;
  ledger_from timestamptz; version bigint; cause text; key text; event_stage text; display_at timestamptz;
BEGIN
  -- Reuse 0041's per-pair lock, including legacy/import writers. No task-wide
  -- revision row lock is taken while another transaction may own a pair lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('task-ledger-state:'||p_tenant::text||':'||p_task||':'||p_student,0));
  SELECT * INTO STRICT task FROM public.tasks WHERE tenant_id=p_tenant AND task_instance_id=p_task;
  SELECT (result_snapshot->>'ledgerFrom')::timestamptz INTO ledger_from FROM public.operations
    WHERE tenant_id=p_tenant AND operation_id='task-ledger:v1' AND status='SUCCEEDED';
  IF p_at IS NOT NULL THEN
    SELECT * INTO prior FROM public.task_history_prefixes WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
      AND (event_at,kind_order,event_sequence)<(p_at,p_kind,p_sequence) ORDER BY event_at DESC,kind_order DESC,event_sequence DESC LIMIT 1;
    IF FOUND THEN stage_now:=prior.stage; before_now:=prior.before_completion; last_at:=prior.event_at; END IF;
  END IF;
  DELETE FROM public.task_history_entries h USING public.task_history_prefixes x
    WHERE x.tenant_id=p_tenant AND x.task_instance_id=p_task AND x.student_id=p_student
      AND (p_at IS NULL OR (x.event_at,x.kind_order,x.event_sequence)>=(p_at,p_kind,p_sequence))
      AND h.tenant_id=x.tenant_id AND h.task_instance_id=x.task_instance_id AND h.event_version=x.event_version;
  DELETE FROM public.task_history_prefixes WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
    AND (p_at IS NULL OR (event_at,kind_order,event_sequence)>=(p_at,p_kind,p_sequence));
  FOR e IN
    SELECT * FROM (
      SELECT 'A'::text AS tab, assignment_id AS id,created_at AS at,0::smallint AS kind,event_sequence,source,note,
        event_type,NULL::text AS status,NULL::timestamptz AS completed_at,0::bigint AS reward,NULL::text AS transaction_id
      FROM public.task_assignments WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student
        AND (p_at IS NULL OR (created_at,0::smallint,event_sequence)>=(p_at,p_kind,p_sequence))
      UNION ALL
      SELECT 'C',completion_id,created_at,CASE WHEN status='COMPLETED' THEN 1 ELSE 2 END::smallint,event_sequence,source,note,
        NULL,status,completed_at,reward_snapshot,transaction_id
      FROM public.task_completions WHERE tenant_id=p_tenant AND task_instance_id=p_task AND student_id=p_student AND status IN ('COMPLETED','CANCELLED')
        AND (p_at IS NULL OR (created_at,CASE WHEN status='COMPLETED' THEN 1 ELSE 2 END::smallint,event_sequence)>=(p_at,p_kind,p_sequence))
    ) events ORDER BY at,kind,event_sequence
  LOOP
    version:=nextval('public.task_history_version_seq');
    FOR reset IN SELECT * FROM public.task_history_reset_steps(task.current_schedule,task.pending_schedule,task.created_at,
      last_at,stage_now,before_now,e.at,ledger_from,false) LOOP
      key:='reset:'||p_student||':'||to_char(reset.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      INSERT INTO public.task_history_entries VALUES(p_tenant,p_task,'R:'||key,'R:'||key,p_student,reset.at,e.at,version,reset.stage,reset.previous_stage,'AUTO_RESET',NULL);
      stage_now:=reset.stage; before_now:=reset.before_completion;
    END LOOP;
    previous:=stage_now;
    IF e.tab='A' THEN stage_now:=CASE WHEN e.event_type='UNASSIGNED' THEN 'UNASSIGNED' WHEN e.note='stage:pending' THEN 'PENDING' ELSE 'READY' END;
    ELSIF e.status='COMPLETED' THEN IF stage_now<>'COMPLETED' THEN before_now:=stage_now; END IF; stage_now:='COMPLETED';
    ELSIF stage_now='COMPLETED' THEN stage_now:=before_now; END IF;
    cause:=CASE WHEN e.tab='A' THEN CASE
      WHEN e.source='QR' OR split_part(e.id,':',1)='tl-q' THEN 'QR'
      WHEN e.source='LEGACY_SEED' THEN 'IMPORTED'
      WHEN e.source='CARRY_FORWARD' THEN CASE WHEN split_part(e.id,':',1)='tl-s' THEN 'AUTO_RESET' END
      WHEN split_part(e.id,':',1)='tl-r' THEN 'RESET' ELSE 'TEACHER' END
    ELSE CASE WHEN e.status='CANCELLED' THEN CASE WHEN e.transaction_id IS NOT NULL THEN 'CANCELLED' ELSE 'RESET' END
      WHEN e.source='BANK' THEN CASE WHEN e.note='teacher-completion-reward' THEN 'TEACHER' ELSE 'BANK' END
      WHEN e.source='CARRY_FORWARD' THEN CASE WHEN split_part(e.id,':',1)='tl-cs' THEN 'AUTO_RESET' END
      WHEN e.source='ADMIN' THEN CASE WHEN split_part(e.id,':',1)='tl-cr' THEN 'RESET' WHEN split_part(e.id,':',1)='tl-cq' THEN 'QR' ELSE 'TEACHER' END
      ELSE 'IMPORTED' END END;
    IF cause IS NOT NULL AND (previous<>stage_now OR cause='BANK') THEN
      -- Shift signed bigint sequences into an unsigned fixed-width decimal key:
      -- C-collation then preserves the domain's kind/sequence order at ties.
      key:='E:'||e.kind||':'||lpad((e.event_sequence::numeric+9223372036854775808)::text,20,'0')||':'||e.tab||':'||e.id;
      INSERT INTO public.task_history_entries VALUES(p_tenant,p_task,key,'E:'||e.tab||':'||e.id,p_student,
        coalesce(e.completed_at,e.at),e.at,version,stage_now,previous,cause,CASE WHEN e.tab='C' AND e.status='COMPLETED' AND e.reward>0 THEN e.reward END);
    END IF;
    INSERT INTO public.task_history_prefixes VALUES(p_tenant,p_task,p_student,e.tab,e.id,e.at,e.kind,e.event_sequence,version,stage_now,before_now);
    last_at:=e.at;
  END LOOP;
END $$;

CREATE FUNCTION public.task_history_project_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event record; latest public.task_history_prefixes%ROWTYPE;
BEGIN
  -- A batch is already visible to an AFTER trigger. Project each pair only once,
  -- from its first inserted tuple, rather than replaying a batch for every row.
  FOR event IN SELECT DISTINCT ON(tenant_id,task_instance_id,student_id)
      tenant_id,task_instance_id,student_id,created_at,event_sequence,
      CASE WHEN TG_TABLE_NAME='task_assignments' THEN 0 WHEN to_jsonb(n)->>'status'='COMPLETED' THEN 1 ELSE 2 END::smallint AS kind
    FROM task_history_inserted n WHERE task_instance_id IS NOT NULL
      AND (TG_TABLE_NAME='task_assignments' OR to_jsonb(n)->>'status' IN ('COMPLETED','CANCELLED'))
    ORDER BY tenant_id,task_instance_id,student_id,created_at,kind,event_sequence
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('task-ledger-state:'||event.tenant_id::text||':'||event.task_instance_id||':'||event.student_id,0));
    SELECT * INTO latest FROM public.task_history_prefixes WHERE tenant_id=event.tenant_id AND task_instance_id=event.task_instance_id AND student_id=event.student_id
      ORDER BY event_at DESC,kind_order DESC,event_sequence DESC LIMIT 1;
    IF FOUND AND (event.created_at,event.kind,event.event_sequence)<=(latest.event_at,latest.kind_order,latest.event_sequence) THEN
      INSERT INTO public.task_history_revisions(tenant_id,task_instance_id) VALUES(event.tenant_id,event.task_instance_id);
    END IF;
    PERFORM public.task_history_rebuild_pair(event.tenant_id,event.task_instance_id,event.student_id,event.created_at,event.kind,event.event_sequence);
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION public.task_history_rebuild_task(p_tenant uuid,p_task text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s record;
BEGIN
  INSERT INTO public.task_history_revisions(tenant_id,task_instance_id) VALUES(p_tenant,p_task);
  FOR s IN SELECT student_id FROM public.task_assignments WHERE tenant_id=p_tenant AND task_instance_id=p_task
    UNION SELECT student_id FROM public.task_completions WHERE tenant_id=p_tenant AND task_instance_id=p_task AND status IN ('COMPLETED','CANCELLED') ORDER BY student_id LOOP
    PERFORM public.task_history_rebuild_pair(p_tenant,p_task,s.student_id);
  END LOOP;
END $$;
CREATE FUNCTION public.task_history_project_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.current_schedule IS DISTINCT FROM OLD.current_schedule OR NEW.pending_schedule IS DISTINCT FROM OLD.pending_schedule THEN
    PERFORM public.task_history_rebuild_task(NEW.tenant_id,NEW.task_instance_id);
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.task_history_project_marker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t record;
BEGIN
  IF NEW.operation_id='task-ledger:v1' AND NEW.status='SUCCEEDED' THEN
    FOR t IN SELECT task_instance_id FROM public.tasks WHERE tenant_id=NEW.tenant_id LOOP
      PERFORM public.task_history_rebuild_task(NEW.tenant_id,t.task_instance_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Source suffix seeks reuse the pair/time indexes installed by 0041.
CREATE TRIGGER task_assignments_history_projection AFTER INSERT ON public.task_assignments REFERENCING NEW TABLE AS task_history_inserted FOR EACH STATEMENT EXECUTE FUNCTION public.task_history_project_event();
CREATE TRIGGER task_completions_history_projection AFTER INSERT ON public.task_completions REFERENCING NEW TABLE AS task_history_inserted FOR EACH STATEMENT EXECUTE FUNCTION public.task_history_project_event();
CREATE TRIGGER tasks_history_schedule_projection AFTER UPDATE OF current_schedule,pending_schedule ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.task_history_project_schedule();
CREATE TRIGGER operations_history_marker_projection AFTER INSERT OR UPDATE OF status,result_snapshot ON public.operations FOR EACH ROW EXECUTE FUNCTION public.task_history_project_marker();
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tenant_id,task_instance_id FROM public.tasks LOOP PERFORM public.task_history_rebuild_task(t.tenant_id,t.task_instance_id); END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.task_history_schedule(jsonb,timestamptz),
  public.task_history_next_boundary(jsonb,timestamptz),
  public.task_history_reset_steps(jsonb,jsonb,timestamptz,timestamptz,text,text,timestamptz,timestamptz,boolean),
  public.task_history_rebuild_pair(uuid,text,text,timestamptz,smallint,bigint),
  public.task_history_project_event(), public.task_history_rebuild_task(uuid,text),
  public.task_history_project_schedule(), public.task_history_project_marker() FROM PUBLIC;
