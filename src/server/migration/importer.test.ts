import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { makeRedis, makeSheets, makeSupportedSheets } from './__fixtures__/normalization';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { canonicalJson, deterministicId, sha256 } from './validators';

vi.mock('server-only', () => ({}));

const JOB_ID = '20000000-0000-4000-8000-000000000099';
const OTHER_JOB_ID = '20000000-0000-4000-8000-000000000100';
let harness: PgliteDatabaseHarness;

function manifest(tenantId = harness.tenantOneId) {
  const value = createLegacyNormalizationManifest({
    tenantId,
    migrationJobId: JOB_ID,
    sheets: makeSupportedSheets(),
    redis: makeRedis(),
  });
  expect(value.status).toBe('READY_FOR_IMPORT');
  return value;
}

// Deliberately reconstruct a correlated pre-quarantine manifest, including every
// child/mapping, so importer defense tests cannot pass at the BLOCKED gate.
function bypassQuarantine(manifest: LegacyNormalizationManifest): LegacyNormalizationManifest {
  const draft = structuredClone(manifest);
  const records = draft.records as Record<string, Record<string, unknown>[]>;
  const sources = draft.sourceRecords.map((source) => {
    if (source.mappingStatus !== 'QUARANTINED') return source;
    const value = source.canonicalRecord!;
    const table = value.completionId ? 'task_completions' : value.binding
      ? 'legacy_operation_bindings' : 'padlet_evidence_claims';
    const id = table === 'task_completions' ? String(value.completionId)
      : deterministicId(draft.tenantId, draft.migrationJobId, table,
        String(table === 'legacy_operation_bindings' ? value.operationId : value.tupleDigest));
    const record = table === 'task_completions' ? { tenantId: draft.tenantId, ...value } : { ...value };
    if (!(records[table] ?? []).some((row) => canonicalJson(row) === canonicalJson(record))) {
      (records[table] ??= []).push(structuredClone(record));
    }
    (draft.mappings as Array<LegacyNormalizationManifest['mappings'][number]>).push({
      sourceDigest: source.source.kind === 'SHEET' ? source.source.rowHash : source.source.sourceDigest,
      targetTable: table, targetId: id, status: 'STAGED',
    });
    return { ...source, canonicalRecord: structuredClone(value), mappingStatus: 'STAGED' as const,
      targetTable: table, targetId: id, errorCodes: [] };
  });
  const { manifestDigest: _digest, ...unsigned } = { ...draft, sourceRecords: sources,
    status: 'READY_FOR_IMPORT' as const, quarantines: [], blockingConflicts: [] };
  void _digest;
  return { ...unsigned, manifestDigest: sha256(canonicalJson(unsigned)) };
}

function bankManifest(withRedis = true) {
  const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
    sheets: makeSheets(3, (tabs) => {
      for (const tab of [tabs.TaskAssignments, tabs.TaskCompletions]) {
        tab.rows[0].cells[tab.headers.indexOf('cycleId')] = 'v1|TI1|r1|2026-08-31T00:00:00Z';
      }
    }), ...(withRedis ? { redis: makeRedis() } : {}) });
  expect(value.status).toBe('BLOCKED');
  // The normalizer symmetrically propagates the authority quarantine to the
  // claim union as CLAIM_BINDING_CONFLICT; no other source defects are allowed.
  for (const source of value.quarantines) expect(source.errorCodes.filter((code) => code !== 'CLAIM_BINDING_CONFLICT')).toEqual(['UNSUPPORTED_LEGACY_BANK_AUTHORITY']);
  return bypassQuarantine(value);
}

function resign(value: LegacyNormalizationManifest, mutate: (draft: Record<string, unknown>) => void): LegacyNormalizationManifest {
  const draft = structuredClone(value) as unknown as Record<string, unknown>;
  mutate(draft);
  delete draft.manifestDigest;
  draft.manifestDigest = sha256(canonicalJson(draft));
  return draft as unknown as LegacyNormalizationManifest;
}

function expectedCheckpointCount(value: LegacyNormalizationManifest): number {
  const mapped = new Set(value.mappings.map(({ sourceDigest }) => sourceDigest));
  return value.mappings.length + value.sourceRecords.filter((record) => !mapped.has(
    record.source.kind === 'SHEET' ? record.source.rowHash : record.source.sourceDigest,
  )).length;
}

async function prepare(tenantId = harness.tenantOneId) {
  await harness.database.query(
    `INSERT INTO migration_jobs (tenant_id, job_id, status) VALUES ($1, $2, 'VALIDATED')`,
    [tenantId, JOB_ID],
  );
}

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const migration of ['0009_promotion_tombstone_invariant.sql', '0010_task_admin_invariants.sql', '0011_generator_grant_claims.sql', '0012_platform_tenant_discovery.sql']) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', migration), 'utf8'));
  }
});

afterEach(async () => {
  await harness?.close();
});

