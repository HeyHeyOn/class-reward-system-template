import { describe, expect, it } from 'vitest';
import type { TaskStage } from './taskStage';
import {
  allocatePadletPosts, matchPadletStudent, normalizePersonName, padletBoardIdFromAddress, padletTaskGroups,
  type PadletLinkedTask, type PadletPost,
} from './padlet';

const STUDENTS = [
  { studentId: 'S1', name: '김민준', active: true },
  { studentId: 'S2', name: '이서연', active: true },
  { studentId: 'S3', name: '김민', active: true },
  { studentId: 'S4', name: '박하늘', active: false },
];

function post(id: string, at: string, author: string, subject = '', extra: Partial<PadletPost> = {}): PadletPost {
  return { id, createdAt: at, status: 'approved', authorName: author, subject, sectionId: null, url: null, ...extra };
}

function task(taskId: string, extra: Partial<PadletLinkedTask> = {}): PadletLinkedTask {
  return { taskId, title: taskId, sortOrder: 1, prerequisiteTaskId: null, sectionId: null,
    opensAt: '2026-10-01T00:00:00.000Z', closesAt: null, visible: true, ...extra };
}

function stages(map: Record<string, Record<string, TaskStage>>) {
  return (taskId: string, studentId: string): TaskStage => map[taskId]?.[studentId] ?? 'UNASSIGNED';
}

describe('padlet board address', () => {
  it('finds the board ID in the addresses a teacher may paste', () => {
    expect(padletBoardIdFromAddress('https://padlet.com/gdteacher5/5-6-mvbij1byfal6f0ik')).toBe('mvbij1byfal6f0ik');
    expect(padletBoardIdFromAddress('padlet.com/gdteacher5/5-6-mvbij1byfal6f0ik/slideshow')).toBe('mvbij1byfal6f0ik');
    expect(padletBoardIdFromAddress('https://padlet.com/linhpublicapidemo/flags-of-20-most-populous-africa-countries-qk3sab0nz9rcp0wv'))
      .toBe('qk3sab0nz9rcp0wv');
    expect(padletBoardIdFromAddress('https://padlet.com/padlets/mvbij1byfal6f0ik')).toBe('mvbij1byfal6f0ik');
    expect(padletBoardIdFromAddress('https://padlet.com/gdteacher5/5-6-mvbij1byfal6f0ik/wish/2652429311')).toBe('mvbij1byfal6f0ik');
    expect(padletBoardIdFromAddress('https://myschool.padlet.org/teacher/board-abcd1234efgh5678')).toBe('abcd1234efgh5678');
    expect(padletBoardIdFromAddress('  mvbij1byfal6f0ik ')).toBe('mvbij1byfal6f0ik');
    expect(padletBoardIdFromAddress('https://example.com/a/b-mvbij1byfal6f0ik')).toBeNull();
    expect(padletBoardIdFromAddress('https://padlet.com/gdteacher5')).toBeNull();
    expect(padletBoardIdFromAddress('')).toBeNull();
  });
});

describe('padlet student names', () => {
  it('compares names without spaces, numbers or marks', () => {
    expect(normalizePersonName(' 3번 김 민준 ')).toBe('김민준');
    expect(normalizePersonName('김민준(03)')).toBe('김민준');
  });

  it('uses the author first, then the title, and never guesses', () => {
    const students = STUDENTS.map(({ studentId, name }) => ({ studentId, name }));
    expect(matchPadletStudent({ authorName: '김민준', subject: '' }, students)).toEqual({ studentId: 'S1', by: 'AUTHOR' });
    expect(matchPadletStudent({ authorName: '', subject: '1번 이서연' }, students)).toEqual({ studentId: 'S2', by: 'SUBJECT' });
    expect(matchPadletStudent({ authorName: '성지환', subject: '김민준의 칭찬 일기' }, students)).toEqual({ studentId: 'S1', by: 'SUBJECT' });
    // ‘김민’ is inside ‘김민준’: the longer name wins.
    expect(matchPadletStudent({ authorName: '익명', subject: '김민준 오늘의 글' }, students)).toEqual({ studentId: 'S1', by: 'SUBJECT' });
    expect(matchPadletStudent({ authorName: '익명', subject: '김민 오늘의 글' }, students)).toEqual({ studentId: 'S3', by: 'SUBJECT' });
    expect(matchPadletStudent({ authorName: '', subject: '김민준과 이서연' }, students)).toEqual({ studentId: null, issue: 'AMBIGUOUS' });
    expect(matchPadletStudent({ authorName: '', subject: '' }, students)).toEqual({ studentId: null, issue: 'NO_NAME' });
    expect(matchPadletStudent({ authorName: '성지환', subject: '오늘의 칭찬' }, students)).toEqual({ studentId: null, issue: 'UNKNOWN' });
    expect(matchPadletStudent({ authorName: '김민준', subject: '' }, [...students, { studentId: 'S9', name: '김민준' }]))
      .toEqual({ studentId: null, issue: 'AMBIGUOUS' });
  });
});

