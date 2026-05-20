export type GeneratorCommand = 'create' | 'update' | 'doctor' | 'help';
export type GeneratorMode = 'dry-run' | 'execute';

export type GeneratorAction = {
  id: string;
  label: string;
  description: string;
};

export type GeneratorPlan = {
  command: Exclude<GeneratorCommand, 'help'>;
  mode: GeneratorMode;
  title: string;
  summary: string;
  actions: GeneratorAction[];
  risks: string[];
};

export type CliResult =
  | { command: 'help'; dryRun: true; message?: string }
  | { command: Exclude<GeneratorCommand, 'help'>; dryRun: boolean; args: string[] };
