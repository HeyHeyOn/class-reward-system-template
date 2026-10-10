import { describe, expect, it } from 'vitest';
import { currentLegalRevision, LEGAL_REVISIONS, LEGAL_VERSION_PATTERN, revisionsSince, upcomingLegalRevision, type LegalRevision } from './legalDocuments';

const revisions: LegalRevision[] = [
  { version: '2026-10-08', effectiveAt: '2026-10-08T00:00:00+09:00', effectiveLabel: '2026년 10월 8일', changes: ['처음'] },
  { version: '2026-12-01', effectiveAt: '2026-12-01T00:00:00+09:00', effectiveLabel: '2026년 12월 1일', changes: ['둘째'] },
];
const at = (iso: string) => Date.parse(iso);

describe('legal revisions', () => {
  it('uses well-formed, ordered versions', () => {
    expect(LEGAL_REVISIONS.length).toBeGreaterThan(0);
    for (const revision of LEGAL_REVISIONS) {
      expect(revision.version).toMatch(LEGAL_VERSION_PATTERN);
      expect(Number.isNaN(Date.parse(revision.effectiveAt))).toBe(false);
      expect(revision.changes.length).toBeGreaterThan(0);
    }
    expect([...LEGAL_REVISIONS].map((revision) => revision.version)).toEqual([...LEGAL_REVISIONS].map((revision) => revision.version).sort());
  });

  it('switches to a revision exactly when it takes effect, announcing it before', () => {
    expect(currentLegalRevision(at('2026-11-30T23:59:59+09:00'), revisions).version).toBe('2026-10-08');
    expect(upcomingLegalRevision(at('2026-11-24T09:00:00+09:00'), revisions)?.version).toBe('2026-12-01');
    expect(currentLegalRevision(at('2026-12-01T00:00:00+09:00'), revisions).version).toBe('2026-12-01');
    expect(upcomingLegalRevision(at('2026-12-01T00:00:00+09:00'), revisions)).toBeNull();
  });

  it('lists what changed since the agreed version, up to the one in force', () => {
    const after = at('2026-12-02T00:00:00+09:00');
    expect(revisionsSince('2026-10-08', after, revisions).map((revision) => revision.version)).toEqual(['2026-12-01']);
    expect(revisionsSince(undefined, after, revisions).map((revision) => revision.version)).toEqual(['2026-10-08', '2026-12-01']);
    expect(revisionsSince('2026-10-08', at('2026-11-01T00:00:00+09:00'), revisions)).toEqual([]);
  });
});
