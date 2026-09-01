import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabasePadletClaimRepository } from './padletClaims';

vi.mock('server-only', () => ({}));

const BOARD_ID = 'BOARD000000000001';

function transactionReturning(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return {
    transaction: { execute } as unknown as TenantTransaction,
    execute,
  };
}

function compiledQuery(execute: ReturnType<typeof vi.fn>) {
  const statement = execute.mock.calls[0]?.[0];
  return new PgDialect().sqlToQuery(statement);
}

describe('database Padlet claimed-post lookup', () => {
  it('returns a new frozen mixed-case subset in raw code-unit order', async () => {
    const sourceRows = [{ post_id: 'post-A' }, { post_id: 'post-B' }, { post_id: 'post-a' }];
    const { transaction } = transactionReturning(sourceRows);

    const result = await createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      ['post-a', 'not-claimed', 'post-B', 'post-A'],
    );

    const rawCodeUnitOrder = ['post-A', 'post-B', 'post-a']
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    expect(rawCodeUnitOrder).toEqual(['post-A', 'post-B', 'post-a']);
    expect(result).toEqual(rawCodeUnitOrder);
    expect(result).not.toBe(sourceRows);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['empty post list', []],
    ['more than 200 posts', Array.from({ length: 201 }, (_, index) => `post_${index}`)],
    ['duplicate posts', ['post_1', 'post_1']],
    ['too-short post ID', ['ab']],
    ['too-long post ID', ['a'.repeat(129)]],
    ['post ID with whitespace', ['post 1']],
    ['post ID with punctuation', ['post.1']],
  ])('rejects %s before SQL', async (_label, postIds) => {
    const { transaction, execute } = transactionReturning([]);

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      postIds,
    )).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    '',
    ' ',
    ' leading',
    'trailing ',
    'a'.repeat(129),
  ])('rejects noncanonical board ID %j before SQL', async (boardId) => {
    const { transaction, execute } = transactionReturning([]);

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      boardId,
      ['post_1'],
    )).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('issues one bounded parameterized global claim query with canonical request ordering', async () => {
    const { transaction, execute } = transactionReturning([]);

    await createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      ['z_post', 'A_post', 'a-post'],
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const query = compiledQuery(execute);
    expect(query.sql).toMatch(/^\s*SELECT post_id\s+FROM padlet_evidence_claims\s+WHERE provider = 'PADLET'\s+AND board_id = \$1\s+AND post_id IN \(\$2, \$3, \$4\)\s+ORDER BY post_id COLLATE "C"\s*$/);
    expect(query.sql).not.toMatch(/ORDER BY post_id\s*$/);
    expect(query.params).toEqual([BOARD_ID, 'A_post', 'a-post', 'z_post']);
    expect(query.sql).not.toMatch(/tenant|tombstone|SET ROLE|set_config/i);
  });

  it.each([
    ['primitive row', 'post_1'],
    ['null row', null],
    ['array row', ['post_1']],
    ['extra key', { post_id: 'post_1', extra: true }],
    ['non-enumerable key', Object.defineProperty({}, 'post_id', { value: 'post_1' })],
    ['boxed string', { post_id: new String('post_1') }],
    ['custom prototype', Object.assign(Object.create({ inherited: true }), { post_id: 'post_1' })],
  ])('rejects hostile adapter %s', async (_label, row) => {
    const { transaction } = transactionReturning([row]);

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      ['post_1'],
    )).rejects.toThrow(/row|result/i);
  });

  it('rejects an accessor row without invoking its getter', async () => {
    const getter = vi.fn(() => 'post_1');
    const row = Object.defineProperty({}, 'post_id', { enumerable: true, get: getter });
    const { transaction } = transactionReturning([row]);

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      ['post_1'],
    )).rejects.toThrow(/row|result/i);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown post', [{ post_id: 'post_2' }], ['post_1']],
    ['duplicate evidence', [{ post_id: 'post_1' }, { post_id: 'post_1' }], ['post_1']],
    ['reordered evidence', [{ post_id: 'post_2' }, { post_id: 'post_1' }], ['post_1', 'post_2']],
    ['noncanonical evidence', [{ post_id: 'bad post' }], ['bad_post']],
  ])('rejects %s rows from the adapter', async (_label, rows, requested) => {
    const { transaction } = transactionReturning(rows);

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      requested,
    )).rejects.toThrow(/row|result/i);
  });

  it('propagates unknown database errors unchanged', async () => {
    const failure = new Error('database unavailable');
    const transaction = {
      execute: vi.fn().mockRejectedValue(failure),
    } as unknown as TenantTransaction;

    await expect(createDatabasePadletClaimRepository().findClaimedPostIds(
      transaction,
      BOARD_ID,
      ['post_1'],
    )).rejects.toBe(failure);
  });
});
