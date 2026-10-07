import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { getTaskRecords } from '@/server/sheetsRepository';
import { updateTaskAssignmentsBatch } from '@/server/repositories/sheets/taskAssignmentCommands';
import { loadTaskCycleLedgerSnapshot, projectTaskCycleStateFromSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
import { readOfflineGoogleGrid } from '@/server/migration/offlineGoogleGrid';
import { captureOfflineGoogleGridBaseline } from '@/server/migration/sheetsSnapshot';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { normalizeSchema4BankHistory } from '@/server/migration/schema4BankHistory';
import { inspectSchema4AdminHistory } from '@/server/migration/schema4AdminHistoryBridge';
import { inspectSchema4AdjustmentHistory } from '@/server/migration/schema4AdjustmentHistory';
import { inspectSchema4CompletionHistory, importSchema4CompletionHistory, readSchema4CompletionHistory,
  replaySchema4CompletionHistory } from '@/server/migration/schema4CompletionHistory';
import { completionMemoryStore } from './schema4CompletionHistory.fixture';
vi.mock('server-only', () => ({}));
const sha = (wire: string) => createHash('sha256').update(wire).digest('hex');
function check(value: boolean, code: string): asserts value { if (!value) throw new Error(code); }

it.skipIf(process.env.A08_PRIVATE !== '1')('A08 pinned two physical completion rows: private writer reader SQL and unchanged operational gate', async () => {
  try {
    const manifestWire = readFileSync('/private/manifest.json', 'utf8'), manifest = JSON.parse(manifestWire);
    const a07Wire = readFileSync('/private/a07.json', 'utf8'), a07 = JSON.parse(a07Wire);
    const gridJson = readFileSync('/private/grid.json', 'utf8');
    check(sha(manifestWire) === 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961'
      && sha(a07Wire) === '0531742cee7e45492667817c4bc03901bb8a67c5274ba8ae873f795f077e1826'
      && manifest.gridReadHashes.length === 2 && manifest.gridReadHashes.every((h: string) => h === sha(gridJson)), 'A08_PIN');
    const { tabs } = readOfflineGoogleGrid(gridJson), plan = normalizeSchema4BankHistory(gridJson);
    const history = inspectSchema4CompletionHistory(gridJson);
    // Facts, codes and coordinates only; raw values never cross assertion/log boundaries.
    if (!history.rows.every(r => r.consistency === 'ADMIN_TOGGLE_WRITER_COMPATIBLE')) {
      console.info(JSON.stringify({ kind: 'A08_PRIVATE_FACTS', rows: history.rows }));
      throw new Error('A08_PAIR_SHAPE');
    }
    check(Object.keys(tabs).length === 10 && plan.groups.length === 1 && plan.groups[0].checkpointRows.length === 3, 'A08_BANK_BOUNDARY');
    check(inspectSchema4AdminHistory(gridJson).resets.find(r => r.rowNumber === 5)?.consistency === 'SINGLE_BANK_RESET_WRITER_MATCH', 'A08_RESET_BOUNDARY');
    check(JSON.stringify(inspectSchema4AdjustmentHistory(gridJson).rows) === JSON.stringify(a07.actualBaseline.rows), 'A08_ADJUSTMENT_BOUNDARY');
    const record = (tab: string, n: number) => Object.fromEntries(tabs[tab][0].map((h, i) => [h, tabs[tab][n - 1][i] ?? '']));
    const a = record('TaskCompletions', 6), b = record('TaskCompletions', 7), ar = record('TaskAssignments', 3), ur = record('TaskAssignments', 4);
    const snapshot = await loadTaskCycleLedgerSnapshot({ getRows: async name => tabs[name] ?? [] });
    check(snapshot.completions.length === 6 && snapshot.assignments.length === 3, 'A08_READER_ROW_LOSS');
    for (const [i, r] of [a, b].entries()) {
      const event = snapshot.completions[i + 4];
      check(event.completionId === r.completionId && event.assignmentId === ar.assignmentId && event.source === r.source
        && event.status === r.status && event.reward === 0 && event.balanceBefore === event.balanceAfter
        && !event.operationId && !event.operationPayloadHash, 'A08_READER_PHYSICAL_ORDER');
    }
    // Current-code reproduction of the matching byte shape, NOT the historical
    // input command, account authorization or Redis state. Everything is RAM-only.
    const local = structuredClone(tabs);
    local.TaskCompletions.splice(5); local.TaskAssignments.splice(2);
    local.Students = [['studentId', 'name', 'balance', 'status'], [a.studentId, a.studentName, a.balanceBefore, 'ACTIVE']];
    const { store, writes } = completionMemoryStore(local);
    const uuids = [ar.assignmentId.slice(2), a.completionId.slice(3), b.completionId.slice(3), ur.assignmentId.slice(2)];
    const random = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => uuids.shift() as ReturnType<typeof crypto.randomUUID>);
    const projections: Array<{ rowNumber: number; assigned: boolean; completed: boolean }> = [];
    try {
      for (const [i, r] of [a, b].entries()) {
        const target = [{ taskId: a.taskId, operations: [{ studentId: a.studentId, assigned: i === 0, completed: i === 0, source: 'ADMIN' as const }] }];
        const result = await updateTaskAssignmentsBatch(store, target, { now: () => r.timestamp });
        check(result.appliedCount === 1 && result.failures.length === 0, 'A08_LOCAL_WRITER');
        const before = writes.length, retry = await updateTaskAssignmentsBatch(store, target, { now: () => r.timestamp });
        check(writes.length === before && retry.appliedCount === 0 && (i === 0 ? retry.failures.length === 0
          : retry.failures.length === 1 && retry.failures[0].code === 'OPERATION_FAILED'), 'A08_SOURCE_WRITER_RETRY');
        const task = (await getTaskRecords(store)).find(r => r.task.taskId === a.taskId)?.task;
        check(Boolean(task), 'A08_TASK_READER');
        const state = projectTaskCycleStateFromSnapshot(task!, r.timestamp, await loadTaskCycleLedgerSnapshot(store)).students[a.studentId];
        check(state.assigned === (i === 0) && state.completed === (i === 0), 'A08_READER_PROJECTION');
        projections.push({ rowNumber: i + 6, assigned: state.assigned, completed: state.completed });
      }
      check(JSON.stringify(local.TaskCompletions) === JSON.stringify(tabs.TaskCompletions)
        && JSON.stringify(local.TaskAssignments) === JSON.stringify(tabs.TaskAssignments), 'A08_EXACT_WRITER_BYTES');
      check(JSON.stringify(local.Transactions) === JSON.stringify(tabs.Transactions)
        && local.Students[1][2] === a.balanceBefore, 'A08_ZERO_WRITER_MONEY');
      check(writes.length === 6 && writes.every(w => ['Tasks', 'TaskAssignments', 'TaskCompletions'].includes(w.tab)), 'A08_WRITER_SCOPE');
    } finally { random.mockRestore(); }
    const captured = await captureOfflineGoogleGridBaseline({ gridJson, capturedAt: manifest.capturedAt });
    const legacyInput = { tenantId: '00000000-0000-4000-8000-000000000008', migrationJobId: '20000000-0000-4000-8000-000000000008', sheets: captured };
    const preflight = createLegacyNormalizationManifest(legacyInput);
    const diagnostics = preflight.blockingConflicts.map(({ code, path }) => ({ code, path }));
    check(preflight.status === 'BLOCKED' && diagnostics.length === 32
      && JSON.stringify(diagnostics) === JSON.stringify(a07.actualBaseline.diagnostics), 'A08_DIAGNOSTIC_DRIFT');
    let operationalTransactions = 0, importerFailures = 0;
    for (let i = 0; i < 2; i++) {
      try { await importLegacyNormalizationManifest({ ...legacyInput, manifest: preflight, offlineRehearsal: true,
        runTransaction: async () => { operationalTransactions++; throw new Error('A08_OPERATIONAL_RUNNER'); } }); }
      catch { importerFailures++; }
    }
    check(importerFailures === 2 && operationalTransactions === 0, 'A08_IMPORTER_GATE');
    const db = await createPgliteDatabaseHarness();
    try {
      await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
      const input = { tenantId: db.tenantOneId, gridJson, intent: 'OFFLINE_INSPECTION' as const, runTransaction: db.runTenantTransaction };
      const count = async () => (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM schema4_history.captures)
        + (SELECT count(*) FROM schema4_history.source_rows) + (SELECT count(*) FROM schema4_history.reward_groups))::int n`)).rows[0].n;
      let rollback = false;
      try { await importSchema4CompletionHistory({ ...input, runTransaction: (tenant, cb) => db.runTenantTransaction(tenant, async tx => {
        await cb(tx); throw new Error('A08_INJECTED_ROLLBACK');
      }) }); } catch (e) { rollback = e instanceof Error && e.message === 'A08_INJECTED_ROLLBACK'; }
      check(rollback && await count() === 0, 'A08_ROLLBACK_RESIDUE');
      const imported = await importSchema4CompletionHistory(input);
      check(JSON.stringify(await importSchema4CompletionHistory(input)) === JSON.stringify(imported), 'A08_RETRY');
      let lostResponse = false;
      try { await importSchema4CompletionHistory({ ...input, runTransaction: async (tenant, cb) => {
        await db.runTenantTransaction(tenant, cb); throw new Error('A08_INJECTED_LOST_RESPONSE');
      } }); } catch (e) { lostResponse = e instanceof Error && e.message === 'A08_INJECTED_LOST_RESPONSE'; }
      check(lostResponse && JSON.stringify(await importSchema4CompletionHistory(input)) === JSON.stringify(imported), 'A08_LOST_RESPONSE');
      const readInput = { ...input, sourceDigest: plan.sourceDigest }, stored = await readSchema4CompletionHistory(readInput);
      check(JSON.stringify(stored.observation.plan.sources) === JSON.stringify(plan.sources)
        && JSON.stringify(stored.completionHistory) === JSON.stringify(history), 'A08_RAW_READBACK');
      const wireRows = (await db.database.query<{ grid_json: string }>('SELECT grid_json FROM schema4_history.captures')).rows;
      check(wireRows.length === 1 && wireRows[0].grid_json === gridJson, 'A08_WIRE_READBACK');
      const previousCount = await count();
      for (const rowNumber of [6, 7]) for (let i = 0; i < 2; i++) {
        const replay = await replaySchema4CompletionHistory({ ...readInput, rowNumber });
        check(!replay.changed && replay.balanceToApply === 0 && replay.stockToApply === 0 && replay.rewardToApply === 0
          && !replay.claimPublished && replay.currentStateAuthority === 'BLOCKED', 'A08_REPLAY_EFFECT');
      }
      check(await count() === previousCount && previousCount === plan.sources.length + plan.groups.length + 1, 'A08_DUPLICATE_ROWS');
      let bridgeCalls = 0, bridgeFailures = 0;
      for (const intent of ['OPERATIONAL_READER', 'OPERATIONAL_IMPORT'] as const) {
        const blocked = { ...readInput, intent, runTransaction: async () => { bridgeCalls++; throw new Error('A08_BRIDGE_RUNNER'); } };
        for (const fn of [() => importSchema4CompletionHistory(blocked), () => readSchema4CompletionHistory(blocked),
          () => replaySchema4CompletionHistory({ ...blocked, rowNumber: 6 })]) {
          try { await fn(); } catch (e) { if (e instanceof Error && e.message === 'SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED') bridgeFailures++; }
        }
      }
      check(bridgeCalls === 0 && bridgeFailures === 6, 'A08_BRIDGE_GATE');
      const modern = (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
        + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM adjustments) + (SELECT count(*) FROM inventory_ledger)
        + (SELECT count(*) FROM task_completions))::int n`)).rows[0].n;
      check(modern === 0, 'A08_MODERN_ROWS');
      console.info(JSON.stringify({ kind: 'A08_PRIVATE_RESULT', manifestSha256: sha(manifestWire), sourceDigest: plan.sourceDigest,
        sourceClassification: 'READ_ONLY_REHEARSAL_BASELINE', authority: history.authority, rows: history.rows,
        historicalAdminAuthentication: history.historicalAdminAuthentication, historicalRedisClaim: history.historicalRedisClaim,
        operationalBridge: history.operationalBridge, rawReadbackExact: true, wireReadbackExact: true, rollbackEmpty: true,
        retryNoDuplicates: true, lostResponseRetryExact: true, replayNoEffect: true, localWriterByteMatch: true,
        localWriterCalls: writes.length, localWriterSuccessRetryNoOp: true, localWriterResetRetryRefusesWithoutWrites: true,
        readerPhysicalRows: [6, 7], projections, rawRowsPreserved: plan.sources.length, businessTabs: Object.keys(tabs).length,
        priorContractsUnchanged: true, operationalTransactions, importerFailures, bridgeCalls, bridgeFailures, modernRows: modern,
        preflight: preflight.status, diagnostics, diagnosticsSha256: sha(JSON.stringify(diagnostics)) }));
    } finally { await db.close(); }
  } catch (error) {
    throw new Error(error instanceof Error && /^A08_[A-Z_]+$/.test(error.message) ? error.message : 'A08_UNEXPECTED_PRIVATE_FAILURE');
  }
}, 30_000);
