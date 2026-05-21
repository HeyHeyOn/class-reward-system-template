export type GeneratorCommand = 'create' | 'update' | 'doctor' | 'help';
export type GeneratorMode = 'dry-run' | 'execute';

export type GeneratorAction = {
  id: string;
  label: string;
  description: string;
};

export type ClassRewardInstanceOptions = {
  className?: string;
  appTitle: string;
  bankTitle: string;
  currencyUnit: string;
  themeColor: string;
  adminPasswordConfigured: boolean;
};

export type GeneratorManifest = {
  systemVersion: string;
  settings: Array<{ key: string; value: string }>;
  sheets: Array<{ name: string; columns: string[] }>;
  vercelEnvNames: string[];
};

export type GeneratorPlan = {
  command: Exclude<GeneratorCommand, 'help'>;
  mode: GeneratorMode;
  title: string;
  summary: string;
  actions: GeneratorAction[];
  risks: string[];
  options?: ClassRewardInstanceOptions;
  manifest?: GeneratorManifest;
};

export type CliResult =
  | { command: 'help'; dryRun: true; message?: string }
  | { command: Exclude<GeneratorCommand, 'help'>; dryRun: boolean; args: string[]; options?: ClassRewardInstanceOptions };
