import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGeneratorPage } from './AdminGeneratorPage';

function stubGeneratorFetch(options?: { authenticated?: boolean; createResponse?: Record<string, unknown> }) {
  const authenticated = options?.authenticated ?? true;
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/google/session') {
      return {
        ok: true,
        json: async () => authenticated
          ? ({ enabled: true, authenticated: true, email: 'teacher@example.com', name: '김선생님' })
          : ({ enabled: true, authenticated: false }),
      };
    }
    if (url === '/api/generator/create' && init?.method === 'POST') {
      return {
        ok: true,
        json: async () => options?.createResponse ?? ({
          ok: true,
          spreadsheetId: 'sheet-123',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
          title: '4학년 1반 - 학급 보상 시스템',
          initializedSheets: ['Students', 'Products'],
          authMode: 'google-login',
          requiredVercelEnv: [
            { name: 'GOOGLE_SHEET_ID', value: 'sheet-123', secret: false },
            { name: 'GOOGLE_CLIENT_ID', value: 'client-id-123.apps.googleusercontent.com', secret: false },
            { name: 'GOOGLE_CLIENT_SECRET', value: 'client-secret-123', secret: true },
            { name: 'GOOGLE_REFRESH_TOKEN', value: 'refresh-token-123', secret: true },
            { name: 'ADMIN_PASSWORD', value: 'teacher@example.com', secret: true },
            { name: 'AUTH_SECRET', value: 'random-auth-secret', secret: true },
          ],
          nextSteps: ['학생과 상품을 입력합니다.'],
          deploymentGuide: {
            ownership: '선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트',
            vercelImportUrl: 'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fexample%2Fclass-store-template',
            checklist: ['개인 Vercel 계정으로 Import Project를 진행합니다.'],
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

async function goToCreateNotice() {
  await waitFor(() => screen.getByRole('button', { name: '새 시스템 생성하기' }));
  fireEvent.click(screen.getByRole('button', { name: '새 시스템 생성하기' }));
}

async function passNotice() {
  fireEvent.click(screen.getByLabelText('위 안내를 읽었으며 개인 서버 URL, 비밀번호, 구글 시트 관리 책임을 이해했습니다.'));
  fireEvent.click(screen.getByRole('button', { name: 'Google 로그인으로 이동' }));
}

async function goThroughAuthenticatedCreateSteps() {
  await goToCreateNotice();
  await passNotice();
  fireEvent.click(screen.getByRole('button', { name: 'Google 로그인 완료, 다음' }));
  expect(screen.getByRole('heading', { name: 'Vercel 로그인하기' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Vercel 열기' }).getAttribute('href')).toBe('https://vercel.com/login');
  fireEvent.click(screen.getByRole('button', { name: '로그인/가입을 완료했습니다' }));
  expect(screen.getByRole('heading', { name: 'GitHub 로그인하기' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'GitHub 열기' }).getAttribute('href')).toBe('https://github.com/login');
  fireEvent.click(screen.getByRole('button', { name: '로그인/가입을 완료했습니다' }));
}

describe('AdminGeneratorPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts with the system explanation and create-or-update choice before Google login', async () => {
    stubGeneratorFetch({ authenticated: false });

    const { container } = render(<AdminGeneratorPage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '학급 보상 시스템 생성기' })).toBeTruthy());
    expect(container.querySelector('main')?.className).toContain('bg-slate-100');
    expect(screen.getByRole('heading', { name: '학급 보상 시스템 만들기' })).toBeTruthy();
    expect(screen.getByText(/구글 스프레드시트와 개인 Vercel 서버를 이용해/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '새 시스템 생성하기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기존 시스템 업데이트하기' })).toBeTruthy();
    expect(screen.queryByText(/먼저 Google 로그인을 해 주세요/)).toBeNull();
    expect(screen.queryByText('관리자 센터로 돌아가기')).toBeNull();
    expect(screen.queryByText('현재 운영 매점 열기')).toBeNull();
  });

  it('allows update guidance without Google authentication', async () => {
    stubGeneratorFetch({ authenticated: false });

    render(<AdminGeneratorPage />);
    await waitFor(() => screen.getByRole('button', { name: '기존 시스템 업데이트하기' }));
    fireEvent.click(screen.getByRole('button', { name: '기존 시스템 업데이트하기' }));

    expect(screen.getByRole('heading', { name: '시스템 업데이트하기' })).toBeTruthy();
    expect(screen.getByText(/기존 시스템 업데이트는 Google 로그인이 필요하지 않습니다/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GitHub 열기' }).getAttribute('href')).toBe('https://github.com');
    expect(screen.getByText(/1단계: GitHub에 로그인하세요/)).toBeTruthy();
    expect(screen.getByText(/2단계: 자신의 학급 보상 시스템 저장소\(repository\)로 이동하세요/)).toBeTruthy();
    expect(screen.getByText(/3단계: Actions 탭으로 이동하세요/)).toBeTruthy();
    expect(screen.getByText(/4단계: Update from template 워크플로우를 선택하세요/)).toBeTruthy();
    expect(screen.getByText(/5단계: Run workflow를 눌러 업데이트 워크플로우를 시작하세요/)).toBeTruthy();
    expect(screen.getByText(/6단계: 실행 완료 후 2~3분 정도 기다리세요/)).toBeTruthy();
    expect(screen.getByText(/기존 Google Sheet와 Vercel 환경변수는 그대로/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '처음 선택으로 돌아가기' })).toBeTruthy();
  });

  it('requires acknowledging the detailed notice before the Google login step', async () => {
    stubGeneratorFetch({ authenticated: false });

    render(<AdminGeneratorPage />);
    await goToCreateNotice();

    expect(screen.getByRole('heading', { name: '중요한 일러두기' })).toBeTruthy();
    expect(screen.getByText(/학급 보상 시스템은 개인 서버를 이용하여 작동하는 온라인 웹 애플리케이션입니다/)).toBeTruthy();
    expect(screen.getByText(/Google, Vercel, GitHub 세 사이트의 로그인을 필요로 합니다/)).toBeTruthy();
    expect(screen.getByText(/개인 서버 URL과 암호가 함께 유출될 경우/)).toBeTruthy();
    const nextButton = screen.getByRole('button', { name: 'Google 로그인으로 이동' });
    expect(nextButton).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByLabelText('위 안내를 읽었으며 개인 서버 URL, 비밀번호, 구글 시트 관리 책임을 이해했습니다.'));
    expect(nextButton).toHaveProperty('disabled', false);
  });

  it('places Google login after the notice and blocks creation steps until authenticated', async () => {
    stubGeneratorFetch({ authenticated: false });

    render(<AdminGeneratorPage />);
    await goToCreateNotice();
    await passNotice();

    expect(screen.getByRole('heading', { name: 'Google 로그인하기' })).toBeTruthy();
    expect(screen.getByText(/이용하실 Google 계정으로 로그인하여 스프레드시트 권한을 부여/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Google로 로그인하기' }).getAttribute('href')).toBe('/api/google/login');
    expect(screen.getByRole('button', { name: 'Google 로그인 완료, 다음' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('heading', { name: 'Vercel 로그인하기' })).toBeNull();
  });

  it('renders Vercel and GitHub preparation steps before the settings/create page', async () => {
    stubGeneratorFetch({ authenticated: true });

    render(<AdminGeneratorPage />);
    await goThroughAuthenticatedCreateSteps();

    expect(screen.getByRole('heading', { name: 'Vercel 배포 준비하기' })).toBeTruthy();
    expect(screen.getByLabelText('학급명')).toBeTruthy();
    expect(screen.getByLabelText('매점 이름')).toHaveProperty('value', '학급 매점');
    expect(screen.getByLabelText('은행 이름')).toHaveProperty('value', '학급 은행');
    expect(screen.getByLabelText('화폐 단위')).toHaveProperty('value', '원');
    expect(screen.getByLabelText('테마')).toHaveProperty('value', 'white');
    expect(screen.getByText(/Students/)).toBeTruthy();
  });

  it('creates the spreadsheet and renders the final Vercel clone/deploy guide', async () => {
    const fetchSpy = stubGeneratorFetch({ authenticated: true });

    render(<AdminGeneratorPage />);
    await goThroughAuthenticatedCreateSteps();
    fireEvent.change(screen.getByLabelText('학급명'), { target: { value: '4학년 1반' } });
    fireEvent.click(screen.getByRole('button', { name: '주요 환경변수 만들고 배포 안내 보기' }));

    await waitFor(() => expect(screen.getByText('학급 보상 시스템 구축 완료')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith('/api/generator/create', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"selfServiceAcknowledged":true'),
    }));
    expect(screen.getAllByText('sheet-123').length).toBeGreaterThan(0);
    expect(screen.getByText('선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vercel 배포 페이지 열기' }).getAttribute('href')).toContain('vercel.com/new/clone');
    expect(screen.getByRole('heading', { name: 'Vercel에서 GitHub 프로젝트 복제 및 배포하기' })).toBeTruthy();
    expect(screen.getByText(/복제할 학급 보상 시스템 템플릿과 연결할 GitHub 계정을 확인/)).toBeTruthy();
    expect(screen.getByText(/아래 값들을 Vercel Environment Variables에 붙여넣고 Deploy 버튼을 누릅니다/)).toBeTruthy();
    expect(screen.getByText(/보통 2~3분 정도 걸립니다/)).toBeTruthy();
    expect(screen.getByText(/도메인 주소를 복사해 보관합니다/)).toBeTruthy();
    expect(screen.getByText(/초기 비밀번호는 사용한 Google 계정 메일 주소입니다/)).toBeTruthy();
    expect(screen.getByText('GOOGLE_CLIENT_ID')).toBeTruthy();
    expect(screen.getByText('GOOGLE_CLIENT_SECRET (비밀값)')).toBeTruthy();
    expect(screen.getByText('GOOGLE_REFRESH_TOKEN (비밀값)')).toBeTruthy();
    expect(screen.getByText(/비밀값은 다른 사람에게 공유하지 말고 Vercel 환경변수 칸에만 붙여넣으세요/)).toBeTruthy();
  });
});
