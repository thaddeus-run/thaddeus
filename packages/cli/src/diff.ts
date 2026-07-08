// A minimal, dependency-free line diff for the `thaddeus diff` command. This is
// deliberately small — an LCS over lines, emitted as tagged lines — not a full
// unified diff with @@ hunk headers. It is enough to show a human (or a TUI)
// what changed in a text file between two snapshots.

// One diff line: context (' '), removed ('-'), or added ('+').
export interface DiffLine {
  readonly tag: ' ' | '-' | '+';
  readonly text: string;
}

// A per-file change with its rendered line diff. `binary` files carry no lines.
export interface FileDiff {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly binary: boolean;
  readonly lines: readonly DiffLine[];
}

// Split into lines WITHOUT a trailing empty element for a final newline, so a
// file and the same file with a trailing newline don't diff as a phantom line.
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

// Bytes are "binary" if they contain a NUL — a cheap, good-enough heuristic that
// keeps the diff from spewing control characters for non-text blobs.
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

// LCS line diff: classic DP table over the two line arrays, then a backtrack
// that emits removed/added/context lines in order. O(n*m) time and space —
// fine for the file sizes a working copy holds.
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tag: '-', text: a[i] });
      i++;
    } else {
      out.push({ tag: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ tag: '-', text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ tag: '+', text: b[j] });
    j++;
  }
  return out;
}

// Build a FileDiff for one path between a base snapshot and a target snapshot
// (either side may be absent → added/deleted). Binary content is flagged, not
// rendered.
export function fileDiff(
  path: string,
  base: Uint8Array | undefined,
  target: Uint8Array | undefined
): FileDiff {
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
  if (base === undefined && target !== undefined) {
    const binary = isBinary(target);
    return {
      path,
      status: 'added',
      binary,
      lines: binary
        ? []
        : toLines(decode(target)).map((text) => ({ tag: '+', text })),
    };
  }
  if (base !== undefined && target === undefined) {
    const binary = isBinary(base);
    return {
      path,
      status: 'deleted',
      binary,
      lines: binary
        ? []
        : toLines(decode(base)).map((text) => ({ tag: '-', text })),
    };
  }
  // Both present → modified (callers only pass paths that actually differ).
  const binary =
    (base !== undefined && isBinary(base)) ||
    (target !== undefined && isBinary(target));
  return {
    path,
    status: 'modified',
    binary,
    lines:
      binary || base === undefined || target === undefined
        ? []
        : lineDiff(decode(base), decode(target)),
  };
}
