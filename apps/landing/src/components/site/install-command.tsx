import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { site } from '@/content/site';

type CopyState = 'idle' | 'copied' | 'selected';

// The async clipboard API only exists in secure contexts, so it is missing on
// a plain-HTTP LAN address such as the Tailscale dev preview, and a browser
// may also refuse the write. Resolve to false in both cases instead of
// throwing or rejecting.
async function copyText(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// The install one-liner with a copy affordance. "copy" becomes "copied" for a
// moment after a click. When the clipboard is unavailable the command text is
// selected instead and the label says so, so the reader can copy it by hand.
export function InstallCommand(): ReactNode {
  const [state, setState] = useState<CopyState>('idle');
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state === 'idle') return undefined;
    const id = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(id);
  }, [state]);

  const copy = (): void => {
    void copyText(site.installCommand).then((ok) => {
      if (ok) {
        setState('copied');
        return;
      }
      const code = codeRef.current;
      const selection = window.getSelection();
      if (code !== null && selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState('selected');
    });
  };

  const label = state === 'idle' ? 'copy' : state;

  return (
    <div className="border-rule bg-surface flex items-center gap-3 rounded-md border px-3.5 py-2.5 text-[13px]">
      <span className="text-accent">$</span>
      <code ref={codeRef}>{site.installCommand}</code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the install command"
        className="text-muted hover:text-ink ml-1.5 w-[8ch] text-left"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            className="inline-block"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}
