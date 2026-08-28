export type TaskEvidencePost = {
  id: string;
  approved: boolean;
  createdAt: string;
  author: { fullName: string | null } | null;
};

export function selectEligibleTaskEvidence<T extends TaskEvidencePost>({
  studentName,
  posts,
  cycleStartsAt,
  claimedPostIds,
}: {
  studentName: string;
  posts: readonly T[];
  cycleStartsAt: string;
  claimedPostIds: ReadonlySet<string> | readonly string[];
}): T[] {
  const expectedName = studentName.trim();
  const cycleStart = Date.parse(cycleStartsAt);
  if (!expectedName || !Number.isFinite(cycleStart)) return [];

  const claimed = claimedPostIds instanceof Set
    ? claimedPostIds
    : new Set(claimedPostIds);

  return posts
    .filter((post) => {
      const createdAt = Date.parse(post.createdAt);
      return post.approved
        && post.author?.fullName?.trim() === expectedName
        && Number.isFinite(createdAt)
        && createdAt >= cycleStart
        && !claimed.has(post.id);
    })
    .slice()
    .sort((left, right) => {
      const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (byCreatedAt) return byCreatedAt;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
}
