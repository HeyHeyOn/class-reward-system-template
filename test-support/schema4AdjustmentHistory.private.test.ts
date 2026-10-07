import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { bulkAdjustStudentBalances, getTransactions, type SheetsStore } from '@/server/sheetsRepository';
import { readOfflineGoogleGrid } from '@/server/migration/offlineGoogleGrid';
import { captureOfflineGoogleGridBaseline } from '@/server/migration/sheetsSnapshot';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { normalizeSchema4BankHistory } from '@/server/migration/schema4BankHistory';
import { inspectSchema4CancellationHistory } from '@/server/migration/schema4CancellationHistory';
import { inspectSchema4AdjustmentHistory, importSchema4AdjustmentHistory, readSchema4AdjustmentHistory,
  replaySchema4AdjustmentHistory } from '@/server/migration/schema4AdjustmentHistory';
vi.mock('server-only', () => ({}));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Only fixed codes/coordinates/booleans cross the assertion/log boundary.
function requirePrivate(value: boolean, code: string): asserts value { if (!value) throw new Error(code); }

it.skipIf(process.env.A07_PRIVATE !== '1')('A07 pinned private rows: writer/reader/raw readback/rollback/retry with no authority', async () => {
  try {
    const manifestWire = readFileSync('/private/manifest.json', 'utf8');
    requirePrivate(sha(manifestWire) === 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961', 'A07_MANIFEST_PIN');
    const manifest = JSON.parse(manifestWire), gridJson = readFileSync('/private/grid.json', 'utf8');
    requirePrivate(manifest.gridReadHashes.length === 2 && manifest.gridReadHashes.every((h: string) => h === sha(gridJson)), 'A07_GRID_PIN');
    const a06Wire = readFileSync('/private/a06.json', 'utf8');
    requirePrivate(sha(a06Wire) === 'd74802a8862cd5a2755518548c837b700f1acff8b8715975f4bee8262a918f25', 'A07_PREDECESSOR_PIN');
    const a06 = JSON.parse(a06Wire), plan = normalizeSchema4BankHistory(gridJson), history = inspectSchema4AdjustmentHistory(gridJson);
    requirePrivate(JSON.stringify(history.rows.map(r => [r.rowNumber, r.mode, r.predecessorRow])) ===
      '[[7,"subtract",6],[8,"add",7],[9,"add",8],[10,"subtract",9]]', 'A07_ROW_COORDINATES');
    requirePrivate(history.authority === 'OFFLINE_NONAUTHORITY' && history.rows.every(r => r.consistency === 'BULK_ADJUSTMENT_WRITER_MATCH'
      && Object.values(r.facts).every(Boolean) && r.priorTransactionLink === 'NONE' && r.claimAuthority === 'UNOBSERVED'), 'A07_WRITER_FACTS');
    requirePrivate(JSON.stringify(history.rows.map(r => r.predecessorNameMatches)) === '[true,true,false,true]'
      && history.rows[2].diagnosticCodes.includes('ADJUSTMENT_NAME_SNAPSHOT_CHANGED'), 'A07_NAME_SNAPSHOT_BOUNDARY');
    const { tabs } = readOfflineGoogleGrid(gridJson), headers = tabs.Transactions[0];
    requirePrivate(Object.keys(tabs).length === 10 && plan.groups.length === 1 && plan.groups[0].checkpointRows.length === 3, 'A07_BANK_BOUNDARY');
    const cancellation = inspectSchema4CancellationHistory(gridJson);
    requirePrivate(JSON.stringify(cancellation.rows) === JSON.stringify(a06.actualBaseline.rows), 'A07_CANCELLATION_BOUNDARY');
    const read = await getTransactions({ getRows: async name => tabs[name] ?? [] });
    let localWriterCalls = 0;
    const readerRows: number[] = [];
    const currentBalanceMatches: Array<{ rowNumber: number; currentBalanceMatchesAfter: boolean }> = [];
    for (const assessed of history.rows) {
      const n = assessed.rowNumber, raw = tabs.Transactions[n - 1], r = Object.fromEntries(headers.map((h, i) => [h, raw[i]]));
      const parsed = read.filter(t => t.transactionId === r.transactionId);
      requirePrivate(parsed.length === 1 && parsed[0].status === 'ADMIN_ADJUSTMENT' && !parsed[0].itemsMalformed
        && parsed[0].balanceBefore === Number(r.balanceBefore) && parsed[0].balanceAfter === Number(r.balanceAfter)
        && parsed[0].totalAmount === Number(r.totalAmount), 'A07_READER_MISMATCH');
      readerRows.push(read.indexOf(parsed[0]));
      const sHeaders = tabs.Students[0], sRow = tabs.Students.slice(1).find(s => s[sHeaders.indexOf('studentId')] === r.studentId);
      currentBalanceMatches.push({ rowNumber: n, currentBalanceMatchesAfter: Boolean(sRow && sRow[sHeaders.indexOf('balance')] === r.balanceAfter) });
      // In-memory reconstruction ONLY: private data never becomes an on-disk fixture.
      // This establishes the current code's byte shape, not actual historical authorship.
      const local: Record<string, string[][]> = {
        Students: [['studentId', 'name', 'balance', 'status'], [r.studentId, r.studentName, r.balanceBefore, 'ACTIVE']],
        Transactions: tabs.Transactions.slice(0, n - 1).map(row => [...row]),
      };
      const store = { getRows: async (name: string) => local[name] ?? [],
        applyAtomicMutation: async (mutation: Parameters<NonNullable<SheetsStore['applyAtomicMutation']>>[0]) => {
          localWriterCalls++;
          requirePrivate(!mutation.uniqueClaim && !mutation.uniqueClaims && mutation.updates.length === 1
            && mutation.appends.length === 1 && mutation.appends[0].sheetName === 'Transactions', 'A07_WRITER_BOUNDARY');
          for (const u of mutation.updates) local[u.sheetName][u.rowNumber - 1][u.columnNumber - 1] = String(u.value);
          for (const a of mutation.appends) local[a.sheetName].push(a.values.map(String));
        } } as SheetsStore;
      const operationId = /^ADMIN-([0-9a-f-]{36})-/.exec(r.transactionId)?.[1];
      requirePrivate(Boolean(operationId) && assessed.mode !== 'UNPROVEN', 'A07_LOCAL_INPUT');
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(r.timestamp));
        const input = { studentIds: [r.studentId], mode: assessed.mode, amount: Math.abs(Number(r.totalAmount)), operationId: operationId! };
        const first = await bulkAdjustStudentBalances(store, input), priorCalls = localWriterCalls;
        requirePrivate(JSON.stringify(await bulkAdjustStudentBalances(store, input)) === JSON.stringify(first)
          && localWriterCalls === priorCalls, 'A07_LOCAL_WRITER_RETRY');
        requirePrivate(JSON.stringify(local.Transactions.at(-1)) === JSON.stringify(raw), 'A07_EXACT_WRITER_BYTES');
      } finally { vi.useRealTimers(); }
    }
    requirePrivate(localWriterCalls === 4 && JSON.stringify(readerRows) === '[3,2,1,0]', 'A07_WRITER_READER_ORDER');
    const snapshot = await captureOfflineGoogleGridBaseline({ gridJson, capturedAt: manifest.capturedAt });
    // Synthetic scope IDs only exercise the negative operational gate, not source-ID replacement.
    const legacyInput = { tenantId: '00000000-0000-4000-8000-000000000007',
      migrationJobId: '20000000-0000-4000-8000-000000000007', sheets: snapshot };
    const preflight = createLegacyNormalizationManifest(legacyInput);
    const diagnostics = preflight.blockingConflicts.map(({ code, path }) => ({ code, path }));
    requirePrivate(preflight.status === 'BLOCKED' && diagnostics.length === 32
      && JSON.stringify(diagnostics) === JSON.stringify(a06.actualBaseline.diagnostics), 'A07_OPERATIONAL_DIAGNOSTIC_DRIFT');
    const adjustmentDiagnostics = diagnostics.filter(r => r.code === 'AMBIGUOUS_ADJUSTMENT_TRANSACTION');
    requirePrivate(JSON.stringify(adjustmentDiagnostics.map(r => r.path)) === JSON.stringify([7, 8, 9, 10].map(n =>
      `Transactions[${String(n).padStart(9, '0')}]`)), 'A07_FOUR_DIAGNOSTICS');
    let operationalTransactions = 0, importerFailures = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await importLegacyNormalizationManifest({ ...legacyInput, manifest: preflight, offlineRehearsal: true,
          runTransaction: async () => { operationalTransactions++; throw new Error('A07_OPERATIONAL_RUNNER_REACHED'); } });
      } catch { importerFailures++; }
    }
    requirePrivate(importerFailures === 2 && operationalTransactions === 0, 'A07_IMPORTER_GATE');
    const db = await createPgliteDatabaseHarness();
    try {
      await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
      const input = { tenantId: db.tenantOneId, gridJson, intent: 'OFFLINE_INSPECTION' as const, runTransaction: db.runTenantTransaction };
      let rolledBack = false;
      try {
        await importSchema4AdjustmentHistory({ ...input, runTransaction: (tenant, cb) => db.runTenantTransaction(tenant, async tx => {
          await cb(tx); throw new Error('A07_INJECTED_ROLLBACK');
        }) });
      } catch (e) { rolledBack = e instanceof Error && e.message === 'A07_INJECTED_ROLLBACK'; }
      const count = async () => (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM schema4_history.captures)
        + (SELECT count(*) FROM schema4_history.source_rows) + (SELECT count(*) FROM schema4_history.reward_groups))::int n`)).rows[0].n;
      requirePrivate(rolledBack && await count() === 0, 'A07_ROLLBACK_RESIDUE');
      const imported = await importSchema4AdjustmentHistory(input);
      requirePrivate(JSON.stringify(await importSchema4AdjustmentHistory(input)) === JSON.stringify(imported), 'A07_RETRY_CONFLICT');
      let lostResponse = false;
      try {
        await importSchema4AdjustmentHistory({ ...input, runTransaction: async (tenant, cb) => {
          await db.runTenantTransaction(tenant, cb); throw new Error('A07_INJECTED_LOST_RESPONSE');
        } });
      } catch (e) { lostResponse = e instanceof Error && e.message === 'A07_INJECTED_LOST_RESPONSE'; }
      requirePrivate(lostResponse && JSON.stringify(await importSchema4AdjustmentHistory(input)) === JSON.stringify(imported), 'A07_LOST_RESPONSE_RETRY');
      const storedInput = { ...input, sourceDigest: plan.sourceDigest }, stored = await readSchema4AdjustmentHistory(storedInput);
      requirePrivate(JSON.stringify(stored.observation.plan.sources) === JSON.stringify(plan.sources), 'A07_RAW_READBACK');
      requirePrivate(JSON.stringify(stored.adjustmentHistory) === JSON.stringify(history), 'A07_ASSESSMENT_READBACK');
      const captures = await db.database.query<{ grid_json: string }>('SELECT grid_json FROM schema4_history.captures');
      requirePrivate(captures.rows.length === 1 && captures.rows[0].grid_json === gridJson, 'A07_WIRE_READBACK');
      const priorCount = await count();
      for (const { rowNumber } of history.rows) for (let attempt = 0; attempt < 2; attempt++) {
        const replay = await replaySchema4AdjustmentHistory({ ...storedInput, rowNumber });
        requirePrivate(!replay.changed && replay.balanceToApply === 0 && replay.stockToApply === 0 && replay.rewardToApply === 0
          && !replay.claimPublished && replay.currentStateAuthority === 'BLOCKED', 'A07_REPLAY_EFFECT');
      }
      requirePrivate(await count() === priorCount && priorCount === plan.sources.length + plan.groups.length + 1, 'A07_DUPLICATE_ROWS');
      let bridgeCalls = 0, bridgeFailures = 0;
      for (const intent of ['OPERATIONAL_READER', 'OPERATIONAL_IMPORT'] as const) {
        const blocked = { ...storedInput, intent, runTransaction: async () => { bridgeCalls++; throw new Error('A07_BRIDGE_RUNNER_REACHED'); } };
        for (const call of [() => importSchema4AdjustmentHistory(blocked), () => readSchema4AdjustmentHistory(blocked),
          () => replaySchema4AdjustmentHistory({ ...blocked, rowNumber: 7 })]) {
          try { await call(); } catch (e) { if (e instanceof Error && e.message === 'SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED') bridgeFailures++; }
        }
      }
      requirePrivate(bridgeCalls === 0 && bridgeFailures === 6, 'A07_BRIDGE_GATE');
      const modern = await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
        + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM adjustments) + (SELECT count(*) FROM inventory_ledger)
        + (SELECT count(*) FROM task_completions))::int n`);
      requirePrivate(modern.rows[0].n === 0, 'A07_MODERN_ROWS');
      console.info(JSON.stringify({ kind: 'A07_PRIVATE_RESULT', manifestSha256: sha(manifestWire), sourceDigest: plan.sourceDigest,
        authority: history.authority, rows: history.rows, operationalBridge: history.operationalBridge,
        sourceClassification: 'READ_ONLY_REHEARSAL_BASELINE', rawReadbackExact: true, wireReadbackExact: true,
        localWriterCalls, localWriterByteMatch: true, localWriterImmediateRetryNoWrites: true, readerPhysicalRowsNewestFirst: [10, 9, 8, 7],
        currentBalanceMatches, rollbackEmpty: true, lostResponseRetryExact: true, replayNoEffect: true, retryNoDuplicates: true,
        rawRowsPreserved: plan.sources.length, businessTabs: Object.keys(tabs).length,
        bankCheckpointsUnchanged: true, cancellationAssessmentUnchanged: true,
        operationalTransactions, importerFailures, bridgeCalls, bridgeFailures, modernRows: modern.rows[0].n,
        preflight: preflight.status, diagnostics, diagnosticsSha256: sha(JSON.stringify(diagnostics)) }));
    } finally { await db.close(); }
  } catch (error) {
    const code = error instanceof Error && /^A07_[A-Z_]+$/.test(error.message) ? error.message : 'A07_UNEXPECTED_PRIVATE_FAILURE';
    throw new Error(code);
  }
});
