// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner, type TenantTransaction } from '@/server/db/transaction';
import { readCurrentLedgerStates } from './currentState';
import {
  buildAdminTaskDto, groupEvents, readLedgerEvents, readLedgerFrom, readLedgerStudents, readLedgerTasks, sortTasks,
  type LedgerStudent, type LedgerTask,
} from './store';

vi.mock('server-only', () => ({}));

// Explicitly opt in: this starts only the owned, network-isolated disposable fixture.
// RUN_REAL_POSTGRES=1 RUN_CRS_BENCHMARK=1 vitest run --config test-support/release-unit.config.mts \
//   src/server/repositories/database/taskLedger/performance.postgres.test.ts --maxWorkers=1
const benchmark = process.env.RUN_CRS_BENCHMARK === '1' ? it : it.skip;
const CLASS_COUNT = 5;
const STUDENT_COUNT = 24;
const TASK_COUNT = 10;
const SINGLE_SAMPLES = 12;
const CONCURRENT_ROUNDS = 8;
const FROM = '2026-01-01T00:00:00.000000Z';
const NOW = '2026-01-02T03:00:00.000000Z';
const EVIDENCE_DIRECTORY = join(homedir(), '.cache', 'crs-optimization-20261007');
const PROJECTION_TRIGGERS = [
  ['task_assignments', 'task_assignments_checkpoint'],
  ['task_completions', 'task_completions_checkpoint'],
  ['task_assignments', 'task_assignments_history_projection'],
  ['task_completions', 'task_completions_history_projection'],
] as const;
type Variant = 'baseline' | 'optimized';
type BoardContext = { tasks: LedgerTask[]; students: LedgerStudent[]; ledgerFrom: string | null };
type Timing = { sampleCount: number; medianMs: number; p95Ms: number; samplesMs: number[] };

function summarize(samples: number[]): Timing {
  const ordered = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  const rounded = (value: number) => Math.round(value * 100) / 100;
  return { sampleCount: samples.length, medianMs: rounded(median),
    p95Ms: rounded(ordered[Math.ceil(ordered.length * 0.95) - 1]), samplesMs: samples.map(rounded) };
}

async function context(tx: TenantTransaction, tenant: string): Promise<BoardContext> {
  const tasks = await readLedgerTasks(tx, tenant);
  const students = await readLedgerStudents(tx, tenant);
  const ledgerFrom = await readLedgerFrom(tx, tenant);
  return { tasks, students, ledgerFrom };
}

async function board(tx: TenantTransaction, tenant: string, input: BoardContext, variant: Variant) {
  const ids = input.tasks.map((task) => task.taskInstanceId);
  const raw = variant === 'baseline'
    ? await readLedgerEvents(tx, tenant, input.ledgerFrom, { taskInstanceIds: ids }) : null;
  const states = raw === null
    ? await readCurrentLedgerStates(tx, tenant, NOW, { taskInstanceIds: ids }) : groupEvents(raw);
  const stateRows = raw?.length ?? [...states.values()].reduce((sum, rows) => sum + rows.size, 0);
  const tasks = sortTasks(input.tasks.map((task) => buildAdminTaskDto(task, input.students, states.get(task.taskInstanceId), NOW)));
  const json = JSON.stringify({ now: NOW, tasks });
  return { json, stateRows, bytes: Buffer.byteLength(json), digest: createHash('sha256').update(json).digest('hex') };
}

async function seedClasses(db: DisposablePostgres): Promise<string[]> {
  const tenants: string[] = [];
  for (let index = 0; index < CLASS_COUNT; index += 1) {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.owner.query('INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,$3)',
      [tenant, `synthetic-benchmark-${tenant}`, `Synthetic benchmark ${index + 1}`]);
    await db.owner.query(`INSERT INTO students(tenant_id,student_id,name,status)
      SELECT $1,'S'||lpad(n::text,3,'0'),'Synthetic student '||n,
        CASE WHEN n%8=0 THEN 'INACTIVE' ELSE 'ACTIVE' END FROM generate_series(1,$2::int)n`, [tenant, STUDENT_COUNT]);
    const tasks = Array.from({ length: TASK_COUNT }, (_, taskIndex) => ({
      taskId: `T${String(taskIndex + 1).padStart(3, '0')}`, title: `Synthetic class ${index + 1} task ${taskIndex + 1}`,
      sortOrder: taskIndex,
      schedule: { ruleVersion: 1, effectiveFrom: FROM, timeZone: 'Asia/Seoul',
        recurrence: taskIndex % 4 === 0 ? { type: 'DAILY', time: '09:00' } : { type: 'NONE' },
        resetStage: 'PENDING', resetAssignmentOnCycle: false, resetCompletionOnCycle: taskIndex % 4 === 0 },
    }));
    await db.owner.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,sort_order,current_schedule,created_at,updated_at)
      SELECT $1,v."taskId",v."taskId",v.title,'Synthetic benchmark task',10,v."sortOrder",v.schedule,$3,$3
      FROM jsonb_to_recordset($2::jsonb) AS v("taskId" text,title text,"sortOrder" int,schedule jsonb)`,
    [tenant, JSON.stringify(tasks), FROM]);
    await db.owner.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,
      started_at,finished_at,created_at,updated_at) VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3,$4,$4,$4,$4)`,
    [tenant, 'b'.repeat(64), JSON.stringify({ ledgerFrom: FROM }), FROM]);
  }
  return tenants;
}

