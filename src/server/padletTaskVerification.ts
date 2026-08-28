import type { TaskCompletionEvidence } from '@/domain/types';
import { isTaskAvailable } from '@/domain/taskAvailability';
import type { TaskCycleProjectionDto } from './repositories/sheets/taskHistoryQueries';
import type {
  PadletBoundEvidenceClaimResult,
  PadletOperationBinding,
} from './padletEvidenceClaimStore';
import {
  fetchPadletBoardPosts,
  isCanonicalPadletPostId,
  isStrictIsoTimestamp,
  type PadletPost,
} from './padletClient';
import { PadletEvidenceClaimStore } from './padletEvidenceClaimStore';

/** Hard bounds keep provider, Redis, and deterministic allocation work predictable. */
export const MAX_PADLET_TASKS_PER_BOARD = 100;
export const MAX_PADLET_POSTS = 200;
export const MAX_CLAIM_ATTEMPTS = 8;
export const MAX_CONCURRENT_PADLET_BOARDS = 4;

export type PadletEligibilityStatus = 'READY' | 'SUBMISSION_REQUIRED' | 'CHECK_UNAVAILABLE';
export type PadletTaskEligibility = { status: PadletEligibilityStatus; message: string };

type Dependencies = {
  fetchBoardPosts?: (input: { boardId: string }) => Promise<PadletPost[]>;
  claimStore?: PadletClaimOwnerReader;
};

/** Provider-independent read seam used by listing projections. */
export interface PadletClaimOwnerReader {
  getClaimOwners(boardId: string, postIds: readonly string[]): Promise<Map<string, string | null>>;
}

/** Provider-independent atomic binding seam; Redis remains the Sheets composition. */
export interface PadletEvidenceClaimGateway extends PadletClaimOwnerReader {
  getOperationBinding(operationId: string): Promise<PadletOperationBinding | null>;
  claimBoundEvidence(input: {
    operationId: string;
    taskId: string;
    studentId: string;
    cycleStartsAt: string;
    evidence: TaskCompletionEvidence;
  }): Promise<PadletBoundEvidenceClaimResult>;
}

export type PadletTaskVerificationErrorCode =
  | 'SUBMISSION_REQUIRED'
  | 'CHECK_UNAVAILABLE'
  | 'OPERATION_CONFLICT'
  | 'POLICY';

export class PadletTaskVerificationError extends Error {
  readonly code: PadletTaskVerificationErrorCode;

  constructor(code: PadletTaskVerificationErrorCode) {
    super(code === 'SUBMISSION_REQUIRED'
      ? 'Padlet submission is required.'
      : code === 'CHECK_UNAVAILABLE'
        ? 'Padlet verification is unavailable.'
        : code === 'OPERATION_CONFLICT'
          ? 'The operation is already bound to different evidence.'
          : 'Task completion is not allowed.');
    this.name = 'PadletTaskVerificationError';
    this.code = code;
  }
}

export type ClaimPadletEvidenceDependencies = {
  fetchBoardPosts?: (input: { boardId: string }) => Promise<PadletPost[]>;
  claimStore?: PadletEvidenceClaimGateway;
};

export type ClaimPadletEvidenceInput = {
  tasks: readonly TaskCycleProjectionDto[];
  taskId: string;
  studentId: string;
  studentName: string;
  operationId: string;
  now: string;
};

type MatchingPost = { id: string; createdAt: string; authorFullName: string };

const READY: PadletTaskEligibility = {
  status: 'READY',
  message: 'Padlet 게시물이 확인되어 완료할 수 있습니다.',
};
const SUBMISSION_REQUIRED: PadletTaskEligibility = {
  status: 'SUBMISSION_REQUIRED',
  message: '승인된 Padlet 게시물을 작성한 뒤 다시 확인해 주세요.',
};
const CHECK_UNAVAILABLE: PadletTaskEligibility = {
  status: 'CHECK_UNAVAILABLE',
  message: 'Padlet 게시물 확인이 일시적으로 불가능합니다. 잠시 후 다시 시도해 주세요.',
};

