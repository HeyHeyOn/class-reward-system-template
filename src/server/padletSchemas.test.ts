import { describe, expect, it } from 'vitest';
import {
  buildTaskAppendRow,
  buildTaskCompletionAppendRow,
  createHeaderIndex,
  parseTaskCompletionRow,
  parseTaskRow,
} from '@/server/sheetsRows';

const BOARD_ID = 'AbCdEfGhIjKlMnOp';

describe('Padlet additive task and evidence schemas', () => {
  it('round-trips the optional Padlet board ID in the additive task column', () => {
    const headers = [
      'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt',
      'allowedStudentIds', 'teacherCustom', 'padletBoardId',
    ];
    const row = ['T-P', 'Padlet 과제', '', '5', 'TRUE', '1', '2026-08-28T00:00:00Z', '', 'keep', BOARD_ID];
    const task = parseTaskRow(row, createHeaderIndex(headers));

    expect(task).toMatchObject({ taskId: 'T-P', padletBoardId: BOARD_ID });
    expect(buildTaskAppendRow(headers, task!, '2026-08-29T00:00:00Z', row)).toEqual([
      'T-P', 'Padlet 과제', '', '5', 'TRUE', '1', '2026-08-29T00:00:00Z', '', 'keep', BOARD_ID,
    ]);
    expect(() => parseTaskRow(
      row.with(headers.indexOf('padletBoardId'), 'invalid_board'),
      createHeaderIndex(headers),
    )).toThrow(/padletBoardId/i);
  });

  it('round-trips complete Padlet evidence and rejects partial or malformed snapshots', () => {
    const headers = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
      'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt',
      'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId',
      'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId',
      'evidenceCreatedAt', 'evidenceAuthorFullName',
    ];
    const completion = {
      completionId: 'TC-E', timestamp: '2026-08-28T01:00:00.000Z', taskId: 'T-P', studentId: 'S-1',
      studentName: '김학생', reward: 5, balanceBefore: 10, balanceAfter: 15, status: 'SUCCESS', note: '',
      taskInstanceId: 'TI-1', cycleId: 'C-1', cycleStartsAt: '2026-08-28T00:00:00.000Z',
      cycleEndsAt: null, ruleVersion: 1, timeZone: 'Asia/Seoul', source: 'BANK' as const,
      assignmentId: 'A-1', schemaVersion: 2,
      operationId: 'operation-1', operationPayloadHash: `sha256:${'a'.repeat(64)}`,
      evidenceProvider: 'PADLET' as const, evidenceBoardId: BOARD_ID, evidencePostId: 'post_456',
      evidenceCreatedAt: '2026-08-28T00:30:00.000Z', evidenceAuthorFullName: '김학생',
    };
    const row = buildTaskCompletionAppendRow(headers, completion);

    expect(row.slice(-5)).toEqual(['PADLET', BOARD_ID, 'post_456', completion.evidenceCreatedAt, '김학생']);
    expect(parseTaskCompletionRow(row, createHeaderIndex(headers))).toEqual(completion);
    for (const invalid of [
      row.with(headers.indexOf('evidencePostId'), ''),
      row.with(headers.indexOf('evidenceProvider'), 'OTHER'),
      row.with(headers.indexOf('evidenceBoardId'), 'invalid_board'),
      row.with(headers.indexOf('evidenceCreatedAt'), 'not-an-instant'),
      row.with(headers.indexOf('evidenceCreatedAt'), '2026-08-28T09:30:00.000+09:00'),
      row.with(headers.indexOf('evidenceCreatedAt'), '2026-08-28T00:30:00Z'),
      row.with(headers.indexOf('evidenceCreatedAt'), '2026-08-28T00:30:00.000000Z'),
      row.with(headers.indexOf('evidenceAuthorFullName'), '   '),
    ]) expect(() => parseTaskCompletionRow(invalid, createHeaderIndex(headers)))
      .toThrow('TaskCompletion evidence is malformed');
    for (const invalid of [
      row.with(headers.indexOf('timestamp'), '2026-08-28T10:00:00.000+09:00'),
      row.with(headers.indexOf('timestamp'), '2026-08-28T01:00:00Z'),
      row.with(headers.indexOf('cycleStartsAt'), '2026-08-28T00:00:00Z'),
      row.with(headers.indexOf('cycleEndsAt'), '2026-08-28T10:00:00.000+09:00'),
    ]) expect(() => parseTaskCompletionRow(invalid, createHeaderIndex(headers)))
      .toThrow(/timestamp|snapshot|canonical/i);
    expect(() => buildTaskCompletionAppendRow(headers, { ...completion, evidencePostId: undefined }))
      .toThrow(/evidence/i);
    expect(() => buildTaskCompletionAppendRow(headers, {
      ...completion,
      evidenceAuthorFullName: ` ${completion.evidenceAuthorFullName} `,
    })).toThrow(/evidence/i);
  });

  it('keeps all evidence properties absent for a fully blank additive evidence tail', () => {
    const headers = [
      'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
      'balanceAfter', 'status', 'note', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId',
      'evidenceCreatedAt', 'evidenceAuthorFullName',
    ];
    const parsed = parseTaskCompletionRow([
      'TC-L', '2026-08-28T01:00:00Z', 'T1', 'S1', '학생', '1', '0', '1', 'SUCCESS', '', '', '', '', '', '',
    ], createHeaderIndex(headers));
    expect(parsed).not.toHaveProperty('evidenceProvider');
  });
});
