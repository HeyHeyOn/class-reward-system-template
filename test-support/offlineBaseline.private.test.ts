// Opt-in, read-only private capture: this file contains no business values.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import { captureOfflineGoogleGridBaseline } from '../src/server/migration/sheetsSnapshot';
import { readOfflineGoogleGrid } from '../src/server/migration/offlineGoogleGrid';
import { createLegacyNormalizationManifest } from '../src/server/migration/manifest';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from '../src/server/migration/importer';
import { createPgliteDatabaseHarness } from '../src/server/db/testing/pglite';
import { canonicalJson } from '../src/server/migration/validators';
import { createHeaderIndex, parseTaskRow, parseStudentRow } from '../src/server/sheetsRows';
import { readTaskCycleState, readTaskCompletions } from '../src/server/repositories/sheets/taskCycleQueries';
import { mutateTaskCompletionNow } from '../src/server/repositories/sheets/taskCompletionCommands';
import type { RecurringSchemaMigrationStore } from '../src/server/storage/tabularStore';
vi.mock('server-only', () => ({}));


it.skipIf(!process.env.A03_CAPTURE)('private fixed baseline current boundary (no business data logging)', async () => {
  const root = process.env.A03_CAPTURE!;
  const manifestBytes = readFileSync(`${root}/manifest.json`);
  const source = JSON.parse(manifestBytes.toString());
  const bytes = readFileSync(`${root}/sheets-grid-1.json`);
  const sha = (wire: Buffer) => createHash('sha256').update(wire).digest('hex');
  expect(sha(bytes)).toBe(source.gridReadHashes[0]);
  expect(sha(readFileSync(`${root}/sheets-grid-2.json`))).toBe(sha(bytes));
  const { tabs } = readOfflineGoogleGrid(bytes.toString());
  const settings = Object.fromEntries(tabs.Settings.slice(1).map(row => [row[0], row[1]]));
  const completionHeader = tabs.TaskCompletions[0];
  const bank = tabs.TaskCompletions.slice(1).filter(row => row[completionHeader.indexOf('source')] === 'BANK');
  const receipt: Record<string, unknown> = { observedAt: new Date().toISOString(), inputManifestSha256: sha(manifestBytes),
    inputGridSha256: sha(bytes), tabCount: Object.keys(tabs).length, schemaVersion: settings.schemaVersion,
    systemVersion: settings.systemVersion, bankCount: bank.length,
    gridRows: Object.fromEntries(Object.entries(tabs).map(([name, rows]) => [name, rows.length])),
    businessRows: Object.fromEntries(Object.entries(tabs).map(([name, rows]) => [name, rows.slice(1).filter(row => row.some(Boolean)).length])),
    scope: 'ALL_BUSINESS_SHEETS_CURRENT_GRID_READ_ONLY_REHEARSAL_BASELINE', redisClaims: 'UNCONFIRMED' };
  try {
    const snapshot = await captureOfflineGoogleGridBaseline({ gridJson: bytes.toString(), capturedAt: source.capturedAt });
    const db = await createPgliteDatabaseHarness({ migrationSet: 'base' });
    try {
    for (const name of readdirSync('src/server/db/migrations').filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) {
      await db.database.exec(readFileSync(`src/server/db/migrations/${name}`, 'utf8'));
    }
    const input = { tenantId: db.tenantOneId, migrationJobId: '20000000-0000-4000-8000-000000000001', sheets: snapshot };
    const normalized = createLegacyNormalizationManifest(input);
    receipt.status = normalized.status;
    receipt.diagnostics = normalized.blockingConflicts.map(({ code, path }) => ({ code, path }));
    receipt.canonicalBankCount = normalized.sourceRecords.filter(row => row.canonicalRecord?.source === 'BANK').length;
    expect(receipt.canonicalBankCount).toBe(3);
    expect(normalized.status).toBe('BLOCKED');
    expect(canonicalJson(createLegacyNormalizationManifest(input)) === canonicalJson(normalized)).toBe(true);
    const records = (name: string) => tabs[name].slice(1).map((row, i) => ({ rowNumber: i + 2, fields: Object.fromEntries(tabs[name][0].map((key, j) => [key, row[j] ?? ''])) }));
    const events = records('TaskCompletions').filter(row => row.fields.source === 'BANK');
    const assignments = records('TaskAssignments'), transactions = records('Transactions');
    receipt.bankAssessment = events.map(({ rowNumber, fields: event }) => {
      const assignment = assignments.filter(row => row.fields.assignmentId === event.assignmentId);
      const ledgerId = `TASK-LOGICAL-${encodeURIComponent(event.completionId.replace(/-(PENDING|BALANCE_APPLIED|SUCCESS)$/, ''))}`;
      const ledger = transactions.filter(row => row.fields.transactionId === ledgerId);
      const tx = ledger[0]?.fields;
      const item = tx ? JSON.parse(tx.items)[0] : undefined;
      const before = Number(event.balanceBefore), after = Number(event.balanceAfter), reward = Number(event.reward);
      const result = { rowNumber, status: event.status, completionSchemaVersion: event.schemaVersion,
        completeAmountEquation: Number.isSafeInteger(reward) && after - before === reward,
        assignmentMatches: assignment.length,
        assignmentTupleMatches: assignment.length === 1 && ['taskId', 'taskInstanceId', 'studentId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone'].every(key => assignment[0].fields[key] === event[key]),
        ledgerMatches: ledger.length,
        signedLedgerMatches: ledger.length === 1 && tx.status === 'TASK_REWARD' && tx.studentId === event.studentId
          && Number(tx.totalAmount) === -reward && Number(tx.balanceBefore) === before && Number(tx.balanceAfter) === after
          && item?.productId === event.taskId && item?.price === -reward && item?.quantity === 1 && item?.subtotal === -reward,
        cancellationReversalMatches: transactions.filter(row => row.fields.status === 'CANCEL_REVERSAL' && row.fields.operator.includes(ledgerId)).length,
        retainedCanonical: normalized.sourceRecords.some(row => row.source.kind === 'SHEET' && row.source.tab === 'TaskCompletions' && row.source.rowNumber === rowNumber && row.canonicalRecord?.source === 'BANK'),
        result: 'PRESERVED_QUARANTINE_REQUIRES_HISTORICAL_EVENT_PROVENANCE', claims: 'UNCONFIRMED' };
      expect(result.completeAmountEquation && result.assignmentTupleMatches && result.signedLedgerMatches && result.retainedCanonical).toBe(true);
      return result;
    });
    receipt.bankDistinctCompletionIds = new Set(events.map(row => row.fields.completionId)).size;
    receipt.bankDistinctOperationIds = new Set(events.map(row => row.fields.operationId)).size;
    receipt.bankDistinctPayloadHashes = new Set(events.map(row => row.fields.operationPayloadHash)).size;
    // Exercise the existing reader and idempotent command against this exact
    // journal, in memory only. Any attempt to write fails closed.
    const denied = vi.fn(async (): Promise<never> => { throw new Error('PRIVATE_REPLAY_WRITE_DENIED'); });
    const reader: RecurringSchemaMigrationStore = {
      getRows: async name => tabs[name], getRowsFresh: async name => tabs[name],
      updateCell: denied, appendRow: denied, lookupSheet: denied, createSheetWithHeader: denied,
      ensureColumnCount: denied, writeHeaderCells: denied, verifyHeaderCells: denied, verifyAndWriteHeaderCells: denied,
    };
    const parsed = await readTaskCompletions(reader);
    const success = parsed.find(row => row.source === 'BANK' && row.status === 'SUCCESS');
    const taskRecords = tabs.Tasks.slice(1).map(row => parseTaskRow(row, createHeaderIndex(tabs.Tasks[0])));
    const studentRecords = tabs.Students.slice(1).map(row => parseStudentRow(row, createHeaderIndex(tabs.Students[0])));
    const taskIndex = taskRecords.findIndex(row => row?.taskId === success?.taskId);
    const studentIndex = studentRecords.findIndex(row => row?.studentId === success?.studentId);
    const task = taskRecords[taskIndex], student = studentRecords[studentIndex];
    if (!success || !task || !student) throw new Error('PRIVATE_REPLAY_PARENT_MISSING');
    const atCapture = await readTaskCycleState(reader, task, source.capturedAt);
    const replay = { store: reader, task, student, taskRowNumber: taskIndex + 2, studentRowNumber: studentIndex + 2,
      source: 'BANK' as const, completed: true, schemaReady: true, now: source.capturedAt,
      operationId: success.operationId, operationPayloadHash: success.operationPayloadHash };
    const firstReplay = await mutateTaskCompletionNow(replay);
    const secondReplay = await mutateTaskCompletionNow(replay);
    expect(firstReplay.changed).toBe(false);
    expect(canonicalJson(firstReplay) === canonicalJson(secondReplay)).toBe(true);
    expect(denied).not.toHaveBeenCalled();
    expect(firstReplay.completion?.completionId === success.completionId).toBe(true);
    receipt.existingSheetsReader = { bankEvents: parsed.filter(row => row.source === 'BANK').length,
      currentAssigned: atCapture.students[student.studentId]?.assigned ?? false,
      currentCompleted: atCapture.students[student.studentId]?.completed ?? false,
      sameOperationReplayAttempts: 2, replayChanged: false, writeCalls: denied.mock.calls.length,
      pgReaderCompatibility: 'NOT_IMPLEMENTED_LEGACY_BANK_GROUP_PROVENANCE_REQUIRED' };
    receipt.bankContractDifference = {
      history: 'Three distinct event IDs share one operation/hash; PENDING -> BALANCE_APPLIED -> SUCCESS is one reward, not three rewards.',
      database: 'task_completions_operation_unique allows one row per operation; database reader requires COMPLETED and UUID operation metadata.',
      requiredChange: 'Immutable historical event-group provenance with original event IDs/statuses and one linked ledger; separate PG reader/reward-dedup projection, never fabricated modern operations.',
    };
    receipt.signedRewardLedgerCanonical = normalized.sourceRecords.filter(row => row.source.kind === 'SHEET' && row.source.tab === 'Transactions' && row.canonicalRecord?.status === 'TASK_REWARD').length;
    expect(receipt.signedRewardLedgerCanonical).toBe(1);
    let calls = 0;
    const runTransaction: TenantImportTransactionRunner = (tenant, callback) => { calls++; return db.runTenantTransaction(tenant, callback); };
    const counts = async () => (await db.database.query("SELECT (SELECT count(*) FROM transactions)::int AS transactions, (SELECT count(*) FROM accounts)::int AS accounts, (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM task_completions)::int AS completions, (SELECT count(*) FROM operations)::int AS operations, (SELECT count(*) FROM migration_snapshots)::int AS snapshots")).rows;
    const before = canonicalJson(await counts());
    const errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await importLegacyNormalizationManifest({ ...input, manifest: normalized, runTransaction, offlineRehearsal: true }); }
      catch (error) { errors.push(error instanceof Error ? error.message : 'Unknown import failure'); }
    }
    expect(errors.length).toBe(2); expect(errors[0] === errors[1]).toBe(true);
    expect(calls).toBe(0); expect(canonicalJson(await counts()) === before).toBe(true);
    expect(sha(readFileSync(`${root}/sheets-grid-1.json`)) === sha(bytes)).toBe(true);
    receipt.importer = { attempts: 2, errors, transactionCalls: calls, databaseUnchanged: true, sourceUnchanged: true };
    receipt.retryManifestIdentical = true;
    } finally { await db.close(); }
  } catch (error) {
    receipt.boundaryFailure = error instanceof Error ? error.message : 'Unknown boundary failure';
    writeFileSync(process.env.A03_RESULT!, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    throw new Error('Private baseline verification failed; see private result.');
  }
  writeFileSync(process.env.A03_RESULT!, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  expect(receipt.tabCount).toBe(10); expect(receipt.schemaVersion).toBe('4'); expect(receipt.bankCount).toBe(3);
});
