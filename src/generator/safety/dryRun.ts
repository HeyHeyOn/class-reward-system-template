import type { GeneratorAction, GeneratorPlan } from '../types.ts';

export function createDryRunPlan(input: Omit<GeneratorPlan, 'mode'>): GeneratorPlan {
  return { ...input, mode: 'dry-run' };
}

export function action(id: string, label: string, description: string): GeneratorAction {
  return { id, label, description };
}