/** Allocates safe, ephemeral Padlet eligibility without exposing evidence. */
export async function allocatePadletTaskEligibility(
  tasks: readonly TaskCycleProjectionDto[],
  studentId: string,
  studentName: string,
  dependencies: Dependencies = {},
  now = new Date().toISOString(),
): Promise<Map<string, PadletTaskEligibility>> {
  const fetchBoardPosts = dependencies.fetchBoardPosts ?? fetchPadletBoardPosts;
  const claimStore = dependencies.claimStore ?? new PadletEvidenceClaimStore();
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const allLinked = tasks.filter((task) => task.padletBoardId && !isCompleted(task, studentId));
  const result = new Map<string, PadletTaskEligibility>();

  if (!isStrictIsoTimestamp(now) || tasks.length > MAX_PADLET_TASKS_PER_BOARD || hasDuplicateTaskIds(tasks)) {
    for (const task of allLinked) result.set(task.taskId, CHECK_UNAVAILABLE);
    return result;
  }

  const linked = allLinked.filter((task) => isCompletionEligible(task, studentId, now, tasksById));
  const byBoard = new Map<string, TaskCycleProjectionDto[]>();
  for (const task of linked) {
    const boardId = task.padletBoardId as string;
    const boardTasks = byBoard.get(boardId) ?? [];
    boardTasks.push(task);
    byBoard.set(boardId, boardTasks);
  }

  await mapWithConcurrency(Array.from(byBoard), MAX_CONCURRENT_PADLET_BOARDS, async ([boardId, boardTasks]) => {
    const orderedTasks = orderTasks(boardTasks, tasksById);
    if (boardTasks.length > MAX_PADLET_TASKS_PER_BOARD
      || boardTasks.some((task) => !isValidCycleStart(task.currentCycle?.startsAt))) {
      for (const task of orderedTasks) result.set(task.taskId, CHECK_UNAVAILABLE);
      return;
    }

    try {
      const fetched = await fetchBoardPosts({ boardId });
      validatePostCollection(fetched);
      const matchingPosts = normalizeMatchingPosts(fetched, studentName);
      if (matchingPosts.length === 0) {
        for (const task of orderedTasks) result.set(task.taskId, SUBMISSION_REQUIRED);
        return;
      }
      const owners = await claimStore.getClaimOwners(boardId, matchingPosts.map((post) => post.id));
      validateOwners(owners, matchingPosts);
      const availablePosts = matchingPosts.filter((post) => owners.get(post.id) === null);
      const allocated = new Set<string>();

      for (const task of orderedTasks) {
        const startsAt = task.currentCycle?.startsAt as string;
        const post = availablePosts.find((candidate) => !allocated.has(candidate.id)
          && Date.parse(candidate.createdAt) >= Date.parse(startsAt));
        if (post) {
          allocated.add(post.id);
          result.set(task.taskId, READY);
        } else {
          result.set(task.taskId, SUBMISSION_REQUIRED);
        }
      }
    } catch {
      for (const task of orderedTasks) result.set(task.taskId, CHECK_UNAVAILABLE);
    }
  });

  return result;
}