async function seedEvents(db: DisposablePostgres, tenants: string[], first: number, last: number) {
  // Only these four derived-projection triggers are disabled, on the owned fixture,
  // while synthetic rows are bulk-seeded. All measured reads run after re-enable/rebuild.
  for (const [table, trigger] of PROJECTION_TRIGGERS) await db.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  let seedError: unknown;
  try {
    for (const tenant of tenants) {
      await db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,
        event_type,note,source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
        SELECT $1,'bench-a-'||t||'-'||s||'-'||e,'T'||lpad(t::text,3,'0'),'T'||lpad(t::text,3,'0'),'S'||lpad(s::text,3,'0'),
          CASE WHEN (e+t+s)%5=0 THEN 'UNASSIGNED' ELSE 'ASSIGNED' END,
          CASE WHEN (e+t+s)%5=1 THEN 'stage:pending' ELSE NULL END,'CARRY_FORWARD','ledger',$6,1,'Asia/Seoul',
          $6::timestamptz+e*interval '1 minute'+s*interval '1 microsecond'
        FROM generate_series(1,$2::int)t CROSS JOIN generate_series(1,$3::int)s CROSS JOIN generate_series($4::int,$5::int)e
        WHERE (e+t+s)%5 IN (0,1,2)`, [tenant, TASK_COUNT, STUDENT_COUNT, first, last, FROM]);
      await db.owner.query(`INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,
        task_name_snapshot,student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status,cycle_id,cycle_start_at,
        rule_version,timezone,source,created_at)
        SELECT $1,'bench-c-'||t||'-'||s||'-'||e,$6::timestamptz+e*interval '1 minute'+s*interval '1 microsecond',
          'T'||lpad(t::text,3,'0'),'T'||lpad(t::text,3,'0'),'Synthetic benchmark task','S'||lpad(s::text,3,'0'),'Synthetic student '||s,
          0,0,0,CASE WHEN (e+t+s)%5=3 THEN 'COMPLETED' ELSE 'CANCELLED' END,'ledger',$6,1,'Asia/Seoul','CARRY_FORWARD',
          $6::timestamptz+e*interval '1 minute'+s*interval '1 microsecond'
        FROM generate_series(1,$2::int)t CROSS JOIN generate_series(1,$3::int)s CROSS JOIN generate_series($4::int,$5::int)e
        WHERE (e+t+s)%5 IN (3,4)`, [tenant, TASK_COUNT, STUDENT_COUNT, first, last, FROM]);
    }
  } catch (error) {
    seedError = error;
    throw error;
  } finally {
    for (const [table, trigger] of PROJECTION_TRIGGERS) {
      try { await db.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
      catch (error) { if (!seedError) throw error; }
    }
  }
  for (const tenant of tenants) {
    await db.owner.query('SELECT public.refresh_tenant_task_ledger_checkpoints($1::uuid)', [tenant]);
    for (let task = 1; task <= TASK_COUNT; task += 1) {
      await db.owner.query('SELECT public.task_history_rebuild_task($1::uuid,$2)', [tenant, `T${String(task).padStart(3, '0')}`]);
    }
  }
  await db.owner.query('ANALYZE tasks; ANALYZE students; ANALYZE task_assignments; ANALYZE task_completions; ANALYZE task_ledger_checkpoints');
  const triggers = await db.owner.query<{ tgenabled: string }>(
    'SELECT tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[])', [PROJECTION_TRIGGERS.map(([, trigger]) => trigger)]);
  expect(triggers.rows).toHaveLength(PROJECTION_TRIGGERS.length);
  expect(triggers.rows.every((trigger) => trigger.tgenabled === 'O')).toBe(true);
}

benchmark('compares bounded current boards against full event folding on an isolated PostgreSQL fixture', async () => {
  const db = await createDisposablePostgres();
  let evidence: Record<string, unknown> | undefined;
  try {
    await db.owner.query('GRANT SELECT ON task_ledger_checkpoints TO app_runtime');
    expect(db.runtime.options.max).toBe(2);
    const run = createTenantTransactionRunner({ pool: db.runtime }, { isolationLevel: 'REPEATABLE READ', maxAttempts: 1 });
    const tenants = await seedClasses(db);
    const scenarios = [];
    for (const eventsPerPair of [10, 100]) {
      // Keep total fixture/WAL size within the unchanged 256 MiB tmpfs limit.
      // Only the primary class grows in the high-history scenario.
      const depthFor = (tenant: string) => tenant === tenants[0] ? eventsPerPair : 10;
      console.info(`CRS synthetic benchmark: preparing primary history ${eventsPerPair} events/pair`);
      await seedEvents(db, eventsPerPair === 10 ? tenants : [tenants[0]], eventsPerPair === 10 ? 1 : 11, eventsPerPair);
      const expected = new Map<string, string>();
      const comparisons = [];
      // Both algorithms consume the same frozen clock and database snapshot here.
      for (const tenant of tenants) {
        const comparison = await run(tenant, async (tx) => {
          const input = await context(tx, tenant);
          const baseline = await board(tx, tenant, input, 'baseline');
          const optimized = await board(tx, tenant, input, 'optimized');
          expect(optimized.json).toBe(baseline.json);
          expect(input.tasks).toHaveLength(TASK_COUNT);
          expect(input.students).toHaveLength(STUDENT_COUNT);
          expect(baseline.stateRows).toBe(TASK_COUNT * STUDENT_COUNT * depthFor(tenant));
          expect(optimized.stateRows).toBe(TASK_COUNT * STUDENT_COUNT);
          return { baselineRows: baseline.stateRows, optimizedRows: optimized.stateRows,
            responseBytes: optimized.bytes, responseSha256: optimized.digest };
        });
        comparisons.push(comparison);
        expected.set(tenant, comparison.responseSha256);
      }
      const timedRead = async (tenant: string, variant: Variant) => {
        const started = performance.now();
        const result = await run(tenant, async (tx) => board(tx, tenant, await context(tx, tenant), variant));
        const elapsed = performance.now() - started;
        expect(result.digest).toBe(expected.get(tenant));
        expect(result.stateRows).toBe(TASK_COUNT * STUDENT_COUNT * (variant === 'baseline' ? depthFor(tenant) : 1));
        return elapsed;
      };
      console.info(`CRS synthetic benchmark: exact JSON verified; measuring primary history ${eventsPerPair} events/pair`);
      // Warm both paths and both pool connections; timings below exclude fixture work.
      for (const variant of ['baseline', 'optimized'] as const) await Promise.all(tenants.map((tenant) => timedRead(tenant, variant)));
      const single: Record<Variant, number[]> = { baseline: [], optimized: [] };
      for (let sample = 0; sample < SINGLE_SAMPLES; sample += 1) {
        const variants: Variant[] = sample % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized'];
        for (const variant of variants) single[variant].push(await timedRead(tenants[0], variant));
      }
      const concurrent: Record<Variant, number[]> = { baseline: [], optimized: [] };
      const rounds: Record<Variant, number[]> = { baseline: [], optimized: [] };
      for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
        const variants: Variant[] = round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized'];
        for (const variant of variants) {
          const started = performance.now();
          concurrent[variant].push(...await Promise.all(tenants.map((tenant) => timedRead(tenant, variant))));
          rounds[variant].push(performance.now() - started);
        }
      }
      scenarios.push({ primaryClassEventsPerPair: eventsPerPair, eventsPerPairByClass: tenants.map(depthFor),
        classes: CLASS_COUNT, studentsPerClass: STUDENT_COUNT, tasksPerClass: TASK_COUNT,
        totalSourceEvents: TASK_COUNT * STUDENT_COUNT * tenants.reduce((sum, tenant) => sum + depthFor(tenant), 0), fullJsonEquality: true, comparisons,
        singleClass: { baseline: summarize(single.baseline), optimized: summarize(single.optimized) },
        fiveConcurrentClasses: { requests: { baseline: summarize(concurrent.baseline), optimized: summarize(concurrent.optimized) },
          rounds: { baseline: summarize(rounds.baseline), optimized: summarize(rounds.optimized) } } });
    }
    evidence = { generatedAt: new Date().toISOString(), benchmark: 'task-ledger-current-board', database: db.evidence,
      clock: NOW, runtimePoolConnections: db.runtime.options.max, isolation: 'REPEATABLE READ',
      method: 'Alternating warmed paths; latency includes pool queue, transaction setup, task/student/marker reads, state read, DTO projection and JSON serialization/hash. Equality checks use the same transaction snapshot and fixed clock. p95 uses nearest rank.',
      limitations: 'Local synthetic PostgreSQL 17 via docker-exec socket relay; concurrent tests may compete for host resources. High-history concurrent mix is one class with 100 events/pair plus four classes with 10 events/pair; unchanged 256 MiB tmpfs fixture limit. No HTTP, browser, network deployment, write throughput, history pagination, or production capacity claim. Sources use synthetic carry-forward events; daily-reset and nonrepeating tasks, active/inactive students, all five stage event kinds.',
      scenarios };
  } finally {
    const cleanup = await db.close();
    if (evidence) {
      await mkdir(EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 });
      await writeFile(join(EVIDENCE_DIRECTORY, 'task-ledger-board-performance.json'), JSON.stringify({ ...evidence, cleanup }, null, 2) + '\n', { mode: 0o600 });
    }
  }
}, 600_000);
