import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClassesSelectionView } from './ClassesSelectionView';

describe('ClassesSelectionView', () => {
  it('offers only the scoped Google login action when unauthenticated', () => {
    render(<ClassesSelectionView model={{ kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' }} />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' }).getAttribute('href'))
      .toBe('/api/google/login?returnTo=%2Fclasses');
    expect(screen.queryByRole('link', { name: /학급으로 이동/ })).toBeNull();
  });

  it('renders canonical active links and leaves suspended memberships non-navigable', () => {
    render(<ClassesSelectionView model={{
      kind: 'MEMBERSHIPS',
      accountLabel: 'Teacher A',
      memberships: [
        {
          slug: 'active-class', displayName: '활성 학급', roleLabel: '소유자',
          lifecycleLabel: '사용 중', href: '/c/active-class', selectable: true,
        },
        {
          slug: 'suspended-class', displayName: '중지 학급', roleLabel: '관리자',
          lifecycleLabel: '사용 중지', href: null, selectable: false,
        },
      ],
    }} />);

    expect(screen.getByRole('link', { name: '활성 학급 학급으로 이동' }).getAttribute('href'))
      .toBe('/c/active-class');
    expect(screen.getByText('소유자')).not.toBeNull();
    expect(screen.getByText('사용 중지')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /중지 학급/ })).toBeNull();
    expect(screen.getByText('현재 선택할 수 없습니다.')).not.toBeNull();
  });
});
