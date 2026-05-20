import { getCreateCommandPlan } from './commands/create.ts';
import { getDoctorCommandPlan } from './commands/doctor.ts';
import { getUpdateCommandPlan } from './commands/update.ts';
import { GENERATOR_NAME_KO } from './config/versions.ts';
import type { CliResult, GeneratorPlan } from './types.ts';

const COMMANDS = ['create', 'update', 'doctor'] as const;

type RunnableCommand = (typeof COMMANDS)[number];

export function parseClassRewardArgs(argv: string[]): CliResult {
  const [first, ...rest] = argv;
  if (!first) return { command: 'help', dryRun: true };

  if (!isRunnableCommand(first)) {
    return { command: 'help', dryRun: true, message: `알 수 없는 명령: ${first}` };
  }

  const dryRun = first === 'update' || rest.includes('--dry-run') || !rest.includes('--execute');
  return { command: first, dryRun, args: rest };
}

export function renderCliResult(result: CliResult): string {
  if (result.command === 'help') {
    return [
      GENERATOR_NAME_KO,
      result.message,
      '',
      '사용법:',
      '  class-reward create --dry-run   새 학급 보상 시스템 만들기 계획',
      '  class-reward update --dry-run   기존 학급 보상 시스템 업데이트 계획',
      '  class-reward doctor             현재 인스턴스 상태 점검',
    ].filter(Boolean).join('\n');
  }

  const plan = getPlanForCommand(result.command, result.dryRun);
  return renderPlan(plan);
}

export function getPlanForCommand(command: RunnableCommand, dryRun = true): GeneratorPlan {
  switch (command) {
    case 'create':
      return getCreateCommandPlan({ dryRun });
    case 'update':
      return getUpdateCommandPlan({ dryRun });
    case 'doctor':
      return getDoctorCommandPlan({ dryRun });
  }
}

function renderPlan(plan: GeneratorPlan): string {
  const actions = plan.actions.map((item, index) => `${index + 1}. ${item.label} — ${item.description}`).join('\n');
  const risks = plan.risks.map((risk) => `- ${risk}`).join('\n');
  return [`${GENERATOR_NAME_KO} / ${plan.title}`, `모드: ${plan.mode}`, plan.summary, '', '작업:', actions, '', '안전 원칙:', risks].join('\n');
}

function isRunnableCommand(value: string): value is RunnableCommand {
  return COMMANDS.includes(value as RunnableCommand);
}
