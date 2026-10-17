import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalHeader, teacherLabel } from './GlobalHeader';
import { GoogleLoginButton } from './GoogleLoginButton';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('GlobalHeader', () => {
  it('shows 딴쌤 / 클래스 with only the features that exist until the hub opens', () => {
    render(<GlobalHeader audience="teacher" account={null} loginHref="/api/google/login?returnTo=%2Fclasses" />);
    expect(screen.getByRole('link', { name: '딴쌤 홈' }).getAttribute('href')).toBe('/classes');
    const menu = screen.getByRole('navigation', { name: '딴쌤 메뉴' });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['클래스', '보드']);
    expect(within(menu).getByRole('link', { name: '클래스' }).getAttribute('aria-current')).toBe('page');
    expect(within(menu).getByRole('link', { name: '보드' }).getAttribute('href')).toBe('https://board.ddanssaem.com');
    expect(screen.queryByText('홈')).toBeNull();
    expect(screen.queryByText('수업 도구')).toBeNull();
    expect(screen.getByRole('link', { name: '로그인' }).getAttribute('href')).toBe('/api/google/login?returnTo=%2Fclasses');
  });

  it('adds 홈 and 문제 은행 and sends the logo to the hub with HUB_READY=1, and keeps 수업 도구 hidden until a tool exists', async () => {
    vi.stubEnv('HUB_READY', '1');
    vi.stubEnv('HUB_HOME_URL', 'https://beta.ddanssaem.com/');
    vi.resetModules();
    const { GlobalHeader: HubHeader } = await import('./GlobalHeader');
    render(<HubHeader audience="teacher" account={null} />);
    expect(screen.getByRole('link', { name: '딴쌤 홈' }).getAttribute('href')).toBe('https://beta.ddanssaem.com');
    const menu = screen.getByRole('navigation', { name: '딴쌤 메뉴' });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['홈', '클래스', '보드', '문제 은행']);
    expect(within(menu).getByRole('link', { name: '문제 은행' }).getAttribute('href')).toBe('https://beta.ddanssaem.com/bank');
    // The phone's ☰ menu has the same items.
    fireEvent.click(screen.getByRole('button', { name: '메뉴' }));
    const phone = screen.getAllByRole('navigation', { name: '딴쌤 메뉴' })[1];
    expect(within(phone).getAllByRole('link').map((link) => link.textContent)).toEqual(['홈', '클래스', '보드', '문제 은행']);
    expect(screen.queryByText('수업 도구')).toBeNull();
  });

  it('opens the account menu with the profile and sign-out for a signed-in teacher', () => {
    render(<GlobalHeader audience="teacher" account={{ nickname: '김하늘' }} />);
    expect(screen.queryByRole('link', { name: '로그인' })).toBeNull();
    const button = screen.getByRole('button', { name: '계정 메뉴' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('김하늘 선생님');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: '내 프로필' }).getAttribute('href')).toBe('/profile');
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('draws the 딴쌤 account icon and offers the name, the e-mail, 딴쌤 계정 and sign-out', () => {
    render(<GlobalHeader audience="teacher" account={{ nickname: '햇살쌤', email: 'sun@example.test',
      avatarUrl: 'https://ddanssaem.com/api/avatar/sky.bear.smile.smile.none.svg', accountUrl: 'https://ddanssaem.com/account' }} />);
    const button = screen.getByRole('button', { name: '계정 메뉴' });
    expect(button.querySelector('img')?.getAttribute('src')).toBe('https://ddanssaem.com/api/avatar/sky.bear.smile.smile.none.svg');
    fireEvent.click(button);
    expect(screen.getByText('햇살쌤', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('sun@example.test')).toBeTruthy();
    expect(screen.getByRole('link', { name: '딴쌤 계정' }).getAttribute('href')).toBe('https://ddanssaem.com/account');
    expect(screen.queryByRole('link', { name: '내 프로필' })).toBeNull();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy();
  });

  it('puts the menu behind ☰ on a phone', () => {
    render(<GlobalHeader audience="teacher" account={null} />);
    fireEvent.click(screen.getByRole('button', { name: '메뉴' }));
    expect(screen.getAllByRole('navigation', { name: '딴쌤 메뉴' })).toHaveLength(2);
  });

  it('shows the class and the student, with no menu or sign-in, on student screens', () => {
    render(<GlobalHeader audience="student" place="6학년 2반" studentName="이서연" />);
    expect(screen.getByText('6학년 2반')).toBeTruthy();
    expect(screen.getByText('이서연')).toBeTruthy();
    expect(screen.getByRole('img', { name: '딴쌤' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('adds 선생님 only when the nickname does not say it', () => {
    expect(teacherLabel('김하늘')).toBe('김하늘 선생님');
    expect(teacherLabel('햇살쌤')).toBe('햇살쌤');
    expect(teacherLabel('김 선생님')).toBe('김 선생님');
    expect(teacherLabel('박교사')).toBe('박교사 선생님');
  });
});

describe('GoogleLoginButton', () => {
  it('is the white standard button with the G and the given address', () => {
    render(<GoogleLoginButton href="/api/google/login?returnTo=%2Fclasses" block />);
    const link = screen.getByRole('link', { name: 'Google로 로그인' });
    expect(link.getAttribute('href')).toBe('/api/google/login?returnTo=%2Fclasses');
    expect(link.style.background).toMatch(/#FFFFFF|rgb\(255, 255, 255\)/i);
    expect(link.style.border).toMatch(/#DADDE2|rgb\(218, 221, 226\)/i);
    expect(link.style.height).toBe('52px');
    expect(link.querySelectorAll('svg path')).toHaveLength(4);
  });
});
