import { describe, expect, it } from 'vitest';
import { blocksNewClass, daysUntilRequired, isVerified, newClassNote, reminderDays } from './teacherVerification';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const at = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe('교사 인증 rules (account-protocol 10-4)', () => {
  it('blocks a new class only when verification is required now and missing or ended', () => {
    // During the grace (required later): not blocked, verified or not.
    expect(blocksNewClass({ verifiedUntil: null, requiredFrom: at(25) }, NOW)).toBe(false);
    // The grace ended, never verified: blocked.
    expect(blocksNewClass({ verifiedUntil: null, requiredFrom: at(-1) }, NOW)).toBe(true);
    // Verified: not blocked.
    expect(blocksNewClass({ verifiedUntil: at(200), requiredFrom: at(-1) }, NOW)).toBe(false);
    // The verification ended: blocked again.
    expect(blocksNewClass({ verifiedUntil: at(-2), requiredFrom: at(-30) }, NOW)).toBe(true);
    // The hub has no start yet, or nothing is known: never blocked.
    expect(blocksNewClass({ verifiedUntil: null, requiredFrom: null }, NOW)).toBe(false);
    expect(blocksNewClass(null, NOW)).toBe(false);
    expect(isVerified({ verifiedUntil: at(1), requiredFrom: null }, NOW)).toBe(true);
  });

  it('reminds within 30 days of the end and once it ended, not before and not for a teacher never verified', () => {
    expect(reminderDays({ verifiedUntil: at(12.5), requiredFrom: null }, NOW)).toBe(13);
    expect(reminderDays({ verifiedUntil: at(30), requiredFrom: null }, NOW)).toBe(30);
    expect(reminderDays({ verifiedUntil: at(31), requiredFrom: null }, NOW)).toBeNull();
    expect(reminderDays({ verifiedUntil: at(-3), requiredFrom: null }, NOW)).toBe(0);
    expect(reminderDays({ verifiedUntil: null, requiredFrom: at(-3) }, NOW)).toBeNull();
  });

  it('counts the days of grace left, and says what the class list shows', () => {
    expect(daysUntilRequired({ verifiedUntil: null, requiredFrom: at(25) }, NOW)).toBe(25);
    expect(daysUntilRequired({ verifiedUntil: at(300), requiredFrom: at(25) }, NOW)).toBeNull();
    expect(newClassNote({ verifiedUntil: null, requiredFrom: at(25) }, NOW)).toEqual({ kind: 'soon', days: 25 });
    expect(newClassNote({ verifiedUntil: null, requiredFrom: at(-1) }, NOW)).toEqual({ kind: 'blocked' });
    expect(newClassNote({ verifiedUntil: at(300), requiredFrom: at(-1) }, NOW)).toBeNull();
    expect(newClassNote({ verifiedUntil: null, requiredFrom: at(45) }, NOW)).toBeNull();
  });
});
