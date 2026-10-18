import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'thaddeus-theme';

// Keeps React in sync with the theme class the root <head> script already
// applied, and persists the user's choice when they toggle. Colour transitions
// are enabled one frame after mount so a reload in dark mode never fades in
// from light.
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const root = document.documentElement;
    setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    const frame = requestAnimationFrame(() =>
      root.classList.add('theme-ready')
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const next: Theme = root.classList.contains('dark') ? 'light' : 'dark';
    root.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for
      // this page view.
    }
    setTheme(next);
  }, []);

  return { theme, toggle };
}
