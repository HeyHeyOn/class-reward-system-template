import 'server-only';

import type { TaskCompletionEvidence } from '@/domain/types';
import {
  TaskRewardCommandError,
  type PadletEvidenceResolutionInput,
} from '@/server/repositories/database/taskCompletionCommands';
import { isCanonicalPadletPostId, type PadletPost } from './padletClient';

export type PadletCompletionEvidenceResolverDependencies = Readonly<{
  fetchPosts: (boardId: string) => Promise<PadletPost[]>;
  findClaimedPostIds: (boardId: string, postIds: string[]) => Promise<string[]>;
}>;

export function createPadletCompletionEvidenceResolver(
  dependencies: PadletCompletionEvidenceResolverDependencies,
): (input: PadletEvidenceResolutionInput) => Promise<TaskCompletionEvidence> {
  return async (input) => {
    if (!isRecord(input) || typeof input.studentName !== 'string'
      || typeof input.boardId !== 'string') {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }
    const studentName = input.studentName.trim();
    const cycleStartsAt = parseCanonicalInstant(input.cycleStartsAt);
    const cycleEndsAt = input.cycleEndsAt === null ? null : parseCanonicalInstant(input.cycleEndsAt);
    const now = parseCanonicalInstant(input.now);
    if (!studentName || !input.boardId || input.boardId.trim() !== input.boardId
      || (cycleEndsAt !== null && cycleEndsAt <= cycleStartsAt)) {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }

    let posts: PadletPost[];
    try {
      posts = await dependencies.fetchPosts(input.boardId);
    } catch {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }
    if (!Array.isArray(posts) || posts.length > 200) {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }

    const candidates: PadletPost[] = [];
    const seen = new Set<string>();
    try {
      for (const post of posts) {
        if (!isRecord(post) || !isCanonicalPadletPostId(post.id) || seen.has(post.id)
          || typeof post.createdAt !== 'string'
          || new Date(parseCanonicalInstant(post.createdAt)).toISOString() !== post.createdAt
          || typeof post.authorFullName !== 'string' || !post.authorFullName.trim()) {
          throw new Error('invalid provider projection');
        }
        seen.add(post.id);
        const authorFullName = post.authorFullName.trim();
        const createdAt = Date.parse(post.createdAt);
        if (authorFullName === studentName && createdAt >= cycleStartsAt
          && (cycleEndsAt === null || createdAt < cycleEndsAt) && createdAt <= now) {
          candidates.push({ ...post, authorFullName });
        }
      }
    } catch {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }
    candidates.sort((left, right) => {
      if (left.createdAt < right.createdAt) return -1;
      if (left.createdAt > right.createdAt) return 1;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
    if (candidates.length === 0) throw new TaskRewardCommandError('SUBMISSION_REQUIRED');

    let claimedIds: string[];
    try {
      claimedIds = await dependencies.findClaimedPostIds(
        input.boardId,
        candidates.map((post) => post.id),
      );
    } catch {
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }
    try {
      if (!Array.isArray(claimedIds)) throw new Error('invalid claim projection');
      const candidateIds = new Set(candidates.map((post) => post.id));
      const claimedSet = new Set<string>();
      for (const id of claimedIds) {
        if (typeof id !== 'string' || !candidateIds.has(id) || claimedSet.has(id)) {
          throw new Error('invalid claim projection');
        }
        claimedSet.add(id);
      }
      const selected = candidates.find((post) => !claimedSet.has(post.id));
      if (!selected) throw new TaskRewardCommandError('SUBMISSION_REQUIRED');
      return {
        evidenceProvider: 'PADLET',
        evidenceBoardId: input.boardId,
        evidencePostId: selected.id,
        evidenceCreatedAt: selected.createdAt,
        evidenceAuthorFullName: selected.authorFullName,
      };
    } catch (error) {
      if (error instanceof TaskRewardCommandError) throw error;
      throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
    }
  };
}

function parseCanonicalInstant(value: string): number {
  if (typeof value !== 'string') throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
