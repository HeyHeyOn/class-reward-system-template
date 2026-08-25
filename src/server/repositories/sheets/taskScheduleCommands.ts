import { resolveTaskSchedule, serializeTaskScheduleCells, validateTaskSchedule } from '@/domain/taskSchedule';
import { isValidNamedTimeZone } from '@/domain/timeZone';
import { getTaskRecords } from '@/server/sheetsRepository';
import {
  type CrossSheetCellUpdate,
  type RecurringSchemaMigrationStore,
  SheetProviderError,
  updateCellsAtomicallyAcrossSheets,
} from '@/server/storage/tabularStore';
import { migrateRecurringTaskSchema } from './recurringSchemaMigrator';
import { enqueueTaskCommand, taskCommandQueueKey } from './taskCommandQueue';

export type ClassTimeZoneChangeResult = {
  classTimeZone: string;
  changedAt: string;
  updatedTaskCount: number;
};

export type ClassTimeZoneChangeOptions = {
  /** Injectable server clock for deterministic command tests. */
  now?: () => string;
};

/**
 * Changes the classroom timezone and every finite recurring task in one provider request.
 * Serialization is process-local only; the Sheets values API does not offer cross-process CAS.
 */
export async function changeClassTimeZone(
  store: RecurringSchemaMigrationStore,
  value: unknown,
  options: ClassTimeZoneChangeOptions = {},
): Promise<ClassTimeZoneChangeResult> {
  const classTimeZone = typeof value === 'string' ? value.trim() : '';
  if (!isValidNamedTimeZone(classTimeZone)) {
    throw new Error('올바른 IANA 시간대를 입력해 주세요.');
  }
  // Capability validation must precede migration, because migration may write schema.
  if (!store.updateCellsAtomicallyAcrossSheets) {
    throw new Error('현재 Sheets 저장소가 원자적 다중 시트 업데이트를 지원하지 않습니다.');
  }

  return enqueueTaskCommand(taskCommandQueueKey(''), async () => {
    // Observe one instant only after entering the mutation queue.
    const changedAt = options.now?.() ?? new Date().toISOString();
    // Validation canonicalizes the instant before any schema or business write.
    validateTaskSchedule({
      ruleVersion: 1,
      effectiveFrom: changedAt,
      timeZone: classTimeZone,
      recurrence: { type: 'NONE' },
      resetCompletionOnCycle: false,
      resetAssignmentOnCycle: false,
    });

    // Explicit, non-destructive prerequisite. Any failure occurs before business mutation.
    await migrateRecurringTaskSchema(store);

    const [taskRecords, taskRows] = await Promise.all([
      getTaskRecords(store),
      store.getRows('Tasks'),
    ]);
    const taskUpdates: CrossSheetCellUpdate[] = [];
    const taskHeaders = taskRows[0] ?? [];
    const taskColumnNumbers = new Map(taskHeaders.map((header, index) => [header.trim(), index + 1]));
    let updatedTaskCount = 0;

    for (const record of taskRecords) {
      const task = record.task;
      if (task.scheduleReadWarnings?.length) {
        throw new Error(`과제 일정 데이터가 손상되었습니다 (${task.scheduleReadWarnings[0]}). 일정을 먼저 복구해 주세요.`);
      }
      if (!task.schedule) continue;
      if (Date.parse(changedAt) < Date.parse(task.schedule.effectiveFrom)) {
        throw new Error('시간대 변경 시각은 과제 일정의 effectiveFrom보다 이를 수 없습니다. 변경 순서를 확인해 주세요.');
      }
      if (!task.taskInstanceId) continue;
      const effectiveSchedule = resolveTaskSchedule({
        currentSchedule: task.schedule,
        pendingSchedule: task.pendingSchedule ?? null,
        now: changedAt,
      });
      const hasFuturePending = task.pendingSchedule !== null
        && task.pendingSchedule !== undefined
        && Date.parse(task.pendingSchedule.effectiveFrom) > Date.parse(changedAt);
      if (effectiveSchedule.recurrence.type === 'NONE' && !hasFuturePending) continue;
      if (effectiveSchedule.timeZone === classTimeZone && !hasFuturePending) continue;

      const pendingSchedule = validateTaskSchedule({
        ...effectiveSchedule,
        ruleVersion: Math.max(
          task.schedule.ruleVersion,
          task.pendingSchedule?.ruleVersion ?? 0,
        ) + 1,
        effectiveFrom: changedAt,
        timeZone: classTimeZone,
      });
      const cells = serializeTaskScheduleCells({
        taskInstanceId: task.taskInstanceId,
        currentSchedule: effectiveSchedule,
        pendingSchedule,
      });
      for (const [columnName, cellValue] of Object.entries(cells)) {
        const columnNumber = taskColumnNumbers.get(columnName);
        if (!columnNumber) throw new Error(`Tasks 시트에 ${columnName} 컬럼이 없습니다.`);
        taskUpdates.push({ sheetName: 'Tasks', rowNumber: record.rowNumber, columnNumber, value: cellValue });
      }
      const updatedAtColumn = taskColumnNumbers.get('updatedAt');
      if (updatedAtColumn) {
        taskUpdates.push({
          sheetName: 'Tasks', rowNumber: record.rowNumber, columnNumber: updatedAtColumn, value: changedAt,
        });
      }
      updatedTaskCount += 1;
    }

    // Avoid leaving an empty schema behind for malformed task state: Settings is the last prerequisite.
    const settingsRows = await getOrCreateSettingsRows(store);
    const updates = [...prepareSettingUpdates(settingsRows, classTimeZone), ...taskUpdates];
    await updateCellsAtomicallyAcrossSheets(store, updates);
    return { classTimeZone, changedAt, updatedTaskCount };
  });
}

