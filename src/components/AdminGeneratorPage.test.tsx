import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGeneratorPage } from './AdminGeneratorPage';

describe('AdminGeneratorPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a safe generator page with dry-run defaults and no live create action', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AdminGeneratorPage />);

    expect(screen.getByRole('heading', { name: '시스템 생성기' })).toBeTruthy();
    expect(screen.getByLabelText('학급명')).toBeTruthy();
    expect(screen.getByLabelText('매점 이름')).toHaveProperty('value', '학급 매점');
    expect(screen.getByLabelText('은행 이름')).toHaveProperty('value', '학급 은행');
    expect(screen.getByLabelText('화폐 단위')).toHaveProperty('value', '원');
    expect(screen.getByLabelText('테마')).toHaveProperty('value', 'blue');
    expect(screen.getByText('실제 생성은 아직 비활성화되어 있습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '실제 생성 준비 중' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/라이브 데이터 수정 없음/).length).toBeGreaterThan(0);
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

  it('links back to the admin center and production doctor page guidance', () => {
    render(<AdminGeneratorPage />);

    expect(screen.getByRole('link', { name: '관리자 센터로 돌아가기' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: '현재 운영 매점 열기' }).getAttribute('href')).toBe('/');
    expect(screen.getByText(/다음 단계는 승인 후 Google Sheets 템플릿 생성/)).toBeTruthy();
  });
});
