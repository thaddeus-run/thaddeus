// @thaddeus.run/theme — shared design tokens for Thaddeus's apps and packages.
//
// Scaffold: a single source of truth for colors so the apps (docs, landing)
// and product packages render consistently. Ships a tokens object plus a
// matching `./style.css` of CSS custom properties.

/** Color tokens, light/dark, as CSS-ready strings. */
export interface ThemeTokens {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
}

/** Default light theme tokens. */
export const lightTokens: ThemeTokens = {
  background: '#ffffff',
  foreground: '#0a0a0a',
  muted: '#6b7280',
  accent: '#2563eb',
};

/** Default dark theme tokens. */
export const darkTokens: ThemeTokens = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  muted: '#9ca3af',
  accent: '#60a5fa',
};

/** Resolve the token set for a given color mode. */
export function resolveTokens(mode: 'light' | 'dark'): ThemeTokens {
  return mode === 'dark' ? darkTokens : lightTokens;
}
