import { BudgetExceededError, type BudgetContext } from '@/lib/boundedWork';

/** Internal final-output emissions, not a public normalization/registration API.
 * One instance per normalization. Fixed counter metadata is not derived data.
 * Targets count final deduplicated canonical rows, mappings retain contributors.
 * Diagnostics = quarantined sources + distinct per-source error codes + final
 * distinct blocking conflicts. Warning lists/codes and temporary Entry flags
 * are not this category. No payload recipes or intermediate-graph certification.
 */
export function createNormalizationOutput(budget?: BudgetContext) {
  let targets = 0, sources = 0, mappings = 0, diagnostics = 0;
  function append<T>(list: T[], factory: () => T): void {
    budget?.spend();
    budget?.reserve({ slots: 1, structuralBytes: 4 });
    const value = factory();
    budget?.check();
    list.push(value);
  }
  function diagnostic(): void {
    if (!budget) return;
    budget.check();
    if (diagnostics === 8_000) throw new BudgetExceededError();
    diagnostics++;
  }
  return {
    target<T>(list: T[], factory: () => T): void {
      if (budget) { budget.check(); if (targets === 4_000) throw new BudgetExceededError(); targets++; }
      append(list, factory);
    },
    sourceRecord<T>(list: T[], quarantined: boolean, factory: () => T): void {
      if (budget) {
        budget.check(); if (sources === 4_000) throw new BudgetExceededError();
        if (quarantined) diagnostic();
        sources++;
      }
      append(list, factory);
    },
    mapping<T>(list: T[], factory: () => T): void {
      if (budget) { budget.check(); if (mappings === 8_000) throw new BudgetExceededError(); mappings++; }
      append(list, factory);
    },
    conflict<T>(list: T[], factory: () => T): void { diagnostic(); append(list, factory); },
    errorCode<T>(list: T[], factory: () => T): void { diagnostic(); append(list, factory); },
  };
}

export type NormalizationOutput = ReturnType<typeof createNormalizationOutput>;
