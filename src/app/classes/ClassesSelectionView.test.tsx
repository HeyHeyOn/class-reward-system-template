import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassesSelectionView } from './ClassesSelectionView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ClassesSelectionView', () => {
  it('shows scoped admin/bank links and owner controls, and separates trash from search results', () => {
    const dashboard = { role: 'OWNER' as const, lifecycle: 'ACTIVE' as const, deletedAt: null, managementVersion: '1', createdAt: '2026-01-01T00:00:00Z', studentCount: 24, productCount: 3, taskCount: 2 };
    render(<ClassesSelectionView model={{ kind:'MEMBERSHIPS', accountLabel:'Teacher', memberships:[
      { slug:'owned',displayName:'우리 반',roleLabel:'소유자',lifecycleLabel:'사용 중',href:'/c/owned',selectable:true,dashboard },
      { slug:'shared',displayName:'공동 학급',roleLabel:'관리자',lifecycleLabel:'사용 중',href:'/c/shared',selectable:true,dashboard:{...dashboard,role:'ADMIN'} },
      { slug:'trashed',displayName:'삭제 학급',roleLabel:'소유자',lifecycleLabel:'사용 중지',href:null,selectable:false,dashboard:{...dashboard,lifecycle:'SUSPENDED',deletedAt:'2026-02-01T00:00:00Z'} },
    ]}}/>);
    expect(screen.getByRole('link',{name:'우리 반 관리자 페이지'}).getAttribute('href')).toBe('/c/owned/admin');
    expect(screen.getByRole('link',{name:'우리 반 은행 페이지'}).getAttribute('href')).toBe('/c/owned/bank');
    expect(screen.getByRole('button',{name:'우리 반 삭제'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'공동 학급 삭제'})).toBeNull();
    expect(screen.queryByText('삭제 학급')).toBeNull();
    fireEvent.change(screen.getByRole('textbox',{name:'학급 이름 검색'}),{target:{value:'공동'}});
    expect(screen.queryByText('우리 반')).toBeNull(); expect(screen.getByText('공동 학급')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox',{name:'학급 이름 검색'}),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:/휴지통\s*1/}));
    expect(screen.getByText('삭제 학급')).toBeTruthy();expect(screen.getByRole('button',{name:'학급 복원'})).toBeTruthy();expect(screen.queryByText('우리 반')).toBeNull();
  });
  it('reports logout failure and allows another attempt', async () => {
    const fetcher=vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetcher);
    render(<ClassesSelectionView model={{kind:'MEMBERSHIPS',accountLabel:'Teacher',memberships:[]}}/>);
    fireEvent.click(screen.getByRole('button',{name:'로그아웃'}));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith('/api/google/logout',expect.objectContaining({method:'POST'}));
    expect((screen.getByRole('button',{name:'로그아웃'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('offers only the scoped Google login action when unauthenticated', () => {
    render(<ClassesSelectionView model={{ kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' }} />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' }).getAttribute('href'))
      .toBe('/api/google/login?returnTo=%2Fclasses');
    expect(screen.queryByRole('link', { name: /학급으로 이동/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '새 학급' })).toBeNull();
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
    expect(screen.getByRole('link', { name: '새 학급' }).getAttribute('href')).toBe('/classes/new');
  });
});
