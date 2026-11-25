// How diffs look. Stored with the rest of the settings (`@/lib/settings`).

import type { DiffIndicators, LineDiffTypes, ThemeTypes } from "@pierre/diffs"

export type DiffSettings = {
  diffStyle: "split" | "unified"
  themeType: ThemeTypes
  lightTheme: string
  darkTheme: string
  overflow: "scroll" | "wrap"
  lineDiffType: LineDiffTypes
  diffIndicators: DiffIndicators
  backgrounds: boolean
  lineNumbers: boolean
  hunkSeparators: "line-info" | "line-info-basic" | "metadata" | "simple"
  lineHoverHighlight: "disabled" | "line" | "number" | "both"
  stickyHeader: boolean
  fileHeader: boolean
}

export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  diffStyle: "split",
  themeType: "system",
  lightTheme: "pierre-light",
  darkTheme: "pierre-dark",
  overflow: "scroll",
  lineDiffType: "word-alt",
  diffIndicators: "bars",
  backgrounds: true,
  lineNumbers: true,
  hunkSeparators: "line-info",
  lineHoverHighlight: "disabled",
  stickyHeader: true,
  fileHeader: true,
}

type Choice<T> = { value: T; label: string }

export const DIFF_STYLES: Choice<DiffSettings["diffStyle"]>[] = [
  { value: "split", label: "Side by side" },
  { value: "unified", label: "Unified" },
]

export const THEME_TYPES: Choice<ThemeTypes>[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

export const OVERFLOWS: Choice<DiffSettings["overflow"]>[] = [
  { value: "scroll", label: "Scroll" },
  { value: "wrap", label: "Wrap" },
]

export const LINE_DIFF_TYPES: Choice<LineDiffTypes>[] = [
  { value: "word-alt", label: "Words" },
  { value: "word", label: "Each word separately" },
  { value: "word-line", label: "First to last change" },
  { value: "char", label: "Characters" },
  { value: "none", label: "Off" },
]

export const DIFF_INDICATORS: Choice<DiffIndicators>[] = [
  { value: "bars", label: "Bars" },
  { value: "classic", label: "+ and −" },
  { value: "none", label: "None" },
]

export const HUNK_SEPARATORS: Choice<DiffSettings["hunkSeparators"]>[] = [
  { value: "line-info", label: "Hidden line count" },
  { value: "line-info-basic", label: "Hidden line count, basic" },
  { value: "metadata", label: "Hunk header" },
  { value: "simple", label: "Plain divider" },
]

export const LINE_HOVER_HIGHLIGHTS: Choice<DiffSettings["lineHoverHighlight"]>[] = [
  { value: "disabled", label: "Off" },
  { value: "line", label: "Line" },
  { value: "number", label: "Line number" },
  { value: "both", label: "Line and number" },
]

// The themes bundled with @pierre/diffs (Pierre's own plus Shiki's), by appearance.
export const LIGHT_THEMES = [
  "pierre-light",
  "pierre-light-soft",
  "pierre-light-vibrant",
  "pierre-light-protanopia-deuteranopia",
  "pierre-light-tritanopia",
  "ayu-light",
  "catppuccin-latte",
  "everforest-light",
  "github-light",
  "github-light-default",
  "github-light-high-contrast",
  "gruvbox-light-hard",
  "gruvbox-light-medium",
  "gruvbox-light-soft",
  "horizon-bright",
  "kanagawa-lotus",
  "light-plus",
  "material-theme-lighter",
  "min-light",
  "night-owl-light",
  "one-light",
  "rose-pine-dawn",
  "slack-ochin",
  "snazzy-light",
  "solarized-light",
  "vitesse-light",
]

export const DARK_THEMES = [
  "pierre-dark",
  "pierre-dark-soft",
  "pierre-dark-vibrant",
  "pierre-dark-protanopia-deuteranopia",
  "pierre-dark-tritanopia",
  "andromeeda",
  "aurora-x",
  "ayu-dark",
  "ayu-mirage",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dark-plus",
  "dracula",
  "dracula-soft",
  "everforest-dark",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "horizon",
  "houston",
  "kanagawa-dragon",
  "kanagawa-wave",
  "laserwave",
  "material-theme",
  "material-theme-darker",
  "material-theme-ocean",
  "material-theme-palenight",
  "min-dark",
  "monokai",
  "night-owl",
  "nord",
  "one-dark-pro",
  "plastic",
  "poimandres",
  "red",
  "rose-pine",
  "rose-pine-moon",
  "slack-dark",
  "solarized-dark",
  "synthwave-84",
  "tokyo-night",
  "vesper",
  "vitesse-black",
  "vitesse-dark",
]

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

const values = <T>(choices: Choice<T>[]) => choices.map((c) => c.value)
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)

/** Reads stored settings, falling back to the default for anything missing or unrecognised. */
export function parseDiffSettings(value: unknown): DiffSettings {
  const raw = (value != null && typeof value === "object" ? value : {}) as Partial<Record<keyof DiffSettings, unknown>>
  const d = DEFAULT_DIFF_SETTINGS
  return {
    diffStyle: oneOf(raw.diffStyle, values(DIFF_STYLES), d.diffStyle),
    themeType: oneOf(raw.themeType, values(THEME_TYPES), d.themeType),
    lightTheme: oneOf(raw.lightTheme, LIGHT_THEMES, d.lightTheme),
    darkTheme: oneOf(raw.darkTheme, DARK_THEMES, d.darkTheme),
    overflow: oneOf(raw.overflow, values(OVERFLOWS), d.overflow),
    lineDiffType: oneOf(raw.lineDiffType, values(LINE_DIFF_TYPES), d.lineDiffType),
    diffIndicators: oneOf(raw.diffIndicators, values(DIFF_INDICATORS), d.diffIndicators),
    backgrounds: flag(raw.backgrounds, d.backgrounds),
    lineNumbers: flag(raw.lineNumbers, d.lineNumbers),
    hunkSeparators: oneOf(raw.hunkSeparators, values(HUNK_SEPARATORS), d.hunkSeparators),
    lineHoverHighlight: oneOf(raw.lineHoverHighlight, values(LINE_HOVER_HIGHLIGHTS), d.lineHoverHighlight),
    stickyHeader: flag(raw.stickyHeader, d.stickyHeader),
    fileHeader: flag(raw.fileHeader, d.fileHeader),
  }
}

/** The `@pierre/diffs` options these settings control. */
export function diffViewOptions(s: DiffSettings) {
  return {
    diffStyle: s.diffStyle,
    themeType: s.themeType,
    theme: { light: s.lightTheme, dark: s.darkTheme },
    overflow: s.overflow,
    lineDiffType: s.lineDiffType,
    diffIndicators: s.diffIndicators,
    disableBackground: !s.backgrounds,
    disableLineNumbers: !s.lineNumbers,
    hunkSeparators: s.hunkSeparators,
    lineHoverHighlight: s.lineHoverHighlight,
    stickyHeader: s.stickyHeader,
    disableFileHeader: !s.fileHeader,
  }
}
