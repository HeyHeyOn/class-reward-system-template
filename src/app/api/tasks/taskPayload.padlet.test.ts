import { describe, expect, it } from 'vitest';
import { parseStrictBatchTaskFields, parseStrictTaskFields } from './taskPayload';

const base = {
  taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true,
  sortOrder: 1, allowedStudentIds: ['S1'],
};

describe('Padlet task payload contract', () => {
  it('accepts an official 16-22 character alphanumeric board ID for create, update, and batch payloads', () => {
    expect(parseStrictTaskFields({ ...base, padletBoardId: 'AbCdEfGhIjKlMnOp' }, 'create'))
      .toMatchObject({ padletBoardId: 'AbCdEfGhIjKlMnOp' });
    const update = {
      title: base.title, description: base.description, reward: base.reward,
      isActive: base.isActive, sortOrder: base.sortOrder, allowedStudentIds: base.allowedStudentIds,
    };
    expect(parseStrictTaskFields({ ...update, padletBoardId: null }, 'update'))
      .toHaveProperty('padletBoardId', undefined);
    expect(parseStrictBatchTaskFields({ ...base, padletBoardId: '1234567890abcdefABCDEF' }))
      .toMatchObject({ padletBoardId: '1234567890abcdefABCDEF' });
  });

  it.each([
    'https://padlet.com/teacher/board-123', 'has spaces', 'x', '/board',
    '1234567890abcde', '1234567890abcdef_______', '1234567890abcdefABCDEFG',
  ]) (
    'rejects invalid server-side board ID %s', (padletBoardId) => {
      expect(() => parseStrictTaskFields({ ...base, padletBoardId }, 'create')).toThrow(/Padlet|형식/);
    },
  );
});
