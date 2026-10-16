import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassesSelectionView } from './ClassesSelectionView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ClassesSelectionView', () => {
  it('opens a class from its card, keeps 매점 and 은행 on it, puts management in ⋯, and separates trash from search results', () => {
    const dashboard = { role: 'OWNER' as const, lifecycle: 'ACTIVE' as const, deletedAt: null, managementVersion: '1', createdAt: '2026-01-01T00:00:00Z', studentCount: 24, productCount: 3, taskCount: 2 };
    render(<ClassesSelectionView model={{ kind:'MEMBERSHIPS', accountLabel:'Teacher', memberships:[
      { slug:'owned',displayName:'우리 반',roleLabel:'소유자',lifecycleLabel:'사용 중',href:'/c/owned',selectable:true,dashboard },
      { slug:'shared',displayName:'공동 학급',roleLabel:'관리자',lifecycleLabel:'사용 중',href:'/c/shared',selectable:true,dashboard:{...dashboard,role:'ADMIN'} },
      { slug:'trashed',displayName:'삭제 학급',roleLabel:'소유자',lifecycleLabel:'사용 중지',href:null,selectable:false,dashboard:{...dashboard,lifecycle:'SUSPENDED',deletedAt:'2026-02-01T00:00:00Z'} },
    ]}}/>);
    expect(screen.getByRole('link',{name:'우리 반 관리자 페이지'}).getAttribute('href')).toBe('/c/owned/admin');
    expect(screen.getByRole('link',{name:'우리 반 은행 페이지'}).getAttribute('href')).toBe('/c/owned/bank');
    expect(screen.getByRole('link',{name:'우리 반 학급으로 이동'}).getAttribute('href')).toBe('/c/owned');
    fireEvent.click(screen.getByRole('button',{name:'우리 반 학급 관리'}));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['이름 바꾸기','복제','학생 QR 인쇄','매점 주소 복사','휴지통으로']);
    expect(screen.getByRole('menuitem',{name:'학생 QR 인쇄'}).getAttribute('href')).toBe('/c/owned/admin/student-qrs');
    fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});
    fireEvent.click(screen.getByRole('button',{name:'공동 학급 학급 관리'}));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['학생 QR 인쇄','매점 주소 복사']);
    expect(screen.queryByText('삭제 학급')).toBeNull();
    fireEvent.change(screen.getByRole('textbox',{name:'학급 검색'}),{target:{value:'공동'}});
    expect(screen.queryByText('우리 반')).toBeNull(); expect(screen.getByText('공동 학급')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox',{name:'학급 검색'}),{target:{value:''}});
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['전체 2','사용 중 2','준비 중 0','휴지통 1']);
    fireEvent.click(screen.getByRole('tab',{name:'휴지통 1'}));
    expect(screen.getByText('삭제 학급')).toBeTruthy();expect(screen.getByRole('button',{name:'학급 복원'})).toBeTruthy();expect(screen.queryByText('우리 반')).toBeNull();
    expect(screen.getByRole('button',{name:'삭제 학급 완전히 삭제'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'삭제 학급 학급 관리'})).toBeNull();
  });

  it('has no summary boxes or lead sentence, sorts by recent activity first and remembers the order on this device', () => {
    const at = (created: string, active?: string) => ({ role: 'OWNER' as const, lifecycle: 'ACTIVE' as const, deletedAt: null, managementVersion: '1',
      createdAt: created, ...(active ? { lastActivityAt: active } : {}), studentCount: 1, productCount: 0, taskCount: 0 });
    const item = (slug: string, displayName: string, dashboard: ReturnType<typeof at>) => ({ slug, displayName, roleLabel: '소유자', lifecycleLabel: '사용 중', href: `/c/${slug}` as const, selectable: true, dashboard });
    render(<ClassesSelectionView model={{ kind:'MEMBERSHIPS', accountLabel:'Teacher', memberships:[
      item('a', '가 반', at('2026-03-01T00:00:00Z')), item('b', '나 반', at('2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z')), item('c', '다 반', at('2026-02-01T00:00:00Z')),
    ]}}/>);
    const names = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(names()).toEqual(['나 반', '가 반', '다 반']);
    expect(screen.queryByText('학급을 선택하고 오늘의 활동을 시작하세요.')).toBeNull();
    expect(screen.queryByText('등록된 학생')).toBeNull();
    const sort = screen.getByRole('combobox', { name: '정렬' }) as HTMLSelectElement;
    expect([...sort.options].map((option) => option.textContent)).toEqual(['최근 활동순', '최근 만든 순', '이름순']);
    fireEvent.change(sort, { target: { value: 'created' } });
    expect(names()).toEqual(['가 반', '다 반', '나 반']);
    expect(localStorage.getItem('class-list-sort')).toBe('created');
    fireEvent.change(sort, { target: { value: 'activity' } });
  });

  it('shows one line and [새 학급] when there is no class yet', () => {
    render(<ClassesSelectionView model={{ kind: 'MEMBERSHIPS', accountLabel: 'Teacher', memberships: [] }} />);
    expect(screen.getByText('아직 학급이 없어요.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /새 학급/ }).map((link) => link.getAttribute('href'))).toEqual(['/classes/new', '/classes/new']);
  });

  it.each([
    ['signed out', { kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' }],
    ['signed in', { kind: 'MEMBERSHIPS', accountLabel: 'Teacher', memberships: [] }],
  ] as const)('shows the 딴쌤 header and the same footer as the hub when %s', (_label, model) => {
    render(<ClassesSelectionView model={model as never}/>);
    expect(screen.getByRole('link', { name: '딴쌤 홈' }).getAttribute('href')).toBe('/classes');
    expect(screen.getByRole('navigation', { name: '딴쌤 메뉴' })).toBeTruthy();
    for (const removed of ['CLASS REWARD SYSTEM', '선생님의 학급 공간', '나의 교실, 하나의 공간', '함께 성장하는 우리 반']) {
      expect(screen.queryByText(removed, { exact: false })).toBeNull();
    }
    expect(screen.getByText('© 2026 환잇쌤')).toBeTruthy();
    expect(screen.getByRole('link', { name: '이용약관' }).getAttribute('href')).toBe('https://ddanssaem.com/terms');
    expect(screen.getByRole('link', { name: '개인정보 처리방침' }).getAttribute('href')).toBe('https://ddanssaem.com/privacy');
    expect(screen.getByRole('link', { name: '문의 hwanit1105@gmail.com' }).getAttribute('href')).toBe('mailto:hwanit1105@gmail.com');
  });
  it('reports logout failure and allows another attempt', async () => {
    const fetcher=vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetcher);
    render(<ClassesSelectionView model={{kind:'MEMBERSHIPS',accountLabel:'Teacher',memberships:[]}}/>);
    fireEvent.click(screen.getByRole('button',{name:'계정 메뉴'}));
    fireEvent.click(screen.getByRole('button',{name:'로그아웃'}));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith('/api/google/logout',expect.objectContaining({method:'POST'}));
    expect((screen.getByRole('button',{name:'로그아웃'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('offers only the scoped Google login action when unauthenticated', () => {
    render(<ClassesSelectionView model={{ kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' }} />);

    expect(screen.getByRole('link', { name: 'Google로 로그인' }).getAttribute('href'))
      .toBe('/api/google/login?returnTo=%2Fclasses');
    expect(screen.queryByRole('link', { name: /학급으로 이동/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '새 학급' })).toBeNull();
  });

  it('offers to sign in again through the 딴쌤 hub after a failed sign-in, without its own Google button', () => {
    render(<ClassesSelectionView model={{ kind: 'LOGIN_REQUIRED', loginHref: '/api/auth/ddanssaem/start?next=%2Fclasses' }} loginFailed />);
    expect(screen.getByRole('heading', { name: '로그인하지 못했어요' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '다시 로그인' }).getAttribute('href')).toBe('/api/auth/ddanssaem/start?next=%2Fclasses');
    expect(screen.queryByText('Google 계정으로 로그인하면 내 학급을 확인하거나 새 학급을 만들 수 있어요.')).toBeNull();
  });

  it('links the signed-in teacher to the 딴쌤 account and asks for a pending agreement', () => {
    const revision = { version: '2026-10-08', effectiveAt: '2026-10-08T00:00:00+09:00', effectiveLabel: '2026년 10월 8일', changes: ['이용약관을 새로 마련했어요.'] };
    const avatar = { v: 1 as const, background: 'sky', face: 'bear', eyes: 'smile', mouth: 'smile', accessory: 'none' };
    const header = { nickname: '햇살쌤', email: 'sun@example.test', avatarUrl: 'https://ddanssaem.com/api/avatar/sky.bear.smile.smile.none.svg', accountUrl: 'https://ddanssaem.com/account' };
    render(<ClassesSelectionView model={{ kind: 'MEMBERSHIPS', accountLabel: 'Teacher', memberships: [] }} header={header}
      account={{ profile: { nickname: '햇살쌤', avatar, avatarUrl: header.avatarUrl }, header, notice: { required: { current: revision, changes: [revision] }, upcoming: null } }} />);
    fireEvent.click(screen.getByRole('button', { name: '계정 메뉴' }));
    expect(screen.getByText('햇살쌤', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '딴쌤 계정' }).getAttribute('href')).toBe('https://ddanssaem.com/account');
    expect(screen.getByRole('dialog', { name: '약관 동의가 필요해요' })).toBeTruthy();
  });

  it('confirms a finished withdrawal on the sign-in screen', () => {
    render(<ClassesSelectionView model={{ kind: 'LOGIN_REQUIRED', loginHref: '/api/google/login?returnTo=%2Fclasses' }} withdrawn />);
    expect(screen.getByRole('status').textContent).toBe('회원 탈퇴가 끝났어요. 그동안 딴쌤 클래스를 이용해 주셔서 고마워요.');
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
    expect(screen.getByText('지금은 선택할 수 없어요.')).not.toBeNull();
    expect(screen.getByRole('link', { name: '새 학급' }).getAttribute('href')).toBe('/classes/new');
  });
});
