import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { getTransactions } from '@/server/sheetsRepository';
import { readOfflineGoogleGrid } from '@/server/migration/offlineGoogleGrid';
import { captureOfflineGoogleGridBaseline } from '@/server/migration/sheetsSnapshot';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { normalizeSchema4BankHistory } from '@/server/migration/schema4BankHistory';
import { inspectSchema4CancellationHistory, importSchema4CancellationHistory, readSchema4CancellationHistory,
  replaySchema4CancellationHistory } from '@/server/migration/schema4CancellationHistory';
vi.mock('server-only', () => ({}));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Only booleans and fixed codes cross the assertion boundary; never a raw row diff.
function requirePrivate(value: boolean, code: string): asserts value { if (!value) throw new Error(code); }

it.skipIf(process.env.A06_PRIVATE !== '1')('A06 fixed capture: exact raw cancellation readback/replay/rollback, no operational authority', async () => {
  try {
    const manifestWire = readFileSync('/private/manifest.json', 'utf8');
    requirePrivate(sha(manifestWire) === 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961', 'A06_MANIFEST_PIN');
    const manifest = JSON.parse(manifestWire), gridJson = readFileSync('/private/grid.json', 'utf8');
    requirePrivate(manifest.gridReadHashes.length === 2 && manifest.gridReadHashes.every((hash: string) => hash === sha(gridJson)), 'A06_GRID_PIN');
    const a05 = JSON.parse(readFileSync('/private/a05.json', 'utf8'));
    const plan = normalizeSchema4BankHistory(gridJson), assessment = inspectSchema4CancellationHistory(gridJson);
    requirePrivate(JSON.stringify(assessment.pairs.map(p => [p.originalRow, p.reversalRow])) === '[[3,5],[4,6]]', 'A06_PAIR_COORDINATES');
    requirePrivate(assessment.rows.every(r => r.consistency === 'CHECKOUT_CANCELLATION_WRITER_MATCH'
      && Object.values(r.facts).every(Boolean)
      && JSON.stringify(r.diagnosticCodes) === '["UNPROVEN_CANCELLATION_AUTHORITY","UNPROVEN_HISTORICAL_STOCK_APPLICATION"]'), 'A06_WRITER_FACTS');
    requirePrivate(assessment.authority === 'OFFLINE_NONAUTHORITY'
      && assessment.pairs.every(p => p.stockAuthority === 'DERIVED_ONLY_NOT_OBSERVED'), 'A06_AUTHORITY');
    const { tabs } = readOfflineGoogleGrid(gridJson);
    const transactions = await getTransactions({ getRows: async name => tabs[name] ?? [] });
    const idColumn = tabs.Transactions[0].indexOf('transactionId');
    for (const pair of assessment.pairs) {
      const original = transactions.find(t => t.transactionId === tabs.Transactions[pair.originalRow - 1][idColumn]);
      const reversal = transactions.find(t => t.transactionId === tabs.Transactions[pair.reversalRow - 1][idColumn]);
      requirePrivate(Boolean(original && reversal && original.cancelledAt === reversal.timestamp), 'A06_SHEETS_READER_LINK');
    }
    const snapshot = await captureOfflineGoogleGridBaseline({ gridJson, capturedAt: manifest.capturedAt });
    // Fixed synthetic tenant/job arguments only exercise the negative operational gate.
    const legacyInput = { tenantId: '00000000-0000-4000-8000-000000000006',
      migrationJobId: '20000000-0000-4000-8000-000000000006', sheets: snapshot };
    const preflight = createLegacyNormalizationManifest(legacyInput);
    const diagnostics = preflight.blockingConflicts.map(({ code, path }) => ({ code, path }));
    requirePrivate(preflight.status === 'BLOCKED' && diagnostics.length === 32
      && JSON.stringify(diagnostics) === JSON.stringify(a05.actualBaseline.fullBaseline.diagnostics), 'A06_OPERATIONAL_DIAGNOSTIC_DRIFT');
    let operationalTransactions = 0, importerFailures = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await importLegacyNormalizationManifest({ ...legacyInput, manifest: preflight, offlineRehearsal: true,
          runTransaction: async () => { operationalTransactions++; throw new Error('A06_OPERATIONAL_RUNNER_REACHED'); } });
      } catch { importerFailures++; }
    }
    requirePrivate(importerFailures === 2 && operationalTransactions === 0, 'A06_IMPORTER_GATE');
    const db = await createPgliteDatabaseHarness();
    try {
      await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
      const input = { tenantId: db.tenantOneId, gridJson, intent: 'OFFLINE_INSPECTION' as const, runTransaction: db.runTenantTransaction };
      let rolledBack = false;
      try {
        await importSchema4CancellationHistory({ ...input, runTransaction: (tenant, callback) => db.runTenantTransaction(tenant, async tx => {
          await callback(tx); throw new Error('A06_INJECTED_ROLLBACK');
        }) });
      } catch (e) { rolledBack = e instanceof Error && e.message === 'A06_INJECTED_ROLLBACK'; }
      const count = async () => (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM schema4_history.captures)
        + (SELECT count(*) FROM schema4_history.source_rows) + (SELECT count(*) FROM schema4_history.reward_groups))::int n`)).rows[0].n;
      requirePrivate(rolledBack && await count() === 0, 'A06_ROLLBACK_RESIDUE');
      const imported = await importSchema4CancellationHistory(input);
      requirePrivate(JSON.stringify(await importSchema4CancellationHistory(input)) === JSON.stringify(imported), 'A06_RETRY_CONFLICT');
      let lostResponse = false;
      try {
        await importSchema4CancellationHistory({ ...input, runTransaction: async (tenant, callback) => {
          await db.runTenantTransaction(tenant, callback); throw new Error('A06_INJECTED_LOST_RESPONSE');
        } });
      } catch (e) { lostResponse = e instanceof Error && e.message === 'A06_INJECTED_LOST_RESPONSE'; }
      requirePrivate(lostResponse && JSON.stringify(await importSchema4CancellationHistory(input)) === JSON.stringify(imported), 'A06_LOST_RESPONSE_RETRY');
      const read = { ...input, sourceDigest: plan.sourceDigest };
      const stored = await readSchema4CancellationHistory(read);
      requirePrivate(JSON.stringify(stored.observation.plan.sources) === JSON.stringify(plan.sources), 'A06_RAW_READBACK');
      requirePrivate(JSON.stringify(stored.cancellationHistory) === JSON.stringify(assessment), 'A06_ASSESSMENT_READBACK');
      const captures = await db.database.query<{ grid_json: string }>('SELECT grid_json FROM schema4_history.captures');
      requirePrivate(captures.rows.length === 1 && captures.rows[0].grid_json === gridJson, 'A06_EXACT_WIRE_READBACK');
      const priorCount = await count();
      for (const pair of assessment.pairs) for (let attempt = 0; attempt < 2; attempt++) {
        const replay = await replaySchema4CancellationHistory({ ...read, originalRow: pair.originalRow, reversalRow: pair.reversalRow });
        requirePrivate(!replay.changed && replay.balanceToApply === 0 && replay.stockToApply === 0
          && replay.currentStateAuthority === 'BLOCKED', 'A06_REPLAY_EFFECT');
      }
      requirePrivate(await count() === priorCount && priorCount === plan.sources.length + plan.groups.length + 1, 'A06_DUPLICATE_ROWS');
      let bridgeCalls = 0, bridgeFailures = 0;
      for (const intent of ['OPERATIONAL_READER', 'OPERATIONAL_IMPORT'] as const) {
        const blocked = { ...read, intent, runTransaction: async () => { bridgeCalls++; throw new Error('A06_BRIDGE_RUNNER_REACHED'); } };
        for (const call of [() => importSchema4CancellationHistory(blocked), () => readSchema4CancellationHistory(blocked),
          () => replaySchema4CancellationHistory({ ...blocked, originalRow: 3, reversalRow: 5 })]) {
          try { await call(); } catch (e) { if (e instanceof Error && e.message === 'SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED') bridgeFailures++; }
        }
      }
      requirePrivate(bridgeCalls === 0 && bridgeFailures === 6, 'A06_BRIDGE_GATE');
      const modern = await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
        + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM inventory_ledger) + (SELECT count(*) FROM task_completions))::int n`);
      requirePrivate(modern.rows[0].n === 0, 'A06_MODERN_ROWS');
      // Coordinates/codes/booleans only; no IDs, names, timestamps or numeric grid values.
      console.info(JSON.stringify({ kind: 'A06_R1_PRIVATE_RESULT', manifestSha256: sha(manifestWire), sourceDigest: plan.sourceDigest,
        authority: assessment.authority, rows: assessment.rows, pairs: assessment.pairs.map(p => ({ originalRow: p.originalRow,
          reversalRow: p.reversalRow, stockAuthority: p.stockAuthority })), operationalBridge: assessment.operationalBridge,
        rawReadbackExact: true, wireReadbackExact: true, sheetsReaderLinksMatch: true, rollbackEmpty: true,
        lostResponseRetryExact: true, replayNoEffect: true, retryNoDuplicates: true,
        rawRowsPreserved: plan.sources.length, businessTabs: Object.keys(tabs).length,
        operationalTransactions, importerFailures, bridgeCalls, bridgeFailures, modernRows: modern.rows[0].n,
        preflight: preflight.status, diagnostics, diagnosticsSha256: sha(JSON.stringify(diagnostics)) }));
    } finally { await db.close(); }
  } catch (error) {
    const code = error instanceof Error && /^A06_[A-Z_]+$/.test(error.message) ? error.message : 'A06_UNEXPECTED_PRIVATE_FAILURE';
    throw new Error(code);
  }
});
