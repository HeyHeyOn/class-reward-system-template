import { action } from '../safety/dryRun.ts';
import { GENERATED_SHEET_NAMES, REQUIRED_SHEETS, type GeneratedSheetName } from '../config/schema.ts';
import { SYSTEM_VERSION } from '../config/versions.ts';
import type { DoctorTargetOptions, GeneratorPlan } from '../types.ts';

export const DOCTOR_ROUTES = ['/', '/bank', '/admin/login', '/api/settings', '/api/products?includeInactive=1', '/api/students'];

export const DOCTOR_SHEETS: ReadonlyArray<{
  name: GeneratedSheetName;
  columns: readonly string[];
  headerRange: string;
}> = GENERATED_SHEET_NAMES.map((name) => ({
  name,
  columns: REQUIRED_SHEETS[name],
  headerRange: `${name}!1:1`,
}));

export function getDoctorCommandPlan(options: { dryRun?: boolean; targetOptions?: DoctorTargetOptions } = {}): GeneratorPlan {
  const mode = options.dryRun === false ? 'execute' : 'dry-run';
  const targetOptions = normalizeTargetOptions(options.targetOptions);
  return {
    command: 'doctor',
    mode,
    title: mode === 'execute' ? '읽기 전용 production doctor' : '현재 인스턴스 상태 점검',
    summary:
      mode === 'execute'
        ? '배포된 학급 보상 시스템의 최종 alias와 주요 읽기 API를 확인하는 Phase 3 production doctor 계획입니다.'
        : '기존 학급 보상 시스템의 배포, 환경변수, Google Sheets 스키마, 운영 라우트를 읽기 중심으로 점검합니다.',
    actions: [
      action('check-vercel-project', 'Vercel 프로젝트 확인', '로컬 링크와 대상 프로젝트 이름을 확인합니다.'),
      action('check-vercel-env', 'Vercel 환경변수 확인', '필수 환경변수가 존재하는지만 확인하고 값은 출력하지 않습니다.'),
      action('check-google-sheets-access', 'Google Sheets 접근 확인', '구성된 시트 ID에 읽기 접근이 가능한지 확인합니다.'),
      action('check-required-sheets', '필수 시트 확인', '신규 생성 스키마의 Students, Products, Transactions, Adjustments, Settings, Tasks, TaskAssignments, TaskCompletions, Recovery 존재 여부를 확인합니다.'),
      action('check-required-columns', '필수 컬럼 확인', '명시된 1행 A1 범위로 각 시트의 헤더명만 확인합니다. Recovery 데이터는 읽거나 출력하지 않습니다.'),
      action('check-settings-version', 'Settings 버전 확인', 'schemaVersion과 systemVersion을 확인합니다.'),
      action('check-production-routes', '운영 라우트 확인', '`/`, `/bank`, `/admin/login`, 주요 읽기 API 응답을 확인합니다.'),
    ],
    risks: ['doctor는 읽기 점검만 수행하고 라이브 데이터 수정 없음.'],
    options: targetOptions,
    manifest: mode === 'execute'
      ? {
          systemVersion: SYSTEM_VERSION,
          settings: [],
          sheets: [],
          vercelEnvNames: ['CLASS_STORE_STORAGE', 'GOOGLE_SHEET_ID', 'ADMIN_PASSWORD', 'AUTH_SECRET'],
          doctorRoutes: DOCTOR_ROUTES,
          // This generator currently emits a plan/manifest; a future Sheets executor must use
          // these exact header-only ranges rather than broadening reads into data rows.
          doctorSheets: DOCTOR_SHEETS,
          doctorTarget: {
            baseUrl: targetOptions.baseUrl ?? '',
            vercelProject: targetOptions.vercelProject ?? '',
          },
        }
      : undefined,
  };
}

function normalizeTargetOptions(options: DoctorTargetOptions = {}): DoctorTargetOptions {
  return {
    baseUrl: options.baseUrl?.replace(/\/$/, ''),
    vercelProject: options.vercelProject?.trim(),
  };
}
