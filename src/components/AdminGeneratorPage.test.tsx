import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGeneratorPage } from './AdminGeneratorPage';

describe('AdminGeneratorPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders an executable generator page with dry-run preview and create action', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AdminGeneratorPage />);

    expect(screen.getByRole('heading', { name: '시스템 생성기' })).toBeTruthy();
    expect(screen.getByLabelText('학급명')).toBeTruthy();
    expect(screen.getByLabelText('매점 이름')).toHaveProperty('value', '학급 매점');
    expect(screen.getByLabelText('은행 이름')).toHaveProperty('value', '학급 은행');
    expect(screen.getByLabelText('화폐 단위')).toHaveProperty('value', '원');
    expect(screen.getByLabelText('테마')).toHaveProperty('value', 'blue');
    expect(screen.getByText('실제 Google Sheets 템플릿 생성을 실행합니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '새 학급 매점 시스템 생성' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/필수 시트와 헤더/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Students/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('updates the dry-run manifest preview from form fields without exposing secrets', () => {
    render(<AdminGeneratorPage />);

    fireEvent.change(screen.getByLabelText('학급명'), { target: { value: '4학년 1반' } });
    fireEvent.change(screen.getByLabelText('매점 이름'), { target: { value: '별빛 매점' } });
    fireEvent.change(screen.getByLabelText('은행 이름'), { target: { value: '별빛 은행' } });
    fireEvent.change(screen.getByLabelText('화폐 단위'), { target: { value: '별' } });
    fireEvent.change(screen.getByLabelText('테마'), { target: { value: 'purple' } });
    fireEvent.click(screen.getByLabelText('관리자 암호 설정 완료'));

    const preview = screen.getByTestId('generator-preview').textContent ?? '';
    expect(preview).toContain('0.4.0-phase3');
    expect(preview).toContain('className: 4학년 1반');
    expect(preview).toContain('appTitle: 별빛 매점');
    expect(preview).toContain('bankTitle: 별빛 은행');
    expect(preview).toContain('currencyUnit: 별');
    expect(preview).toContain('themeColor: purple');
    expect(preview).toContain('adminPasswordConfigured: yes');
    expect(preview).toContain('GOOGLE_SHEET_ID, ADMIN_PASSWORD, AUTH_SECRET');
    expect(preview).not.toContain('password=');
    expect(preview).not.toContain('token');
  });

  it('requires teachers to acknowledge personal-account deployment terms before creating', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AdminGeneratorPage />);

    expect(screen.getByText(/운영 앱은 선생님 개인 Vercel 프로젝트에 배포됩니다/)).toBeTruthy();
    expect(screen.getByText(/데이터는 선생님 개인 Google 계정의 스프레드시트에 저장됩니다/)).toBeTruthy();
    const createButton = screen.getByRole('button', { name: '새 학급 매점 시스템 생성' });
    expect(createButton).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByLabelText('위 내용을 충분히 숙지했습니다.'));

    expect(createButton).toHaveProperty('disabled', false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the create API with self-service acknowledgement and renders the generated deployment guide', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
        title: '4학년 1반 - 학급 보상 시스템',
        initializedSheets: ['Students', 'Products'],
        authMode: 'google-login',
        requiredVercelEnv: [{ name: 'GOOGLE_SHEET_ID', value: 'sheet-123', secret: false }],
        nextSteps: ['학생과 상품을 입력합니다.'],
        deploymentGuide: {
          ownership: '선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트',
          vercelImportUrl: 'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fexample%2Fclass-store-template',
          checklist: ['개인 Vercel 계정으로 Import Project를 진행합니다.'],
        },
      }),
    }));

    render(<AdminGeneratorPage />);
    fireEvent.change(screen.getByLabelText('학급명'), { target: { value: '4학년 1반' } });
    fireEvent.click(screen.getByLabelText('위 내용을 충분히 숙지했습니다.'));
    fireEvent.click(screen.getByRole('button', { name: '새 학급 매점 시스템 생성' }));

    await waitFor(() => expect(screen.getByText('생성 완료')).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith('/api/generator/create', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"selfServiceAcknowledged":true'),
    }));
    expect(screen.getByText('sheet-123')).toBeTruthy();
    expect(screen.getByText('선생님 개인 Google 계정 + 선생님 개인 Vercel 프로젝트')).toBeTruthy();
    expect(screen.getByRole('link', { name: '개인 Vercel에 배포 시작' }).getAttribute('href')).toContain('vercel.com/new/clone');
  });

  it('links back to the admin center and Google login', () => {
    render(<AdminGeneratorPage />);

    expect(screen.getByRole('link', { name: 'Google 로그인' }).getAttribute('href')).toBe('/api/google/login');
    expect(screen.getByRole('link', { name: '관리자 센터로 돌아가기' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: '현재 운영 매점 열기' }).getAttribute('href')).toBe('/');
    expect(screen.getByText(/선생님 개인 Vercel에 배포하도록/)).toBeTruthy();
  });
});