describe('legacy migration importer', () => {

  const eventTables = [
    ['task_completions', 'TaskCompletions', 'completionId', 'completion_id', 'timestamp'],
    ['transactions', 'Transactions', 'transactionId', 'transaction_id', 'timestamp'],
    ['task_assignments', 'TaskAssignments', 'assignmentId', 'assignment_id', 'createdAt'],
  ] as const;
  type EventTable = typeof eventTables[number];
  function historicalEvents(descriptor: EventTable, tied = false) {
    const [table, tab, id, , timestamp] = descriptor;
    const sheets = makeSupportedSheets(3, (tabs) => {
      const template = structuredClone(tabs[tab].rows[table === 'task_assignments' ? 1 : 0]);
      if (table !== 'transactions') {
        const second = structuredClone(tabs.Students.rows[0]); second.cells[0] = 'S2'; tabs.Students.rows.push(second);
        if (table === 'task_completions') {
          const secondAssignments = tabs.TaskAssignments.rows.map((row) => {
            const copy = structuredClone(row);
            for (const key of ['assignmentId', 'previousAssignmentId']) {
              const index = tabs.TaskAssignments.headers.indexOf(key);
              if (copy.cells[index]) copy.cells[index] += '-S2';
            }
            copy.cells[tabs.TaskAssignments.headers.indexOf('studentId')] = 'S2';
            return copy;
          });
          tabs.TaskAssignments.rows.push(...secondAssignments);
        }
      }
      tabs.TaskCompletions.rows = [];
      tabs.Transactions.rows = [];
      tabs.Adjustments.rows = [];
      const chronological = ['Z-old', 'A-new'].map((value, index) => {
        const row = structuredClone(template);
        row.cells[tabs[tab].headers.indexOf(id)] = value;
        row.cells[tabs[tab].headers.indexOf(timestamp)] = !tied && index === 1
          ? '2026-08-31T01:00:00.000Z' : '2026-08-31T00:00:00.000Z';
        if (table !== 'transactions') row.cells[tabs[tab].headers.indexOf('studentId')] = index === 0 ? 'S1' : 'S2';
        if (table === 'task_assignments') {
          row.cells[tabs[tab].headers.indexOf('source')] = 'LEGACY_SEED';
          row.cells[tabs[tab].headers.indexOf('previousAssignmentId')] = '';
        }
        if (table === 'task_completions') {
          row.cells[tabs[tab].headers.indexOf('assignmentId')] = index === 0 ? 'AS1' : 'AS1-S2';
          for (const key of ['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName']) {
            row.cells[tabs[tab].headers.indexOf(key)] = '';
          }
        }
        return row;
      });
      // Assignments deliberately retain physical append order. The legacy parser
      // does not sort them, even when wall-clock timestamps are inverted.
      if (table === 'task_assignments' && !tied) {
        chronological[0].cells[tabs[tab].headers.indexOf(timestamp)] = '2026-08-31T02:00:00.000Z';
      }
      tabs[tab].rows = tied || table === 'task_assignments' ? chronological : chronological.reverse();
    });
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets });
    expect(value.status).toBe('READY_FOR_IMPORT');
    return value;
  }
  async function eventRows([table, , , id]: EventTable) {
    return (await harness.database.query<{ id: string; sequence: string }>(
      `SELECT ${id} AS id,event_sequence::text AS sequence FROM ${table} WHERE tenant_id=$1 ORDER BY event_sequence`,
      [harness.tenantOneId],
    )).rows;
  }
  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('imports historical event order rather than target-ID order: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    const before = canonicalJson(value);
    await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    expect((await eventRows(descriptor)).map((row) => row.id)).toEqual(['Z-old', 'A-new']);
    expect(canonicalJson(value)).toBe(before);
  });
  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('uses actual source row provenance for same-time historical events: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor, true);
    await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    expect((await eventRows(descriptor)).map((row) => row.id)).toEqual(['Z-old', 'A-new']);
  });
  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('resumes historical event order across an interruption and sequence gaps: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH 101`);
    const interrupt: TenantImportTransactionRunner = async (tenantId, callback) => {
      if ((await eventRows(descriptor)).length === 1) throw new Error('historical interruption');
      return harness.runTenantTransaction(tenantId, callback);
    };
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: interrupt })).rejects.toThrow('historical interruption');
    expect(await eventRows(descriptor)).toEqual([{ id: 'Z-old', sequence: '101' }]);
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH 201`);
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    await importLegacyNormalizationManifest(input);
    const persisted = await eventRows(descriptor);
    expect(persisted).toEqual([{ id: 'Z-old', sequence: '101' }, { id: 'A-new', sequence: '201' }]);
    await importLegacyNormalizationManifest(input);
    expect(await eventRows(descriptor)).toEqual(persisted);
  });

  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('rejects conflicting persisted historical event order without changing history or checkpoints: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    const [table, , , id] = descriptor;
    await harness.database.exec(`ALTER SEQUENCE ${table}_event_sequence_seq RESTART WITH 101`);
    const interrupt: TenantImportTransactionRunner = async (tenantId, callback) => {
      if ((await eventRows(descriptor)).length === 1) throw new Error('historical interruption');
      return harness.runTenantTransaction(tenantId, callback);
    };
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: interrupt })).rejects.toThrow('historical interruption');
    // Seed a prior import's wrong relative sequence using INSERT only. All
    // production FK/check/append-only triggers remain enabled; no history repair.
    const timeColumn = table === 'task_completions' ? 'completed_at' : table === 'transactions' ? 'occurred_at' : 'created_at';
    await harness.database.query(`INSERT INTO ${table}
      SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(original) || $3::jsonb)).*
      FROM ${table} original WHERE tenant_id=$1 AND ${id}=$2`,
    [harness.tenantOneId, 'Z-old', JSON.stringify({ [id]: 'A-new', event_sequence: 100, [timeColumn]: '2026-08-31T01:00:00.000Z' })]);
    const history = await eventRows(descriptor);
    expect(history.map((row) => row.id)).toEqual(['A-new', 'Z-old']);
    const checkpoints = (await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows;
    await expect(importLegacyNormalizationManifest(input)).rejects.toThrow(/historical.*order/i);
    expect(await eventRows(descriptor)).toEqual(history);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(checkpoints);
  });
  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('rolls back a resumed historical event when its generated sequence goes backwards: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH 101`);
    const interrupt: TenantImportTransactionRunner = async (tenantId, callback) => {
      if ((await eventRows(descriptor)).length === 1) throw new Error('historical interruption');
      return harness.runTenantTransaction(tenantId, callback);
    };
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: interrupt })).rejects.toThrow('historical interruption');
    const history = await eventRows(descriptor);
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH 1`);
    await expect(importLegacyNormalizationManifest(input)).rejects.toThrow(/historical.*order/i);
    expect(await eventRows(descriptor)).toEqual(history);
  });
  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('rolls back an unsafe generated event sequence target batch: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    const interrupt: TenantImportTransactionRunner = async (tenantId, callback) => {
      if ((await eventRows(descriptor)).length === 1) throw new Error('historical interruption');
      return harness.runTenantTransaction(tenantId, callback);
    };
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: interrupt })).rejects.toThrow('historical interruption');
    const history = (await harness.database.query(`SELECT * FROM ${descriptor[0]} ORDER BY event_sequence`)).rows;
    const checkpoints = (await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows;
    const job = (await harness.database.query('SELECT * FROM migration_jobs WHERE job_id=$1', [JOB_ID])).rows;
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH ${BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)}`);
    await expect(importLegacyNormalizationManifest(input)).rejects.toThrow(/historical.*order/i);
    expect((await harness.database.query(`SELECT * FROM ${descriptor[0]} ORDER BY event_sequence`)).rows).toEqual(history);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(checkpoints);
    expect((await harness.database.query('SELECT * FROM migration_jobs WHERE job_id=$1', [JOB_ID])).rows).toEqual(job);
  });

  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('imports and exactly resumes high safe generated event sequences including the maximum: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    await harness.database.exec(`ALTER SEQUENCE ${descriptor[0]}_event_sequence_seq RESTART WITH ${maximum - BigInt(1)}`);
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    await importLegacyNormalizationManifest(input);
    expect(await eventRows(descriptor)).toEqual([
      { id: 'Z-old', sequence: String(maximum - BigInt(1)) }, { id: 'A-new', sequence: String(maximum) },
    ]);
    const history = (await harness.database.query(`SELECT * FROM ${descriptor[0]} ORDER BY event_sequence`)).rows;
    const checkpoints = (await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows;
    await importLegacyNormalizationManifest(input);
    expect((await harness.database.query(`SELECT * FROM ${descriptor[0]} ORDER BY event_sequence`)).rows).toEqual(history);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(checkpoints);
  });

  it.each(eventTables.map((descriptor) => ({ descriptor, table: descriptor[0] })))('rejects an already persisted unsafe generated event sequence on resume without mutation: $table', async ({ descriptor }) => {
    const value = historicalEvents(descriptor);
    await prepare();
    const [table] = descriptor;
    let captured: Record<string, unknown> | undefined;
    const capture: TenantImportTransactionRunner = (tenantId, callback) => harness.runTenantTransaction(tenantId, async (transaction) => {
      const result = await callback(transaction);
      const rows = (await harness.database.query<{ value: Record<string, unknown> }>(`SELECT to_jsonb(original) AS value FROM ${table} original`)).rows;
      if (rows.length === 1) {
        captured = rows[0].value;
        throw new Error('capture and roll back first event');
      }
      return result;
    });
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 1, runTransaction: harness.runTenantTransaction };
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: capture })).rejects.toThrow('capture and roll back first event');
    expect(captured).toBeDefined();
    expect(await eventRows(descriptor)).toEqual([]);
    // Seed an exact prior import row using INSERT only, preserving production
    // immutable guards and all semantic fields; only its generated value differs.
    await harness.database.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, $1::jsonb)).*`,
      [JSON.stringify({ ...captured, event_sequence: String(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)) })]);
    await harness.database.exec(`ALTER SEQUENCE ${table}_event_sequence_seq RESTART WITH ${BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2)}`);
    const history = (await harness.database.query(`SELECT * FROM ${table} ORDER BY event_sequence`)).rows;
    const checkpoints = (await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows;
    const job = (await harness.database.query('SELECT * FROM migration_jobs WHERE job_id=$1', [JOB_ID])).rows;
    await expect(importLegacyNormalizationManifest(input)).rejects.toThrow(/historical.*order/i);
    expect((await harness.database.query(`SELECT * FROM ${table} ORDER BY event_sequence`)).rows).toEqual(history);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(checkpoints);
    expect((await harness.database.query('SELECT * FROM migration_jobs WHERE job_id=$1', [JOB_ID])).rows).toEqual(job);
  });

  it.each(['transactions', 'task_assignments'] as const)('keeps ready historical events ordered while respecting predecessor dependencies: %s', async (table) => {
    const tab = table === 'transactions' ? 'Transactions' : 'TaskAssignments';
    const sheets = makeSupportedSheets(3, (tabs) => {
      const template = structuredClone(tabs[tab].rows[table === 'task_assignments' ? 1 : 0]);
      if (table === 'task_assignments') {
        const second = structuredClone(tabs.Students.rows[0]); second.cells[0] = 'S2'; tabs.Students.rows.push(second);
      }
      tabs.TaskCompletions.rows = []; tabs.Adjustments.rows = []; tabs.Transactions.rows = [];
      const values = table === 'transactions' ? [
        { transactionId: 'Z-parent', status: 'CANCELLED', timestamp: '2026-08-31T00:00:00.000Z' },
        { transactionId: 'A-child', status: 'CANCEL_REVERSAL', timestamp: '2026-08-31T01:00:00.000Z', items: '[]', totalAmount: '-20', balanceBefore: '80', balanceAfter: '100', operator: 'cancel:Z-parent' },
        { transactionId: 'M-independent', timestamp: '2026-08-31T02:00:00.000Z' },
      ] : [
        { assignmentId: 'Z-parent', source: 'LEGACY_SEED', previousAssignmentId: '' },
        { assignmentId: 'A-child', source: 'CARRY_FORWARD', previousAssignmentId: 'Z-parent', cycleId: 'v1|TI1|r3|2026-09-01T00:00:00Z', ruleVersion: '3', cycleStartsAt: '2026-09-01T00:00:00.000Z', cycleEndsAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' },
        { assignmentId: 'M-independent', source: 'LEGACY_SEED', previousAssignmentId: '', studentId: 'S2' },
      ];
      tabs[tab].rows = values.map((values) => {
        const row = structuredClone(template);
        for (const [key, value] of Object.entries(values)) row.cells[tabs[tab].headers.indexOf(key)] = value;
        return row;
      });
    });
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets });
    expect(value.status).toBe('READY_FOR_IMPORT'); await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    expect((await eventRows(eventTables.find((entry) => entry[0] === table)!)).map((row) => row.id)).toEqual(['Z-parent', 'A-child', 'M-independent']);
  });

  // Normalizer semantic inventory: 209-325 status/cardinality/sign/delta, safe
  // item sums, unique products, legacy arithmetic and extended snapshot parser;
  // 439-531 exact one-to-one adjustment key and ADMIN pseudo-item; 580-621
  // reversal identity/student/time/inverse totals/exact cardinality; 634-724
  // business-instance equality and eight-field assignment/completion tuple;
  // 414-419 BANK operation and carry balances; 843-867 discriminated tombstones.
  // Existing graph/projection tests retain FK/unique/cycle/complete-output gates.
  // Extended item checks reuse parseCheckoutLineSnapshot: safe nonnegative money,
  // price/quantity/final aliases, paid+free, regular product and discount difference;
  // exact nested discriminators, promotion identity/type/product/order/multiplicity,
  // free quantities and contiguous before/after chain. Do NOT recompute discounts:
  // the real-normalizer empty-adjustment historical snapshot below is accepted.
  // Event shape guards retain cycle chronology, operation/hash pairing, complete
  // evidence binding and provenance. ADMIN/ADMIN_RESET/QR remain rejected for missing
  // production admin-operation provenance (0010), rather than inventing history.
  // V1 keeps acquisition owner evidence; ORPHAN cannot add even a null ownerDigest.
  // Its canonical provenance excludes :orphan; its source pointer includes :orphan
  // and sha256(tupleDigest). Existing tests verify deferred staging/exact reruns.
  // Full pre-fix source-variant inventory: secondbot/cache/task16-semantic-inventory.md.
  function redisGraphManifest(kind = 'mixed', tombstone?: 'V1_GLOBAL' | 'ORPHAN_V2') {
    if (kind === 'mixed') return bankManifest();
    return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      sheets: makeSupportedSheets(3, (tabs) => { if (kind === 'Redis only') tabs.TaskCompletions.rows = []; }),
      redis: makeRedis(tombstone === 'V1_GLOBAL' ? { v1Tombstones: [{ tupleDigest: 'e'.repeat(64), ownerDigest: 'a'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }] }
        : tombstone === 'ORPHAN_V2' ? { orphanedClaimDigests: ['e'.repeat(64)] } : {}),
    });
  }
  function removeGraphTable(draft: Record<string, unknown>, table: string) {
    (draft.records as Record<string, unknown[]>)[table] = [];
    draft.sourceRecords = (draft.sourceRecords as Array<Record<string, unknown>>).filter((s) => s.targetTable !== table);
    draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((m) => m.targetTable !== table);
  }
  function rehashRedisSource(draft: Record<string, unknown>, source: Record<string, unknown>) {
    const pointer = source.source as Record<string, unknown>;
    const row = source.canonicalRecord as Record<string, unknown>;
    const old = pointer.sourceDigest;
    const raw = 'binding' in row ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'tenantId'))
      : row.provider ? { tupleDigest: row.tupleDigest, boardId: row.boardId, postId: row.postId, ownerDigest: row.ownerDigest, operationId: row.operationId, sourceProvenance: pointer.provenance }
        : { tupleDigest: row.tupleDigest, ownerDigest: row.ownerDigest, sourceProvenance: row.provenance };
    pointer.sourceDigest = row.kind === 'ORPHAN_V2' ? sha256(String(row.tupleDigest)) : sha256(canonicalJson(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined))));
    for (const mapping of draft.mappings as Array<Record<string, unknown>>) if (mapping.sourceDigest === old) mapping.sourceDigest = pointer.sourceDigest;
  }
  it.each(['Transactions', 'Adjustments', 'Students', 'TaskCompletions'].flatMap((tab) => ['identical', 'divergent', 'distinct digest'].map((kind) => [tab, kind])))('rejects ordinary source cardinality before digest reduction: %s %s', async (tab, kind) => {
    const value = resign(manifest(), (draft) => {
      const all = draft.sourceRecords as Array<Record<string, unknown>>;
      const original = all.find((s) => (s.source as Record<string, unknown>).tab === tab && !(s.canonicalRecord as Record<string, unknown>)?.provider)!;
      const copy = structuredClone(original);
      (copy.source as Record<string, unknown>).rowNumber = 999;
      if (kind === 'distinct digest') {
        const pointer = copy.source as Record<string, unknown>; const old = pointer.rowHash;
        pointer.rowHash = sha256('distinct source row');
        const mappings = draft.mappings as Array<Record<string, unknown>>;
        mappings.push(...mappings.filter((m) => m.sourceDigest === old).map((m) => ({ ...m, sourceDigest: pointer.rowHash })));
      }
      if (kind === 'divergent') {
        const row = copy.canonicalRecord as Record<string, unknown>;
        row[tab === 'Students' ? 'name' : tab === 'TaskCompletions' ? 'note' : 'operator'] = 'different';
      }
      all.push(copy);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction })).rejects.toThrow(/duplicate.*source|source.*identity/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it.each(['clear snapshot', 'completion version', 'assignment version', 'promotion version', 'link version', 'task version'])('rejects source-version contract corruption: %s', async (kind) => {
    await rejectSemantic(resign(semanticManifest(), (draft) => {
      const [tab, table] = kind === 'assignment version' ? ['TaskAssignments', 'task_assignments']
        : kind === 'promotion version' ? ['Promotions', 'promotions'] : kind === 'link version' ? ['PromotionProducts', 'promotion_products']
          : kind === 'task version' ? ['Tasks', 'tasks'] : ['TaskCompletions', 'task_completions'];
      const row = sources(draft, tab)[0];
      if (kind === 'clear snapshot') for (const key of ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId']) row[key] = null;
      else row.schemaVersion = 99;
      Object.assign((draft.records as Record<string, Array<Record<string, unknown>>>)[table][0], structuredClone(row));
    }), 'Legacy migration manifest is structurally invalid.');
  });
  function mutateRedisScalar(draft: Record<string, unknown>, key: string, value: string) {
    const records = draft.records as Record<string, Array<Record<string, unknown>>>;
    const binding = records.legacy_operation_bindings[0]; const claim = records.padlet_evidence_claims[0];
    const nested = binding.binding as Record<string, unknown>;
    if (key === 'author') { (nested.evidence as Record<string, unknown>).evidenceAuthorFullName = value; claim.evidenceAuthorFullName = value; }
    else if (key === 'operationId') { binding.operationId = claim.operationId = value; binding.ownerDigest = claim.ownerDigest = sha256(value); }
    else {
      const old = String(nested[key]);
      // Update every canonical and target reference, including deterministic IDs below.
      const replace = (object: unknown): void => {
        if (!object || typeof object !== 'object') return;
        for (const [field, child] of Object.entries(object)) {
          if (child === old) (object as Record<string, unknown>)[field] = value;
          else replace(child);
        }
      };
      replace(draft);
    }
    binding.payloadHash = claim.operationPayloadHash = `sha256:${sha256(canonicalJson(nested))}`;
    const all = draft.sourceRecords as Array<Record<string, unknown>>;
    for (const source of all) {
      if (source.targetTable === 'legacy_operation_bindings') {
        if (key === 'operationId') {
          const old = source.targetId;
          source.targetId = deterministicId(String(draft.tenantId), String(draft.migrationJobId), 'legacy_operation_bindings', value);
          for (const m of draft.mappings as Array<Record<string, unknown>>) if (m.targetId === old) m.targetId = source.targetId;
        }
        source.canonicalRecord = structuredClone(binding); rehashRedisSource(draft, source);
      }
      if (source.targetTable === 'padlet_evidence_claims') { source.canonicalRecord = structuredClone(claim); rehashRedisSource(draft, source); }
    }
    claim.provenances = structuredClone(all.filter((s) => s.targetTable === 'padlet_evidence_claims').map((s) => s.source));
    for (const s of all.filter((s) => s.targetTable === 'padlet_evidence_claims')) s.canonicalRecord = structuredClone(claim);
    if (key === 'studentId') {
      for (const source of all.filter((s) => (s.source as Record<string, unknown>).tab === 'Tasks')) {
        const row = source.canonicalRecord as Record<string, unknown>;
        const old = deterministicId(String(draft.tenantId), 'task_allowed_students', String(row.taskInstanceId), 'S1');
        const id = deterministicId(String(draft.tenantId), 'task_allowed_students', String(row.taskInstanceId), value);
        for (const m of draft.mappings as Array<Record<string, unknown>>) if (m.targetId === old) m.targetId = id;
      }
    }
  }
  it.each([['author', ''], ['author', ' '], ['author', ' Alice'], ['author', 'a'.repeat(201)], ...['operationId', 'taskId', 'studentId'].map((key) => [key, 'i'.repeat(129)])])('rejects rehashed Redis scalar contract: %s %s', async (key, value) => {
    await rejectSemantic(resign(redisGraphManifest('Redis only'), (draft) => mutateRedisScalar(draft, key, value)),
      key === 'operationId' ? 'Redis operation binding provenance is invalid.' : 'Legacy migration manifest is structurally invalid.');
  });
  it('rejects rehashed arbitrary sole Redis claim provenance', async () => {
    await rejectSemantic(resign(redisGraphManifest('Redis only'), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'padlet_evidence_claims')!;
      (source.source as Record<string, unknown>).provenance = 'arbitrary'; rehashRedisSource(draft, source);
      const claim = (draft.records as Record<string, Array<Record<string, unknown>>>).padlet_evidence_claims[0];
      claim.provenances = [structuredClone(source.source)]; source.canonicalRecord = structuredClone(claim);
    }), 'Redis claim canonical source schema is invalid.');
  });
  it.each(['author minimum', 'author maximum', 'operationId', 'taskId', 'studentId'])('imports real normalized Redis scalar boundary: %s', async (kind) => {
    const original = makeRedis().operationBindings[0];
    const operation = { ...original, binding: { ...original.binding, evidence: { ...original.binding.evidence } } };
    const key = kind.startsWith('author') ? 'author' : kind;
    const value = kind === 'author minimum' ? 'A' : kind === 'author maximum' ? 'a'.repeat(200) : 'i'.repeat(128);
    if (key === 'author') operation.binding.evidence.evidenceAuthorFullName = value;
    else if (key === 'operationId') operation.operationId = value;
    else if (key === 'taskId') operation.binding.taskId = value;
    else operation.binding.studentId = value;
    const sheets = makeSupportedSheets(3, (tabs) => {
      tabs.TaskCompletions.rows = [];
      if (key === 'taskId' || key === 'studentId') {
        const old = key === 'taskId' ? 'T1' : 'S1';
        for (const tab of Object.values(tabs)) for (const row of tab.rows) row.cells = row.cells.map((cell) => cell === old ? value : cell);
      }
    });
    const normalized = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets, redis: makeRedis({ operationBindings: [operation] }) });
    expect(normalized.status).toBe('READY_FOR_IMPORT'); await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: normalized, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query<{ count: number }>('SELECT count(*)::int count FROM migration_source_records WHERE tenant_id=$1', [harness.tenantOneId]);
    expect(rows[0].count).toBe(expectedCheckpointCount(normalized));
  });
  it.each([1, 2, 3] as const)('enforces the operational contract for real normalized completion source version: %s', async (version) => {
    const sheets = makeSupportedSheets(version, (tabs) => {
      if (version === 1) {
        const modern = makeSupportedSheets(3).tabs.TaskCompletions;
        tabs.TaskCompletions = { headers: modern.headers.slice(0, 10), rows: modern.rows.map((row) => ({ ...row, cells: row.cells.slice(0, 10) })) };
      } else {
        for (const name of ['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName']) {
          const index = tabs.TaskCompletions.headers.indexOf(name);
          if (index >= 0) tabs.TaskCompletions.rows[0].cells[index] = '';
        }
      }
    });
    const normalized = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets });
    if (version === 1) {
      expect(normalized.status).toBe('BLOCKED');
      expect(normalized.sourceRecords.find((source) => source.canonicalRecord?.completionId === 'C1')).toMatchObject({
        mappingStatus: 'QUARANTINED', errorCodes: ['UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY'], canonicalRecord: { schemaVersion: 1 } });
      expect(normalized.records.task_completions).toEqual([]);
      return;
    }
    expect(normalized.status).toBe('READY_FOR_IMPORT'); await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: normalized, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query<{ schema_version: number }>('SELECT schema_version FROM task_completions WHERE tenant_id=$1', [harness.tenantOneId]);
    expect(rows).toEqual([{ schema_version: 1 }]);
    expect(normalized.sourceRecords.find((source) => source.canonicalRecord?.completionId === 'C1')?.canonicalRecord?.schemaVersion).toBe(2);
  });
  it.each([
    ['empty', ''], ['whitespace', ' \t\n '], ['untrimmed', ' Historical student '],
  ])('rejects correlated completion studentName %s before transactions', async (_label, studentName) => {
    await rejectSemantic(resign(manifest(), (draft) => {
      sources(draft, 'TaskCompletions')[0].studentName = studentName;
      (draft.records as Record<string, Array<Record<string, unknown>>>).task_completions[0].studentName = studentName;
    }), 'Legacy migration manifest is structurally invalid.');
  });
  it('imports the historical completion studentName independently of the current student name', async () => {
    const studentName = 'Historical student';
    const normalized = createLegacyNormalizationManifest({
      tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      sheets: makeSupportedSheets(3, (tabs) => {
        tabs.TaskCompletions.rows[0].cells[tabs.TaskCompletions.headers.indexOf('studentName')] = studentName;
        tabs.Students.rows[0].cells[tabs.Students.headers.indexOf('name')] = 'Current student';
      }),
      redis: makeRedis(),
    });
    expect(normalized.status).toBe('READY_FOR_IMPORT');
    await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: normalized, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query<{ student_name_snapshot: string; name: string }>(
      `SELECT c.student_name_snapshot, s.name FROM task_completions c
       JOIN students s USING (tenant_id, student_id) WHERE c.tenant_id=$1`, [harness.tenantOneId],
    );
    expect(rows).toEqual([{ student_name_snapshot: studentName, name: 'Current student' }]);
  });
  it.each(['missing operation', 'missing digest', 'null digest', 'wrong digest'])('rejects completion evidence obligation: %s', async (kind) => {
    await rejectSemantic(resign(bankManifest(), (draft) => {
      removeGraphTable(draft, 'padlet_evidence_claims');
      const row = sources(draft, 'TaskCompletions')[0];
      if (kind === 'missing operation') { row.operationId = row.operationPayloadHash = null; removeGraphTable(draft, 'legacy_operation_bindings'); }
      if (kind === 'null digest') row.tupleDigest = null;
      else if (kind === 'wrong digest') row.tupleDigest = 'f'.repeat(64);
      else delete row.tupleDigest;
      const target = (draft.records as Record<string, Array<Record<string, unknown>>>).task_completions[0];
      delete target.tupleDigest; Object.assign(target, row);
    }), 'Legacy migration manifest is structurally invalid.');
  });
  it.each(['Redis only', 'mixed'])('rejects reverse Redis claim omission: %s', async (kind) => {
    await rejectSemantic(resign(redisGraphManifest(kind), (draft) => {
      removeGraphTable(draft, 'task_completions'); removeGraphTable(draft, 'padlet_evidence_claims');
    }), 'Redis binding graph requires exactly one Redis claim contributor.');
  });
  it.each(['taskId', 'studentId'])('rejects rehashed Redis-only canonical reference: %s', async (key) => {
    await rejectSemantic(resign(redisGraphManifest('Redis only'), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const binding = records.legacy_operation_bindings[0]; const claim = records.padlet_evidence_claims[0];
      (binding.binding as Record<string, unknown>)[key] = claim[key] = 'missing-reference';
      binding.payloadHash = claim.operationPayloadHash = `sha256:${sha256(canonicalJson(binding.binding))}`;
      for (const source of draft.sourceRecords as Array<Record<string, unknown>>) {
        if (source.targetTable === 'legacy_operation_bindings') { source.canonicalRecord = structuredClone(binding); rehashRedisSource(draft, source); }
        if (source.targetTable === 'padlet_evidence_claims') source.canonicalRecord = structuredClone(claim);
      }
    }), 'Redis claim graph contains an unresolved canonical reference.');
  });
  it('rejects an invented second Redis contributor provenance despite rehashing the union', async () => {
    await rejectSemantic(resign(redisGraphManifest('Redis only'), (draft) => {
      const all = draft.sourceRecords as Array<Record<string, unknown>>;
      const original = all.find((s) => s.targetTable === 'padlet_evidence_claims')!;
      const copy = structuredClone(original); const pointer = copy.source as Record<string, unknown>;
      // A forged provenance suffix cannot create a second authentic contributor.
      // The exact-duplicate case below independently exercises union uniqueness.
      pointer.provenance = 'upstash:padlet:evidence-bindings:v2:duplicate';
      pointer.sourceDigest = 'f'.repeat(64);
      all.push(copy);
      (draft.mappings as Array<Record<string, unknown>>).push({ sourceDigest: pointer.sourceDigest, targetTable: copy.targetTable, targetId: copy.targetId, status: 'STAGED' });
      rehashRedisSource(draft, copy);
      const claim = (draft.records as Record<string, Array<Record<string, unknown>>>).padlet_evidence_claims[0];
      claim.provenances = structuredClone([original.source, copy.source]).sort((a, b) => String((a as Record<string, unknown>).sourceDigest).localeCompare(String((b as Record<string, unknown>).sourceDigest)));
      original.canonicalRecord = structuredClone(claim); copy.canonicalRecord = structuredClone(claim);
    }), 'Redis claim canonical source schema is invalid.');
  });
  it('rejects an exact duplicate authenticated Redis contributor at the provenance union gate', async () => {
    await rejectSemantic(resign(redisGraphManifest('Redis only'), (draft) => {
      const all = draft.sourceRecords as Array<Record<string, unknown>>;
      const original = all.find((source) => source.targetTable === 'padlet_evidence_claims')!;
      const copy = structuredClone(original);
      all.push(copy);
      const claim = (draft.records as Record<string, Array<Record<string, unknown>>>).padlet_evidence_claims[0];
      claim.provenances = structuredClone([original.source, copy.source]);
      original.canonicalRecord = structuredClone(claim);
      copy.canonicalRecord = structuredClone(claim);
      // One mapping per source digest is already present. Duplicating it would
      // hit mapping uniqueness rather than repeated contributor validation.
    }), 'Claim provenance union does not equal its full contributing source pointers.');
  });

  it.each(['V1_GLOBAL', 'ORPHAN_V2'] as const)('rejects claim/tombstone tuple collision: %s', async (kind) => {
    await rejectSemantic(resign(redisGraphManifest('Redis only', kind), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const row = records.padlet_claim_digest_tombstones[0]; row.tupleDigest = records.padlet_evidence_claims[0].tupleDigest;
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'padlet_claim_digest_tombstones')!;
      source.canonicalRecord = structuredClone(row);
      const old = source.targetId;
      // Match the normalizer's global deterministic target identity.
      const hash = sha256(['global', 'padlet_claim_digest_tombstones', String(row.tupleDigest)].map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|'));
      source.targetId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      for (const m of draft.mappings as Array<Record<string, unknown>>) if (m.targetId === old) m.targetId = source.targetId;
      rehashRedisSource(draft, source);
    }), 'Claim and tombstone tuple sets must be disjoint.');
  });
  it.each(['V1_GLOBAL', 'ORPHAN_V2'] as const)('imports real normalized Redis graph and tombstone discriminator: %s', async (kind) => {
    await prepare(); const value = redisGraphManifest('Redis only', kind); expect(value.status).toBe('READY_FOR_IMPORT');
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query("SELECT mapping_status,canonical_record->>'kind' kind FROM migration_source_records WHERE tenant_id=$1 AND canonical_record->>'kind'=$2", [harness.tenantOneId, kind]);
    expect(rows).toEqual([{ mapping_status: 'STAGED', kind }]);
  });
  it.each((['V1_GLOBAL', 'ORPHAN_V2'] as const).flatMap((kind) =>
    ['null owner', 'missing owner', 'unknown', 'null provenance', 'arbitrary provenance', 'null kind']
      .filter((edit) => kind !== 'ORPHAN_V2' || edit !== 'missing owner').map((edit) => [kind, edit] as const)))('rejects discriminated tombstone corruption: %s %s', async (kind, edit) => {
      await rejectSemantic(resign(redisGraphManifest('Redis only', kind), (draft) => {
        const records = draft.records as Record<string, Array<Record<string, unknown>>>;
        const row = records.padlet_claim_digest_tombstones[0];
        if (edit === 'null owner') row.ownerDigest = null;
        if (edit === 'missing owner') delete row.ownerDigest;
        if (edit === 'unknown') row.unexpected = null;
        if (edit === 'null provenance') row.provenance = null;
        if (edit === 'arbitrary provenance') row.provenance = 'fabricated';
        if (edit === 'null kind') row.kind = null;
        const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'padlet_claim_digest_tombstones')!;
        source.canonicalRecord = structuredClone(row);
        if (kind === 'V1_GLOBAL') (source.source as Record<string, unknown>).provenance = row.provenance;
        if (kind === 'V1_GLOBAL') rehashRedisSource(draft, source);
      }), kind === 'ORPHAN_V2' && ['null owner', 'arbitrary provenance'].includes(edit) ? 'Redis orphan discriminator is invalid.' : 'Legacy migration manifest is structurally invalid.');
  });
  it.each(['equal', 'inverted'])('rejects correlated task availability chronology: %s', async (kind) => {
    await rejectSemantic(resign(manifest(), (draft) => {
      const row = sources(draft, 'Tasks')[0]; row.availableFrom = '2026-09-01T00:00:00.000Z';
      row.dueAt = kind === 'equal' ? row.availableFrom : '2026-08-31T00:00:00.000Z';
      Object.assign((draft.records as Record<string, Array<Record<string, unknown>>>).tasks[0], structuredClone(row));
    }), 'Legacy migration manifest is structurally invalid.');
  });
  it.each(['both null', 'start null', 'end null', 'ordered'])('imports real normalized task availability: %s', async (kind) => {
    await prepare();
    const availableFrom = kind === 'both null' || kind === 'start null' ? '' : '2026-08-31T00:00:00.000Z';
    const dueAt = kind === 'both null' || kind === 'end null' ? '' : '2026-09-01T00:00:00.000Z';
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      for (const [key, cell] of Object.entries({ availableFrom, dueAt })) tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf(key)] = cell;
    }) });
    expect(value.status).toBe('READY_FOR_IMPORT');
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query<{ available_from: Date | null; due_at: Date | null }>('SELECT available_from,due_at FROM tasks WHERE tenant_id=$1', [harness.tenantOneId]);
    expect(rows.map((r) => [r.available_from?.toISOString() ?? null, r.due_at?.toISOString() ?? null])).toEqual([[availableFrom || null, dueAt || null]]);
  });
  function semanticManifest(reversal = false) {
    return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets: makeSupportedSheets(3, (tabs) => {
      const set = (tab: string, index: number, values: Record<string, string>) => {
        for (const [key, value] of Object.entries(values)) tabs[tab].rows[index].cells[tabs[tab].headers.indexOf(key)] = value;
      };
      set('TaskCompletions', 0, Object.fromEntries(['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'].map((key) => [key, ''])));
      tabs.Students.rows.push(structuredClone(tabs.Students.rows[0])); set('Students', 1, { studentId: 'S2' });
      tabs.Tasks.rows.push(structuredClone(tabs.Tasks.rows[0])); set('Tasks', 1, { taskId: 'T2', taskInstanceId: 'TI2' });
      if (reversal) {
        set('Transactions', 0, { status: 'CANCELLED' }); tabs.Transactions.rows.push(structuredClone(tabs.Transactions.rows[0]));
        set('Transactions', 2, { transactionId: 'REV1', timestamp: '2026-09-02T00:00:00.000Z', items: '[]', totalAmount: '-20', balanceBefore: '80', balanceAfter: '100', status: 'CANCEL_REVERSAL', operator: 'cancel:TX1' });
      }
    }) });
  }
  function sources(draft: Record<string, unknown>, tab: string) {
    return (draft.sourceRecords as Array<{ source: { kind: string; tab?: string }; canonicalRecord: Record<string, unknown> }>).filter((s) => s.source.kind === 'SHEET' && s.source.tab === tab && !s.canonicalRecord?.provider).map((s) => s.canonicalRecord);
  }
  function syncSemantic(draft: Record<string, unknown>) {
    const records = draft.records as Record<string, Array<Record<string, unknown>>>;
    for (const [tab, table, id] of [['TaskAssignments', 'task_assignments', 'assignmentId'], ['TaskCompletions', 'task_completions', 'completionId']])
      for (const row of sources(draft, tab)) Object.assign(records[table].find((r) => r[id] === row[id])!, structuredClone(row));
    for (const row of sources(draft, 'Transactions')) {
      const target = records.transactions.find((r) => r.transactionId === row.transactionId)!;
      Object.assign(target, { occurredAt: row.timestamp, studentId: row.studentId, legacyTotalAmount: row.totalAmount, balanceBefore: row.balanceBefore, balanceAfter: row.balanceAfter, balanceDelta: Number(row.balanceAfter) - Number(row.balanceBefore), operatorSnapshot: row.operator, legacyStatusSnapshot: row.status, kind: ['COMPLETED', 'CANCELLED'].includes(String(row.status)) ? 'CHECKOUT' : row.status === 'CANCEL_REVERSAL' ? 'CANCELLATION' : row.status });
      if ('reversesTransactionId' in row) target.reversesTransactionId = row.reversesTransactionId;
      for (const item of row.items as Record<string, unknown>[]) Object.assign(records.transaction_items.find((r) => r.itemId === item.itemId)!, { productIdSnapshot: item.productId, currentProductId: row.status === 'ADMIN_ADJUSTMENT' ? null : item.productId, productNameSnapshot: item.name, quantity: item.quantity, unitPriceSnapshot: item.price, subtotalSnapshot: item.subtotal });
    }
    for (const row of sources(draft, 'Adjustments')) Object.assign(records.adjustments.find((r) => r.adjustmentId === row.adjustmentId)!, { transactionId: row.transactionId, mode: row.mode, requestedAmount: row.amount, operatorSnapshot: row.operator, legacyAdjustmentId: row.adjustmentId });
  }
  async function rejectSemantic(value: LegacyNormalizationManifest, expected: string | RegExp) {
    expect(value.status).toBe('READY_FOR_IMPORT');
    expect(value.quarantines).toEqual([]);
    expect(value.blockingConflicts).toEqual([]);
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction })).rejects.toThrow(expected);
    expect(runTransaction).not.toHaveBeenCalled();
  }
  it.each(['price', 'subtotal', 'negative', 'total', 'delta', 'empty purchase', 'reward items', 'admin empty', 'admin name', 'admin product', 'admin quantity', 'admin subtotal', 'amount', 'mode', 'timestamp', 'studentId', 'operator', 'transactionId'])('rejects semantic financial corruption: %s', async (key) => {
    await rejectSemantic(resign(semanticManifest(), (draft) => {
      const [tx, admin] = sources(draft, 'Transactions'); const item = (tx.items as Record<string, unknown>[])[0];
      const adminItem = (admin.items as Record<string, unknown>[])[0]; const adjustment = sources(draft, 'Adjustments')[0];
      if (key === 'price') item.price = 21;
      if (key === 'subtotal') item.subtotal = 21;
      if (key === 'negative') { item.price = -20; item.subtotal = -20; }
      if (key === 'total') { tx.totalAmount = 21; tx.balanceAfter = 79; }
      if (key === 'delta') tx.balanceAfter = 79;
      if (key === 'reward items') tx.status = 'TASK_REWARD';
      if (key === 'empty purchase' || key === 'admin empty') {
        const row = key === 'admin empty' ? admin : tx; const ids = (row.items as Record<string, unknown>[]).map((i) => i.itemId); row.items = [];
        const records = draft.records as Record<string, Array<Record<string, unknown>>>;
        records.transaction_items = records.transaction_items.filter((r) => !ids.includes(r.itemId));
        draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((m) => !ids.includes(m.targetId));
      }
      if (key === 'admin name') adminItem.name = 'invented';
      if (key === 'admin product') adminItem.productId = 'ADMIN-SET';
      if (key === 'admin quantity') { adminItem.quantity = 2; adminItem.price = -5; }
      if (key === 'admin subtotal') { adminItem.price = -11; adminItem.subtotal = -11; }
      const edits: Record<string, unknown> = { amount: 11, mode: 'subtract', timestamp: '2026-09-02T00:00:00.000Z', studentId: 'S2', operator: 'other', transactionId: 'TX1' };
      if (key in edits) adjustment[key] = edits[key];
      if (key === 'operator') adjustment.operatorDigest = sha256('other');
      syncSemantic(draft);
    }), /Canonical financial history is inconsistent/);
  });
  it.each(['operator', 'studentId', 'timestamp', 'amount', 'original status', 'missing reversal', 'positive reversal'])('rejects semantic reversal corruption: %s', async (key) => {
    const value = semanticManifest(true); expect(value.status).toBe('READY_FOR_IMPORT');
    await rejectSemantic(resign(value, (draft) => {
      const rows = sources(draft, 'Transactions'); const original = rows.find((r) => r.transactionId === 'TX1')!; const reversal = rows.find((r) => r.transactionId === 'REV1')!;
      if (key === 'operator') reversal.operator = 'cancel:TX-ADJ1';
      if (key === 'studentId') reversal.studentId = 'S2';
      if (key === 'timestamp') reversal.timestamp = original.timestamp;
      if (key === 'amount') { reversal.totalAmount = -21; reversal.balanceAfter = 101; }
      if (key === 'positive reversal') { reversal.totalAmount = 20; reversal.balanceAfter = 60; }
      if (key === 'original status') original.status = 'COMPLETED';
      if (key === 'missing reversal') {
        draft.sourceRecords = (draft.sourceRecords as Array<Record<string, unknown>>).filter((s) => s.targetId !== 'REV1');
        const records = draft.records as Record<string, Array<Record<string, unknown>>>; records.transactions = records.transactions.filter((r) => r.transactionId !== 'REV1');
        draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((m) => m.targetId !== 'REV1');
      }
      syncSemantic(draft);
    }), /Canonical financial history is inconsistent/);
  });
  it.each(['assignment business', 'completion business', 'taskId', 'taskInstanceId', 'studentId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone'])('rejects semantic event tuple corruption: %s', async (key) => {
    await rejectSemantic(resign(semanticManifest(), (draft) => {
      const assignment = sources(draft, 'TaskAssignments').find((row) => row.assignmentId === 'AS1')!; const completion = sources(draft, 'TaskCompletions')[0];
      if (key === 'assignment business') assignment.taskId = 'missing-business';
      else if (key === 'completion business') completion.taskId = 'T2';
      else assignment[key] = ({ taskId: 'T2', taskInstanceId: 'TI2', studentId: 'S2', cycleId: 'CYCLE2', cycleStartsAt: '2026-08-30T00:00:00.000Z', cycleEndsAt: null, ruleVersion: 3, timeZone: 'UTC' } as Record<string, unknown>)[key];
      syncSemantic(draft);
    }), key === 'timeZone' ? /structurally invalid/ : /tuple reference is inconsistent/);
  });
  it.each(['carry', 'bank'])('rejects semantic event balance corruption: %s', async (kind) => {
    const value = kind === 'bank' ? bankManifest() : semanticManifest();
    await rejectSemantic(resign(value, (draft) => { const row = sources(draft, 'TaskCompletions')[0]; row.balanceAfter = 81; if (kind === 'carry') { row.source = 'CARRY_FORWARD'; row.reward = 0; } syncSemantic(draft); }), 'Legacy migration manifest is structurally invalid.');
  });
  it.each(['provenance', 'ownerDigest', 'null ownerDigest'])('rejects semantic orphan discriminator corruption: %s', async (key) => {
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets: makeSupportedSheets(), redis: makeRedis({ orphanedClaimDigests: ['e'.repeat(64)] }) });
    await rejectSemantic(resign(value, (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => (s.canonicalRecord as Record<string, unknown>)?.kind === 'ORPHAN_V2')!;
      const target = (draft.records as Record<string, Array<Record<string, unknown>>>).padlet_claim_digest_tombstones[0];
      for (const row of [source.canonicalRecord as Record<string, unknown>, target]) row[key === 'null ownerDigest' ? 'ownerDigest' : key] = key === 'provenance' ? 'fabricated' : key === 'null ownerDigest' ? null : 'a'.repeat(64);
    }), 'Redis orphan discriminator is invalid.');
  });
  it.each([
    ['add', 10, -5, 5, -10, 'ADMIN-ADD', '관리자 지급'],
    ['subtract', 10, 5, -5, 10, 'ADMIN-SUBTRACT', '관리자 회수'],
    ['set', 0, -5, 0, -5, 'ADMIN-SET', '관리자 잔액 지정'],
    ['set', -5, -10, -5, -5, 'ADMIN-SET', '관리자 잔액 지정'],
  ] as const)('imports semantic signed administrator history %s requested=%s', async (mode, amount, before, after, total, productId, name) => {
    await prepare();
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Adjustments.rows[0].cells = ['ADJ1', '2026-08-31T00:00:00.000Z', 'S1', String(amount), mode, 'operator-1'];
      tabs.Transactions.rows[1].cells = ['TX-ADJ1', '2026-08-31T00:00:00.000Z', 'S1', 'Alice', JSON.stringify([{ productId, name, price: total, quantity: 1, subtotal: total }]), String(total), String(before), String(after), 'ADMIN_ADJUSTMENT', 'operator-1'];
    }) });
    expect(value.status).toBe('READY_FOR_IMPORT');
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query('SELECT requested_amount::int amount,mode FROM adjustments WHERE tenant_id=$1', [harness.tenantOneId]);
    expect(rows).toEqual([{ amount, mode }]);
  });

  it.each(['legacy snapshot', 'extended snapshot', 'signed reward', 'zero reward', 'carry', 'unbound bank'])('preserves historical catalog values and quarantines unsupported BANK: %s', async (kind) => {
    await prepare();
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      const set = (tab: string, index: number, values: Record<string, string>) => { for (const [key, value] of Object.entries(values)) tabs[tab].rows[index].cells[tabs[tab].headers.indexOf(key)] = value; };
      set('Products', 0, { price: '999' }); set('Tasks', 0, { reward: '999' });
      if (kind === 'extended snapshot') set('Transactions', 0, { items: JSON.stringify([{ productId: 'P1', name: 'Historical pencil', price: 31, quantity: 1, subtotal: 20, regularUnitPrice: 31, regularTotal: 31, totalQuantity: 1, paidQuantity: 1, freeQuantity: 0, finalTotal: 20, totalDiscount: 11, adjustments: [], appliedPromotions: [] }]) });
      if (kind === 'signed reward' || kind === 'zero reward') set('Transactions', 0, { items: '[]', status: 'TASK_REWARD', totalAmount: kind === 'signed reward' ? '-20' : '0', balanceAfter: kind === 'signed reward' ? '80' : '100' });
      if (kind === 'carry' || kind === 'unbound bank') {
        set('TaskCompletions', 0, Object.fromEntries(['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'].map((key) => [key, ''])));
        set('TaskCompletions', 0, kind === 'carry' ? { source: 'CARRY_FORWARD', reward: '0', balanceBefore: '80', balanceAfter: '80' } : { source: 'BANK', balanceBefore: '80', reward: '10', balanceAfter: '81' });
      }
    }) });
    if (kind === 'unbound bank') {
      expect(value.status).toBe('BLOCKED');
      expect(value.sourceRecords.find((source) => source.canonicalRecord?.completionId === 'C1')).toMatchObject({
        mappingStatus: 'QUARANTINED', errorCodes: ['UNSUPPORTED_LEGACY_BANK_AUTHORITY'],
        canonicalRecord: { source: 'BANK', operationId: null, reward: 10, balanceBefore: 80, balanceAfter: 81 } });
      expect(value.records.task_completions).toEqual([]);
      expect(value.records.products[0].price).toBe(999);
      return;
    }
    expect(value.status).toBe('READY_FOR_IMPORT');
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction })).resolves.toMatchObject({ status: 'IMPORTING' });
    const { rows } = await harness.database.query('SELECT price::int price FROM products WHERE tenant_id=$1', [harness.tenantOneId]); expect(rows).toEqual([{ price: 999 }]);
  });

  it.each(['unmatched admin', 'unmatched adjustment', 'duplicate admin key', 'duplicate adjustment key', 'duplicate reversal', 'duplicate product', 'unsafe multiplication', 'unsafe sum', 'reward delta', 'admin delta', 'reversal items', 'business and instance'])('rejects semantic cardinality and arithmetic boundaries: %s', async (kind) => {
    const value = semanticManifest(kind === 'duplicate reversal' || kind === 'reversal items');
    await rejectSemantic(resign(value, (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const sourceRecords = draft.sourceRecords as Array<Record<string, unknown>>;
      const mappings = draft.mappings as Array<Record<string, unknown>>;
      const tx = sources(draft, 'Transactions').find((r) => r.transactionId === 'TX1')!;
      const admin = sources(draft, 'Transactions').find((r) => r.transactionId === 'TX-ADJ1')!;
      const item = (tx.items as Record<string, unknown>[])[0];
      const duplicateSource = (table: string, id: string, idKey: string) => {
        const source = structuredClone(sourceRecords.find((s) => s.targetTable === table && s.targetId === id)!);
        const canonical = source.canonicalRecord as Record<string, unknown>;
        const pointer = source.source as Record<string, unknown>; pointer.rowHash = sha256(`duplicate-${id}`); pointer.rowNumber = 999;
        source.targetId = canonical[idKey] = `${id}-duplicate`; sourceRecords.push(source);
        records[table].push({ ...structuredClone(records[table].find((r) => r[idKey] === id)!), [idKey]: canonical[idKey] });
        mappings.push({ sourceDigest: pointer.rowHash, targetTable: table, targetId: canonical[idKey], status: 'STAGED' });
        if (table === 'transactions') for (const child of canonical.items as Record<string, unknown>[]) {
          const oldId = child.itemId; child.itemId = '10000000-0000-4000-8000-000000000123'; child.transactionId = canonical.transactionId;
          records.transaction_items.push({ ...structuredClone(records.transaction_items.find((r) => r.itemId === oldId)!), itemId: child.itemId, transactionId: child.transactionId });
          mappings.push({ sourceDigest: pointer.rowHash, targetTable: 'transaction_items', targetId: child.itemId, status: 'STAGED' });
        }
      };
      if (kind === 'duplicate admin key') duplicateSource('transactions', 'TX-ADJ1', 'transactionId');
      if (kind === 'duplicate adjustment key') duplicateSource('adjustments', 'ADJ1', 'adjustmentId');
      if (kind === 'duplicate reversal') duplicateSource('transactions', 'REV1', 'transactionId');
      if (kind === 'unmatched admin' || kind === 'unmatched adjustment') {
        const id = kind === 'unmatched admin' ? 'ADJ1' : 'TX-ADJ1'; const table = kind === 'unmatched admin' ? 'adjustments' : 'transactions';
        const childIds = kind === 'unmatched admin' ? [] : (admin.items as Record<string, unknown>[]).map((i) => i.itemId);
        draft.sourceRecords = sourceRecords.filter((s) => s.targetId !== id); records[table] = records[table].filter((r) => r[table === 'adjustments' ? 'adjustmentId' : 'transactionId'] !== id);
        records.transaction_items = records.transaction_items.filter((r) => !childIds.includes(r.itemId)); draft.mappings = mappings.filter((m) => m.targetId !== id && !childIds.includes(m.targetId));
      }
      if (kind === 'duplicate product' || kind === 'unsafe sum') {
        const copy: Record<string, unknown> = { ...item, itemId: '10000000-0000-4000-8000-000000000123', lineNumber: 2 };
        if (kind === 'unsafe sum') { item.price = item.subtotal = Number.MAX_SAFE_INTEGER; copy.productId = 'P2'; records.products.push({ ...records.products[0], productId: 'P2' });
          // Use a second authentic product source/mapping so the financial gate,
          // rather than incomplete output/FK validation, sees the overflow.
          const source = structuredClone(sourceRecords.find((s) => s.targetTable === 'products')!); const row = source.canonicalRecord as Record<string, unknown>;
          row.productId = source.targetId = 'P2'; const pointer = source.source as Record<string, unknown>; pointer.rowHash = sha256('P2'); pointer.rowNumber = 999; sourceRecords.push(source);
          mappings.push({ sourceDigest: pointer.rowHash, targetTable: 'products', targetId: 'P2', status: 'STAGED' });
        }
        (tx.items as Record<string, unknown>[]).push(copy); records.transaction_items.push({ ...records.transaction_items.find((r) => r.itemId === item.itemId)!, itemId: copy.itemId, lineNumber: 2 });
        mappings.push({ ...mappings.find((m) => m.targetId === item.itemId)!, targetId: copy.itemId });
      }
      if (kind === 'unsafe multiplication') { item.price = Number.MAX_SAFE_INTEGER; item.quantity = 2; }
      if (kind === 'reward delta') {
        tx.status = 'TASK_REWARD'; tx.items = []; records.transaction_items = records.transaction_items.filter((r) => r.itemId !== item.itemId); draft.mappings = mappings.filter((m) => m.targetId !== item.itemId);
      }
      if (kind === 'admin delta') admin.balanceAfter = 91;
      if (kind === 'reversal items') {
        const reversal = sources(draft, 'Transactions').find((r) => r.transactionId === 'REV1')!;
        const copy = { ...item, itemId: '10000000-0000-4000-8000-000000000123', transactionId: 'REV1' };
        reversal.items = [copy]; records.transaction_items.push({ ...records.transaction_items.find((r) => r.itemId === item.itemId)!, itemId: copy.itemId, transactionId: 'REV1' });
        mappings.push({ ...mappings.find((m) => m.targetId === 'REV1')!, targetTable: 'transaction_items', targetId: copy.itemId });
      }
      if (kind === 'business and instance') Object.assign(sources(draft, 'TaskAssignments').find((row) => row.assignmentId === 'AS1')!, { taskId: 'T2', taskInstanceId: 'TI2' });
      syncSemantic(draft);
    }), kind === 'business and instance' ? /tuple reference is inconsistent/ : /Canonical financial history is inconsistent/);
  });

  it.each([false, true])('imports real normalizer semantic history with reversal=%s', async (reversal) => {
    await prepare(); const value = semanticManifest(reversal); expect(value.status).toBe('READY_FOR_IMPORT');
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction })).resolves.toMatchObject({ status: 'IMPORTING' });
    const { rows } = await harness.database.query('SELECT unit_price_snapshot::int AS price FROM transaction_items WHERE tenant_id=$1 AND transaction_id=$2', [harness.tenantOneId, 'TX-ADJ1']); expect(rows).toEqual([{ price: -10 }]);
  });

  it.each([
    ['N_PLUS_ONE', '', '2', '1', { buy_quantity: 2, free_quantity: 1, promotional_price: null, percent: null, discount_amount: null }],
    ['PROMOTIONAL_PRICE', '0', '', '', { buy_quantity: null, free_quantity: null, promotional_price: 0, percent: null, discount_amount: null }],
    ['PERCENT_DISCOUNT', '12.5', '', '', { buy_quantity: null, free_quantity: null, promotional_price: null, percent: 12.5, discount_amount: null }],
    ['FIXED_DISCOUNT', '5', '', '', { buy_quantity: null, free_quantity: null, promotional_price: null, percent: null, discount_amount: 5 }],
  ])('imports real normalized promotion variant %s', async (type, value, buy, free, expected) => {
    await prepare();
    const normalized = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      const tab = tabs.Promotions;
      for (const [key, cell] of Object.entries({ type, value, buyQuantity: buy, freeQuantity: free })) tab.rows[0].cells[tab.headers.indexOf(key)] = String(cell);
    }) });
    expect(normalized.status).toBe('READY_FOR_IMPORT');
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: normalized, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query('SELECT n_plus_one_buy_quantity AS buy_quantity,n_plus_one_free_quantity AS free_quantity,promotional_price,percent_discount::float8 AS percent,fixed_discount AS discount_amount FROM promotions WHERE tenant_id=$1', [harness.tenantOneId]);
    expect(rows).toEqual([expected]);
  });

  it.each(['equal', 'divergent', 'unknown nested field', 'same line'])('rejects duplicate canonical items: %s', async (kind) => {
    const forged = resign(manifest(), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'transactions' && s.targetId === 'TX1')!;
      const items = (source.canonicalRecord as Record<string, unknown>).items as Array<Record<string, unknown>>;
      const duplicate = structuredClone(items[0]);
      if (kind === 'divergent') duplicate.name = 'different';
      if (kind === 'unknown nested field') duplicate.unexpected = { secret: 'unvalidated' };
      if (kind === 'same line') {
        duplicate.itemId = '10000000-0000-4000-8000-000000000123';
        const records = draft.records as Record<string, Array<Record<string, unknown>>>;
        records.transaction_items.push({ ...records.transaction_items.find((r) => r.itemId === items[0].itemId)!, itemId: duplicate.itemId });
        const mappings = draft.mappings as Array<Record<string, unknown>>;
        mappings.push({ ...mappings.find((m) => m.targetId === items[0].itemId)!, targetId: duplicate.itemId });
      }
      items.push(duplicate);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/structurally invalid|duplicate|unique/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  function dependencyManifest() {
    return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      const tab = tabs.Tasks;
      for (const [id, prerequisite] of [['2', 'T1'], ['3', '']]) {
        const row = structuredClone(tab.rows[0]);
        for (const [key, cell] of Object.entries({ taskId: `T${id}`, taskInstanceId: `TI${id}`, prerequisiteTaskId: prerequisite, allowedStudentIds: '' })) row.cells[tab.headers.indexOf(key)] = cell;
        tab.rows.push(row);
      }
    }) });
  }

  it('imports real normalized business prerequisite as exact physical dependency', async () => {
    await prepare();
    const value = dependencyManifest();
    expect(value.status).toBe('READY_FOR_IMPORT');
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const { rows } = await harness.database.query('SELECT task_id,prerequisite_task_instance_id FROM tasks WHERE tenant_id=$1 ORDER BY task_id', [harness.tenantOneId]);
    expect(rows).toEqual([{ task_id: 'T1', prerequisite_task_instance_id: null }, { task_id: 'T2', prerequisite_task_instance_id: 'TI1' }, { task_id: 'T3', prerequisite_task_instance_id: null }]);
  });

  it.each(['removed', 'null', 'substituted', 'unrequested'])('rejects correlated prerequisite resolution corruption: %s', async (kind) => {
    const forged = resign(dependencyManifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const id = kind === 'unrequested' ? 'T3' : 'T2';
      const canonical = (draft.sourceRecords as Array<Record<string, unknown>>).map((s) => s.canonicalRecord as Record<string, unknown>).find((r) => r?.taskId === id)!;
      for (const row of [canonical, records.tasks.find((r) => r.taskId === id)!]) {
        if (kind === 'removed') delete row.prerequisiteTaskInstanceId;
        else row.prerequisiteTaskInstanceId = kind === 'null' ? null : kind === 'unrequested' ? 'TI1' : 'TI3';
      }
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/prerequisite|dependency/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each(['Redis only', 'Sheets plus Redis'])('preserves the real claim provenance union without unsupported publication: %s', async (kind) => {
    if (kind === 'Sheets plus Redis') {
      const quarantined = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets: makeSheets(), redis: makeRedis() });
      const contributors = quarantined.sourceRecords.filter((source) => source.canonicalRecord?.provider === 'PADLET');
      expect(contributors.map((source) => source.source.kind).sort()).toEqual(['REDIS', 'SHEET']);
      for (const source of contributors) {
        expect(source.errorCodes).toContain('UNSUPPORTED_LEGACY_BANK_AUTHORITY');
        expect(source.canonicalRecord?.provenances).toEqual(expect.arrayContaining(contributors.map((row) => row.source)));
      }
      expect(quarantined.records.padlet_evidence_claims).toEqual([]);
      expect(quarantined.mappings.some((row) => row.targetTable === 'padlet_evidence_claims')).toBe(false);
      return;
    }
    await prepare();
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      if (kind === 'Redis only') tabs.TaskCompletions.rows = [];
    }) });
    expect(value.status).toBe('READY_FOR_IMPORT');
    const contributors = value.sourceRecords.filter((s) => s.targetTable === 'padlet_evidence_claims').map((s) => s.source);
    expect(contributors.map((p) => p.kind).sort()).toEqual(kind === 'Redis only' ? ['REDIS'] : ['REDIS', 'SHEET']);
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction };
    await importLegacyNormalizationManifest(input);
    await importLegacyNormalizationManifest(input);
    const { rows } = await harness.database.query<{ mapping_status: string; target_table: string | null; target_id: string | null; provenances: unknown[] }>(`SELECT mapping_status,target_table,target_id,canonical_record->'provenances' provenances FROM migration_source_records WHERE tenant_id=$1 AND canonical_record->'migrationCheckpoint'->>'intendedTargetTable'='padlet_evidence_claims'`, [harness.tenantOneId]);
    expect(rows).toHaveLength(contributors.length);
    for (const row of rows) {
      expect(row).toEqual({ mapping_status: 'STAGED', target_table: null, target_id: null, provenances: value.records.padlet_evidence_claims[0].provenances });
      expect(row.provenances.map((p) => canonicalJson(p)).sort()).toEqual(contributors.map((p) => canonicalJson(p)).sort());
    }
  });

  it.each(['empty', 'invented', 'duplicate', 'missing', 'changed pointer'])('rejects correlated claim provenance union corruption: %s', async (kind) => {
    const forged = resign(bankManifest(), (draft) => {
      const claim = (draft.records as Record<string, Array<Record<string, unknown>>>).padlet_evidence_claims[0];
      const pointers = claim.provenances as Array<Record<string, unknown>>;
      expect(pointers).toHaveLength(2);
      if (kind === 'empty') claim.provenances = [];
      if (kind === 'missing') pointers.pop();
      if (kind === 'duplicate') pointers.push(structuredClone(pointers[0]));
      if (kind === 'invented') pointers.push(structuredClone((draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'students')!.source) as Record<string, unknown>);
      if (kind === 'changed pointer') pointers.find((p) => p.kind === 'SHEET')!.rowNumber = 999;
      for (const source of draft.sourceRecords as Array<Record<string, unknown>>) if (source.targetTable === 'padlet_evidence_claims') source.canonicalRecord = structuredClone(claim);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/provenance/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['padlet_evidence_claims', 'IMPORTED'], ['padlet_claim_digest_tombstones', 'IMPORTED'],
    ['padlet_evidence_claims', 'STAGED'], ['padlet_claim_digest_tombstones', 'STAGED'],
  ])('rejects prematurely populated deferred checkpoint on rerun: %s %s', async (table, status) => {
    await prepare();
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets: makeSupportedSheets(), redis: makeRedis({ orphanedClaimDigests: ['e'.repeat(64)] }) });
    expect(value.status).toBe('READY_FOR_IMPORT');
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction };
    await importLegacyNormalizationManifest(input);
    const corrupt = () => harness.database.query<{ record_id: string }>(`UPDATE migration_source_records SET mapping_status=$3,target_table=$2,target_id=canonical_record->'migrationCheckpoint'->>'intendedTargetId' WHERE tenant_id=$1 AND canonical_record->'migrationCheckpoint'->>'intendedTargetTable'=$2 RETURNING record_id`, [harness.tenantOneId, table, status]);
    if (status === 'STAGED') {
      // Production DDL already prevents this state. Do not weaken the harness to
      // fabricate it: verify the constraint and the unchanged resumable checkpoint.
      await expect(corrupt()).rejects.toThrow(/migration_source_records_target_check/);
      const { rows } = await harness.database.query('SELECT mapping_status,target_table,target_id FROM migration_source_records WHERE tenant_id=$1 AND canonical_record->\'migrationCheckpoint\'->>\'intendedTargetTable\'=$2', [harness.tenantOneId, table]);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toEqual({ mapping_status: 'STAGED', target_table: null, target_id: null });
      await expect(importLegacyNormalizationManifest(input)).resolves.toMatchObject({ status: 'IMPORTING' });
    } else {
      const { rows } = await corrupt();
      expect(rows.length).toBeGreaterThan(0);
      await expect(importLegacyNormalizationManifest(input)).rejects.toThrow(/persisted migration source record/i);
    }
  });

  it.each(['accounts', 'transaction_items', 'task_allowed_students', 'products', 'transactions', 'padlet_evidence_claims'])('rejects correlated whole-output omission: %s', async (table) => {
    const forged = resign(manifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      records[table] = [];
      draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((m) => m.targetTable !== table);
      for (const source of draft.sourceRecords as Array<Record<string, unknown>>) {
        if (source.targetTable === table) { delete source.targetTable; delete source.targetId; }
      }
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/mapping|canonical source|projection/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects unmapped ADMIN_ADJUSTMENT item identifier secrets', async () => {
    const forged = resign(manifest(), (draft) => {
      const sources = draft.sourceRecords as Array<Record<string, unknown>>;
      const source = structuredClone(sources.find((s) => (s.canonicalRecord as Record<string, unknown>)?.status === 'ADMIN_ADJUSTMENT')!);
      delete source.targetTable; delete source.targetId;
      (source.source as Record<string, unknown>).rowHash = sha256('unmapped-admin');
      (source.canonicalRecord as Record<string, unknown>).transactionId = 'UNMAPPED-ADMIN';
      for (const item of (source.canonicalRecord as Record<string, unknown>).items as Array<Record<string, unknown>>) item.transactionId = 'UNMAPPED-ADMIN';
      (source.source as Record<string, unknown>).rowNumber = 999;
      ((source.canonicalRecord as Record<string, unknown>).items as Array<Record<string, unknown>>)[0].productId = { password: 'secret' };
      sources.push(source);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['transactions', 'studentId'], ['promotion_products', 'productId'], ['promotion_products', 'promotionId'],
    ['task_assignments', 'studentId'], ['task_assignments', 'taskInstanceId'], ['task_completions', 'assignmentId'],
  ])('rejects correlated missing FK %s.%s before transactions', async (table, key) => {
    const forged = resign(manifest(), (draft) => {
      const rows = (draft.records as Record<string, Array<Record<string, unknown>>>)[table];
      if (table === 'task_assignments' && key === 'studentId') {
        // Correlate the entire retained lineage so the missing student reaches
        // the physical FK gate, not the earlier carry-predecessor validator.
        for (const row of [...sources(draft, 'TaskAssignments'), ...sources(draft, 'TaskCompletions')]) row.studentId = 'missing-reference';
        syncSemantic(draft);
        return;
      }
      const target = table === 'transactions' ? rows.find((row) => row.transactionId === 'TX1')! : rows[0];
      target[key] = 'missing-reference';
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === table && (table !== 'transactions' || s.targetId === target.transactionId))!;
      (source.canonicalRecord as Record<string, unknown>)[key] = 'missing-reference';
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/reference|graph/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each(['itemId', 'lineNumber'])('rejects correlated physical item identity corruption: %s', async (key) => {
    const forged = resign(manifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const item = records.transaction_items.find((r) => r.transactionId === 'TX1')!;
      const oldId = item.itemId;
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'transactions' && s.targetId === 'TX1')!;
      const items = (source.canonicalRecord as Record<string, unknown>).items as Array<Record<string, unknown>>;
      if (key === 'itemId') {
        item.itemId = items[0].itemId = 'not-a-uuid';
        for (const m of draft.mappings as Array<Record<string, unknown>>) if (m.targetId === oldId) m.targetId = item.itemId;
      } else {
        const copy = { ...item, itemId: '10000000-0000-4000-8000-000000000123' };
        records.transaction_items.push(copy); items.push({ ...items[0], itemId: copy.itemId });
        const mapping = (draft.mappings as Array<Record<string, unknown>>).find((m) => m.targetId === oldId)!;
        (draft.mappings as Array<Record<string, unknown>>).push({ ...mapping, targetId: copy.itemId });
      }
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/structurally invalid|unique|graph/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each(['boardId', 'postId', 'ownerDigest'])('rejects correlated self-digested claim %s edits', async (key) => {
    const forged = resign(manifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const claim = records.padlet_evidence_claims[0];
      claim[key] = key === 'ownerDigest' ? 'e'.repeat(64) : key === 'boardId' ? 'ZZZZZZZZZZZZZZZZ' : 'forged-post';
      for (const s of draft.sourceRecords as Array<Record<string, unknown>>) {
        if (s.targetTable !== 'padlet_evidence_claims') continue;
        s.canonicalRecord = structuredClone(claim);
        const pointer = s.source as Record<string, unknown>;
        if (pointer.kind !== 'REDIS') continue;
        const old = pointer.sourceDigest;
        pointer.sourceDigest = sha256(canonicalJson({ tupleDigest: claim.tupleDigest, boardId: claim.boardId, postId: claim.postId, ownerDigest: claim.ownerDigest, operationId: claim.operationId, sourceProvenance: pointer.provenance }));
        for (const m of draft.mappings as Array<Record<string, unknown>>) if (m.sourceDigest === old) m.sourceDigest = pointer.sourceDigest;
        for (const provenance of claim.provenances as Array<Record<string, unknown>>) if (provenance.sourceDigest === old) provenance.sourceDigest = pointer.sourceDigest;
      }
      for (const s of draft.sourceRecords as Array<Record<string, unknown>>) if (s.targetTable === 'padlet_evidence_claims') s.canonicalRecord = structuredClone(claim);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/binding|claim|tuple/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['tasks', 'taskInstanceId'], ['promotion_products', 'promotionProductId'], ['adjustments', 'adjustmentId'], ['task_completions', 'completionId'],
  ])('rejects correlated alternate identity collision at its earliest domain gate in %s', async (table, idKey) => {
    const forged = resign(table === 'task_completions' ? bankManifest() : manifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const original = records[table][0];
      const id = `${original[idKey]}-duplicate`;
      records[table].push({ ...structuredClone(original), [idKey]: id });
      const sources = draft.sourceRecords as Array<Record<string, unknown>>;
      const source = structuredClone(sources.find((s) => s.targetTable === table)!);
      source.targetId = id;
      (source.canonicalRecord as Record<string, unknown>)[idKey] = id;
      if (table === 'tasks') {
        (source.canonicalRecord as Record<string, unknown>).allowedStudentIds = [];
        records[table][1].allowedStudentIds = [];
      }
      if (table === 'adjustments') records[table][1].legacyAdjustmentId = id;
      if (table === 'task_completions') {
        for (const row of [records[table][1], source.canonicalRecord as Record<string, unknown>]) {
          for (const key of ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest']) delete row[key];
        }
      }
      const pointer = source.source as Record<string, unknown>;
      pointer.rowHash = sha256(`duplicate-${table}`); pointer.rowNumber = 999;
      sources.push(source);
      (draft.mappings as Array<Record<string, unknown>>).push({ sourceDigest: pointer.rowHash, targetTable: table, targetId: id, status: 'STAGED' });
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(table === 'adjustments' ? 'Canonical financial history is inconsistent.'
      : table === 'task_completions' ? 'Unsupported legacy BANK authority cannot be imported.' : /unique|graph/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('applies the complete production migration inventory', async () => {
    const { rows } = await harness.database.query<{ grants: string | null; discovery: string | null }>(
      "SELECT to_regclass('public.generator_grant_claims')::text grants, to_regprocedure('public.platform_find_tenant_by_slug(text)')::text discovery",
    );
    expect(rows[0].grants).toBe('generator_grant_claims');
    expect(rows[0].discovery).toBe('platform_find_tenant_by_slug(text)');
  });

  it('rejects a Sheet claim whose pointer no longer identifies its originating completion', async () => {
    const forged = resign(bankManifest(), (draft) => {
      for (const source of draft.sourceRecords as Array<Record<string, unknown>>) {
        const pointer = source.source as Record<string, unknown>;
        if (source.targetTable === 'padlet_evidence_claims' && pointer.kind === 'SHEET') pointer.tab = 'Students';
      }
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/claim|completion|provenance/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('preserves unsupported-tab and redacted-setting skipped checkpoints', async () => {
    await prepare();
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Unrelated = { headers: ['unknown'], rows: [{ rowNumber: 2, cells: ['ignored'], hash: '' }] };
    }) });
    expect(value.status).toBe('READY_FOR_IMPORT');
    const result = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    expect(result.skippedSourceRecords).toBe(value.sourceRecords.filter((source) => !source.targetTable).length);
    expect(result.skippedSourceRecords).toBeGreaterThan(0);
  });

  it.each([
    ['empty', ''],
    ['201 code units', 'x'.repeat(201)],
    ['oversized', 'x'.repeat(10_000)],
    ['astral 201 code units', `${'😀'.repeat(100)}x`],
  ])('rejects re-digested unsupported source tab length before transactions: %s', async (_variant, tab) => {
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
        tabs.Notes = { headers: ['unknown'], rows: [{ rowNumber: 2, cells: ['ignored'], hash: '' }] };
      }),
    });
    const forged = resign(value, (draft) => {
      const sources = draft.sourceRecords as Array<LegacyNormalizationManifest['sourceRecords'][number]>;
      const source = sources.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'Notes')!;
      expect(source.canonicalRecord).toBeNull();
      expect(source.targetTable).toBeUndefined();
      expect(value.mappings.some((mapping) => mapping.sourceDigest === (source.source.kind === 'SHEET' ? source.source.rowHash : ''))).toBe(false);
      if (source.source.kind === 'SHEET') (source.source as { tab: string }).tab = tab;
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    const result = importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction });
    await expect(result).rejects.toThrow();
    expect(runTransaction).not.toHaveBeenCalled();
    await expect(result).rejects.toThrow(/structurally invalid/i);
  });

  it.each([
    { variant: 'leading space', names: [' Notes'] },
    { variant: 'literal identity boundaries', names: [' Notes', 'Notes', 'Notes ', ' ', '  ', ':Notes', 'source:Notes', '메모:😀', ' 메모 ', '界'.repeat(200), '😀'.repeat(100)] },
  ])('persists raw unsupported tab names as distinct skipped checkpoints on exact rerun: $variant', async ({ names }) => {
    // Acquisition permits nonempty names up to 200 UTF-16 code units, without trimming.
    // Identical row bytes/positions must remain distinct across literal tab names.
    const value = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      redis: makeRedis(), sheets: makeSupportedSheets(3, (tabs) => {
        for (const name of names) tabs[name] = { headers: ['unknown'], rows: [{ rowNumber: 2, cells: ['ignored'], hash: '' }] };
      }),
    });
    expect(value.status).toBe('READY_FOR_IMPORT');
    const sources = value.sourceRecords.filter((source) => source.warningCodes.includes('UNSUPPORTED_TAB'));
    expect(sources).toHaveLength(names.length);
    expect(sources.map(({ source }) => source.kind === 'SHEET' ? source.tab : null).sort()).toEqual([...names].sort());
    const originalSources = structuredClone(value.sourceRecords);
    await prepare();
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction };
    await importLegacyNormalizationManifest(input);
    const readCheckpoints = () => harness.database.query<{
      record_id: string; source_collection: string; mapping_status: string; redacted_record: unknown; warning_details: string[];
    }>('SELECT * FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2 ORDER BY record_id', [harness.tenantOneId, JOB_ID]).then(({ rows }) => rows);
    const first = await readCheckpoints();
    expect(first).toHaveLength(expectedCheckpointCount(value));
    const skipped = first.filter((row) => row.warning_details.includes('UNSUPPORTED_TAB'));
    expect(skipped).toHaveLength(names.length);
    expect(new Set(skipped.map((row) => row.source_collection)).size).toBe(names.length);
    expect(skipped.map((row) => canonicalJson(row.redacted_record)).sort())
      .toEqual(sources.map((source) => canonicalJson(source.redactedSourceRecord)).sort());
    for (const checkpoint of skipped) {
      expect(checkpoint.mapping_status).toBe('SKIPPED');
      expect(checkpoint.source_collection).toBe(checkpoint.source_collection.trim());
    }
    await importLegacyNormalizationManifest(input);
    expect(await readCheckpoints()).toEqual(first);
    expect(value.sourceRecords).toEqual(originalSources);
  });

  it('rejects correlated source checkpoint physical identity collisions before transactions', async () => {
    const forged = resign(manifest(), (draft) => {
      const sources = draft.sourceRecords as Array<Record<string, unknown>>;
      const source = structuredClone(sources.find((s) => s.targetTable === 'students')!);
      const pointer = source.source as Record<string, unknown>;
      const old = pointer.rowHash;
      pointer.rowHash = sha256('same-sheet-row-different-digest');
      sources.push(source);
      const mappings = draft.mappings as Array<Record<string, unknown>>;
      mappings.push(...mappings.filter((m) => m.sourceDigest === old).map((m) => ({ ...m, sourceDigest: pointer.rowHash })));
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/checkpoint|unique|graph/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects a physical UUID alias collision before transactions', async () => {
    const forged = resign(manifest(), (draft) => {
      const records = draft.records as Record<string, Array<Record<string, unknown>>>;
      const item = records.transaction_items.find((r) => r.transactionId === 'TX1')!;
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'transactions' && s.targetId === 'TX1')!;
      const items = (source.canonicalRecord as Record<string, unknown>).items as Array<Record<string, unknown>>;
      const alias = String(item.itemId).toUpperCase();
      expect(alias).not.toBe(item.itemId);
      records.transaction_items.push({ ...item, itemId: alias, lineNumber: 2 });
      items.push({ ...items[0], itemId: alias, lineNumber: 2 });
      const mappings = draft.mappings as Array<Record<string, unknown>>;
      mappings.push({ ...mappings.find((m) => m.targetId === item.itemId)!, targetId: alias });
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/structurally invalid|unique|graph/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each(['row number integer overflow', 'PostgreSQL text NUL', 'unpaired UTF-16 surrogate'])('rejects physical staging value corruption: %s', async (kind) => {
    const forged = resign(manifest(), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((s) => s.targetTable === 'students')!;
      if (kind === 'row number integer overflow') (source.source as Record<string, unknown>).rowNumber = 2_147_483_648;
      else {
        const name = kind === 'PostgreSQL text NUL' ? 'Alice\0suffix' : 'Alice\ud800suffix';
        (source.canonicalRecord as Record<string, unknown>).name = name;
        (draft.records as Record<string, Array<Record<string, unknown>>>).students[0].name = name;
      }
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction })).rejects.toThrow(/structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('resumes after interruption without replay duplicates', async () => {
    await prepare();
    let transactions = 0;
    const interruptingRunner: TenantImportTransactionRunner = async (tenantId, callback) => {
      transactions += 1;
      if (transactions === 4) throw new Error('simulated interruption');
      return harness.runTenantTransaction(tenantId, callback);
    };

    await expect(importLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      manifest: manifest(),
      batchSize: 3,
      runTransaction: interruptingRunner,
    })).rejects.toThrow('simulated interruption');

    const result = await importLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      manifest: manifest(),
      batchSize: 3,
      runTransaction: harness.runTenantTransaction,
    });

    expect(result.status).toBe('IMPORTING');
    expect(result.importedSourceRecords + result.deferredSourceRecords + result.skippedSourceRecords).toBe(result.totalSourceRecords);
    const [{ count }] = await harness.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2`,
      [harness.tenantOneId, JOB_ID],
    ).then(({ rows }) => rows);
    expect(count).toBe(result.totalSourceRecords);
  });

  it('reruns an exact manifest without duplicating targets', async () => {
    await prepare();
    const value = manifest();
    const first = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const second = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const [{ sourceCount, transactionCount }] = await harness.database.query<{ sourceCount: number; transactionCount: number }>(
      `SELECT (SELECT count(*)::int FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2) AS "sourceCount",
              (SELECT count(*)::int FROM transactions WHERE tenant_id=$1) AS "transactionCount"`,
      [harness.tenantOneId, JOB_ID],
    ).then(({ rows }) => rows);
    expect(second).toEqual(first);
    expect(sourceCount).toBe(expectedCheckpointCount(value));
    expect(transactionCount).toBe(value.records.transactions.length);
  });

  it('detects source mutation before changing targets', async () => {
    await prepare();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), runTransaction: harness.runTenantTransaction });
    const changed = createLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      sheets: makeSupportedSheets(3, (tabs) => { tabs.Students.rows[0].cells[1] = 'Changed'; }),
      redis: makeRedis(),
    });
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: changed, runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/fingerprint changed/i);
    const [{ name }] = await harness.database.query<{ name: string }>('SELECT name FROM students WHERE tenant_id=$1 AND student_id=$2', [harness.tenantOneId, 'S1']).then(({ rows }) => rows);
    expect(name).toBe('Alice');
  });

  it('rejects a different manifest digest bound to the same source fingerprint', async () => {
    await prepare();
    const original = manifest();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: original, runTransaction: harness.runTenantTransaction });
    const changed = structuredClone(original) as unknown as Record<string, unknown>;
    changed.warnings = [{ code: 'MUTATED_MANIFEST', path: 'redacted', sourceDigest: 'a'.repeat(64) }];
    delete changed.manifestDigest;
    changed.manifestDigest = sha256(canonicalJson(changed));

    await expect(importLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      manifest: changed as unknown as LegacyNormalizationManifest,
      runTransaction: harness.runTenantTransaction,
    })).rejects.toThrow(/manifest digest changed/i);
  });

  it('never uses manifest records to escape the trusted tenant', async () => {
    await prepare(harness.tenantTwoId);
    const untrusted = manifest(harness.tenantOneId);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantTwoId, migrationJobId: JOB_ID, manifest: untrusted, runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/trusted migration binding/i);
    const [{ count }] = await harness.database.query<{ count: number }>('SELECT count(*)::int AS count FROM students WHERE tenant_id IN ($1,$2)', [harness.tenantOneId, harness.tenantTwoId]).then(({ rows }) => rows);
    expect(count).toBe(0);
  });

  it('rolls back every write in a target batch when a conflict fails the batch', async () => {
    await prepare();
    await harness.database.query(`INSERT INTO students (tenant_id,student_id,name,status) VALUES ($1,'S1','Divergent','ACTIVE')`, [harness.tenantOneId]);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), batchSize: 3, runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/target conflict/i);
    const [{ settings, accounts }] = await harness.database.query<{ settings: number; accounts: number }>(
      `SELECT (SELECT count(*)::int FROM tenant_settings WHERE tenant_id=$1) AS settings,
              (SELECT count(*)::int FROM accounts WHERE tenant_id=$1) AS accounts`,
      [harness.tenantOneId],
    ).then(({ rows }) => rows);
    expect(settings).toBe(0);
    expect(accounts).toBe(0);
  });

  it('fails closed on an unknown source mapping target before opening a transaction', async () => {
    const value = structuredClone(manifest()) as unknown as Record<string, unknown>;
    const sourceRecords = value.sourceRecords as Array<Record<string, unknown>>;
    sourceRecords[0].targetTable = 'unexpected_table';
    delete value.manifestDigest;
    value.manifestDigest = sha256(canonicalJson(value));
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;

    await expect(importLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      manifest: value as unknown as LegacyNormalizationManifest,
      runTransaction,
    })).rejects.toThrow(/unsupported target table/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('stages global claims and tombstones without publishing global registry data', async () => {
    await prepare();
    const digest = 'f'.repeat(64);
    const value = createLegacyNormalizationManifest({
      tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID,
      sheets: makeSupportedSheets(),
      redis: makeRedis({ orphanedClaimDigests: [digest] }),
    });
    const result = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const [{ claims, tombstones, registry, staged }] = await harness.database.query<{ claims: number; tombstones: number; registry: number; staged: number }>(
      `SELECT (SELECT count(*)::int FROM padlet_evidence_claims) claims,
              (SELECT count(*)::int FROM padlet_claim_digest_tombstones) tombstones,
              (SELECT count(*)::int FROM padlet_claim_digest_registry) registry,
              (SELECT count(*)::int FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2 AND mapping_status='STAGED' AND canonical_record->'migrationCheckpoint'->>'intendedTargetTable' IN ('padlet_evidence_claims','padlet_claim_digest_tombstones')) staged`,
      [harness.tenantOneId, JOB_ID],
    ).then(({ rows }) => rows);
    expect({ claims, tombstones, registry }).toEqual({ claims: 0, tombstones: 0, registry: 0 });
    expect(staged).toBe(value.mappings.filter(({ targetTable }) => targetTable.startsWith('padlet_')).length);
    expect(result.deferredSourceRecords).toBe(staged + value.mappings.filter(({ targetTable }) => targetTable === 'legacy_operation_bindings').length);
    expect(result.importedTargetRecords).toBe(result.targetRecords);
    expect(result.deferredTargetRecords).toBe(value.records.padlet_evidence_claims.length + value.records.padlet_claim_digest_tombstones.length + value.records.legacy_operation_bindings.length);
    expect(JSON.stringify(result)).not.toContain('upstash:');
  });

  it('persists no global claim data when import staging is interrupted after target batches', async () => {
    await prepare();
    let transactions = 0;
    const failingRunner: TenantImportTransactionRunner = async (tenantId, callback) => {
      transactions += 1;
      if (transactions === 4) throw new Error('fail after targets');
      return harness.runTenantTransaction(tenantId, callback);
    };
    await expect(importLegacyNormalizationManifest({
      tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), batchSize: 500, runTransaction: failingRunner,
    })).rejects.toThrow('fail after targets');
    const [{ claims, tombstones, registry }] = await harness.database.query<{ claims: number; tombstones: number; registry: number }>(
      `SELECT (SELECT count(*)::int FROM padlet_evidence_claims) claims,
              (SELECT count(*)::int FROM padlet_claim_digest_tombstones) tombstones,
              (SELECT count(*)::int FROM padlet_claim_digest_registry) registry`,
    ).then(({ rows }) => rows);
    expect({ claims, tombstones, registry }).toEqual({ claims: 0, tombstones: 0, registry: 0 });
  });

  it.each(['ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'] as const)('rejects tenant lifecycle %s without changing the migration job', async (lifecycle) => {
    await prepare();
    await harness.database.query('UPDATE tenants SET lifecycle=$2 WHERE id=$1', [harness.tenantOneId, lifecycle]);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/lifecycle/i);
    const [{ status, sourceFingerprint }] = await harness.database.query<{ status: string; sourceFingerprint: string | null }>('SELECT status, source_fingerprint AS "sourceFingerprint" FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [harness.tenantOneId, JOB_ID]).then(({ rows }) => rows);
    expect(status).toBe('VALIDATED');
    expect(sourceFingerprint).toBeNull();
  });

  it('persists one deterministic checkpoint for every multi-target source mapping', async () => {
    await prepare();
    const value = manifest();
    const result = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const rows = await harness.database.query<{ sourceRowHash: string; targetTable: string | null; targetId: string | null; intendedTable: string | null; intendedId: string | null }>(
      `SELECT source_row_hash "sourceRowHash", target_table "targetTable", target_id "targetId",
              canonical_record->'migrationCheckpoint'->>'intendedTargetTable' "intendedTable",
              canonical_record->'migrationCheckpoint'->>'intendedTargetId' "intendedId"
       FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2`, [harness.tenantOneId, JOB_ID],
    ).then(({ rows }) => rows);
    expect(rows).toHaveLength(expectedCheckpointCount(value));
    for (const mapping of value.mappings) {
      const checkpoints = rows.filter((row) => row.sourceRowHash === mapping.sourceDigest
        && (row.targetTable === mapping.targetTable || row.intendedTable === mapping.targetTable)
        && (row.targetId === mapping.targetId || row.intendedId === mapping.targetId));
      expect(checkpoints, `${mapping.targetTable}:${mapping.targetId}`).toHaveLength(1);
    }
    expect(result.importedSourceRecords).toBe(value.mappings.filter(({ targetTable }) => !targetTable.startsWith('padlet_') && targetTable !== 'legacy_operation_bindings').length);
  });

  it('rejects missing, dangling, extra, and duplicate mappings before opening a transaction', async () => {
    const base = manifest();
    const corruptions = [
      (draft: Record<string, unknown>) => { (draft.mappings as unknown[]).pop(); },
      (draft: Record<string, unknown>) => { (draft.mappings as Array<Record<string, unknown>>)[0].sourceDigest = 'f'.repeat(64); },
      (draft: Record<string, unknown>) => { (draft.mappings as unknown[]).push(structuredClone((draft.mappings as unknown[])[0])); },
      (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).students.push({ ...(draft.records as Record<string, Array<Record<string, unknown>>>).students[0], studentId: 'EXTRA' }); },
    ];
    for (const corrupt of corruptions) {
      const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
      await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: resign(base, corrupt), runTransaction }))
        .rejects.toThrow(/mapping|target record/i);
      expect(runTransaction).not.toHaveBeenCalled();
    }
  });

  it('rejects forged administrator provenance before opening a transaction', async () => {
    const forged = resign(manifest(), (draft) => {
      (draft.records as Record<string, Array<Record<string, unknown>>>).task_assignments[0].source = 'ADMIN';
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((row) => row.targetTable === 'task_assignments')!;
      (source.canonicalRecord as Record<string, unknown>).source = 'ADMIN';
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow('Unsupported legacy operational history cannot be imported.');
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects materially divergent schema defaults on rerun', async () => {
    await prepare();
    await harness.database.query(`INSERT INTO students (tenant_id,student_id,name,status,version) VALUES ($1,'S1','Alice','ACTIVE',2)`, [harness.tenantOneId]);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/target conflict/i);
  });

  it('does not adopt or change a preexisting modern operation from legacy evidence', async () => {
    await prepare();
    const value = manifest();
    const payloadHash = String(value.records.legacy_operation_bindings[0].payloadHash).replace(/^sha256:/, '');
    await harness.database.query(
      `INSERT INTO operations (tenant_id,operation_id,operation_kind,payload_hash,status,failure_code,finished_at,updated_at)
       VALUES ($1,'op-1','TASK_REWARD',$2,'FAILED','legacy-failure',now(),now())`,
      [harness.tenantOneId, payloadHash],
    );
    const before = (await harness.database.query('SELECT * FROM operations')).rows;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction }))
      .resolves.toMatchObject({ status: 'IMPORTING' });
    expect((await harness.database.query('SELECT * FROM operations')).rows).toEqual(before);
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    expect((await harness.database.query('SELECT * FROM operations')).rows).toEqual(before);
  });

  it.each([
    ['manifest version', (draft: Record<string, unknown>) => { draft.manifestVersion = 2; }],
    ['top-level extra', (draft: Record<string, unknown>) => { draft.unexpected = true; }],
    ['target extra', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).students[0].unexpected = true; }],
    ['target type', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).students[0].name = 42; }],
    ['source extra', (draft: Record<string, unknown>) => { (draft.sourceRecords as Array<Record<string, unknown>>)[0].unexpected = true; }],
    ['mapping digest', (draft: Record<string, unknown>) => { (draft.mappings as Array<Record<string, unknown>>)[0].sourceDigest = 'A'.repeat(64); }],
  ])('rejects malformed self-digested %s before opening a transaction', async (_label, corrupt) => {
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: resign(manifest(), corrupt), runTransaction }))
      .rejects.toThrow(/structurally invalid|manifest version/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('bounds oversized and cyclic hostile manifests before opening a transaction', async () => {
    const oversized = resign(manifest(), (draft) => { draft.unexpected = 'x'.repeat(8_000_001); });
    const cyclic = structuredClone(manifest()) as unknown as Record<string, unknown>;
    cyclic.cycle = cyclic;
    for (const value of [oversized, cyclic as unknown as LegacyNormalizationManifest]) {
      const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
      await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction }))
        .rejects.toThrow(/bounds|structurally invalid/i);
      expect(runTransaction).not.toHaveBeenCalled();
    }
  });

  it('rejects a BANK completion without an explicit verified operation binding before opening a transaction', async () => {
    const value = bankManifest(false);
    expect(value.records.task_completions[0]).toMatchObject({ source: 'BANK', operationId: 'op-1' });
    expect(value.records.legacy_operation_bindings ?? []).toEqual([]);
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;

    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction }))
      .rejects.toThrow(/explicit.*operation binding/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('defers an explicitly mapped verified Redis binding without minting an operation', async () => {
    await prepare();
    const value = manifest();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const rows = await harness.database.query<{ operationId: string; payloadHash: string }>(
      'SELECT operation_id "operationId", payload_hash "payloadHash" FROM operations WHERE tenant_id=$1',
      [harness.tenantOneId],
    ).then(({ rows }) => rows);
    expect(rows).toEqual([]);
    const staged = (await harness.database.query<{ canonical_record: Record<string, unknown> }>(
      "SELECT canonical_record FROM migration_source_records WHERE canonical_record->'migrationCheckpoint'->>'intendedTargetTable'='legacy_operation_bindings'" )).rows;
    expect(staged).toEqual([{ canonical_record: expect.objectContaining({
      payloadHash: value.records.legacy_operation_bindings[0].payloadHash,
      migrationCheckpoint: expect.objectContaining({ publication: 'DEFERRED' }),
    }) }]);
  });

  it.each([
    ['null student name', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).students[0].name = null; }],
    ['invalid transaction kind', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).transactions[0].kind = 'NOT_A_KIND'; }],
    ['invalid assignment source', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).task_assignments[0].source = 'NOT_A_SOURCE'; }],
    ['invalid completion source', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).task_completions[0].source = 'NOT_A_SOURCE'; }],
    ['partial completion cycle metadata', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).task_completions[0].cycleId = null; }],
    ['malformed current schedule', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).tasks[0].currentSchedule = { ruleVersion: 1 }; }],
    ['partial extended transaction item snapshot', (draft: Record<string, unknown>) => { (draft.records as Record<string, Array<Record<string, unknown>>>).transaction_items[0].regularUnitPrice = 20; }],
    ['malformed extended transaction item arrays', (draft: Record<string, unknown>) => {
      const item = (draft.records as Record<string, Array<Record<string, unknown>>>).transaction_items[0];
      Object.assign(item, { regularUnitPrice: 20, regularTotal: 20, totalQuantity: 1, paidQuantity: 1, freeQuantity: 0, finalTotal: 20, totalDiscount: 0, adjustmentsSnapshot: {}, appliedPromotionsSnapshot: [] });
    }],
  ])('rejects runtime-invalid projected rows (%s) before opening a transaction', async (_label, corrupt) => {
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: resign(manifest(), corrupt), runTransaction }))
      .rejects.toThrow(/structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('allows only one nonterminal import owner for a tenant', async () => {
    await prepare();
    const first = manifest();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: first, runTransaction: harness.runTenantTransaction });
    await harness.database.query(
      `INSERT INTO migration_jobs (tenant_id, job_id, status) VALUES ($1, $2, 'VALIDATED')`,
      [harness.tenantOneId, OTHER_JOB_ID],
    );
    const second = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: OTHER_JOB_ID, sheets: makeSupportedSheets(), redis: makeRedis() });

    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: OTHER_JOB_ID, manifest: second, runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow(/import owner|another migration job/i);
    const jobs = await harness.database.query<{ jobId: string; status: string }>(
      'SELECT job_id "jobId", status FROM migration_jobs WHERE tenant_id=$1 ORDER BY job_id', [harness.tenantOneId],
    ).then(({ rows }) => rows);
    expect(jobs).toEqual([{ jobId: JOB_ID, status: 'IMPORTING' }, { jobId: OTHER_JOB_ID, status: 'VALIDATED' }]);
    const [{ mixed }] = await harness.database.query<{ mixed: number }>(
      'SELECT count(*)::int mixed FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2', [harness.tenantOneId, OTHER_JOB_ID],
    ).then(({ rows }) => rows);
    expect(mixed).toBe(0);
  });

  it('reasserts the sole tenant import owner before every batch', async () => {
    await prepare();
    let transactions = 0;
    const interleavingRunner: TenantImportTransactionRunner = async (tenantId, callback) => {
      transactions += 1;
      if (transactions === 2) {
        await harness.database.query(
          `INSERT INTO migration_jobs (tenant_id, job_id, status) VALUES ($1, $2, 'VALIDATED')`,
          [tenantId, OTHER_JOB_ID],
        );
      }
      return harness.runTenantTransaction(tenantId, callback);
    };

    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: manifest(), runTransaction: interleavingRunner }))
      .rejects.toThrow(/import owner|another migration job/i);
    const [{ sources, targets }] = await harness.database.query<{ sources: number; targets: number }>(
      `SELECT (SELECT count(*)::int FROM migration_source_records WHERE tenant_id=$1) sources,
              (SELECT count(*)::int FROM students WHERE tenant_id=$1) targets`, [harness.tenantOneId],
    ).then(({ rows }) => rows);
    expect({ sources, targets }).toEqual({ sources: 0, targets: 0 });
  });

  it.each([
    ['tasks', 'taskInstanceId', 'prerequisiteTaskInstanceId'],
    ['task_assignments', 'assignmentId', 'previousAssignmentId'],
    ['transactions', 'transactionId', 'reversesTransactionId'],
  ] as const)('rejects %s self cycles before opening a transaction', async (table, idKey, parentKey) => {
    const value = resign(manifest(), (draft) => {
      const rows = (draft.records as Record<string, Array<Record<string, unknown>>>)[table];
      const row = table === 'transactions' ? rows.find((row) => row.kind === 'CHECKOUT')! : rows[0];
      row[parentKey] = row[idKey];
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((entry) => entry.targetTable === table && entry.targetId === row[table === 'tasks' ? 'taskInstanceId' : table === 'task_assignments' ? 'assignmentId' : 'transactionId'])!;
      const canonical = source.canonicalRecord as Record<string, unknown>;
      canonical[parentKey] = row[parentKey];
      if (table === 'tasks') row.prerequisiteTaskId = canonical.prerequisiteTaskId = row[parentKey] === row.taskInstanceId ? row.taskId : 'missing-parent';
      if (table === 'transactions') {
        row.kind = 'CANCELLATION';
        row.legacyStatusSnapshot = 'CANCEL_REVERSAL';
        canonical.status = 'CANCEL_REVERSAL';
        Object.assign(canonical, { totalAmount: -20, balanceBefore: 80, balanceAfter: 100, operator: `cancel:${row[parentKey]}` });
        Object.assign(row, { legacyTotalAmount: -20, balanceBefore: 80, balanceAfter: 100, balanceDelta: 20, operatorSnapshot: canonical.operator });
        canonical.items = [];
        const records = draft.records as Record<string, Array<Record<string, unknown>>>;
        const removed = new Set(records.transaction_items.filter((item) => item.transactionId === row.transactionId).map((item) => item.itemId));
        records.transaction_items = records.transaction_items.filter((item) => !removed.has(item.itemId));
        draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((mapping) => mapping.targetTable !== 'transaction_items' || !removed.has(mapping.targetId));
      }
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction }))
      .rejects.toThrow(table === 'transactions' ? 'Canonical financial history is inconsistent.'
        : table === 'task_assignments' ? 'Unsupported legacy operational history cannot be imported.' : /cycle/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['tasks', 'prerequisiteTaskInstanceId'],
    ['task_assignments', 'previousAssignmentId'],
    ['transactions', 'reversesTransactionId'],
  ] as const)('rejects unresolved %s parent dependencies before opening a transaction', async (table, parentKey) => {
    const value = resign(manifest(), (draft) => {
      const rows = (draft.records as Record<string, Array<Record<string, unknown>>>)[table];
      const row = table === 'transactions' ? rows.find((row) => row.kind === 'CHECKOUT')! : rows[0];
      row[parentKey] = 'missing-parent';
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((entry) => entry.targetTable === table && entry.targetId === row[table === 'tasks' ? 'taskInstanceId' : table === 'task_assignments' ? 'assignmentId' : 'transactionId'])!;
      const canonical = source.canonicalRecord as Record<string, unknown>;
      canonical[parentKey] = row[parentKey];
      if (table === 'tasks') row.prerequisiteTaskId = canonical.prerequisiteTaskId = row[parentKey] === row.taskInstanceId ? row.taskId : 'missing-parent';
      if (table === 'transactions') {
        row.kind = 'CANCELLATION';
        row.legacyStatusSnapshot = 'CANCEL_REVERSAL';
        canonical.status = 'CANCEL_REVERSAL';
        Object.assign(canonical, { totalAmount: -20, balanceBefore: 80, balanceAfter: 100, operator: `cancel:${row[parentKey]}` });
        Object.assign(row, { legacyTotalAmount: -20, balanceBefore: 80, balanceAfter: 100, balanceDelta: 20, operatorSnapshot: canonical.operator });
        canonical.items = [];
        const records = draft.records as Record<string, Array<Record<string, unknown>>>;
        const removed = new Set(records.transaction_items.filter((item) => item.transactionId === row.transactionId).map((item) => item.itemId));
        records.transaction_items = records.transaction_items.filter((item) => !removed.has(item.itemId));
        draft.mappings = (draft.mappings as Array<Record<string, unknown>>).filter((mapping) => mapping.targetTable !== 'transaction_items' || !removed.has(mapping.targetId));
      }
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction }))
      .rejects.toThrow(table === 'transactions' ? 'Canonical financial history is inconsistent.'
        : table === 'task_assignments' ? 'Unsupported legacy operational history cannot be imported.' : /unresolved.*parent/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('imports a long valid task prerequisite chain without recursive stack traversal', async () => {
    await prepare();
    const chainLength = 1_000;
    const value = createLegacyNormalizationManifest({
      tenantId: harness.tenantOneId, migrationJobId: JOB_ID, redis: makeRedis(),
      sheets: makeSupportedSheets(3, (tabs) => {
        const { headers, rows } = tabs.Tasks;
        const template = rows[0].cells;
        for (let index = 1; index < chainLength; index += 1) {
          const cells = [...template];
          for (const [key, value] of Object.entries({ taskId: `T${index + 1}`, taskInstanceId: `TI${index + 1}`, prerequisiteTaskId: `T${index}`, allowedStudentIds: '' })) {
            cells[headers.indexOf(key)] = value;
          }
          rows.push({ rowNumber: index + 2, cells, hash: '' });
        }
      }),
    });
    expect(value.status).toBe('READY_FOR_IMPORT');

    const result = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, batchSize: 500, runTransaction: harness.runTenantTransaction });
    const [{ count }] = await harness.database.query<{ count: number }>('SELECT count(*)::int count FROM tasks WHERE tenant_id=$1', [harness.tenantOneId]).then(({ rows }) => rows);
    expect(count).toBe(chainLength);
    expect(result.importedTargetRecords).toBeGreaterThanOrEqual(chainLength);
  }, 30_000);

  it.each([
    ['top-level secret', (canonical: Record<string, unknown>) => { canonical.clientSecret = 'do-not-persist'; }],
    ['nested secret', (canonical: Record<string, unknown>) => { canonical.audit = { password: 'do-not-persist' }; }],
  ])('rejects arbitrary %s canonical source data before opening a transaction', async (_label, corrupt) => {
    const forged = resign(manifest(), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((row) => row.targetTable === 'students')!;
      corrupt(source.canonicalRecord as Record<string, unknown>);
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/canonical source|structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['Transactions', 'operator', { password: 'secret' }],
    ['Transactions', 'items', [{ productId: 'P1', secret: 'hidden' }]],
    ['Transactions', 'items', [{ productId: 'P1', name: 'Pencil', price: 20, quantity: 1, subtotal: 20, itemId: 'I1', transactionId: 'TX1', lineNumber: 1, adjustments: [{ password: 'hidden' }] }]],
    ['Transactions', 'items', [{ productId: { password: 'hidden' }, name: 'Pencil', price: 20, quantity: 1, subtotal: 20, itemId: 'I1', transactionId: 'TX1', lineNumber: 1 }]],
    ['Students', 'balance', 'not-a-number'],
    ['Tasks', 'currentSchedule', { secret: 'hidden' }],
    ['Settings', 'key', { password: 'hidden' }],
  ])('validates unmapped canonical %s %s before transactions', async (tab, key, badValue) => {
    const forged = resign(manifest(), (draft) => {
      const sources = draft.sourceRecords as Array<Record<string, unknown>>;
      const source = structuredClone(sources.find((row) => (row.source as Record<string, unknown>).tab === tab && (tab !== 'Settings' || !row.targetTable) && (tab !== 'Transactions' || row.targetId === 'TX1'))!);
      delete source.targetTable;
      delete source.targetId;
      (source.source as Record<string, unknown>).rowHash = sha256(`unmapped-${tab}-${key}`);
      // Keep this scalar regression independent of the earlier duplicate-source gate.
      const canonical = source.canonicalRecord as Record<string, unknown>;
      const identity = ({ Transactions: 'transactionId', Students: 'studentId', Tasks: 'taskId' } as Record<string, string>)[String(tab)];
      if (identity) canonical[identity] = `unmapped-${tab}`;
      (source.source as Record<string, unknown>).rowNumber = 999;
      (source.canonicalRecord as Record<string, unknown>)[key as string] = badValue;
      sources.push(source);
    });
    const runTransaction = vi.fn(async () => { throw new Error('transaction entered'); }) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/canonical source|structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects canonical content that disagrees with its exact mapped target before opening a transaction', async () => {
    const forged = resign(manifest(), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((row) => row.targetTable === 'students')!;
      (source.canonicalRecord as Record<string, unknown>).name = 'Mallory';
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/canonical source.*target|mapping.*canonical/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['Redis derived canonical shape', (source: Record<string, unknown>) => { delete (source.canonicalRecord as Record<string, unknown>).binding; }],
    ['Redis source digest', (source: Record<string, unknown>, draft: Record<string, unknown>) => {
      const prior = (source.source as Record<string, unknown>).sourceDigest;
      const forged = sha256(canonicalJson(source.canonicalRecord));
      (source.source as Record<string, unknown>).sourceDigest = forged;
      for (const mapping of draft.mappings as Array<Record<string, unknown>>) if (mapping.sourceDigest === prior) mapping.sourceDigest = forged;
    }],
  ])('rejects malformed %s before opening a transaction', async (_label, corrupt) => {
    const forged = resign(manifest(), (draft) => {
      const source = (draft.sourceRecords as Array<Record<string, unknown>>).find((row) => row.targetTable === 'legacy_operation_bindings')!;
      corrupt(source, draft);
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/Redis|canonical source|provenance|structurally invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['tuple digest', (row: Record<string, unknown>) => { row.tupleDigest = 'e'.repeat(64); }],
    ['owner digest', (row: Record<string, unknown>) => { row.ownerDigest = 'e'.repeat(64); }],
    ['payload hash', (row: Record<string, unknown>) => { row.payloadHash = `sha256:${'e'.repeat(64)}`; }],
    ['binding evidence', (row: Record<string, unknown>) => { ((row.binding as Record<string, unknown>).evidence as Record<string, unknown>).evidencePostId = 'forged-post'; }],
  ])('rejects a forged Redis operation binding %s before opening a transaction', async (_label, corrupt) => {
    const forged = resign(manifest(), (draft) => {
      corrupt((draft.records as Record<string, Array<Record<string, unknown>>>).legacy_operation_bindings[0]);
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/operation binding|canonical source|provenance|target/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['missing schemaVersion', (records: Array<Record<string, unknown>>) => { records.splice(records.findIndex((row) => row.key === 'schemaVersion'), 1); }],
    ['duplicate classTimeZone', (records: Array<Record<string, unknown>>) => { records.push(structuredClone(records.find((row) => row.key === 'classTimeZone')!)); }],
    ['metadata mismatch', (_records: Array<Record<string, unknown>>, draft: Record<string, unknown>) => { (draft.metadata as Record<string, unknown>).classTimeZone = 'UTC'; }],
    ['unsupported secret key', (records: Array<Record<string, unknown>>) => { records.push({ tenantId: harness.tenantOneId, key: 'adminPassword', value: 'secret' }); }],
  ])('rejects invalid operational settings: %s before opening a transaction', async (_label, corrupt) => {
    const forged = resign(manifest(), (draft) => corrupt(
      (draft.records as Record<string, Array<Record<string, unknown>>>).settings,
      draft,
    ));
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/setting|mapping|target/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('retains the original prefixed legacy digest in deferred evidence, not operation columns', async () => {
    await prepare();
    const value = manifest();
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: value, runTransaction: harness.runTenantTransaction });
    const staged = (await harness.database.query<{ digest: string }>(
      "SELECT canonical_record->>'payloadHash' digest FROM migration_source_records WHERE canonical_record->'migrationCheckpoint'->>'intendedTargetTable'='legacy_operation_bindings'" )).rows;
    expect(staged).toEqual([{ digest: value.records.legacy_operation_bindings[0].payloadHash }]);
    expect(staged[0].digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await harness.database.query('SELECT * FROM operations')).rows).toEqual([]);
    expect((await harness.database.query('SELECT operation_id,operation_hash FROM task_completions')).rows)
      .toEqual([{ operation_id: null, operation_hash: null }]);
  });

  it('rejects a forged completion operation hash mismatch before opening a transaction', async () => {
    const forged = resign(bankManifest(), (draft) => {
      (draft.records as Record<string, Array<Record<string, unknown>>>).task_completions[0].operationPayloadHash = `sha256:${'e'.repeat(64)}`;
    });
    const runTransaction = vi.fn(harness.runTenantTransaction) as TenantImportTransactionRunner;
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, manifest: forged, runTransaction }))
      .rejects.toThrow(/operation binding|operation hash/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
