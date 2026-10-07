import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { captureOfflineGoogleGridBaseline } from '@/server/migration/sheetsSnapshot';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { normalizeSchema4BankHistory, importSchema4BankHistory, replaySchema4BankReward } from '@/server/migration/schema4BankHistory';
import { inspectSchema4AdminHistory, readSchema4AdminHistory } from '@/server/migration/schema4AdminHistoryBridge';
import { projectTaskCycleStateFromSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
import { createHeaderIndex, parseTaskRow } from '@/server/sheetsRows';
vi.mock('server-only', () => ({}));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Boolean-only assertions ensure assertion diffs never serialize captured values.
function requirePrivate(value: boolean, code: string): asserts value { if (!value) throw new Error(code); }

it.skipIf(process.env.A05_PRIVATE !== '1')('fixed capture: writer-consistent reset remains unproven; raw PG history only, operational gates still closed', async () => {
  try {
  requirePrivate(process.env.A05_PRIVATE === '1', 'A05_PRIVATE_SANDBOX_REQUIRED');
  const manifestWire = readFileSync('/private/manifest.json', 'utf8');
  requirePrivate(sha(manifestWire) === 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961', 'A05_MANIFEST_PIN');
  const manifest = JSON.parse(manifestWire);
  const gridJson = readFileSync('/private/grid.json', 'utf8');
  requirePrivate(manifest.gridReadHashes.length === 2 && manifest.gridReadHashes.every((hash: string) => hash === sha(gridJson)), 'A05_GRID_PIN');
  const a04 = JSON.parse(readFileSync('/private/a04.json', 'utf8'));
  const plan = normalizeSchema4BankHistory(gridJson), assessment = inspectSchema4AdminHistory(gridJson);
  const reset = assessment.resets[0];
  requirePrivate(assessment.resets.length === 2 && reset.rowNumber === 5
    && reset.consistency === 'SINGLE_BANK_RESET_WRITER_MATCH' && Object.values(reset.facts).every(Boolean), 'A05_RESET_WRITER_FACTS');
  requirePrivate(reset.authority === 'UNPROVEN_ADMIN_RESET_OPERATION'
    && JSON.stringify(reset.diagnosticCodes) === JSON.stringify(['MISSING_ADMIN_OPERATION_PROVENANCE']), 'A05_AUTHORITY_NOT_PROMOTED');
  requirePrivate(plan.groups.length === 1 && plan.groups[0].checkpointRows.join(',') === '2,3,4'
    && reset.anchor?.assignmentRow === 2 && reset.anchor?.transactionRow === 2, 'A05_ANCHOR_COORDINATES');
  requirePrivate(assessment.resets[1].rowNumber === 7 && assessment.resets[1].consistency === 'UNPROVEN', 'A05_OTHER_RESET_PRESERVED');
  const snapshot = await captureOfflineGoogleGridBaseline({ gridJson, capturedAt: manifest.capturedAt });
  const legacyInput = { tenantId: '00000000-0000-4000-8000-000000000005',
    migrationJobId: '20000000-0000-4000-8000-000000000005', sheets: snapshot };
  const preflight = createLegacyNormalizationManifest(legacyInput);
  const issues = preflight.blockingConflicts.map(({ code, path }) => ({ code, path }));
  requirePrivate(preflight.metadata.sheetSchemaVersion === 4 && preflight.status === 'BLOCKED', 'A05_PREFLIGHT_NOT_BLOCKED');
  requirePrivate(issues.length === 32 && JSON.stringify(issues) === JSON.stringify(a04.actualBaseline.fullBaseline.diagnostics), 'A05_BASELINE_DIAGNOSTICS_DRIFT');
  let operationalTransactions = 0;
  let importerFailures = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await importLegacyNormalizationManifest({ ...legacyInput, manifest: preflight, offlineRehearsal: true,
        runTransaction: async () => { operationalTransactions++; throw new Error('A05_OPERATIONAL_RUNNER_REACHED'); } });
    } catch { importerFailures++; }
  }
  requirePrivate(importerFailures === 2, 'A05_IMPORTER_UNEXPECTED_ACCEPTANCE');
  requirePrivate(operationalTransactions === 0, 'A05_OPERATIONAL_TRANSACTION_OPENED');
  const db = await createPgliteDatabaseHarness();
  try {
    await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
    const input = { tenantId: db.tenantOneId, gridJson, runTransaction: db.runTenantTransaction };
    const imported = await importSchema4BankHistory(input);
    requirePrivate(JSON.stringify(await importSchema4BankHistory(input)) === JSON.stringify(imported), 'A05_RETRY_DIFFERENT');
    const read = { tenantId: db.tenantOneId, sourceDigest: plan.sourceDigest, runTransaction: db.runTenantTransaction,
      intent: 'OFFLINE_INSPECTION' as const };
    const stored = await readSchema4AdminHistory(read);
    requirePrivate(JSON.stringify(stored.adminHistory) === JSON.stringify(assessment), 'A05_READBACK_ASSESSMENT');
    requirePrivate(JSON.stringify(stored.observation.plan.sources) === JSON.stringify(plan.sources), 'A05_RAW_ROWS_DRIFT');
    const storedCounts = await db.database.query<{ n: number }>('SELECT count(*)::int n FROM schema4_history.source_rows');
    requirePrivate(storedCounts.rows[0].n === plan.sources.length, 'A05_RAW_ROWS_COUNT');
    const ledger = await db.database.query<{ n: number }>('SELECT count(*)::int n FROM schema4_history.reward_ledger');
    requirePrivate(ledger.rows[0].n === 1, 'A05_LEDGER_COUNT');
    const completion = stored.observation.snapshot.completions.find(e => e.source === 'ADMIN_RESET');
    requirePrivate(Boolean(completion), 'A05_RESET_NOT_READ');
    const taskRows = plan.sources.filter(row => row.tab === 'Tasks');
    const headers = taskRows.find(row => row.rowNumber === 1)!.cells;
    const task = taskRows.filter(row => row.rowNumber > 1).map(row => parseTaskRow(row.cells, createHeaderIndex(headers)))
      .find(row => row?.taskId === completion!.taskId);
    requirePrivate(Boolean(task), 'A05_TASK_NOT_READ');
    const state = projectTaskCycleStateFromSnapshot(task!, manifest.capturedAt, stored.observation.snapshot);
    requirePrivate(state.students[completion!.studentId]?.completed === false
      && state.students[completion!.studentId]?.assigned === true, 'A05_OBSERVED_CURRENT_STATE');
    const bank = plan.groups[0];
    requirePrivate(replaySchema4BankReward(stored.observation.plan, bank.operationId, bank.operationPayloadHash).rewardToApply === 0, 'A05_REPLAY_REWARD_NONZERO');
    let bridgeCalls = 0;
    for (const intent of ['OPERATIONAL_READER', 'OPERATIONAL_IMPORT'] as const) {
      try {
        await readSchema4AdminHistory({ ...read, intent, runTransaction: async () => { bridgeCalls++; throw new Error('A05_BRIDGE_RUNNER_REACHED'); } });
        throw new Error('A05_BRIDGE_ACCEPTED');
      } catch (e) { requirePrivate(e instanceof Error && e.message === 'SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED', 'A05_BRIDGE_FAILURE_CLASS'); }
    }
    requirePrivate(bridgeCalls === 0, 'A05_BRIDGE_CALLS');
    const modern = await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
      + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM task_completions))::int n`);
    requirePrivate(modern.rows[0].n === 0, 'A05_MODERN_ROWS_CREATED');
    console.info(JSON.stringify({ kind: 'A05_PRIVATE_RESULT', sourceDigest: plan.sourceDigest,
      manifestSha256: sha(manifestWire), businessTabs: new Set(plan.sources.map(row => row.tab)).size,
      originalRawRowsPreserved: plan.sources.length, checkpointRows: bank.checkpointRows,
      resetRow: reset.rowNumber, assignmentRow: reset.anchor!.assignmentRow, transactionRow: reset.anchor!.transactionRow,
      resetConsistency: reset.consistency, resetFacts: reset.facts, resetAuthority: reset.authority,
      rawReadbackExact: true, replayRewardToApply: 0, logicalRewards: 1, observedCompleted: false,
      operationalBridge: assessment.operationalBridge, operationalTransactions, operationalBridgeCalls: bridgeCalls,
      operationalIssues: issues.length, issuesSha256: sha(JSON.stringify(issues)), importerAttempts: 2, importerFailures,
      preflight: preflight.status, modernRows: modern.rows[0].n, authority: 'OFFLINE_NONAUTHORITY' }));
  } finally { await db.close(); }
  expect(operationalTransactions).toBe(0);
  } catch (error) {
    // A failed parser/SQL statement must not leak a captured row via Vitest.
    const code = error instanceof Error && /^A05_[A-Z_]+$/.test(error.message)
      ? error.message : 'A05_UNEXPECTED_PRIVATE_FAILURE';
    throw new Error(code);
  }
});
