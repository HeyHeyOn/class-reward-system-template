import { createDryRunPlan, action } from '../safety/dryRun.ts';
import type { GeneratorPlan } from '../types.ts';

export function getDoctorCommandPlan(options: { dryRun?: boolean } = {}): GeneratorPlan {
  void options;
  return createDryRunPlan({
    command: 'doctor',
    title: '현재 인스턴스 상태 점검',
    summary: '기존 학급 보상 시스템의 배포, 환경변수, Google Sheets 스키마, 운영 라우트를 읽기 중심으로 점검합니다.',
    actions: [
      action('check-vercel-project', 'Vercel 프로젝트 확인', '로컬 링크와 대상 프로젝트 이름을 확인합니다.'),
      action('check-vercel-env', 'Vercel 환경변수 확인', '필수 환경변수가 존재하는지만 확인하고 값은 출력하지 않습니다.'),
      action('check-google-sheets-access', 'Google Sheets 접근 확인', '구성된 시트 ID에 읽기 접근이 가능한지 확인합니다.'),
      action('check-required-sheets', '필수 시트 확인', 'Students, Products, Transactions, Adjustments, Settings, Tasks, TaskCompletions 존재 여부를 확인합니다.'),
      action('check-required-columns', '필수 컬럼 확인', '각 시트의 헤더가 최신 스키마를 충족하는지 확인합니다.'),
      action('check-settings-version', 'Settings 버전 확인', 'schemaVersion과 systemVersion을 확인합니다.'),
      action('check-production-routes', '운영 라우트 확인', '`/`, `/bank`, `/admin/login`, 주요 읽기 API 응답을 확인합니다.'),
    ],
    risks: ['doctor는 기본적으로 읽기 점검만 수행하고 데이터를 수정하지 않습니다.'],
  });
}
