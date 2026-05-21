import { DEFAULT_SETTINGS } from './config/schema.ts';
import type { ClassRewardInstanceOptions } from './types.ts';

const DEFAULT_CREATE_OPTIONS: ClassRewardInstanceOptions = {
  appTitle: '학급 매점',
  bankTitle: '학급 은행',
  currencyUnit: '원',
  themeColor: 'blue',
  adminPasswordConfigured: false,
};

export function normalizeClassRewardCreateOptions(options: Partial<ClassRewardInstanceOptions> = {}): ClassRewardInstanceOptions {
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

export function buildSettingsRows(options: ClassRewardInstanceOptions): Array<{ key: string; value: string }> {
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
