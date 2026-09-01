import { describe, expect, it, vi } from 'vitest';
import { TaskRewardCommandError, type PadletEvidenceResolutionInput } from './repositories/database/taskCompletionCommands';
import { PadletClientError, type PadletPost } from './padletClient';
import { createPadletCompletionEvidenceResolver } from './padletCompletionEvidenceResolver';

vi.mock('server-only', () => ({}));

const input: PadletEvidenceResolutionInput = {
  taskId: 'T001',
  taskInstanceId: 'I-T001',
  studentId: 'S001',
  studentName: ' 김학생 ',
  boardId: 'Board1234567890',
  cycleId: 'CYCLE-1',
  cycleStartsAt: '2026-08-28T00:00:00.000Z',
  cycleEndsAt: '2026-08-29T00:00:00.000Z',
  operationId: '10000000-0000-4000-8000-000000000001',
  now: '2026-08-28T12:00:00.000Z',
};

function post(id: string, createdAt: string, authorFullName = '김학생'): PadletPost {
  return { id, createdAt, authorFullName };
}

describe('createPadletCompletionEvidenceResolver', () => {
  it('returns the oldest deterministic eligible unclaimed approved post', async () => {
    const fetchPosts = vi.fn(async () => [
      post('post-b', '2026-08-28T01:00:00.000Z'),
      post('post-a', '2026-08-28T01:00:00.000Z'),
      post('post-old', '2026-08-27T23:59:59.999Z'),
      post('post-future', '2026-08-28T12:00:00.001Z'),
      post('post-other', '2026-08-28T00:30:00.000Z', '다른 학생'),
    ]);
    const findClaimedPostIds = vi.fn(async () => ['post-a']);
    const resolve = createPadletCompletionEvidenceResolver({ fetchPosts, findClaimedPostIds });

    await expect(resolve(input)).resolves.toEqual({
      evidenceProvider: 'PADLET',
      evidenceBoardId: input.boardId,
      evidencePostId: 'post-b',
      evidenceCreatedAt: '2026-08-28T01:00:00.000Z',
      evidenceAuthorFullName: '김학생',
    });
    expect(fetchPosts).toHaveBeenCalledWith(input.boardId);
    expect(findClaimedPostIds).toHaveBeenCalledWith(input.boardId, ['post-a', 'post-b']);
  });

  it('uses raw code-unit ID order for equal timestamps regardless of provider order', async () => {
    const createdAt = '2026-08-28T01:00:00.000Z';
    for (const posts of [
      [post('post-a', createdAt), post('post-A', createdAt)],
      [post('post-A', createdAt), post('post-a', createdAt)],
    ]) {
      const findClaimedPostIds = vi.fn(async () => []);
      const resolve = createPadletCompletionEvidenceResolver({
        fetchPosts: async () => posts,
        findClaimedPostIds,
      });

      await expect(resolve(input)).resolves.toMatchObject({ evidencePostId: 'post-A' });
      expect(findClaimedPostIds).toHaveBeenCalledWith(input.boardId, ['post-A', 'post-a']);
    }
  });

  it('uses a half-open cycle window and accepts a post exactly at now', async () => {
    const fetchPosts = vi.fn(async () => [
      post('at-start', input.cycleStartsAt),
      post('at-now', input.now),
      post('at-end', input.cycleEndsAt!),
    ]);
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts,
      findClaimedPostIds: async () => ['at-start'],
    });
    await expect(resolve(input)).resolves.toMatchObject({ evidencePostId: 'at-now' });
  });

  it.each([
    ['no eligible posts', []],
    ['all eligible posts claimed', [post('post-1', '2026-08-28T01:00:00.000Z')]],
  ])('reports SUBMISSION_REQUIRED for %s', async (_label, posts) => {
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => posts,
      findClaimedPostIds: async (_boardId, postIds) => [...postIds],
    });
    const error = await resolve(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskRewardCommandError);
    expect(error).toMatchObject({ code: 'SUBMISSION_REQUIRED' });
  });

  it('maps a provider error to a safe PROVIDER_UNAVAILABLE error', async () => {
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => { throw new PadletClientError('UPSTREAM'); },
      findClaimedPostIds: async () => [],
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it.each([
    ['POLICY', new TaskRewardCommandError('POLICY')],
    ['CONFLICT', new TaskRewardCommandError('CONFLICT')],
    ['OPERATION_CONFLICT', new TaskRewardCommandError('OPERATION_CONFLICT')],
    ['OPERATION_PENDING', new TaskRewardCommandError('OPERATION_PENDING')],
    ['PROVIDER_UNAVAILABLE', new TaskRewardCommandError('PROVIDER_UNAVAILABLE')],
    ['SUBMISSION_REQUIRED', new TaskRewardCommandError('SUBMISSION_REQUIRED')],
    ['EVIDENCE_CONFLICT', new TaskRewardCommandError('EVIDENCE_CONFLICT')],
    ['generic error', new Error('database secret')],
  ])('maps a rejected claim lookup (%s) to a new safe PROVIDER_UNAVAILABLE error', async (_label, failure) => {
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => [post('post-1', '2026-08-28T01:00:00.000Z')],
      findClaimedPostIds: async () => { throw failure; },
    });
    const error = await resolve(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskRewardCommandError);
    expect(error).not.toBe(failure);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(String(error)).not.toContain('database secret');
  });

  it('rejects more than 200 fetched posts before looking up claims', async () => {
    const posts = Array.from({ length: 201 }, (_, index) =>
      post(`post-${String(index).padStart(3, '0')}`, '2026-08-28T01:00:00.000Z'));
    const findClaimedPostIds = vi.fn(async () => []);
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => posts,
      findClaimedPostIds,
    });

    await expect(resolve(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(findClaimedPostIds).not.toHaveBeenCalled();
  });

  it('fails closed when claimed lookup returns an unknown or duplicate post ID', async () => {
    for (const claimed of [['unknown'], ['post-1', 'post-1']]) {
      const resolve = createPadletCompletionEvidenceResolver({
        fetchPosts: async () => [post('post-1', '2026-08-28T01:00:00.000Z')],
        findClaimedPostIds: async () => claimed,
      });
      await expect(resolve(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
  });

  it('maps a noncanonical provider post ID to PROVIDER_UNAVAILABLE', async () => {
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => [post('bad/id', '2026-08-28T01:00:00.000Z')],
      findClaimedPostIds: async () => [],
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it.each([
    ['studentName', 1],
    ['boardId', {}],
  ])('maps malformed runtime %s to PROVIDER_UNAVAILABLE', async (key, value) => {
    const resolve = createPadletCompletionEvidenceResolver({
      fetchPosts: async () => [],
      findClaimedPostIds: async () => [],
    });
    const malformed = { ...input, [key]: value } as unknown as PadletEvidenceResolutionInput;
    await expect(resolve(malformed)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
