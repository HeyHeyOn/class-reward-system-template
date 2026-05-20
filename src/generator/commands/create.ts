import { createDryRunPlan, action } from '../safety/dryRun.ts';
import type { GeneratorPlan } from '../types.ts';

export function getCreateCommandPlan(options: { dryRun?: boolean } = {}): GeneratorPlan {
  void options;
  return createDryRunPlan({
    command: 'create',
    title: '새 학급 보상 시스템 만들기',
    summary: '새 Google Sheets 템플릿과 Vercel 배포를 준비하는 신규 인스턴스 생성 경로입니다.',
    actions: [
      action('collect-basic-settings', '기본 설정 입력', '시스템 이름, 매점 제목, 은행 제목, 화폐 단위, 테마, 관리자 암호를 입력받습니다.'),
      action('create-sheets-template', '시트 템플릿 생성', '필수 시트와 헤더만 생성하고 실제 학생 개인정보는 수집하지 않습니다.'),
      action('initialize-settings', 'Settings 초기화', 'schemaVersion, systemVersion, systemName, appTitle, bankTitle, currencyUnit, themeColor를 기록합니다.'),
      action('configure-vercel-env', 'Vercel 환경변수 준비', 'GOOGLE_SHEET_ID, ADMIN_PASSWORD, AUTH_SECRET 등 배포 환경을 구성합니다.'),
      action('deploy-production', 'Production 배포', '새 학급 보상 시스템 인스턴스를 운영 배포합니다.'),
      action('write-result-report', '결과 리포트 작성', '운영 URL, 관리자 URL, 은행 URL, 시트 URL, 운영 가이드를 출력합니다.'),
    ],
    risks: ['학생 정보 자동 불러오기는 개인정보 위험 때문에 Phase 1/MVP 범위에서 제외합니다.'],
  });
}
