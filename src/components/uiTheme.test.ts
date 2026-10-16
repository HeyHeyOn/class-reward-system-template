import { describe, expect, it } from 'vitest';
import { contrastRatio, normalizeThemeColor, THEME_PALETTES, themeStyles } from './uiTheme';

describe('the one 딴쌤 theme', () => {
  it('is the only theme, and every earlier theme reads as it', () => {
    expect(Object.keys(THEME_PALETTES)).toEqual(['white']);
    for (const stored of ['white', 'blue', 'pink', 'yellow', 'green', 'purple', 'black', 'navy', ' white ', '', undefined, null, 3]) {
      expect(normalizeThemeColor(stored)).toBe('white');
    }
  });

  it('defines every semantic token', () => {
    expect(Object.keys(THEME_PALETTES.white)).toEqual(expect.arrayContaining([
      'shell', 'surface', 'surfaceRaised', 'contentCard', 'input', 'border', 'divider', 'text', 'mutedText',
      'accentSolid', 'accentOnSolid', 'accentSoft', 'accentText', 'focusRing', 'hover', 'hoverText',
    ]));
  });

  it('is a plain white page with the brand blue (ddanssaem-brand README)', () => {
    const chroma = (hex: string) => {
      const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };
    const white = THEME_PALETTES.white;
    for (const key of ['shell', 'surface', 'surfaceRaised', 'text', 'mutedText', 'border', 'divider'] as const) {
      expect(chroma(white[key]), `${key} has no hue`).toBeLessThanOrEqual(12);
    }
    expect(white).toMatchObject({ shell: '#F7F7F8', surface: '#FFFFFF', text: '#2B2D31', accentSolid: '#2B6DE8', accentOnSolid: '#FFFFFF', accentText: '#1D58C6', focusRing: '#2B6DE8' });
  });

  it('meets WCAG AA for text and keeps boundaries visible', () => {
    const palette = THEME_PALETTES.white;
    expect(contrastRatio(palette.text, palette.shell)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.text, palette.contentCard)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.mutedText, palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.accentOnSolid, palette.accentSolid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.accentText, palette.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.hoverText, palette.hover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.border, palette.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.border, palette.input)).toBeGreaterThanOrEqual(3);
    const divider = contrastRatio(palette.divider, palette.surface);
    expect(divider).toBeGreaterThanOrEqual(1.2);
    expect(divider).toBeLessThan(contrastRatio(palette.border, palette.surface));
  });

  it('exposes the palette as CSS variables and utility classes', () => {
    const styles = themeStyles('white');
    expect(styles.variables['--theme-shell']).toBe('#F7F7F8');
    expect(styles.variables['--theme-accent-solid']).toBe('#2B6DE8');
    expect(styles.shell).toBe('bg-[var(--theme-shell)]');
  });
});
