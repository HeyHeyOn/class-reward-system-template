import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';

const session = {
  subject: 'subject-a',
  email: 'a@example.com',
  name: 'Teacher A',
  issuedAt: 1,
};

describe('class membership page access', () => {
  it('requires an ordinary Google identity session without querying memberships', async () => {
    const listByGoogleSubject = vi.fn();

    await expect(loadClassMembershipPage(
      new Request('https://example.com/classes?subject=subject-b', {
        headers: { 'x-google-subject': 'subject-b' },
      }),
      { getSession: () => null, listByGoogleSubject },
    )).resolves.toEqual({ kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' });
    expect(listByGoogleSubject).not.toHaveBeenCalled();
  });

  it('derives membership authority only from the authenticated session subject', async () => {
    const listByGoogleSubject = vi.fn(async () => [{
      slug: 'active-class', displayName: '활성 학급', role: 'OWNER' as const, lifecycle: 'ACTIVE' as const,
    }]);
    const request = new Request('https://example.com/classes?subject=subject-b', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-google-subject': 'subject-b',
        'x-user-id': 'subject-b',
      },
      body: JSON.stringify({ subject: 'subject-b', googleSubject: 'subject-b' }),
    });

    const result = await loadClassMembershipPage(request, {
      getSession: () => session,
      listByGoogleSubject,
    });

    expect(listByGoogleSubject).toHaveBeenCalledExactlyOnceWith('subject-a');
    expect(result).toEqual({
      kind: 'MEMBERSHIPS',
      accountLabel: 'Teacher A',
      memberships: [{
        slug: 'active-class',
        displayName: '활성 학급',
        roleLabel: '소유자',
        lifecycleLabel: '사용 중',
        href: '/c/active-class',
        selectable: true,
      }],
    });
  });

  it.each([
    ['DRAFT', '준비 중'],
    ['IMPORTING', '가져오는 중'],
    ['READY', '활성화 대기'],
    ['MIGRATION_READ_ONLY', '읽기 전용 전환 중'],
    ['SUSPENDED', '사용 중지'],
  ] as const)('shows %s membership safely without a navigable tenant link', async (lifecycle, lifecycleLabel) => {
    const result = await loadClassMembershipPage(new Request('https://example.com/classes'), {
      getSession: () => session,
      listByGoogleSubject: async () => [{
        slug: 'inactive-class', displayName: '비활성 학급', role: 'ADMIN', lifecycle,
      }],
    });

    expect(result).toEqual({
      kind: 'MEMBERSHIPS',
      accountLabel: 'Teacher A',
      memberships: [{
        slug: 'inactive-class',
        displayName: '비활성 학급',
        roleLabel: '관리자',
        lifecycleLabel,
        href: null,
        selectable: false,
      }],
    });
  });
});
