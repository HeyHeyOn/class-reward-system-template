import { createDryRunPlan, action } from '../safety/dryRun.ts';
import type { GeneratorPlan } from '../types.ts';
import { LATEST_SCHEMA_VERSION } from '../config/versions.ts';

export function getUpdateCommandPlan(options: { dryRun?: boolean; currentSchemaVersion?: number; currentSystemVersion?: string } = {}): GeneratorPlan {
  const currentSchemaVersion = options.currentSchemaVersion ?? LATEST_SCHEMA_VERSION;
  const currentSystemVersion = options.currentSystemVersion ?? 'unknown';

  return createDryRunPlan({
    command: 'update',
    title: '기존 학급 보상 시스템 업데이트하기',
    summary: `현재 system ${currentSystemVersion}, schema ${currentSchemaVersion} → ${LATEST_SCHEMA_VERSION} 기준으로 비파괴 업데이트를 계획합니다.`,
    actions: [
      action('inspect-current-instance', '현재 인스턴스 점검', 'Vercel 연결, 운영 URL, Google Sheets 접근, Settings 버전을 먼저 확인합니다.'),
      action('backup-spreadsheet', '업데이트 전 백업', '스키마 변경 전 Google Sheets 복사본 또는 내보내기 백업을 준비합니다.'),
      action('plan-schema-migrations', '스키마 마이그레이션 계획', '누락된 시트와 컬럼만 보강하는 마이그레이션 목록을 만듭니다.'),
      action('ensure-settings-defaults', 'Settings 기본값 보강', '누락된 schemaVersion, systemVersion, systemName 등 기본 설정만 추가합니다.'),
      action('deploy-latest-app', '최신 앱 배포', '기존 환경변수를 유지한 채 최신 학급 보상 시스템 앱을 배포합니다.'),
      action('run-post-update-doctor', '업데이트 후 점검', 'doctor 점검을 실행해 라우트/API/시트 상태를 확인합니다.'),
    ],
    risks: ['기존 학생, 상품, 거래, 잔액 데이터는 덮어쓰거나 삭제하지 않습니다.'],
  });
}
