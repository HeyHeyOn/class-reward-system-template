import type { CSSProperties } from 'react';

export type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';

export type SemanticThemePalette = {
  shell: string;
  surface: string;
  surfaceRaised: string;
  input: string;
  border: string;
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
  blue: { shell: '#EDF5FA', surface: '#FFFFFF', surfaceRaised: '#F5F9FC', input: '#FFFFFF', border: '#7D98A8', text: '#1F2937', mutedText: '#52616B', accentSolid: '#B8D0E0', accentOnSolid: '#1F2937', accentSoft: '#D8E9F2', accentText: '#365F78', focusRing: '#365F78', hover: '#A6C3D6', hoverText: '#1F2937' },
  pink: { shell: '#FAEDED', surface: '#FFFFFF', surfaceRaised: '#FFF7F7', input: '#FFFFFF', border: '#A87E7E', text: '#2A2020', mutedText: '#685858', accentSolid: '#F0C7C7', accentOnSolid: '#2A2020', accentSoft: '#F4DADA', accentText: '#774444', focusRing: '#8F5555', hover: '#E7B6B6', hoverText: '#2A2020' },
  yellow: { shell: '#FCFAE6', surface: '#FFFFFF', surfaceRaised: '#FFFDF2', input: '#FFFFFF', border: '#9B9147', text: '#292711', mutedText: '#625E3D', accentSolid: '#F5EDA6', accentOnSolid: '#292711', accentSoft: '#F8F2BF', accentText: '#645B12', focusRing: '#766D1E', hover: '#E9DE87', hoverText: '#292711' },
  green: { shell: '#DCF5C9', surface: '#FFFFFF', surfaceRaised: '#F3FBEF', input: '#FFFFFF', border: '#789763', text: '#1F2A1B', mutedText: '#52614A', accentSolid: '#A5C78B', accentOnSolid: '#1F2A1B', accentSoft: '#C3E5AE', accentText: '#405F2F', focusRing: '#4F7138', hover: '#94B978', hoverText: '#1F2A1B' },
  purple: { shell: '#F7EDFC', surface: '#FFFFFF', surfaceRaised: '#FCF7FE', input: '#FFFFFF', border: '#927AA0', text: '#291F2E', mutedText: '#65566C', accentSolid: '#BB99CC', accentOnSolid: '#291F2E', accentSoft: '#E8D6F0', accentText: '#68427A', focusRing: '#76518A', hover: '#AB86BE', hoverText: '#291F2E' },
  white: { shell: '#FCFCFC', surface: '#FFFFFF', surfaceRaised: '#F2F2F2', input: '#FFFFFF', border: '#8A8A8A', text: '#1F1F1F', mutedText: '#595959', accentSolid: '#1F1F1F', accentOnSolid: '#FCFCFC', accentSoft: '#EFEFEF', accentText: '#1F1F1F', focusRing: '#1F1F1F', hover: '#353535', hoverText: '#FCFCFC' },
  black: { shell: '#1F1F1F', surface: '#2B2B2B', surfaceRaised: '#383838', input: '#252525', border: '#818181', text: '#FCFCFC', mutedText: '#C4C4C4', accentSolid: '#FCFCFC', accentOnSolid: '#1F1F1F', accentSoft: '#383838', accentText: '#FCFCFC', focusRing: '#FCFCFC', hover: '#E5E5E5', hoverText: '#1F1F1F' },
  navy: { shell: '#111A2E', surface: '#1B2945', surfaceRaised: '#293B61', input: '#17233B', border: '#7184A6', text: '#F7FAFF', mutedText: '#C3CEE0', accentSolid: '#D9E5FF', accentOnSolid: '#111A2E', accentSoft: '#293B61', accentText: '#F7FAFF', focusRing: '#D9E5FF', hover: '#C3D2F0', hoverText: '#111A2E' },
};

type ThemeVariables = CSSProperties & Record<`--theme-${string}`, string>;

export type ThemeStyles = {
  variables: ThemeVariables;
  shell: string;
  surface: string;
  surfaceRaised: string;
  input: string;
  border: string;
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
      '--theme-input': palette.input,
      '--theme-border': palette.border,
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
    input: 'bg-[var(--theme-input)]',
    border: 'border-[var(--theme-border)]',
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
