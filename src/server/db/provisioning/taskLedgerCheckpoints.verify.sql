-- Read-only, aggregate-only derivation check after 0041/backfill/restore.
-- Expected: missing, orphan, metadata and fold mismatch counts are all zero.
-- Each checkpoint is checked against its source event and previous checkpoint;
-- together with completeness this inductively verifies the whole raw fold.
WITH markers AS (
  SELECT tenant_id,(result_snapshot->>'ledgerFrom')::timestamptz AS ledger_from
  FROM public.operations WHERE operation_id='task-ledger:v1' AND status='SUCCEEDED'
), sources AS (
  SELECT a.tenant_id,a.task_instance_id,a.student_id,'A'::text AS event_table,a.assignment_id AS event_id,
    a.created_at AS at,0 AS kind,a.event_sequence,a.source,
    CASE WHEN a.event_type='UNASSIGNED' THEN 'UNASSIGNED' WHEN a.note='stage:pending' THEN 'PENDING' ELSE 'READY' END AS event_stage
  FROM public.task_assignments a JOIN markers m ON m.tenant_id=a.tenant_id AND a.created_at>=m.ledger_from
  UNION ALL
  SELECT c.tenant_id,c.task_instance_id,c.student_id,'C',c.completion_id,c.created_at,
    CASE WHEN c.status='COMPLETED' THEN 1 ELSE 2 END,c.event_sequence,c.source,NULL
  FROM public.task_completions c JOIN markers m ON m.tenant_id=c.tenant_id AND c.created_at>=m.ledger_from
  WHERE c.task_instance_id IS NOT NULL AND c.status IN ('COMPLETED','CANCELLED')
), linked AS (
  SELECT e.*,c.event_id AS checkpoint_id,c.task_instance_id AS checkpoint_task,c.student_id AS checkpoint_student,
    c.event_at AS checkpoint_at,c.event_kind AS checkpoint_kind,c.event_sequence AS checkpoint_sequence,c.event_source AS checkpoint_source,
    c.stage,c.since,c.before_completion,c.before_completion_since,c.last_completion_at,
    c.latest_assignment_id,c.latest_completion_id,c.completion_count,
    lag(c.stage,1,'UNASSIGNED') OVER w AS p_stage,lag(c.since) OVER w AS p_since,
    lag(c.before_completion,1,'UNASSIGNED') OVER w AS p_before,lag(c.before_completion_since) OVER w AS p_before_since,
    lag(c.last_completion_at) OVER w AS p_completion_at,lag(c.latest_assignment_id) OVER w AS p_assignment,
    lag(c.latest_completion_id) OVER w AS p_completion,lag(c.completion_count,1,0::bigint) OVER w AS p_count
  FROM sources e LEFT JOIN public.task_ledger_checkpoints c
    ON c.tenant_id=e.tenant_id AND c.event_table=e.event_table AND c.event_id=e.event_id
  WINDOW w AS (PARTITION BY e.tenant_id,e.task_instance_id,e.student_id ORDER BY e.at,e.kind,e.event_sequence)
)
SELECT count(*) AS source_count,
  (SELECT count(*) FROM public.task_ledger_checkpoints) AS checkpoint_count,
  count(*) FILTER(WHERE checkpoint_id IS NULL) AS missing_count,
  (SELECT count(*) FROM public.task_ledger_checkpoints c WHERE NOT EXISTS
    (SELECT 1 FROM sources e WHERE e.tenant_id=c.tenant_id AND e.event_table=c.event_table AND e.event_id=c.event_id)) AS orphan_count,
  count(*) FILTER(WHERE checkpoint_id IS NOT NULL AND
    (checkpoint_task,checkpoint_student,checkpoint_at,checkpoint_kind,checkpoint_sequence,checkpoint_source)
      IS DISTINCT FROM (task_instance_id,student_id,at,kind,event_sequence,source)) AS metadata_mismatch_count,
  count(*) FILTER(WHERE checkpoint_id IS NOT NULL AND
    (stage,since,before_completion,before_completion_since,last_completion_at,latest_assignment_id,latest_completion_id,completion_count)
    IS DISTINCT FROM (
      CASE WHEN kind=0 THEN event_stage WHEN kind=1 THEN 'COMPLETED' WHEN p_stage='COMPLETED' THEN p_before ELSE p_stage END,
      CASE WHEN kind=0 AND event_stage<>p_stage THEN at WHEN kind=1 AND p_stage<>'COMPLETED' THEN at
        WHEN kind=2 AND p_stage='COMPLETED' THEN coalesce(p_before_since,at) ELSE p_since END,
      CASE WHEN kind=1 AND p_stage<>'COMPLETED' THEN p_stage ELSE p_before END,
      CASE WHEN kind=1 AND p_stage<>'COMPLETED' THEN p_since ELSE p_before_since END,
      CASE WHEN kind=0 OR (kind=2 AND p_stage='COMPLETED') THEN NULL WHEN kind=1 THEN at ELSE p_completion_at END,
      CASE WHEN kind=0 AND event_stage<>'UNASSIGNED' THEN event_id ELSE p_assignment END,
      CASE WHEN kind=1 THEN event_id ELSE p_completion END,
      p_count+CASE WHEN kind=1 THEN 1 ELSE 0 END
    )) AS fold_mismatch_count
FROM linked;
