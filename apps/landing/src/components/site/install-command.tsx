import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';

import { site } from '@/content/site';

// The install one-liner with a copy affordance. "copy" becomes "copied" for a
// moment after a click.
export function InstallCommand(): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(site.installCommand)
      .then(() => setCopied(true));
  };

  return (
    <div className="border-rule bg-surface flex items-center gap-3 rounded-md border px-3.5 py-2.5 text-[13px]">
      <span className="text-accent">$</span>
      <code>{site.installCommand}</code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the install command"
        className="text-muted hover:text-ink ml-1.5 w-[6ch] text-left"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? 'copied' : 'copy'}
            className="inline-block"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {copied ? 'copied' : 'copy'}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}
