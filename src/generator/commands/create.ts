import { createDryRunPlan, action } from '../safety/dryRun.ts';
import { DEFAULT_SETTINGS, REQUIRED_SHEETS } from '../config/schema.ts';
import { SYSTEM_VERSION } from '../config/versions.ts';
import type { ClassRewardInstanceOptions, GeneratorPlan } from '../types.ts';

const DEFAULT_CREATE_OPTIONS: ClassRewardInstanceOptions = {
  appTitle: '학급 매점',
  bankTitle: '학급 은행',
  currencyUnit: '원',
  themeColor: 'blue',
  adminPasswordConfigured: false,
};

export function getCreateCommandPlan(options: { dryRun?: boolean; instanceOptions?: Partial<ClassRewardInstanceOptions> } = {}): GeneratorPlan {
  const instanceOptions = normalizeCreateOptions(options.instanceOptions);
  return createDryRunPlan({
    command: 'create',
    title: '새 학급 보상 시스템 만들기',
    summary: '새 Google Sheets 템플릿과 Vercel 배포를 준비하는 신규 인스턴스 생성 경로입니다. Phase 2는 입력 설정을 반영한 실행 전 manifest를 생성합니다.',
    actions: [
      action('collect-basic-settings', '기본 설정 입력', '시스템 이름, 매점 제목, 은행 제목, 화폐 단위, 테마, 관리자 암호 설정 여부를 확정합니다.'),
      action('create-sheets-template', '시트 템플릿 생성', '필수 시트와 헤더만 생성하고 실제 학생 개인정보는 수집하지 않습니다.'),
      action('initialize-settings', 'Settings 초기화', 'schemaVersion, systemVersion, systemName, appTitle, bankTitle, currencyUnit, themeColor, className을 기록합니다.'),
      action('configure-vercel-env', 'Vercel 환경변수 준비', 'GOOGLE_SHEET_ID, ADMIN_PASSWORD, AUTH_SECRET 등 배포 환경 이름을 확인하고 값은 출력하지 않습니다.'),
      action('deploy-production', 'Production 배포', '새 학급 보상 시스템 인스턴스를 운영 배포합니다.'),
      action('write-result-report', '결과 리포트 작성', '운영 URL, 관리자 URL, 은행 URL, 시트 URL, 운영 가이드를 출력합니다.'),
    ],
    risks: ['학생 정보 자동 불러오기는 개인정보 위험 때문에 Phase 1/MVP 범위에서 제외합니다.', 'Phase 2 dry-run은 외부 시트/Vercel 값을 실제로 만들거나 수정하지 않습니다.'],
    options: instanceOptions,
    manifest: {
      systemVersion: SYSTEM_VERSION,
      settings: buildSettingsRows(instanceOptions),
      sheets: Object.entries(REQUIRED_SHEETS).map(([name, columns]) => ({ name, columns })),
      vercelEnvNames: ['GOOGLE_SHEET_ID', 'ADMIN_PASSWORD', 'AUTH_SECRET'],
    },
  });
}

function normalizeCreateOptions(options: Partial<ClassRewardInstanceOptions> = {}): ClassRewardInstanceOptions {
  return {
    ...DEFAULT_CREATE_OPTIONS,
    ...options,
    appTitle: options.appTitle?.trim() || DEFAULT_CREATE_OPTIONS.appTitle,
    bankTitle: options.bankTitle?.trim() || DEFAULT_CREATE_OPTIONS.bankTitle,
    currencyUnit: options.currencyUnit?.trim() || DEFAULT_CREATE_OPTIONS.currencyUnit,
    themeColor: options.themeColor?.trim() || DEFAULT_CREATE_OPTIONS.themeColor,
    className: options.className?.trim() || undefined,
    adminPasswordConfigured: Boolean(options.adminPasswordConfigured),
  };
}

function buildSettingsRows(options: ClassRewardInstanceOptions): Array<{ key: string; value: string }> {
  const overrides = new Map<string, string>([
    ['appTitle', options.appTitle],
    ['bankTitle', options.bankTitle],
    ['currencyUnit', options.currencyUnit],
    ['themeColor', options.themeColor],
  ]);
  if (options.className) overrides.set('className', options.className);

  const rows = DEFAULT_SETTINGS.map((row) => ({ ...row, value: overrides.get(row.key) ?? row.value }));
  if (options.className && !rows.some((row) => row.key === 'className')) {
    rows.push({ key: 'className', value: options.className });
  }
  return rows;
}
