import type { CSSProperties } from 'react';

export type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';

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
  blue: { shell: '#F2F7FC', surface: '#FFFFFF', surfaceRaised: '#F6FAFD', contentCard: '#FBFDFF', input: '#FFFFFF', border: '#7D91AA', divider: '#E0E8F1', text: '#1F2A3A', mutedText: '#5A687C', accentSolid: '#CADFF6', accentOnSolid: '#1F3A5F', accentSoft: '#E6F0FB', accentText: '#3A6491', focusRing: '#6E96C8', hover: '#B9D3F0', hoverText: '#1F3A5F' },
  pink: { shell: '#FDF4F7', surface: '#FFFFFF', surfaceRaised: '#FEF7FA', contentCard: '#FFFBFC', input: '#FFFFFF', border: '#A78592', divider: '#F1E2E8', text: '#34232B', mutedText: '#735C67', accentSolid: '#F8D3DF', accentOnSolid: '#5B2338', accentSoft: '#FCE9EF', accentText: '#A0456B', focusRing: '#D88CA8', hover: '#F3C1D2', hoverText: '#5B2338' },
  yellow: { shell: '#FDFAEC', surface: '#FFFFFF', surfaceRaised: '#FFFCF1', contentCard: '#FFFDF7', input: '#FFFFFF', border: '#9A8E60', divider: '#EFE9D3', text: '#2F2A15', mutedText: '#6B6248', accentSolid: '#FAE9A8', accentOnSolid: '#4D3D07', accentSoft: '#FDF4CF', accentText: '#806511', focusRing: '#C9A84A', hover: '#F5DF8C', hoverText: '#4D3D07' },
  green: { shell: '#F1F8F2', surface: '#FFFFFF', surfaceRaised: '#F5FAF6', contentCard: '#FAFDFB', input: '#FFFFFF', border: '#789581', divider: '#DDEBE0', text: '#1B2A20', mutedText: '#56685B', accentSolid: '#C9E9D2', accentOnSolid: '#1E4A2E', accentSoft: '#E4F4E8', accentText: '#2F7148', focusRing: '#6EAE86', hover: '#B6DFC2', hoverText: '#1E4A2E' },
  purple: { shell: '#F7F4FD', surface: '#FFFFFF', surfaceRaised: '#FAF7FE', contentCard: '#FCFBFF', input: '#FFFFFF', border: '#9388AD', divider: '#E8E2F3', text: '#2A2238', mutedText: '#665D78', accentSolid: '#DED3F6', accentOnSolid: '#3E2C6E', accentSoft: '#EFE9FB', accentText: '#6650A8', focusRing: '#9C86D6', hover: '#D0C1F1', hoverText: '#3E2C6E' },
  white: { shell: '#F7F7F8', surface: '#FFFFFF', surfaceRaised: '#FAFAFB', contentCard: '#FDFDFD', input: '#FFFFFF', border: '#8E9299', divider: '#E7E8EA', text: '#2B2D31', mutedText: '#64686F', accentSolid: '#2B6DE8', accentOnSolid: '#FFFFFF', accentSoft: '#E7F0FE', accentText: '#1D58C6', focusRing: '#2B6DE8', hover: '#1F5DD0', hoverText: '#FFFFFF' },
  black: { shell: '#161618', surface: '#1F1F22', surfaceRaised: '#29292D', contentCard: '#303035', input: '#1B1B1E', border: '#76767F', divider: '#35353B', text: '#F2F2F3', mutedText: '#ABABB3', accentSolid: '#E4E4E7', accentOnSolid: '#1F1F22', accentSoft: '#2F2F34', accentText: '#EDEDEF', focusRing: '#D4D4D8', hover: '#F0F0F2', hoverText: '#1F1F22' },
  navy: { shell: '#141C2E', surface: '#1C263B', surfaceRaised: '#253149', contentCard: '#2B3852', input: '#18213A', border: '#6D7FA0', divider: '#313F5A', text: '#EEF2FA', mutedText: '#AAB6CC', accentSolid: '#C9D8F5', accentOnSolid: '#1A2744', accentSoft: '#2A3A5C', accentText: '#C3D4F6', focusRing: '#A9C1EE', hover: '#D7E2F8', hoverText: '#1A2744' },
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

export function normalizeThemeColor(value: unknown): ThemeColor {
  return typeof value === 'string' && value in THEME_PALETTES ? value as ThemeColor : 'white';
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
