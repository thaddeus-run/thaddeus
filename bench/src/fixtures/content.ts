import { createPrng } from '../prng';
import type { Step } from './plan';

// Pulls the file number back out of a plan path such as `src/f12.ts`.
function fileIndex(path: string): number {
  const match = /f(\d+)\.ts$/.exec(path);
  if (match === null) throw new Error(`unexpected fixture path: ${path}`);
  return Number(match[1]);
}

// Builds deterministic source for one write step: a few imports from
// lower-numbered files, then functions that call into them. Functions are
// written `fn name() { ... }` because that is the only definition shape the
// graph package's HeuristicExtractor recognizes; with `export function` it
// would find no symbols and the query cases would measure an empty graph. The text is padded
// with a comment to land on `step.bytes`. It depends only on the step, so any
// process regenerates identical bytes.
export function contentFor(step: Extract<Step, { kind: 'write' }>): Uint8Array {
  const prng = createPrng(step.contentSeed);
  const file = fileIndex(step.path);

  // Imports point at lower-numbered files only, so the planner never needs to
  // know how many files exist.
  const others: number[] = [];
  if (file > 0) {
    const wanted = 1 + prng.int(2);
    for (let i = 0; i < wanted; i++) {
      const other = file - 1 - prng.int(Math.min(file, 8));
      if (!others.includes(other)) others.push(other);
    }
  }

  let text = others
    .map((o) => `import { f_${o}_0, f_${o}_1 } from './f${o}.ts';\n`)
    .join('');

  const functionLine = (k: number): string => {
    let call: string;
    if (others.length > 0) {
      call = `f_${others[prng.int(others.length)]}_${prng.int(2)}()`;
    } else {
      call = k > 0 ? `f_${file}_${k - 1}()` : '0';
    }
    return `fn f_${file}_${k}() { return ${call}; }\n`;
  };

  // Every file defines f_<file>_0 and f_<file>_1 so imports always resolve.
  let k = 0;
  while (k < 2) text += functionLine(k++);
  for (;;) {
    const line = functionLine(k);
    if (text.length + line.length > step.bytes) break;
    text += line;
    k++;
  }

  // Everything is ASCII, so string length equals byte length.
  const remaining = step.bytes - text.length;
  if (remaining > 4) text += `//${'.'.repeat(remaining - 3)}\n`;
  return new TextEncoder().encode(text);
}
