import { fileContent } from './schedule';

// What the workload wrote and what the server acknowledged, per repository
// and path, so the end-of-run check can say which files main must hold.

interface Version {
  token: number;
  acked: boolean;
}

export class Ledger {
  // repo -> path -> every attempted version, in attempt order.
  readonly #writes = new Map<string, Map<string, Version[]>>();
  // repo -> paths no accepted write may have put on main.
  readonly #forbidden = new Map<string, Set<string>>();

  // Records an attempted write before it is sent.
  attempt(repo: string, edits: readonly { path: string; token: number }[]) {
    let paths = this.#writes.get(repo);
    if (paths === undefined) {
      paths = new Map();
      this.#writes.set(repo, paths);
    }
    for (const { path, token } of edits) {
      const versions = paths.get(path) ?? [];
      versions.push({ token, acked: false });
      paths.set(path, versions);
    }
  }

  // Marks attempted writes as acknowledged: the server said they are on main.
  ack(repo: string, edits: readonly { path: string; token: number }[]) {
    const paths = this.#writes.get(repo);
    for (const { path, token } of edits) {
      const version = paths?.get(path)?.find((v) => v.token === token);
      if (version === undefined) {
        throw new Error(`ledger: ack of unattempted ${repo}:${path}#${token}`);
      }
      version.acked = true;
    }
  }

  // Records a path that only a refused write tried to create.
  forbid(repo: string, path: string) {
    const paths = this.#forbidden.get(repo) ?? new Set();
    paths.add(path);
    this.#forbidden.set(repo, paths);
  }

  repos(): string[] {
    return [...new Set([...this.#writes.keys(), ...this.#forbidden.keys()])];
  }

  // Compares a repository's main, as path -> content, against the ledger.
  // A path with an acknowledged write must hold the latest acknowledged
  // content or a later attempted one, because a write whose answer was lost
  // in a fault may still have landed. A forbidden path must be absent.
  // Returns how many paths it checked and one string per violation.
  check(
    repo: string,
    main: ReadonlyMap<string, string>
  ): { checked: number; violations: string[] } {
    const violations: string[] = [];
    let checked = 0;
    for (const [path, versions] of this.#writes.get(repo) ?? []) {
      const last = versions.findLastIndex((v) => v.acked);
      if (last === -1) continue;
      checked++;
      const allowed = versions
        .slice(last)
        .map((v) => fileContent(path, v.token));
      const actual = main.get(path);
      if (actual === undefined) {
        violations.push(
          `${repo}: acknowledged ${path}#${versions[last].token} is missing from main`
        );
      } else if (!allowed.includes(actual)) {
        violations.push(
          `${repo}: ${path} on main is not its acknowledged content #${versions[last].token} or a later write`
        );
      }
    }
    for (const path of this.#forbidden.get(repo) ?? []) {
      checked++;
      if (main.has(path)) {
        violations.push(`${repo}: refused write ${path} is on main`);
      }
    }
    return { checked, violations };
  }
}
