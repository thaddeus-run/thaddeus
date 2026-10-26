import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentFor } from '../fixtures/content';
import type { FixturePlan } from '../fixtures/plan';

// The plaintext main tree of a serial plan, and the fixed edit the status and
// diff cases apply to it. Both the thaddeus and the git side apply the same
// edit to the same tree.

// How many files the edit touches.
export const EDIT_FILES = 10;
const EDIT_LINE = '// bench edit\n';

// Replays a serial plan in memory and returns what main holds at the end:
// path to file bytes. Only the open view's map is kept, and it is dropped
// after it lands, because a stress plan would otherwise hold hundreds of
// copies of a 20,000-file tree. Throws on a base plan, whose lands merge
// concurrent views and so have no single replayable tree.
export function mainTree(plan: FixturePlan): Map<string, Uint8Array> {
  if (plan.spec.variant !== 'serial') {
    throw new Error(`mainTree needs a serial plan, got ${plan.spec.name}`);
  }
  let main = new Map<string, Uint8Array>();
  const open = new Map<string, Map<string, Uint8Array>>();
  const tree = (view: string) => (view === 'main' ? main : open.get(view));
  for (const step of plan.steps) {
    if (step.kind === 'fork') open.set(step.view, new Map(main));
    else if (step.kind === 'land') {
      const landed = open.get(step.from);
      if (landed !== undefined) main = landed;
      open.delete(step.from);
    } else if (step.kind === 'write')
      tree(step.view)?.set(step.path, contentFor(step));
    else tree(step.view)?.delete(step.path);
  }
  return main;
}

// The files the edit touches: the first EDIT_FILES paths of main in sorted
// order, so every run and both tools edit the same ones.
export function editPaths(plan: FixturePlan): string[] {
  return [...mainTree(plan).keys()].sort().slice(0, EDIT_FILES);
}

// Appends one comment line to each of `paths` under `dir`. The same bytes go
// onto the thaddeus working copy and the git one, so both see the same change.
export function applyEdit(dir: string, paths: readonly string[]): void {
  for (const path of paths) appendFileSync(join(dir, path), EDIT_LINE);
}