/** Atomically reserves completion evidence without exposing unclaimed post data. */
export async function claimPadletEvidenceForTask(
  input: ClaimPadletEvidenceInput,
  dependencies: ClaimPadletEvidenceDependencies = {},
): Promise<TaskCompletionEvidence> {
  if (input.tasks.length > MAX_PADLET_TASKS_PER_BOARD
    || !isTrimmedBounded(input.studentId) || !isTrimmedBounded(input.studentName)
    || !isTrimmedBounded(input.operationId) || !isStrictIsoTimestamp(input.now)
    || hasDuplicateTaskIds(input.tasks)) {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }

  const studentId = input.studentId.trim();
  const studentName = input.studentName.trim();
  const operationId = input.operationId.trim();

  const target = input.tasks.find((task) => task.taskId === input.taskId);
  if (!target?.padletBoardId) throw new PadletTaskVerificationError('POLICY');
  const cycleStartsAt = target.currentCycle?.startsAt;
  if (!isValidCycleStart(cycleStartsAt)) throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');

  const boardId = target.padletBoardId;
  const rawBoardTasks = input.tasks.filter((task) => task.padletBoardId === boardId);
  if (rawBoardTasks.some((task) => !isValidCycleStart(task.currentCycle?.startsAt))) {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }
  const fetchBoardPosts = dependencies.fetchBoardPosts ?? fetchPadletBoardPosts;
  const claimStore = dependencies.claimStore ?? new PadletEvidenceClaimStore();
  let existingBinding: PadletOperationBinding | null;
  try {
    existingBinding = await claimStore.getOperationBinding(operationId);
  } catch {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }
  if (existingBinding) {
    return resolveBinding(existingBinding, input.taskId, studentId, cycleStartsAt, boardId);
  }

  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  if (!isCompletionEligible(target, studentId, input.now, tasksById)) {
    throw new PadletTaskVerificationError('POLICY');
  }
  const boardTasks = input.tasks.filter((task) => task.padletBoardId === boardId
    && isCompletionEligible(task, studentId, input.now, tasksById));
  if (boardTasks.length > MAX_PADLET_TASKS_PER_BOARD
    || boardTasks.some((task) => !isValidCycleStart(task.currentCycle?.startsAt))) {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }

  const orderedTasks = orderTasks(boardTasks, tasksById);
  let matchingPosts: MatchingPost[];
  try {
    const fetched = await fetchBoardPosts({ boardId });
    validatePostCollection(fetched);
    matchingPosts = normalizeMatchingPosts(fetched, studentName);
  } catch {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }

  if (matchingPosts.length === 0) {
    throw new PadletTaskVerificationError('SUBMISSION_REQUIRED');
  }

  let owners: Map<string, string | null>;
  try {
    owners = await claimStore.getClaimOwners(boardId, matchingPosts.map((post) => post.id));
    validateOwners(owners, matchingPosts);
  } catch {
    throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
  }

  const raceConsumed = new Set<string>();
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const targetPost = allocateTargetPost(
      orderedTasks, input.taskId, matchingPosts, owners, raceConsumed, operationId,
    );
    if (!targetPost) throw new PadletTaskVerificationError('SUBMISSION_REQUIRED');

    const evidence: TaskCompletionEvidence = {
      evidenceProvider: 'PADLET',
      evidenceBoardId: boardId,
      evidencePostId: targetPost.id,
      evidenceCreatedAt: targetPost.createdAt,
      evidenceAuthorFullName: targetPost.authorFullName,
    };
    try {
      const claimResult = await claimStore.claimBoundEvidence({
        operationId,
        taskId: input.taskId,
        studentId,
        cycleStartsAt,
        evidence,
      });
      if (claimResult.status === 'CLAIMED' || claimResult.status === 'IDEMPOTENT') {
        return resolveBinding(claimResult.binding, input.taskId, studentId, cycleStartsAt, boardId);
      }
      if (claimResult.status === 'OPERATION_CONFLICT') {
        return resolveBinding(claimResult.binding, input.taskId, studentId, cycleStartsAt, boardId);
      }
      if (claimResult.status !== 'CONFLICT') throw new Error();
      raceConsumed.add(targetPost.id);
    } catch (error) {
      if (error instanceof PadletTaskVerificationError) throw error;
      throw new PadletTaskVerificationError('CHECK_UNAVAILABLE');
    }
  }

  const remaining = allocateTargetPost(
    orderedTasks, input.taskId, matchingPosts, owners, raceConsumed, operationId,
  );
  throw new PadletTaskVerificationError(remaining ? 'CHECK_UNAVAILABLE' : 'SUBMISSION_REQUIRED');
}

function resolveBinding(
  binding: PadletOperationBinding,
  taskId: string,
  studentId: string,
  cycleStartsAt: string,
  boardId: string,
): TaskCompletionEvidence {
  if (binding.taskId !== taskId || binding.studentId !== studentId
    || binding.cycleStartsAt !== cycleStartsAt || binding.evidence.evidenceBoardId !== boardId) {
    throw new PadletTaskVerificationError('OPERATION_CONFLICT');
  }
  return binding.evidence;
}

function validatePostCollection(posts: unknown): asserts posts is PadletPost[] {
  if (!Array.isArray(posts) || posts.length > MAX_PADLET_POSTS) throw new Error();
  const ids = new Set<string>();
  for (const post of posts) {
    if (!isRecord(post) || typeof post.id !== 'string' || !isCanonicalPadletPostId(post.id)
      || ids.has(post.id) || typeof post.approved !== 'boolean'
      || typeof post.createdAt !== 'string' || !isStrictIsoTimestamp(post.createdAt)
      || (post.author !== null && (!isRecord(post.author)
        || (post.author.fullName !== null && typeof post.author.fullName !== 'string')))) {
      throw new Error();
    }
    ids.add(post.id);
  }
}

