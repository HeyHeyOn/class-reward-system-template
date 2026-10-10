import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TermsOfServicePage, { metadata } from './page';

afterEach(cleanup);

describe('terms of service page', () => {
  it('sets out the terms a Korean free classroom service needs, including student data duties', () => {
    render(<TermsOfServicePage />);
    expect(metadata.title).toBe('이용약관');
    expect(screen.getByRole('heading', { level: 1, name: '이용약관' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '제1조 (목적)', '제2조 (용어의 뜻)', '제3조 (약관의 게시와 변경)', '제4조 (이용 계약의 성립)', '제5조 (서비스의 내용)',
      '제6조 (서비스의 변경과 중단)', '제7조 (학생 개인정보와 회원의 책임)', '제8조 (학급 화폐)', '제9조 (회원의 의무)', '제10조 (운영자의 의무)',
      '제11조 (회원 탈퇴와 이용 제한)', '제12조 (책임의 범위)', '제13조 (분쟁 해결과 관할)', '부칙',
    ]);
    const students = screen.getByRole('heading', { name: '제7조 (학생 개인정보와 회원의 책임)' }).closest('section')!;
    expect(within(students).getByText(/법정대리인\(학부모\)의 개인정보 수집·이용 동의와 국외 이전 동의를 받아야 합니다/)).toBeTruthy();
    expect(within(students).getByText(/별명과 임의 번호로 등록해야 합니다/)).toBeTruthy();
    const changes = screen.getByRole('heading', { name: '제3조 (약관의 게시와 변경)' }).closest('section')!;
    expect(within(changes).getByText(/시행일 7일 전부터/)).toBeTruthy();
    expect(within(changes).getByText(/30일 전부터 알립니다/)).toBeTruthy();
    // Liability for the operator's intent or gross negligence is never excluded (약관규제법 제7조).
    expect(screen.getByText(/고의 또는 중대한 과실로 회원에게 손해가 생긴 경우에는 관련 법령에 따라 책임을 집니다/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'hwanit1105@gmail.com' }).length).toBeGreaterThan(0);
    expect(screen.getByText('이 약관은 2026년 10월 8일부터 시행합니다.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '이용약관' }).getAttribute('href')).toBe('/terms');
    expect(screen.getByRole('link', { name: '개인정보처리방침' }).getAttribute('href')).toBe('/privacy');
  });
});
