import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { parseLegacyTaskHistory } from './legacyTaskHistory';
import { parseLegacyFullSnapshot } from './legacyFullSnapshot';
vi.mock('server-only', () => ({}));
import { taskHistoryFixture, taskHistoryGrid, taskHistoryCarryFixture } from '../../../test-support/legacyTaskFixture';
describe('source-bound task history normalization', () => {
  it('retains all checkpoints but projects one reward and the later reset without a modern operation', () => {
    const plan = parseLegacyTaskHistory(taskHistoryGrid());
    expect(plan.assignments).toHaveLength(1); expect(plan.completions).toHaveLength(2);
    expect(plan.completions.map(e => e.event.status)).toEqual(['SUCCESS', 'RESET']);
    expect(plan.completions[0].sources).toHaveLength(3);
    expect(plan.completions[0].transactionId).toBe('TASK-LOGICAL-C1');
    expect(plan.completions[0].event).not.toHaveProperty('operationId');
    expect(plan.completions[0].sources[0].cells).toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });
  it.each(['checkpoint', 'assignment', 'reset-reward', 'duplicate', 'mirror'])('rejects inconsistent %s history', kind => {
    const tabs = taskHistoryFixture();
    if (kind === 'checkpoint') tabs.TaskCompletions.splice(2, 1);
    if (kind === 'assignment') tabs.TaskCompletions[3][17] = 'missing';
    if (kind === 'reset-reward') tabs.TaskCompletions[4][5] = '20';
    if (kind === 'duplicate') tabs.TaskCompletions[4][0] = 'C1-SUCCESS';
    if (kind === 'mirror') tabs.Tasks[1][8] = '';
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow(/LEGACY_TASK_/);
  });
  it('reads the deployed legacy task header while retaining the original column positions', () => {
    const tabs = taskHistoryFixture();
    tabs.Tasks[0].splice(4, 0, 'maxCompletionsPerStudent'); tabs.Tasks[1].splice(4, 0, '1');
    const plan = parseLegacyTaskHistory(taskHistoryGrid(tabs));
    expect(plan.tasks[0]).toMatchObject({ taskId: 'T1', taskInstanceId: 'I1', reward: 20, isActive: true });
    expect(plan.completions).toHaveLength(2);
    expect(plan.assignments[0].sources[0].cells).toEqual(tabs.TaskAssignments[1]);
  });
  it('imports an older single-row BANK reward without inventing a request ID or checkpoints', () => {
    const tabs = taskHistoryFixture(); tabs.Settings[1][1] = '1';
    tabs.Transactions[0][4] = 'itemsJson'; tabs.Transactions[1][0] = 'TASK-C1';
    const event = [...tabs.TaskCompletions[3]];
    for (const [key, value] of Object.entries({ completionId: 'C1', operationId: '', operationPayloadHash: '' })) {
      event[tabs.TaskCompletions[0].indexOf(key)] = value;
    }
    tabs.TaskCompletions = [tabs.TaskCompletions[0], event, tabs.TaskCompletions[4]];
    const plan = parseLegacyTaskHistory(taskHistoryGrid(tabs));
    expect(plan.completions[0]).toMatchObject({ transactionId: 'TASK-C1', event: { completionId: 'C1', status: 'SUCCESS' } });
    expect(plan.completions[0].sources).toHaveLength(1);
    expect(plan.completions[0]).not.toHaveProperty('historicalOperation');
    expect(plan.completions[0].sources[0].cells).toEqual(event);
  });
  it('recognizes a checkpoint reward against its recorded ADMIN assignment', () => {
    const tabs = taskHistoryFixture();
    tabs.TaskAssignments[1][tabs.TaskAssignments[0].indexOf('source')] = 'ADMIN';
    const plan = parseLegacyTaskHistory(taskHistoryGrid(tabs));
    expect(plan.assignments[0].event.source).toBe('ADMIN');
    expect(plan.completions[0].transactionId).toBe('TASK-LOGICAL-C1');
    expect(plan.completions[0].historicalOperation?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });
  it('rejects a single-row BANK reward with no exact historical ledger identity', () => {
    const tabs = taskHistoryFixture(), event = [...tabs.TaskCompletions[3]];
    event[tabs.TaskCompletions[0].indexOf('operationId')] = '';
    event[tabs.TaskCompletions[0].indexOf('operationPayloadHash')] = '';
    tabs.TaskCompletions = [tabs.TaskCompletions[0], event];
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow('LEGACY_TASK_BANK_CHECKPOINTS');
  });
  it.each([true, false])('preserves a schedule-boundary carry with assigned=%s and its exact predecessor', assigned => {
    const tabs = taskHistoryCarryFixture(assigned), plan = parseLegacyTaskHistory(taskHistoryGrid(tabs));
    expect(plan.tasks[0].pendingSchedule?.ruleVersion).toBe(2);
    expect(plan.assignments.at(-1)?.event).toMatchObject({ assignmentId: 'CARRY1', source: 'CARRY_FORWARD',
      status: assigned ? 'ASSIGNED' : 'UNASSIGNED', previousAssignmentId: assigned ? 'A1' : 'A2' });
    expect(plan.assignments.at(-1)?.sources[0].cells).toEqual(tabs.TaskAssignments.at(-1));
  });
  it('rejects a carry whose recorded status differs from its predecessor', () => {
    const tabs = taskHistoryCarryFixture(false);
    tabs.TaskAssignments.at(-1)![tabs.TaskAssignments[0].indexOf('status')] = 'ASSIGNED';
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow('LEGACY_TASK_CARRY_ASSIGNMENT');
  });
  it('keeps older schedule snapshots and absent historical instances without recreating active definitions', () => {
    const tabs = taskHistoryFixture();
    const set = (h: string[], r: string[], k: string, v: string) => { r[h.indexOf(k)] = v; };
    set(tabs.Tasks[0], tabs.Tasks[1], 'ruleVersion', '3');
    set(tabs.Tasks[0], tabs.Tasks[1], 'scheduleEffectiveFrom', '2026-09-03T00:00:00.000Z');
    set(tabs.Tasks[0], tabs.Tasks[1], 'updatedAt', '2026-09-03T00:00:00.000Z');
    const archived = [...tabs.TaskAssignments[1]];
    for (const [key, value] of Object.entries({ assignmentId: 'OLD-A', taskId: 'DELETED-T', taskInstanceId: 'OLD-I',
      cycleId: archived[tabs.TaskAssignments[0].indexOf('cycleId')].replace('|I1|', '|OLD-I|') })) set(tabs.TaskAssignments[0], archived, key, value);
    tabs.TaskAssignments.push(archived);
    const plan = parseLegacyTaskHistory(taskHistoryGrid(tabs));
    expect(plan.tasks).toHaveLength(1); expect(plan.tasks[0].schedule?.ruleVersion).toBe(3);
    expect(plan.assignments[0].event.ruleVersion).toBe(1);
    expect(plan.archivedTaskIdentities).toEqual([{ taskId: 'DELETED-T', taskInstanceId: 'OLD-I',
      firstObservedAt: '2026-09-01T00:00:00.000Z', lastObservedAt: '2026-09-01T00:00:00.000Z' }]);
    set(tabs.TaskAssignments[0], archived, 'cycleId', 'v1|wrong-instance|r1|2026-09-01T00:00:00Z');
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow('LEGACY_TASK_CYCLE_SNAPSHOT');
  });
  it('preserves an unversioned administrator outcome with a reward snapshot but no paid reward', () => {
    const tabs = taskHistoryFixture(), h = tabs.TaskCompletions[0], event = [...tabs.TaskCompletions[3]];
    for (const key of h.slice(10)) event[h.indexOf(key)] = '';
    event[h.indexOf('completionId')] = 'OLD-ADMIN'; event[h.indexOf('note')] = 'admin-assignment-status';
    event[h.indexOf('balanceBefore')] = '120'; event[h.indexOf('balanceAfter')] = '120';
    tabs.TaskCompletions.push(event);
    const plan = parseLegacyTaskHistory(taskHistoryGrid(tabs)), old = plan.completions.at(-1)!;
    expect(old.event).toMatchObject({ completionId: 'OLD-ADMIN', reward: 20, balanceBefore: 120, balanceAfter: 120 });
    expect(old.transactionId).toBeNull(); expect(old.event).not.toHaveProperty('source');
    expect(old.event).not.toHaveProperty('taskInstanceId'); expect(old.sources[0].cells).toEqual(event);
    event[h.indexOf('balanceAfter')] = '140';
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow('LEGACY_TASK_UNVERSIONED_LEDGER');
  });
  it('requires the historical state predecessor for a zero-money completion carry', () => {
    const tabs = taskHistoryCarryFixture(true), h = tabs.TaskCompletions[0]; tabs.TaskCompletions.pop();
    const event = [...tabs.TaskCompletions[3]], a = Object.fromEntries(tabs.TaskAssignments[0].map((k, i) => [k, tabs.TaskAssignments.at(-1)![i]]));
    for (const [key, value] of Object.entries({ completionId: 'CARRY-C', timestamp: '2026-09-02T00:01:00.000Z',
      assignmentId: 'CARRY1', source: 'CARRY_FORWARD', reward: '0', balanceBefore: '120', balanceAfter: '120',
      operationId: '', operationPayloadHash: '', cycleId: a.cycleId, cycleStartsAt: a.cycleStartsAt,
      cycleEndsAt: a.cycleEndsAt, ruleVersion: a.ruleVersion })) event[h.indexOf(key)] = value;
    tabs.TaskCompletions.push(event);
    expect(parseLegacyTaskHistory(taskHistoryGrid(tabs)).completions.at(-1)?.event.source).toBe('CARRY_FORWARD');
    tabs.TaskCompletions.splice(1, 3);
    expect(() => parseLegacyTaskHistory(taskHistoryGrid(tabs))).toThrow('LEGACY_TASK_CARRY_COMPLETION');
  });
  it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('retains the representative three assignments and six completion rows as four state events', async () => {
    const plan = parseLegacyTaskHistory(await readFile(process.env.CRS_PRIVATE_BASELINE!, 'utf8'));
    expect(plan).toMatchObject({ sourceAssignmentRows: 3, sourceCompletionRows: 6 });
    expect(plan.completions).toHaveLength(4);
    expect(plan.completions.filter(e => e.event.source === 'BANK')).toHaveLength(1);
    const full = await parseLegacyFullSnapshot({ tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', migrationJobId: 'full-baseline', gridJson: await readFile(process.env.CRS_PRIVATE_BASELINE!, 'utf8'), capturedAt: '2026-09-29T09:36:55.078Z' });
    expect(full).toMatchObject({ physicalRows: 53, businessRows: 43, writerFreezeProven: false, redisClaims: 'UNCONFIRMED' });
    expect(full.definitionProjection.kind).toBe('CURRENT_DEFINITIONS_ONLY');
    expect(full.records.students).toHaveLength(3); expect(full.records.products).toHaveLength(3); expect(full.records.tasks).toHaveLength(2);
    expect(full.records.promotions).toHaveLength(1); expect(full.records.promotion_products).toHaveLength(1);
  });
});
