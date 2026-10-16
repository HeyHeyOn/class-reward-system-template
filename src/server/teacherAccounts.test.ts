import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { AVATAR_PRESETS, defaultAvatarFor } from '@/components/profile/avatar';
import { currentLegalRevision } from '@/lib/legalDocuments';
import {
  createTeacherAccountStore, defaultNickname, legalNoticeFor, loadTeacherAccountView, normalizeNickname, parseProfileInput, resolveTeacherProfile,
  teacherAccountsEnabled,
} from './teacherAccounts';

const avatar = AVATAR_PRESETS[0].config;
const session = { subject: 'google-1', email: 'kim.teacher@example.com', name: '김선생', issuedAt: Date.now() };

describe('teacher accounts', () => {
  it('exist only for the central PostgreSQL service', () => {
    expect(teacherAccountsEnabled({ CLASS_STORE_STORAGE: 'postgresql' })).toBe(true);
    expect(teacherAccountsEnabled({ CLASS_STORE_STORAGE: 'postgresql', NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT: 'generator' })).toBe(false);
    expect(teacherAccountsEnabled({})).toBe(false);
  });

  it('accepts nicknames of 1–20 characters without control characters', () => {
    expect(normalizeNickname('  별빛   쌤 ')).toBe('별빛 쌤');
    expect(normalizeNickname('가'.repeat(20))).toBe('가'.repeat(20));
    expect(normalizeNickname('가'.repeat(21))).toBeNull();
    expect(normalizeNickname('   ')).toBeNull();
    expect(normalizeNickname('a\u0000b')).toBeNull();
    expect(normalizeNickname('a\u202eb')).toBeNull();
    expect(normalizeNickname(42)).toBeNull();
  });

  it('parses a profile only with a known avatar and no extra fields', () => {
    expect(parseProfileInput({ nickname: ' 별빛쌤 ', avatar })).toEqual({ nickname: '별빛쌤', avatar });
    expect(parseProfileInput({ nickname: '별빛쌤', avatar: { ...avatar, face: 'dragon' } })).toBeNull();
    expect(parseProfileInput({ nickname: '별빛쌤', avatar, admin: true })).toBeNull();
    expect(parseProfileInput([])).toBeNull();
  });

  it('starts from the Google name and a stable preset avatar until the teacher saves a profile', () => {
    expect(defaultNickname(session)).toBe('김선생');
    expect(defaultNickname({ email: 'teacher.long-address@example.com' })).toBe('teacher.long-address');
    expect(resolveTeacherProfile(session, null, {})).toEqual({ nickname: '김선생', avatar: defaultAvatarFor('google-1'), avatarUrl: null });
    expect(resolveTeacherProfile(session, { nickname: '햇살쌤', avatar }, {})).toEqual({ nickname: '햇살쌤', avatar, avatarUrl: null });
    expect(resolveTeacherProfile(session, { nickname: '햇살쌤', avatar: { broken: true } }).avatar).toEqual(defaultAvatarFor('google-1'));
  });

  it('draws the icon from the 딴쌤 hub: its own address once the icon follows the hub, else the hub picture of the kept icon', () => {
    const hub = { DDANSSAEM_HUB_URL: 'https://ddanssaem.com' };
    const kept = `https://ddanssaem.com/api/avatar/${[avatar.background, avatar.face, avatar.eyes, avatar.mouth, avatar.accessory].join('.')}.svg`;
    expect(resolveTeacherProfile(session, { nickname: '햇살쌤', avatar, avatarUrl: 'https://ddanssaem.com/api/avatar/x.svg', avatarFromHub: true }, hub).avatarUrl)
      .toBe('https://ddanssaem.com/api/avatar/x.svg');
    expect(resolveTeacherProfile(session, { nickname: '햇살쌤', avatar, avatarUrl: 'https://ddanssaem.com/api/avatar/x.svg', avatarFromHub: false }, hub).avatarUrl).toBe(kept);
    expect(resolveTeacherProfile(session, { nickname: '햇살쌤', avatar }, hub).avatarUrl).toBe(kept);
  });

  it('requires agreement when the session has not agreed to the version in force', () => {
    const current = currentLegalRevision().version;
    expect(legalNoticeFor({ agreement: current }).required).toBeNull();
    const notice = legalNoticeFor({});
    expect(notice.required?.current.version).toBe(current);
    expect(notice.required?.changes.length).toBeGreaterThan(0);
  });

  it('maps the database functions', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('platform_latest_user_agreement')) return { rows: [{ agreement_version: '2026-10-08', agreed_at: new Date('2026-10-08T03:00:00Z') }] };
      if (text.includes('platform_has_user_agreement')) return { rows: [{ agreed: true }] };
      if (text.includes('platform_record_user_agreement')) return { rows: [{ agreed_at: new Date('2026-10-08T03:00:00Z') }] };
      if (text.includes('platform_get_hub_profile')) return { rows: [{ nickname: '햇살쌤', avatar, avatar_url: null, avatar_from_hub: false }] };
      if (text.includes('platform_withdraw_user')) return { rows: [{ closed: 2 }] };
      return { rows: [] };
    });
    const store = createTeacherAccountStore({ query });
    expect(await store.latestAgreement('google-1')).toEqual({ version: '2026-10-08', agreedAt: '2026-10-08T03:00:00.000Z' });
    expect(await store.hasAgreement('google-1', '2026-10-08')).toBe(true);
    expect(await store.recordAgreement('google-1', '2026-10-08')).toBe('2026-10-08T03:00:00.000Z');
    expect(await store.getProfile('google-1')).toEqual({ nickname: '햇살쌤', avatar, avatarUrl: null, avatarFromHub: false });
    await store.saveProfile('google-1', { nickname: '햇살쌤', avatar });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('platform_save_user_profile'), ['google-1', '햇살쌤', JSON.stringify(avatar)]);
    expect(await store.withdraw('google-1')).toBe(2);
  });

  it('shows a default profile when the profile cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createTeacherAccountStore({ query: async () => { throw new Error('down'); } });
    const view = await loadTeacherAccountView(session, store);
    expect(view.profile.nickname).toBe('김선생');
    expect(view.notice.required).not.toBeNull();
    spy.mockRestore();
  });
});
