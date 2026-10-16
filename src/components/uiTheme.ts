import type { CSSProperties } from 'react';

/**
 * 딴쌤 클래스 has one theme: the white page with the brand blue (ddanssaem-brand README). Classes saved with
 * one of the earlier themes (blue, pink, yellow, green, purple, black, navy) show it too.
 */
export type ThemeColor = 'white';

export type SemanticThemePalette = {
  shell: string;
  surface: string;
  surfaceRaised: string;
  contentCard: string;
  input: string;
  border: string;
  divider: string;
  text: string;
  mutedText: string;
  accentSolid: string;
  accentOnSolid: string;
  accentSoft: string;
  accentText: string;
  focusRing: string;
  hover: string;
  hoverText: string;
};

export const THEME_PALETTES: Record<ThemeColor, SemanticThemePalette> = {
  white: { shell: '#F7F7F8', surface: '#FFFFFF', surfaceRaised: '#FAFAFB', contentCard: '#FDFDFD', input: '#FFFFFF', border: '#8E9299', divider: '#E7E8EA', text: '#2B2D31', mutedText: '#64686F', accentSolid: '#2B6DE8', accentOnSolid: '#FFFFFF', accentSoft: '#E7F0FE', accentText: '#1D58C6', focusRing: '#2B6DE8', hover: '#1F5DD0', hoverText: '#FFFFFF' },
};

type ThemeVariables = CSSProperties & Record<`--theme-${string}`, string>;

export type ThemeStyles = {
  variables: ThemeVariables;
  shell: string;
  surface: string;
  surfaceRaised: string;
  contentCard: string;
  input: string;
  border: string;
  divider: string;
  text: string;
  mutedText: string;
  accentSolid: string;
  accentOnSolid: string;
  accentSoft: string;
  accentText: string;
  hover: string;
  hoverText: string;
  ring: string;
};

/** Every stored value, including the earlier themes, is the one theme now. */
export function normalizeThemeColor(value?: unknown): ThemeColor {
  void value;
  return 'white';
}

export function themeStyles(theme: ThemeColor): ThemeStyles {
  const palette = THEME_PALETTES[theme];
  return {
    variables: {
      '--theme-shell': palette.shell,
      '--theme-surface': palette.surface,
      '--theme-surface-raised': palette.surfaceRaised,
      '--theme-content-card': palette.contentCard,
      '--theme-input': palette.input,
      '--theme-border': palette.border,
      '--theme-divider': palette.divider,
      '--theme-text': palette.text,
      '--theme-muted-text': palette.mutedText,
      '--theme-accent-solid': palette.accentSolid,
      '--theme-accent-on-solid': palette.accentOnSolid,
      '--theme-accent-soft': palette.accentSoft,
      '--theme-accent-text': palette.accentText,
      '--theme-focus-ring': palette.focusRing,
      '--theme-hover': palette.hover,
      '--theme-hover-text': palette.hoverText,
    },
    shell: 'bg-[var(--theme-shell)]',
    surface: 'bg-[var(--theme-surface)]',
    surfaceRaised: 'bg-[var(--theme-surface-raised)]',
    contentCard: 'bg-[var(--theme-content-card)]',
    input: 'bg-[var(--theme-input)]',
    border: 'border-[var(--theme-border)]',
    divider: 'divide-[var(--theme-divider)]',
    text: 'text-[var(--theme-text)]',
    mutedText: 'text-[var(--theme-muted-text)]',
    accentSolid: 'bg-[var(--theme-accent-solid)]',
    accentOnSolid: 'text-[var(--theme-accent-on-solid)]',
    accentSoft: 'bg-[var(--theme-accent-soft)]',
    accentText: 'text-[var(--theme-accent-text)]',
    hover: 'hover:bg-[var(--theme-hover)]',
    hoverText: 'hover:text-[var(--theme-hover-text)]',
    ring: 'focus:ring-[var(--theme-focus-ring)]',
  };
}

function linearChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid six-digit hex color: ${hex}`);
    const channels = [1, 3, 5].map((offset) => linearChannel(Number.parseInt(hex.slice(offset, offset + 2), 16)));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
