import { describe, expect, it } from 'vitest';
import { parseClassRewardArgs, renderCliResult } from './cli';
import { getCreateCommandPlan } from './commands/create';
import { getDoctorCommandPlan } from './commands/doctor';
import { getUpdateCommandPlan } from './commands/update';
import { DEFAULT_SETTINGS, REQUIRED_SHEETS } from './config/schema';
import { GENERATOR_NAME_KO, LATEST_SCHEMA_VERSION, SYSTEM_NAME_KO } from './config/versions';

describe('학급 보상 시스템 생성기 Phase 1', () => {
  it('defines the reward-system schema without student auto-import as an MVP capability', () => {
    expect(SYSTEM_NAME_KO).toBe('학급 보상 시스템');
    expect(GENERATOR_NAME_KO).toBe('학급 보상 시스템 생성기');
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SETTINGS).toEqual(
      expect.arrayContaining([
        { key: 'schemaVersion', value: String(LATEST_SCHEMA_VERSION) },
        { key: 'systemName', value: '학급 보상 시스템' },
        { key: 'appTitle', value: '학급 매점' },
        { key: 'bankTitle', value: '학급 은행' },
        { key: 'currencyUnit', value: '원' },
      ]),
    );
    expect(Object.keys(REQUIRED_SHEETS)).toEqual([
      'Students',
      'Products',
      'Transactions',
      'Adjustments',
      'Settings',
      'Tasks',
      'TaskCompletions',
    ]);
    expect(REQUIRED_SHEETS.Students).toEqual(['studentId', 'name', 'number', 'balance', 'status']);
    expect(JSON.stringify({ REQUIRED_SHEETS, DEFAULT_SETTINGS })).not.toMatch(/import|csv|NEIS|나이스|자동 불러오기/iu);
  });

  it('routes create, update, and doctor commands with dry-run-first command plans', () => {
    expect(parseClassRewardArgs(['create', '--dry-run'])).toMatchObject({ command: 'create', dryRun: true });
    expect(parseClassRewardArgs(['update'])).toMatchObject({ command: 'update', dryRun: true });
    expect(parseClassRewardArgs(['doctor'])).toMatchObject({ command: 'doctor', dryRun: true });
    expect(parseClassRewardArgs([])).toMatchObject({ command: 'help', dryRun: true });

    const rendered = renderCliResult(parseClassRewardArgs([]));
    expect(rendered).toContain('학급 보상 시스템 생성기');
    expect(rendered).toContain('create');
    expect(rendered).toContain('update');
    expect(rendered).toContain('doctor');
  });

  it('keeps create focused on a fresh instance without collecting student personal data', () => {
    const plan = getCreateCommandPlan({ dryRun: true });

    expect(plan.command).toBe('create');
    expect(plan.mode).toBe('dry-run');
    expect(plan.title).toContain('새 학급 보상 시스템 만들기');
    expect(plan.actions.map((action) => action.id)).toEqual([
      'collect-basic-settings',
      'create-sheets-template',
      'initialize-settings',
      'configure-vercel-env',
      'deploy-production',
      'write-result-report',
    ]);
    expect(plan.risks).toContain('학생 정보 자동 불러오기는 개인정보 위험 때문에 Phase 1/MVP 범위에서 제외합니다.');
    expect(plan.actions.some((action) => /학생.*자동|CSV|NEIS|나이스/iu.test(`${action.label} ${action.description}`))).toBe(false);
  });

  it('plans update as a non-destructive migration with backup and version checks', () => {
    const plan = getUpdateCommandPlan({ dryRun: true, currentSchemaVersion: 0, currentSystemVersion: '0.0.0' });

    expect(plan.command).toBe('update');
    expect(plan.mode).toBe('dry-run');
    expect(plan.actions.map((action) => action.id)).toEqual([
      'inspect-current-instance',
      'backup-spreadsheet',
      'plan-schema-migrations',
      'ensure-settings-defaults',
      'deploy-latest-app',
      'run-post-update-doctor',
    ]);
    expect(plan.summary).toContain('0.0.0');
    expect(plan.summary).toContain(`schema 0 → ${LATEST_SCHEMA_VERSION}`);
    expect(plan.risks).toContain('기존 학생, 상품, 거래, 잔액 데이터는 덮어쓰거나 삭제하지 않습니다.');
  });

  it('exposes doctor checks for existing instance health inspection', () => {
    const plan = getDoctorCommandPlan({ dryRun: true });

    expect(plan.command).toBe('doctor');
    expect(plan.mode).toBe('dry-run');
    expect(plan.actions.map((action) => action.id)).toEqual([
      'check-vercel-project',
      'check-vercel-env',
      'check-google-sheets-access',
      'check-required-sheets',
      'check-required-columns',
      'check-settings-version',
      'check-production-routes',
    ]);
    expect(renderCliResult({ command: 'doctor', dryRun: true })).toContain('현재 인스턴스 상태 점검');
  });

  it('parses Phase 2 create options into a safe instance configuration without exposing secrets', () => {
    const result = parseClassRewardArgs([
      'create',
      '--dry-run',
      '--class-name',
      '4학년 1반',
      '--app-title',
      '별빛 매점',
      '--bank-title',
      '별빛 은행',
      '--currency-unit',
      '별',
      '--theme',
      'purple',
      '--admin-password-set',
    ]);

    expect(result).toMatchObject({
      command: 'create',
      dryRun: true,
      options: {
        className: '4학년 1반',
        appTitle: '별빛 매점',
        bankTitle: '별빛 은행',
        currencyUnit: '별',
        themeColor: 'purple',
        adminPasswordConfigured: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('renders a Phase 2 create manifest with sheet headers, settings rows, and deployment env names', () => {
    const rendered = renderCliResult(
      parseClassRewardArgs([
        'create',
        '--dry-run',
        '--class-name',
        '4학년 1반',
        '--app-title',
        '별빛 매점',
        '--bank-title',
        '별빛 은행',
        '--currency-unit',
        '별',
        '--theme',
        'purple',
        '--admin-password-set',
      ]),
    );

    expect(rendered).toContain('0.3.0-phase2');
    expect(rendered).toContain('인스턴스 설정');
    expect(rendered).toContain('className: 4학년 1반');
    expect(rendered).toContain('appTitle: 별빛 매점');
    expect(rendered).toContain('bankTitle: 별빛 은행');
    expect(rendered).toContain('currencyUnit: 별');
    expect(rendered).toContain('themeColor: purple');
    expect(rendered).toContain('Students: studentId, name, number, balance, status');
    expect(rendered).toContain('Tasks: taskId, title, description, reward, maxCompletionsPerStudent, isActive, sortOrder');
    expect(rendered).toContain('Vercel 환경변수: GOOGLE_SHEET_ID, ADMIN_PASSWORD, AUTH_SECRET');
    expect(rendered).not.toContain('비밀번호');
  });

  it('rejects invalid Phase 2 create options before planning external work', () => {
    expect(parseClassRewardArgs(['create', '--theme', 'rainbow'])).toMatchObject({
      command: 'help',
      dryRun: true,
      message: expect.stringContaining('지원하지 않는 테마'),
    });
    expect(parseClassRewardArgs(['create', '--currency-unit', ''])).toMatchObject({
      command: 'help',
      dryRun: true,
      message: expect.stringContaining('값이 필요합니다'),
    });
  });
});
