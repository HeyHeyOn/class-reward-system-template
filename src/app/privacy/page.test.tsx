import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PrivacyPolicyPage, { metadata } from './page';

afterEach(cleanup);

describe('privacy policy page', () => {
  it('states every item the Korean Personal Information Protection Act asks a policy to disclose', () => {
    render(<PrivacyPolicyPage />);
    expect(metadata.title).toBe('개인정보처리방침');
    expect(screen.getByRole('heading', { level: 1, name: '개인정보처리방침' })).toBeTruthy();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      '제1조 (개인정보의 처리 목적)', '제2조 (처리하는 개인정보의 항목과 수집 방법)', '제3조 (개인정보의 처리 및 보유 기간)',
      '제4조 (개인정보의 파기 절차 및 방법)', '제5조 (개인정보의 제3자 제공)', '제6조 (개인정보 처리의 위탁)', '제7조 (개인정보의 국외 이전)',
      '제8조 (정보주체와 법정대리인의 권리·의무 및 행사 방법)', '제9조 (만 14세 미만 아동의 개인정보 처리)', '제10조 (개인정보의 안전성 확보 조치)',
      '제11조 (개인정보 자동 수집 장치의 설치·운영 및 거부)', '제12조 (개인정보 보호책임자)', '제13조 (권익침해 구제 방법)', '제14조 (개인정보처리방침의 변경)',
    ]);
    const overseas = screen.getByRole('heading', { name: '제7조 (개인정보의 국외 이전)' }).closest('section')!;
    for (const fact of ['Vercel Inc.', 'privacy@vercel.com', 'Neon, LLC', 'privacy@databricks.com', '싱가포르(서버 위치), 미국(본사)']) {
      expect(within(overseas).getByText(fact, { exact: false })).toBeTruthy();
    }
    const officer = screen.getByRole('heading', { name: '제12조 (개인정보 보호책임자)' }).closest('section')!;
    expect(within(officer).getByRole('link', { name: 'hwanit1105@gmail.com' }).getAttribute('href')).toBe('mailto:hwanit1105@gmail.com');
    expect(screen.queryByText(/haeon0511/)).toBeNull();
    const children = screen.getByRole('heading', { name: '제9조 (만 14세 미만 아동의 개인정보 처리)' }).closest('section')!;
    expect(within(children).getByText(/법정대리인의 개인정보 수집·이용 동의와 국외 이전 동의를 받아야 합니다/)).toBeTruthy();
    expect(within(children).getByText(/별명과 임의 번호로 등록해야/)).toBeTruthy();
    const retention = screen.getByRole('heading', { name: '제3조 (개인정보의 처리 및 보유 기간)' }).closest('section')!;
    expect(within(retention).getByText(/회원이 탈퇴하면 그 회원이 만든 학급은 즉시 접속이 중지되고/)).toBeTruthy();
    expect(screen.getByText(/2026년 10월 8일부터 적용됩니다/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '메인 화면으로' }).getAttribute('href')).toBe('/classes');
    expect(screen.getByText('© 2026 환잇쌤. All rights reserved.')).toBeTruthy();
  });
});
