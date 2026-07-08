import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Directory names never walked into, whatever the ignore files say — VCS
// metadata, our own store, and the dependency tree that must never be versioned.
// Pruning these at the directory level is also what keeps `status`/`push` fast
// on a real project (a vite app's node_modules is hundreds of MB).
const ALWAYS_IGNORED_DIRS = new Set(['.git', '.thaddeus', 'node_modules']);

interface Rule {
  negated: boolean; // `!pattern` re-includes a path an earlier rule ignored
  dirOnly: boolean; // a trailing slash restricts the match to directories
  re: RegExp; // tested against a repo-relative POSIX path
}

export interface Ignore {
  // Whether a repo-relative POSIX path is ignored. `isDir` matches prune the
  // whole subtree (the walk never descends into an ignored directory).
  ignored(relPath: string, isDir: boolean): boolean;
}

// Translate one gitignore glob (already stripped of a leading `!`/`/` and a
// trailing `/`) into a regex body over a POSIX path: `*` stays within a path
// segment, `**` crosses segments, `?` is one non-slash char.
function globToRe(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` matches zero or more directories
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

// Compile one non-blank, non-comment ignore line into a Rule, or null if empty.
function compile(line: string): Rule | null {
  let pat = line;
  const negated = pat.startsWith('!');
  if (negated) pat = pat.slice(1);
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  if (pat === '') return null;
  // A slash anywhere but the (already-removed) trailing one anchors the pattern
  // to the ignore file's directory — here the repo root; otherwise it matches at
  // any depth. A leading slash only anchors and is not part of the match.
  const anchored = pat.includes('/');
  const body = globToRe(pat.startsWith('/') ? pat.slice(1) : pat);
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // The `(?:/.*)?` tail lets a directory match also cover everything beneath it.
  return { negated, dirOnly, re: new RegExp(`${prefix}${body}(?:/.*)?$`) };
}

function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // gitignore ignores trailing whitespace (we skip the backslash-escape edge
    // case); blanks and `#` comments are not rules.
    const line = raw.replace(/\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const rule = compile(line);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

// Load the ignore rules for a working copy: the repo-root `.gitignore` then
// `.thaddeusignore` (later rules win, so `.thaddeusignore` can re-include a path
// with `!`). `.git`, `.thaddeus`, and `node_modules` are always pruned. Only the
// root-level ignore files are read — nested ignore files are a later refinement.
export function loadIgnore(root: string): Ignore {
  const rules: Rule[] = [];
  for (const name of ['.gitignore', '.thaddeusignore']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      rules.push(...parse(readFileSync(path, 'utf8')));
    } catch {
      // An unreadable ignore file is treated as absent, not fatal.
    }
  }
  return {
    ignored(relPath: string, isDir: boolean): boolean {
      const base = relPath.slice(relPath.lastIndexOf('/') + 1);
      if (isDir && ALWAYS_IGNORED_DIRS.has(base)) return true;
      // Last matching rule wins (gitignore semantics); a dir-only rule never
      // applies to a file.
      let decision = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(relPath)) decision = !rule.negated;
      }
      return decision;
    },
  };
}
