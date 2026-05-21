import { getCreateCommandPlan } from './commands/create.ts';
import { getDoctorCommandPlan } from './commands/doctor.ts';
import { getUpdateCommandPlan } from './commands/update.ts';
import { THEME_COLORS } from './config/schema.ts';
import { GENERATOR_NAME_KO } from './config/versions.ts';
import type { CliResult, GeneratorOptions, GeneratorPlan } from './types.ts';

const COMMANDS = ['create', 'update', 'doctor'] as const;

type RunnableCommand = (typeof COMMANDS)[number];

export function parseClassRewardArgs(argv: string[]): CliResult {
  const [first, ...rest] = argv;
  if (!first) return { command: 'help', dryRun: true };

  if (!isRunnableCommand(first)) {
    return { command: 'help', dryRun: true, message: `알 수 없는 명령: ${first}` };
  }

  const parsed = parseOptions(rest);
  if ('message' in parsed) return { command: 'help', dryRun: true, message: parsed.message };

  const dryRun = first === 'update' || rest.includes('--dry-run') || !rest.includes('--execute');
  return { command: first, dryRun, args: sanitizeArgs(rest), options: parsed.options };
}

export function renderCliResult(result: CliResult): string {
  if (result.command === 'help') {
    return [
      GENERATOR_NAME_KO,
      result.message,
      '',
      '사용법:',
      '  class-reward create --dry-run   새 학급 보상 시스템 만들기 계획',
      '  class-reward create --dry-run --class-name "4학년 1반" --app-title "별빛 매점" --bank-title "별빛 은행" --currency-unit 별 --theme purple --admin-password-set',
      '  class-reward update --dry-run   기존 학급 보상 시스템 업데이트 계획',
      '  class-reward doctor             현재 인스턴스 상태 점검',
    ].filter(Boolean).join('\n');
  }

  const plan = getPlanForCommand(result.command, result.dryRun, result.options);
  return renderPlan(plan);
}

export function getPlanForCommand(command: RunnableCommand, dryRun = true, options?: GeneratorOptions): GeneratorPlan {
  switch (command) {
    case 'create':
      return getCreateCommandPlan({ dryRun, instanceOptions: options });
    case 'update':
      return getUpdateCommandPlan({ dryRun });
    case 'doctor':
      return getDoctorCommandPlan({ dryRun, targetOptions: options });
  }
}

function parseOptions(args: string[]): { options: GeneratorOptions } | { message: string } {
  const options: GeneratorOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--dry-run':
      case '--execute':
        break;
      case '--class-name':
        options.className = readValue(args, index, arg);
        if (options.className === undefined) return { message: `${arg} 값이 필요합니다.` };
        index += 1;
        break;
      case '--app-title':
        options.appTitle = readValue(args, index, arg);
        if (options.appTitle === undefined) return { message: `${arg} 값이 필요합니다.` };
        index += 1;
        break;
      case '--bank-title':
        options.bankTitle = readValue(args, index, arg);
        if (options.bankTitle === undefined) return { message: `${arg} 값이 필요합니다.` };
        index += 1;
        break;
      case '--currency-unit':
        options.currencyUnit = readValue(args, index, arg);
        if (options.currencyUnit === undefined) return { message: `${arg} 값이 필요합니다.` };
        index += 1;
        break;
      case '--theme': {
        const theme = readValue(args, index, arg);
        if (theme === undefined) return { message: `${arg} 값이 필요합니다.` };
        if (!THEME_COLORS.includes(theme as (typeof THEME_COLORS)[number])) {
          return { message: `지원하지 않는 테마: ${theme}. 사용 가능: ${THEME_COLORS.join(', ')}` };
        }
        options.themeColor = theme;
        index += 1;
        break;
      }
      case '--admin-password-set':
        options.adminPasswordConfigured = true;
        break;
      case '--base-url': {
        const baseUrl = readValue(args, index, arg);
        if (baseUrl === undefined) return { message: `${arg} 값이 필요합니다.` };
        const validation = validateProductionBaseUrl(baseUrl);
        if (validation) return { message: validation };
        options.baseUrl = baseUrl.replace(/\/$/, '');
        index += 1;
        break;
      }
      case '--vercel-project':
        options.vercelProject = readValue(args, index, arg);
        if (options.vercelProject === undefined) return { message: `${arg} 값이 필요합니다.` };
        index += 1;
        break;
      default:
        if (arg.startsWith('--')) return { message: `알 수 없는 옵션: ${arg}` };
        return { message: `알 수 없는 인자: ${arg}` };
    }
  }

  return {
    options: {
      appTitle: options.appTitle ?? '학급 매점',
      bankTitle: options.bankTitle ?? '학급 은행',
      currencyUnit: options.currencyUnit ?? '원',
      themeColor: options.themeColor ?? 'blue',
      className: options.className,
      adminPasswordConfigured: Boolean(options.adminPasswordConfigured),
      baseUrl: options.baseUrl,
      vercelProject: options.vercelProject,
    },
  };
}

function validateProductionBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '올바른 URL을 입력해 주세요.';
  }
  if (parsed.protocol !== 'https:') return 'production doctor에는 https URL이 필요합니다.';
  return null;
}

function sanitizeArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== '--admin-password-set');
}

function readValue(args: string[], index: number, optionName: string): string | undefined {
  void optionName;
  const value = args[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) return undefined;
  return value.trim();
}

function renderPlan(plan: GeneratorPlan): string {
  const actions = plan.actions.map((item, index) => `${index + 1}. ${item.label} — ${item.description}`).join('\n');
  const risks = plan.risks.map((risk) => `- ${risk}`).join('\n');
  const optionBlock = plan.options ? renderOptions(plan.options) : '';
  const manifestBlock = plan.manifest ? renderManifest(plan.manifest) : '';
  return [
    `${GENERATOR_NAME_KO} / ${plan.title}`,
    `모드: ${plan.mode}`,
    plan.summary,
    optionBlock,
    manifestBlock,
    '',
    '작업:',
    actions,
    '',
    '안전 원칙:',
    risks,
  ].filter(Boolean).join('\n');
}

function renderOptions(options: GeneratorOptions): string {
  return [
    '',
    '인스턴스 설정:',
    options.className ? `className: ${options.className}` : undefined,
    options.appTitle ? `appTitle: ${options.appTitle}` : undefined,
    options.bankTitle ? `bankTitle: ${options.bankTitle}` : undefined,
    options.currencyUnit ? `currencyUnit: ${options.currencyUnit}` : undefined,
    options.themeColor ? `themeColor: ${options.themeColor}` : undefined,
    options.adminPasswordConfigured !== undefined ? `adminPasswordConfigured: ${options.adminPasswordConfigured ? 'yes' : 'no'}` : undefined,
    options.baseUrl ? `baseUrl: ${options.baseUrl}` : undefined,
    options.vercelProject ? `vercelProject: ${options.vercelProject}` : undefined,
  ].filter(Boolean).join('\n');
}

function renderManifest(manifest: NonNullable<GeneratorPlan['manifest']>): string {
  return [
    '',
    `생성 manifest: ${manifest.systemVersion}`,
    manifest.settings.length ? 'Settings:' : undefined,
    ...manifest.settings.map((row) => `- ${row.key}: ${row.value}`),
    manifest.sheets.length ? 'Sheets:' : undefined,
    ...manifest.sheets.map((sheet) => `- ${sheet.name}: ${sheet.columns.join(', ')}`),
    manifest.doctorRoutes?.length ? 'Doctor routes:' : undefined,
    ...(manifest.doctorRoutes?.map((route) => `- ${route}`) ?? []),
    `Vercel 환경변수: ${manifest.vercelEnvNames.join(', ')}`,
  ].filter(Boolean).join('\n');
}

function isRunnableCommand(value: string): value is RunnableCommand {
  return COMMANDS.includes(value as RunnableCommand);
}
