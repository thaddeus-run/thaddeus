import { Moon, Sun } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

import { useTheme } from '@/lib/theme';

// A round icon button that swaps sun and moon with a short rotate-and-fade.
export function ThemeToggle(): ReactNode {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="border-rule bg-surface text-ink grid size-7 place-items-center rounded-full border"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          className="grid"
          initial={{ rotate: -40, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          exit={{ rotate: 40, opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          {isDark ? (
            <Sun size={14} strokeWidth={1.6} />
          ) : (
            <Moon size={14} strokeWidth={1.6} />
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
