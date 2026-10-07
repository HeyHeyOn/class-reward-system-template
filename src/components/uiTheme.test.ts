import { describe, expect, it } from 'vitest';
import { contrastRatio, THEME_PALETTES, themeStyles } from './uiTheme';

describe('semantic kiosk theme palettes', () => {
  it('defines every semantic token for all eight themes', () => {
    expect(Object.keys(THEME_PALETTES)).toEqual(['blue', 'pink', 'yellow', 'green', 'purple', 'white', 'black', 'navy']);
    for (const palette of Object.values(THEME_PALETTES)) {
      expect(Object.keys(palette)).toEqual(expect.arrayContaining([
        'shell', 'surface', 'surfaceRaised', 'contentCard', 'input', 'border', 'divider', 'text', 'mutedText',
        'accentSolid', 'accentOnSolid', 'accentSoft', 'accentText', 'focusRing', 'hover', 'hoverText',
      ]));
    }
  });

  it('keeps white outlines visible and gives black and navy real surface hierarchy', () => {
    expect(THEME_PALETTES.white.border).not.toBe(THEME_PALETTES.white.surface);
    expect(contrastRatio(THEME_PALETTES.white.border, THEME_PALETTES.white.surface)).toBeGreaterThan(1.5);
    expect(new Set([
      THEME_PALETTES.black.shell,
      THEME_PALETTES.black.surface,
      THEME_PALETTES.black.surfaceRaised,
    ]).size).toBe(3);
    expect(THEME_PALETTES.navy).toMatchObject({ shell: '#141C2E', surface: '#1C263B', surfaceRaised: '#253149' });
  });

  it('keeps panel and black raised-card boundaries at non-text contrast', () => {
    for (const [name, palette] of Object.entries(THEME_PALETTES)) {
      expect(contrastRatio(palette.border, palette.surface), `${name} panel boundary`).toBeGreaterThanOrEqual(3);
    }
    const black = THEME_PALETTES.black;
    expect(contrastRatio(black.border, black.surfaceRaised), 'black border against product card').toBeGreaterThanOrEqual(3);
  });

  it('uses softer visible dividers and brighter coordinated content cards', () => {
    for (const [name, palette] of Object.entries(THEME_PALETTES)) {
      const dividerContrast = contrastRatio(palette.divider, palette.surface);
      expect(dividerContrast, `${name} divider remains visible`).toBeGreaterThanOrEqual(1.2);
      expect(dividerContrast, `${name} divider is softer than strong border`).toBeLessThan(contrastRatio(palette.border, palette.surface));
      expect(contrastRatio(palette.text, palette.contentCard), `${name} content-card text`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio('#000000', THEME_PALETTES.white.contentCard)).toBeGreaterThan(
      contrastRatio('#000000', THEME_PALETTES.white.surfaceRaised),
    );
    expect(new Set([
      THEME_PALETTES.black.surface,
      THEME_PALETTES.black.surfaceRaised,
      THEME_PALETTES.black.contentCard,
    ]).size).toBe(3);
    expect(new Set([
      THEME_PALETTES.navy.surface,
      THEME_PALETTES.navy.surfaceRaised,
      THEME_PALETTES.navy.contentCard,
    ]).size).toBe(3);
  });

  it('meets WCAG AA for key semantic text/background pairs', () => {
    for (const [name, palette] of Object.entries(THEME_PALETTES)) {
      expect(contrastRatio(palette.text, palette.shell), `${name} shell text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.text, palette.surface), `${name} surface text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.mutedText, palette.surface), `${name} muted text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accentOnSolid, palette.accentSolid), `${name} solid accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accentText, palette.accentSoft), `${name} soft accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.hoverText, palette.hover), `${name} hover control`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.border, palette.input), `${name} input boundary`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps '파랑' (white) a plain white page with blue accents and the other light themes soft pastels", () => {
    const chroma = (hex: string) => {
      const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };
    const white = THEME_PALETTES.white;
    for (const key of ['shell', 'surface', 'surfaceRaised', 'text', 'mutedText', 'border', 'divider'] as const) {
      expect(chroma(white[key]), `white ${key} has no hue`).toBeLessThanOrEqual(12);
    }
    expect(white).toMatchObject({ accentSolid: '#2B6DE8', accentOnSolid: '#FFFFFF', accentText: '#1D58C6', focusRing: '#2B6DE8' });
    for (const name of ['blue', 'pink', 'yellow', 'green', 'purple'] as const) {
      const palette = THEME_PALETTES[name];
      expect(contrastRatio(palette.accentSolid, '#FFFFFF'), `${name} accent is a light pastel`).toBeLessThan(1.6);
      expect(contrastRatio(palette.accentOnSolid, palette.accentSolid), `${name} accent text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('projects palette values into shared semantic CSS variables and classes', () => {
    const navy = themeStyles('navy');
    expect(navy.variables['--theme-shell']).toBe('#141C2E');
    expect(navy.shell).toContain('bg-[var(--theme-shell)]');
    expect(navy.surfaceRaised).toContain('bg-[var(--theme-surface-raised)]');
    expect(navy.contentCard).toContain('bg-[var(--theme-content-card)]');
    expect(navy.border).toContain('border-[var(--theme-border)]');
    expect(navy.divider).toContain('divide-[var(--theme-divider)]');
    expect(navy.hover).toContain('hover:bg-[var(--theme-hover)]');
    expect(navy.hoverText).toContain('hover:text-[var(--theme-hover-text)]');
  });
});