describe('padlet task groups', () => {
  it('chains linked tasks by 선행 과제 and keeps the rest apart', () => {
    const groups = padletTaskGroups([
      task('C', { prerequisiteTaskId: 'B', sortOrder: 1 }), task('A', { sortOrder: 3 }), task('B', { prerequisiteTaskId: 'A', sortOrder: 2 }),
      task('X', { sortOrder: 0 }), task('Y', { prerequisiteTaskId: 'NOT_LINKED', sortOrder: 5 }),
    ]);
    expect(groups.map((group) => group.map((item) => item.taskId))).toEqual([['X'], ['A', 'B', 'C'], ['Y']]);
  });
});

describe('padlet allocation', () => {
  const now = '2026-10-12T00:00:00.000Z';

  it('moves 미완료 to 완료 가능 for every separate task with one post, and leaves 미부여 alone', () => {
    const result = allocatePadletPosts({
      tasks: [task('A'), task('B', { sortOrder: 2 })], students: STUDENTS,
      stageOf: stages({ A: { S1: 'PENDING', S2: 'PENDING' }, B: { S1: 'PENDING' } }),
      posts: [post('p1', '2026-10-05T01:00:00.000Z', '김민준'), post('p2', '2026-10-05T02:00:00.000Z', '이서연')],
      uses: [], now,
    });
    expect(result.moves).toEqual([
      { taskId: 'A', studentId: 'S1', postId: 'p1', postCreatedAt: '2026-10-05T01:00:00.000Z' },
      { taskId: 'B', studentId: 'S1', postId: 'p1', postCreatedAt: '2026-10-05T01:00:00.000Z' },
      { taskId: 'A', studentId: 'S2', postId: 'p2', postCreatedAt: '2026-10-05T02:00:00.000Z' },
    ]);
    // Newest first, with what each post did for each task.
    expect(result.outcomes.map((outcome) => [outcome.postId, outcome.results])).toEqual([
      ['p2', { A: 'MOVED', B: 'NOT_ASSIGNED' }], ['p1', { A: 'MOVED', B: 'MOVED' }],
    ]);
  });

  it('gives a chain one task per post, in order (A, then B, then C)', () => {
    const chain = [task('A'), task('B', { prerequisiteTaskId: 'A' }), task('C', { prerequisiteTaskId: 'B' })];
    const pending = stages({ A: { S1: 'PENDING' }, B: { S1: 'PENDING' }, C: { S1: 'PENDING' } });
    const one = allocatePadletPosts({ tasks: chain, students: STUDENTS, stageOf: pending,
      posts: [post('p1', '2026-10-05T01:00:00.000Z', '김민준')], uses: [], now });
    expect(one.moves.map((move) => move.taskId)).toEqual(['A']);
    expect(one.outcomes[0].results).toEqual({ A: 'MOVED', B: 'OTHER_TASK', C: 'OTHER_TASK' });

    const three = allocatePadletPosts({ tasks: chain, students: STUDENTS, stageOf: pending,
      posts: [post('p1', '2026-10-05T01:00:00.000Z', '김민준'), post('p2', '2026-10-05T02:00:00.000Z', '김민준'),
        post('p3', '2026-10-05T03:00:00.000Z', '김민준'), post('p4', '2026-10-05T04:00:00.000Z', '김민준')], uses: [], now });
    expect(three.moves.map((move) => [move.postId, move.taskId])).toEqual([['p1', 'A'], ['p2', 'B'], ['p3', 'C']]);
    expect(three.outcomes[0]).toMatchObject({ postId: 'p4', results: { A: 'DONE', B: 'DONE', C: 'DONE' } });
  });

  it('does not use a post twice in a chain, and continues from where earlier syncs stopped', () => {
    const chain = [task('A'), task('B', { prerequisiteTaskId: 'A' })];
    const result = allocatePadletPosts({ tasks: chain, students: STUDENTS,
      // p1 already made A 완료 가능 in an earlier sync; the student has since completed A.
      stageOf: stages({ A: { S1: 'COMPLETED' }, B: { S1: 'PENDING' } }),
      posts: [post('p1', '2026-10-05T01:00:00.000Z', '김민준'), post('p2', '2026-10-06T01:00:00.000Z', '김민준')],
      uses: [{ taskId: 'A', postId: 'p1', studentId: 'S1' }], now });
    expect(result.moves.map((move) => [move.postId, move.taskId])).toEqual([['p2', 'B']]);
  });

  it('never counts a post written before the student became 미완료 (a reset or the teacher\'s change)', () => {
    // S1 was sent back to 미완료 on 10/06; S2 has been 미완료 since 10/01.
    const since = (taskId: string, studentId: string) => (studentId === 'S1' ? '2026-10-06T00:00:00.000123Z' : '2026-10-01T00:00:00.000Z');
    const result = allocatePadletPosts({ tasks: [task('A')], students: STUDENTS,
      stageOf: stages({ A: { S1: 'PENDING', S2: 'PENDING' } }), sinceOf: since,
      posts: [post('old', '2026-10-05T01:00:00.000Z', '김민준'), post('same_ms', '2026-10-06T00:00:00.000Z', '김민준'),
        post('s2', '2026-10-05T02:00:00.000Z', '이서연')], uses: [], now });
    expect(result.moves.map((move) => [move.postId, move.studentId])).toEqual([['s2', 'S2']]);
    expect(result.outcomes.map((outcome) => [outcome.postId, outcome.results])).toEqual([
      ['same_ms', { A: 'EARLIER' }], ['s2', { A: 'MOVED' }], ['old', { A: 'EARLIER' }],
    ]);
    const fresh = allocatePadletPosts({ tasks: [task('A')], students: STUDENTS,
      stageOf: stages({ A: { S1: 'PENDING' } }), sinceOf: since,
      posts: [post('new', '2026-10-06T00:00:01.000Z', '김민준')], uses: [], now });
    expect(fresh.moves.map((move) => move.postId)).toEqual(['new']);
  });

  it('does not hand a post that is too early for the chain\'s next task to a later task', () => {
    const chain = [task('A'), task('B', { prerequisiteTaskId: 'A' })];
    const result = allocatePadletPosts({ tasks: chain, students: STUDENTS,
      stageOf: stages({ A: { S1: 'PENDING' }, B: { S1: 'PENDING' } }),
      // A was reset on 10/06; B has been 미완료 since 10/01.
      sinceOf: (taskId) => (taskId === 'A' ? '2026-10-06T00:00:00.000Z' : '2026-10-01T00:00:00.000Z'),
      posts: [post('old', '2026-10-05T01:00:00.000Z', '김민준')], uses: [], now });
    expect(result.moves).toEqual([]);
    expect(result.outcomes[0].results).toEqual({ A: 'EARLIER', B: 'WAITING' });
  });

  it('skips a chain task the post does not fit, and counts only open, visible, same-section tasks', () => {
    const chain = [task('A', { closesAt: '2026-10-04T00:00:00.000Z' }), task('B', { prerequisiteTaskId: 'A' })];
    const result = allocatePadletPosts({ tasks: chain, students: STUDENTS,
      stageOf: stages({ A: { S1: 'PENDING' }, B: { S1: 'PENDING' } }),
      posts: [post('late', '2026-10-05T01:00:00.000Z', '김민준')], uses: [], now });
    expect(result.moves.map((move) => move.taskId)).toEqual(['B']);

    const others = allocatePadletPosts({
      tasks: [task('early', { opensAt: '2026-10-06T00:00:00.000Z' }), task('hidden', { visible: false }), task('section', { sectionId: 'sec_a' })],
      students: STUDENTS, stageOf: stages({ early: { S1: 'PENDING' }, hidden: { S1: 'PENDING' }, section: { S1: 'PENDING' } }),
      posts: [post('p', '2026-10-05T01:00:00.000Z', '김민준', '', { sectionId: 'sec_b' })], uses: [], now });
    expect(others.moves).toEqual([]);
    expect(others.outcomes[0].results).toEqual({ early: 'OUTSIDE', hidden: 'OUTSIDE', section: 'OUTSIDE' });
  });

  it('reports posts it could not use and ignores future and scheduled posts', () => {
    const result = allocatePadletPosts({ tasks: [task('A')], students: STUDENTS, stageOf: stages({ A: { S1: 'PENDING', S4: 'PENDING' } }),
      posts: [
        post('nobody', '2026-10-05T01:00:00.000Z', '성지환', '오늘의 칭찬'),
        post('waiting', '2026-10-05T02:00:00.000Z', '김민준', '', { status: 'pending_moderation' }),
        post('scheduled', '2026-10-05T03:00:00.000Z', '김민준', '', { status: 'scheduled' }),
        post('gone', '2026-10-05T04:00:00.000Z', '박하늘'),
        post('future', '2026-10-13T00:00:00.000Z', '김민준'),
      ], uses: [], now });
    expect(result.moves).toEqual([]);
    expect(result.outcomes.map((outcome) => [outcome.postId, outcome.issue])).toEqual([
      ['gone', 'INACTIVE_STUDENT'], ['waiting', 'AWAITING_APPROVAL'], ['nobody', 'UNKNOWN'],
    ]);
  });
});