async function getOrCreateSettingsRows(store: RecurringSchemaMigrationStore): Promise<string[][]> {
  let lookup = await store.lookupSheet('Settings');
  if (!lookup.found) {
    try {
      await store.createSheetWithHeader('Settings', ['key', 'value']);
    } catch (error) {
      if (!(error instanceof SheetProviderError) || error.reason !== 'SHEET_ALREADY_EXISTS') throw error;
    }
    lookup = await store.lookupSheet('Settings');
    if (!lookup.found) throw new Error('Settings sheet was absent after creation.');
  }
  return store.getRows('Settings');
}

function prepareSettingUpdates(rows: string[][], classTimeZone: string): CrossSheetCellUpdate[] {
  const [headers, ...dataRows] = rows;
  if (!headers) {
    return [
      { sheetName: 'Settings', rowNumber: 1, columnNumber: 1, value: 'key' },
      { sheetName: 'Settings', rowNumber: 1, columnNumber: 2, value: 'value' },
      { sheetName: 'Settings', rowNumber: 2, columnNumber: 1, value: 'classTimeZone' },
      { sheetName: 'Settings', rowNumber: 2, columnNumber: 2, value: classTimeZone },
    ];
  }
  const normalized = headers.map((header) => header.trim());
  const keyIndex = normalized.indexOf('key');
  const valueIndex = normalized.indexOf('value');
  if (keyIndex < 0 || valueIndex < 0) {
    throw new Error('Settings 시트에 필수 컬럼이 없습니다: key, value');
  }
  const existingIndexes = dataRows
    .map((row, index) => String(row[keyIndex] ?? '').trim() === 'classTimeZone' ? index : -1)
    .filter((index) => index >= 0);
  if (existingIndexes.length > 0) {
    return existingIndexes.map((index) => ({
      sheetName: 'Settings',
      rowNumber: index + 2,
      columnNumber: valueIndex + 1,
      value: classTimeZone,
    }));
  }
  const rowNumber = dataRows.length + 2;
  return [
    {
      sheetName: 'Settings' as const,
      rowNumber,
      columnNumber: keyIndex + 1,
      value: 'classTimeZone',
    },
    { sheetName: 'Settings', rowNumber, columnNumber: valueIndex + 1, value: classTimeZone },
  ];
}