function normalizeMatchingPosts(posts: readonly PadletPost[], studentName: string): MatchingPost[] {
  const expectedName = studentName.trim();
  return posts.flatMap((post): MatchingPost[] => {
    const authorFullName = post.author?.fullName?.trim();
    if (!post.approved || !authorFullName || authorFullName !== expectedName) return [];
    return [{ id: post.id, createdAt: post.createdAt, authorFullName }];
  }).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.id.localeCompare(right.id));
}

function validateOwners(owners: ReadonlyMap<string, string | null>, posts: readonly MatchingPost[]): void {
  if (posts.some((post) => !owners.has(post.id)
    || (owners.get(post.id) !== null && typeof owners.get(post.id) !== 'string'))) throw new Error();
}

function allocateTargetPost(
  orderedTasks: readonly TaskCycleProjectionDto[],
  targetTaskId: string,
  posts: readonly MatchingPost[],
  owners: ReadonlyMap<string, string | null>,
  raceConsumed: ReadonlySet<string>,
  operationId: string,
): MatchingPost | undefined {
  const allocated = new Set<string>();
  let targetPost: MatchingPost | undefined;
  for (const task of orderedTasks) {
    const startsAt = task.currentCycle?.startsAt as string;
    const post = posts.find((candidate) => {
      const owner = owners.get(candidate.id);
      return !allocated.has(candidate.id) && !raceConsumed.has(candidate.id)
        && (owner === null || owner === operationId)
        && Date.parse(candidate.createdAt) >= Date.parse(startsAt);
    });
    if (!post) continue;
    allocated.add(post.id);
    if (task.taskId === targetTaskId) targetPost = post;
  }
  return targetPost;
}

function orderTasks(
  tasks: readonly TaskCycleProjectionDto[],
  tasksById: ReadonlyMap<string, TaskCycleProjectionDto>,
): TaskCycleProjectionDto[] {
  return [...tasks].sort((left, right) => prerequisiteDepth(left, tasksById) - prerequisiteDepth(right, tasksById)
    || left.sortOrder - right.sortOrder || left.taskId.localeCompare(right.taskId));
}

function isCompleted(task: TaskCycleProjectionDto, studentId: string): boolean {
  return task.currentCycle?.students?.find((student) => student.studentId === studentId)?.completed === true
    || task.currentCycle?.completedStudentIds?.includes(studentId) === true;
}

function isCompletionEligible(
  task: TaskCycleProjectionDto,
  studentId: string,
  now: string,
  tasksById: ReadonlyMap<string, TaskCycleProjectionDto>,
): boolean {
  const assigned = task.studentStatus?.studentId === studentId
    ? task.studentStatus.assigned
    : task.currentCycle?.students?.find((student) => student.studentId === studentId)?.assigned;
  if (!task.isActive || !isTaskAvailable(task, now) || assigned !== true || isCompleted(task, studentId)) return false;
  if (!task.prerequisiteTaskId) return true;
  const prerequisite = tasksById.get(task.prerequisiteTaskId);
  return Boolean(prerequisite && isCompleted(prerequisite, studentId));
}

function isValidCycleStart(value: string | undefined): value is string {
  return Boolean(value && isStrictIsoTimestamp(value));
}

function isTrimmedBounded(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 128;
}

function hasDuplicateTaskIds(tasks: readonly TaskCycleProjectionDto[]): boolean {
  return new Set(tasks.map((task) => task.taskId)).size !== tasks.length;
}

function prerequisiteDepth(
  task: TaskCycleProjectionDto,
  tasksById: ReadonlyMap<string, TaskCycleProjectionDto>,
  visiting: ReadonlySet<string> = new Set(),
): number {
  if (!task.prerequisiteTaskId || visiting.has(task.taskId)) return 0;
  const prerequisite = tasksById.get(task.prerequisiteTaskId);
  if (!prerequisite) return 0;
  return 1 + prerequisiteDepth(prerequisite, tasksById, new Set([...visiting, task.taskId]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}
