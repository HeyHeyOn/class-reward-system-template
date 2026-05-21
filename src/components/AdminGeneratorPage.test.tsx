import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGeneratorPage } from './AdminGeneratorPage';

function stubGeneratorFetch(createResponse?: Record<string, unknown>) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/google/session') {
      return {
        ok: true,
        json: async () => ({ enabled: true, authenticated: true, email: 'teacher@example.com', name: '김선생님' }),
      };
    }
    if (url === '/api/generator/create' && init?.method === 'POST') {
      return {
        ok: true,
        json: async () => createResponse ?? ({
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
            { name: 'ADMIN_PASSWORD', value: '생성 시 정한 관리자 암호', secret: true },
            { name: 'AUTH_SECRET', value: '무작위 긴 문자열로 직접 설정', secret: true },
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

describe('AdminGeneratorPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows only the Google login start page when the teacher is not authenticated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, authenticated: false }),
    }));

    render(<AdminGeneratorPage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '학급 보상 시스템 생성기' })).toBeTruthy());
    expect(screen.getByText(/먼저 Google 로그인을 해 주세요/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Google로 시작하기' }).getAttribute('href')).toBe('/api/google/login');
    expect(screen.queryByText('시스템 생성하기')).toBeNull();
    expect(screen.queryByText('관리자 센터로 돌아가기')).toBeNull();
    expect(screen.queryByText('현재 운영 매점 열기')).toBeNull();
  });

  it('after login shows a simple create-or-update choice before any long instructions', async () => {
    stubGeneratorFetch();

    render(<AdminGeneratorPage />);

    await waitFor(() => expect(screen.getByText(/teacher@example.com/)).toBeTruthy());
    expect(screen.getByRole('heading', { name: '무엇을 할까요?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '새 시스템 생성하기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기존 시스템 업데이트하기' })).toBeTruthy();
    expect(screen.queryByLabelText('학급명')).toBeNull();
  });

  it('shows a friendly Vercel redeploy guide for updating an existing system', async () => {
    stubGeneratorFetch();

    render(<AdminGeneratorPage />);
    await waitFor(() => screen.getByRole('button', { name: '기존 시스템 업데이트하기' }));
    fireEvent.click(screen.getByRole('button', { name: '기존 시스템 업데이트하기' }));

    expect(screen.getByRole('heading', { name: '기존 앱 업데이트 안내' })).toBeTruthy();
    expect(screen.getByText(/데이터가 들어 있는 Google 스프레드시트는 그대로 사용합니다/)).toBeTruthy();
    expect(screen.getByText(/Vercel 대시보드에서 기존 프로젝트를 다시 배포하면 됩니다/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vercel 프로젝트 목록 열기' }).getAttribute('href')).toBe('https://vercel.com/dashboard');
    expect(screen.getByText(/class-store 또는 학급 보상 시스템 프로젝트를 선택/)).toBeTruthy();
    expect(screen.getAllByText(/Deployments 탭/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Redeploy/).length).toBeGreaterThan(0);
    expect(screen.getByText(/환경변수를 다시 만들 필요는 없습니다/)).toBeTruthy();
    expect(screen.getByText(/업데이트 뒤에는 관리자 페이지에서 생성기 탭이 사라졌는지 확인/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '처음 선택으로 돌아가기' })).toBeTruthy();
  });

  it('requires acknowledging the self-deployment notice before moving to settings', async () => {
    stubGeneratorFetch();

    render(<AdminGeneratorPage />);
    await waitFor(() => screen.getByRole('button', { name: '새 시스템 생성하기' }));
    fireEvent.click(screen.getByRole('button', { name: '새 시스템 생성하기' }));

    expect(screen.getByRole('heading', { name: '시작 전에 확인해 주세요' })).toBeTruthy();
    expect(screen.getByText(/운영 앱은 선생님 개인 Vercel 프로젝트에 배포됩니다/)).toBeTruthy();
    const nextButton = screen.getByRole('button', { name: '기본 설정으로 이동' });
    expect(nextButton).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByLabelText('위 내용을 충분히 숙지했습니다.'));
    expect(nextButton).toHaveProperty('disabled', false);
  });

  it('renders the settings page with dry-run preview and creates the spreadsheet only after the wizard steps', async () => {
    const fetchSpy = stubGeneratorFetch();

    render(<AdminGeneratorPage />);
    await waitFor(() => screen.getByRole('button', { name: '새 시스템 생성하기' }));
    fireEvent.click(screen.getByRole('button', { name: '새 시스템 생성하기' }));
    fireEvent.click(screen.getByLabelText('위 내용을 충분히 숙지했습니다.'));
    fireEvent.click(screen.getByRole('button', { name: '기본 설정으로 이동' }));

    expect(screen.getByRole('heading', { name: '시트 생성을 위한 기본 설정' })).toBeTruthy();
    expect(screen.getByLabelText('학급명')).toBeTruthy();
    expect(screen.getByLabelText('매점 이름')).toHaveProperty('value', '학급 매점');
    expect(screen.getByLabelText('은행 이름')).toHaveProperty('value', '학급 은행');
    expect(screen.getByLabelText('화폐 단위')).toHaveProperty('value', '원');
    expect(screen.getByText(/Students/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('학급명'), { target: { value: '4학년 1반' } });
    fireEvent.click(screen.getByRole('button', { name: 'Google Sheets 생성하고 Vercel 안내 보기' }));

    await waitFor(() => expect(screen.getByText('생성 완료')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith('/api/generator/create', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"selfServiceAcknowledged":true'),
    }));
  });

  it('renders a final step-by-step Vercel deployment guide after creation', async () => {
    stubGeneratorFetch();

    render(<AdminGeneratorPage />);
    await waitFor(() => screen.getByRole('button', { name: '새 시스템 생성하기' }));
    fireEvent.click(screen.getByRole('button', { name: '새 시스템 생성하기' }));
    fireEvent.click(screen.getByLabelText('위 내용을 충분히 숙지했습니다.'));
    fireEvent.click(screen.getByRole('button', { name: '기본 설정으로 이동' }));
    fireEvent.click(screen.getByRole('button', { name: 'Google Sheets 생성하고 Vercel 안내 보기' }));

    await waitFor(() => expect(screen.getByText('생성 완료')).toBeTruthy());
    expect(screen.getAllByText('sheet-123').length).toBeGreaterThan(0);
    expect(screen.getByText('선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트')).toBeTruthy();
    expect(screen.getByRole('link', { name: '1단계: Vercel 배포 페이지 열기' }).getAttribute('href')).toContain('vercel.com/new/clone');
    expect(screen.getByRole('heading', { name: '이제 Vercel에서 이렇게 누르세요' })).toBeTruthy();
    expect(screen.getByText(/GitHub 계정으로 Vercel에 로그인합니다/)).toBeTruthy();
    expect(screen.getByText(/Continue with GitHub가 보이면 그 버튼을 누릅니다/)).toBeTruthy();
    expect(screen.getByText(/학급 보상 시스템 템플릿 저장소를 찾고 Import를 누릅니다/)).toBeTruthy();
    expect(screen.getByText(/운영 앱이 생성된 시트를 읽고 쓰려면 6개 환경변수를 모두 입력해야 합니다/)).toBeTruthy();
    expect(screen.getByText('GOOGLE_CLIENT_ID')).toBeTruthy();
    expect(screen.getByText('GOOGLE_CLIENT_SECRET (비밀값)')).toBeTruthy();
    expect(screen.getByText('GOOGLE_REFRESH_TOKEN (비밀값)')).toBeTruthy();
    expect(screen.getByText(/비밀값은 다른 사람에게 공유하지 말고 Vercel 환경변수 칸에만 붙여넣으세요/)).toBeTruthy();
    expect(screen.getByText(/운영 앱이 생성된 시트를 읽고 쓰려면 6개 환경변수를 모두 입력해야 합니다/)).toBeTruthy();
    expect(screen.getByText(/Deploy 버튼을 누른 뒤 Ready가 나올 때까지 기다립니다/)).toBeTruthy();
    expect(screen.getByText(/배포 완료 후 제공되는 vercel.app 주소가 선생님 전용 URL입니다/)).toBeTruthy();
    expect(screen.getByText(/막히면 화면을 닫지 말고 오류 문구를 복사/)).toBeTruthy();
  });
});
