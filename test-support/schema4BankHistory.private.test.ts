// Opt-in only. No private values are fixtures, assertions, errors or reports.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { captureOfflineGoogleGridBaseline } from '@/server/migration/sheetsSnapshot';
import { readOfflineGoogleGrid } from '@/server/migration/offlineGoogleGrid';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from '@/server/migration/importer';
import { canonicalJson } from '@/server/migration/validators';
import { normalizeSchema4BankHistory, importSchema4BankHistory, readSchema4BankHistory, replaySchema4BankReward } from '@/server/migration/schema4BankHistory';
import { createHeaderIndex, parseTaskRow } from '@/server/sheetsRows';
import { loadTaskCycleLedgerSnapshot, projectTaskCycleStateFromSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
vi.mock('server-only', () => ({}));

it.skipIf(process.env.A04_PRIVATE !== '1')('actual fixed schema4 baseline: immutable PG history, one ledger, observed reset, full import still BLOCKED', async () => {
  let step = 'input_hashes';
  const receipt: Record<string, unknown> = {};
  const check = (condition: boolean) => { if (!condition) throw new Error('PRIVATE_ASSERTION'); };
  const sha = (wire: string | Buffer) => createHash('sha256').update(wire).digest('hex');
  try {
    const manifestBytes = readFileSync('/private/manifest.json');
    check(sha(manifestBytes) === 'a3317f315c60124f77af6a42813bdc012700debc9fc715ea8e20a0865df93961');
    const source = JSON.parse(manifestBytes.toString());
    const a03 = JSON.parse(readFileSync('/private/a03.json', 'utf8'));
    const wire = readFileSync('/private/grid.json', 'utf8');
    check(sha(wire) === source.gridReadHashes[0]);
    const { tabs } = readOfflineGoogleGrid(wire);
    check(Object.keys(tabs).length === 10 && !Object.hasOwn(tabs, 'Recovery'));
    const original = await loadTaskCycleLedgerSnapshot({ getRows: async name => tabs[name] });
    step = 'group_normalization';
    const plan = normalizeSchema4BankHistory(wire);
    check(plan.groups.length === 1 && !plan.diagnostics.some(row => row.code.startsWith('BANK_')));
    const group = plan.groups[0];
    check(canonicalJson(group.checkpointRows) === '[2,3,4]' && group.assignmentRow === 2 && canonicalJson(group.laterResetRows) === '[5]');
    const pending = original.completions[0], reset = original.completions[3];
    check(reset.source === 'ADMIN_RESET' && reset.timestamp === pending.timestamp && reset.operationId !== pending.operationId
      && reset.assignmentId === pending.assignmentId && reset.reward === 0 && reset.balanceBefore === reset.balanceAfter);
    const snapshot = await captureOfflineGoogleGridBaseline({ gridJson: wire, capturedAt: source.capturedAt });
    const db = await createPgliteDatabaseHarness();
    try {
      await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
      const legacyInput = { tenantId: db.tenantOneId, migrationJobId: '20000000-0000-4000-8000-000000000001', sheets: snapshot };
      const manifest = createLegacyNormalizationManifest(legacyInput);
      const diagnostics = manifest.blockingConflicts.map(({ code, path }) => ({ code, path }));
      check(manifest.status === 'BLOCKED' && identical(diagnostics, a03.actualBaseline.diagnostics));
      receipt.fullBaseline = { status: 'BLOCKED', diagnostics, a03DiagnosticsUnchanged: true };
      step = 'rollback';
      const base = { tenantId: db.tenantOneId, gridJson: wire, runTransaction: db.runTenantTransaction };
      let failed = false;
      try {
        await importSchema4BankHistory({ ...base, runTransaction: (tenant, callback) => db.runTenantTransaction(tenant, async tx => {
          await callback(tx); throw new Error('A04_INJECTED_ROLLBACK');
        }) });
      } catch { failed = true; }
      check(failed);
      const afterFailure = await db.database.query<{ n: number }>('SELECT count(*)::int n FROM schema4_history.captures');
      check(afterFailure.rows[0].n === 0);
      step = 'import_reconcile_retry';
      const first = await importSchema4BankHistory(base), second = await importSchema4BankHistory(base);
      check(identical(first, second));
      const stored = await readSchema4BankHistory({ ...base, sourceDigest: plan.sourceDigest });
      check(identical(stored.plan, plan) && identical(stored.snapshot, original));
      const ledger = await db.database.query<{ signed_total: string; balance_delta: string }>('SELECT signed_total,balance_delta FROM schema4_history.reward_ledger');
      check(ledger.rows.length === 1 && Number(ledger.rows[0].signed_total) === group.signedTotal && Number(ledger.rows[0].balance_delta) === group.reward);
      step = 'reader_meaning_and_replay';
      const task = tabs.Tasks.slice(1).map(row => parseTaskRow(row, createHeaderIndex(tabs.Tasks[0])))
        .find(task => task?.taskInstanceId === pending.taskInstanceId);
      check(Boolean(task));
      if (!task) throw new Error('PRIVATE_PARENT_MISSING');
      const sourceState = projectTaskCycleStateFromSnapshot(task, source.capturedAt, original);
      const pgState = projectTaskCycleStateFromSnapshot(task, source.capturedAt, stored.snapshot);
      check(identical(sourceState, pgState) && pgState.students[pending.studentId].assigned && !pgState.students[pending.studentId].completed);
      for (let attempt = 0; attempt < 2; attempt++) {
        const replay = replaySchema4BankReward(stored.plan, group.operationId, group.operationPayloadHash);
        check(!replay.changed && replay.rewardToApply === 0 && replay.currentStateAuthority === 'BLOCKED');
      }
      let mismatchRejected = false;
      try { replaySchema4BankReward(stored.plan, group.operationId, `sha256:${'0'.repeat(64)}`); } catch { mismatchRejected = true; }
      check(mismatchRejected);
      step = 'immutable_provenance';
      let immutableRejected = false;
      try { await db.database.exec("UPDATE schema4_history.source_rows SET row_digest=repeat('0',64) WHERE tab='TaskCompletions' AND row_number=2"); } catch { immutableRejected = true; }
      check(immutableRejected);
      check(identical((await readSchema4BankHistory({ ...base, sourceDigest: plan.sourceDigest })).snapshot, original));
      step = 'full_import_still_blocked';
      let transactionCalls = 0, failures = 0;
      const runTransaction: TenantImportTransactionRunner = (tenant, callback) => { transactionCalls++; return db.runTenantTransaction(tenant, callback); };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await importLegacyNormalizationManifest({ ...legacyInput, manifest, runTransaction, offlineRehearsal: true }); }
        catch { failures++; }
      }
      check(failures === 2 && transactionCalls === 0);
      const counts = (await db.database.query<{ operations: number; completions: number; accounts: number; transactions: number; products: number }>(`SELECT
        (SELECT count(*)::int FROM operations) operations, (SELECT count(*)::int FROM task_completions) completions,
        (SELECT count(*)::int FROM accounts) accounts, (SELECT count(*)::int FROM transactions) transactions,
        (SELECT count(*)::int FROM products) products`)).rows[0];
      check(Object.values(counts).every(n => n === 0));
      check(identical(createLegacyNormalizationManifest(legacyInput), manifest));
      check(sha(readFileSync('/private/grid.json')) === plan.sourceDigest);
      Object.assign(receipt, {
        inputManifestSha256: sha(manifestBytes), inputGridSha256: sha(wire), tabCount: 10,
        engine: 'PGlite / embedded PostgreSQL; NOT external PostgreSQL server',
        historicalBankProjection: { status: 'PASS_ISOLATED_DEVELOPMENT_ONLY', checkpointRows: group.checkpointRows,
          assignmentRow: group.assignmentRow, transactionRow: group.transactionRow, laterResetRows: group.laterResetRows,
          originalRowsStored: plan.sources.length, importedRewardGroups: first.rewardLedgers, immutableCheckpoints: 3,
          signedLedgerProjectionCount: 1, rollbackVerified: true, importAttemptsAfterRollback: 2, retryReadbackIdentical: true,
          currentAssigned: true, currentCompleted: false, readerSnapshotExactMatch: true, replayAttempts: 2, replayRewardToApply: 0,
          payloadMismatchRejected: true, immutableMutationRejected: true, originalGridUnchanged: true,
          authority: 'OFFLINE_NONAUTHORITY', operationalPublication: 'BLOCKED', currentStateAuthority: 'BLOCKED' },
        historicalDiagnostics: plan.diagnostics,
        fullImporter: { status: 'BLOCKED', attempts: 2, failures, transactionCalls },
        operationalRowCounts: counts, redisClaims: 'UNCONFIRMED', formalFreeze: 'NOT_PROVEN_DRIVE_REVISION_403',
      });
    } finally { await db.close(); }
  } catch {
    // Never stringify database/source exceptions: query parameters can be private.
    writeFileSync('.runner-v2-reports/private-observation.json', JSON.stringify({ status: 'FAILED', step }), { mode: 0o600 });
    throw new Error(`Private A-04 verification failed at ${step}; no source values logged.`);
  }
  writeFileSync('.runner-v2-reports/private-observation.json', JSON.stringify(receipt, null, 2), { mode: 0o600 });
});
function identical(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
