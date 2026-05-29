import { describe, expect, it } from 'vitest';

import { FONT_FAMILY_OPTIONS, getFontFamilyCss, normalizeFontFamily } from './fontSettings';

describe('fontSettings', () => {
  it('allows the bundled classroom fonts uploaded in 폰트2.zip', () => {
    expect(FONT_FAMILY_OPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'school-safe-dictation', label: '학교안심 받아쓰기' }),
        expect.objectContaining({ value: 'school-safe-chalk', label: '학교안심 분필' }),
        expect.objectContaining({ value: 'school-safe-sans', label: '학교안심 산뜻돋움' }),
        expect.objectContaining({ value: 'school-safe-space', label: '학교안심 우주' }),
      ]),
    );
  });

  it('resolves newly bundled classroom font keys to CSS font stacks', () => {
    expect(normalizeFontFamily('school-safe-dictation')).toBe('school-safe-dictation');
    expect(getFontFamilyCss('school-safe-dictation')).toContain('SchoolSafeDictation');
    expect(getFontFamilyCss('school-safe-chalk')).toContain('SchoolSafeChalk');
    expect(getFontFamilyCss('school-safe-sans')).toContain('SchoolSafeSans');
    expect(getFontFamilyCss('school-safe-space')).toContain('SchoolSafeSpace');
  });
});
