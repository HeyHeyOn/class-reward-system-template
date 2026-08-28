import { describe, expect, it } from 'vitest';
import { selectEligibleTaskEvidence } from './taskEvidenceEligibility';

const posts = [
  { id: 'z-last', approved: true, createdAt: '2026-08-03T00:00:00.000Z', author: { fullName: ' 김학생 ' } },
  { id: 'b-same-time', approved: true, createdAt: '2026-08-02T00:00:00.000Z', author: { fullName: '김학생' } },
  { id: 'a-same-time', approved: true, createdAt: '2026-08-02T00:00:00.000Z', author: { fullName: '김학생' } },
  { id: 'at-boundary', approved: true, createdAt: '2026-08-01T00:00:00.000Z', author: { fullName: '김학생' } },
  { id: 'too-old', approved: true, createdAt: '2026-07-31T23:59:59.999Z', author: { fullName: '김학생' } },
  { id: 'pending', approved: false, createdAt: '2026-08-01T01:00:00.000Z', author: { fullName: '김학생' } },
  { id: 'wrong-case', approved: true, createdAt: '2026-08-01T01:00:00.000Z', author: { fullName: '김학생A' } },
  { id: 'anonymous', approved: true, createdAt: '2026-08-01T01:00:00.000Z', author: null },
];

describe('selectEligibleTaskEvidence', () => {
  it('matches trimmed fullName exactly and case-sensitively, enforcing approval, cycle, and claims', () => {
    const result = selectEligibleTaskEvidence({
      studentName: '  김학생  ',
      posts,
      cycleStartsAt: '2026-08-01T00:00:00.000Z',
      claimedPostIds: new Set(['at-boundary']),
    });

    expect(result.map((post) => post.id)).toEqual(['a-same-time', 'b-same-time', 'z-last']);
  });

  it('includes a post created exactly at cycleStartsAt when unclaimed', () => {
    const result = selectEligibleTaskEvidence({
      studentName: '김학생',
      posts: [posts[3]],
      cycleStartsAt: posts[3].createdAt,
      claimedPostIds: [],
    });

    expect(result).toEqual([posts[3]]);
  });

  it('does not mutate the source order while returning deterministic createdAt then id order', () => {
    const source = [posts[0], posts[1], posts[2]];
    selectEligibleTaskEvidence({
      studentName: '김학생',
      posts: source,
      cycleStartsAt: '2026-08-01T00:00:00.000Z',
      claimedPostIds: [],
    });

    expect(source.map((post) => post.id)).toEqual(['z-last', 'b-same-time', 'a-same-time']);
  });
});
