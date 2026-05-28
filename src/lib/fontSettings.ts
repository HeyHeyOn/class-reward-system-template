export type FontFamily = 'default' | 'nanum-barun-gothic' | 'school-safe-board-marker' | 'school-safe-notice' | 'school-safe-poster';

export const FONT_FAMILY_OPTIONS: Array<{ value: FontFamily; label: string; cssFamily: string }> = [
  { value: 'default', label: '기본 글꼴', cssFamily: 'Arial, Helvetica, sans-serif' },
  { value: 'nanum-barun-gothic', label: '나눔바른고딕', cssFamily: 'NanumBarunGothic, Arial, Helvetica, sans-serif' },
  { value: 'school-safe-board-marker', label: '학교안심 보드마카', cssFamily: 'SchoolSafeBoardMarker, Arial, Helvetica, sans-serif' },
  { value: 'school-safe-notice', label: '학교안심 알림장', cssFamily: 'SchoolSafeNotice, Arial, Helvetica, sans-serif' },
  { value: 'school-safe-poster', label: '학교안심 포스터', cssFamily: 'SchoolSafePoster, Arial, Helvetica, sans-serif' },
];

const FONT_FAMILY_VALUES = new Set<FontFamily>(FONT_FAMILY_OPTIONS.map((option) => option.value));

export function normalizeFontFamily(value: unknown): FontFamily {
  if (typeof value !== 'string') return 'default';
  const trimmed = value.trim() as FontFamily;
  return FONT_FAMILY_VALUES.has(trimmed) ? trimmed : 'default';
}

export function getFontFamilyCss(value: unknown): string | undefined {
  const fontFamily = normalizeFontFamily(value);
  if (fontFamily === 'default') return undefined;
  return FONT_FAMILY_OPTIONS.find((option) => option.value === fontFamily)?.cssFamily;
}
