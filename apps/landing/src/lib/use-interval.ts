import { useEffect, useRef } from 'react';

// Runs `callback` every `delayMs` while mounted. Pass null to pause, which the
// animated sections do when the reader prefers reduced motion.
export function useInterval(
  callback: () => void,
  delayMs: number | null
): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delayMs === null) return undefined;
    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}
