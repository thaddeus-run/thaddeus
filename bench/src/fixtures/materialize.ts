import { Identity, ready } from '@thaddeus.run/identity';
import { Platform } from '@thaddeus.run/platform';
import type { LandPolicy, Repo } from '@thaddeus.run/platform';
import type { Backend } from '@thaddeus.run/store';

import { contentFor } from './content';
import type { FixturePlan } from './plan';

// The plan's author identities, derived from their seeds. Author 0 is the
// repository owner. Call `ready()` first: identity needs its crypto loaded.
export function authorsOf(plan: FixturePlan): Identity[] {
  return plan.authorSeeds.map((seed) => Identity.fromSeed(seed));
}

// Whether landing `from` into `into` would change nothing: `from` has no heads
// (empty or unknown view), or every head is already an ancestor of, or equal
// to, one of `into`'s heads. Decided up front because Repo.land reports every
// refusal with the same unchanged heads, so its result cannot tell a harmless
// no-op from a policy denial.
function isAlreadyLanded(repo: Repo, from: string, into: string): boolean {
  const merged = new Set<string>();
  for (const op of repo.log.reachable(repo.log.heads(into))) merged.add(op.id);
  return repo.log.heads(from).every((head) => merged.has(head));
}

// The head-set a land of `from` into `into` re-points `into` to: the sorted,
// de-duplicated union of both views' heads. A copy of `mergeHeads` in
// packages/platform/src/platform.ts, which the platform does not export;
// the materialize test checks that both give the same persisted state.
function mergedHeads(repo: Repo, from: string, into: string): string[] {
  return [
    ...new Set([...repo.log.heads(into), ...repo.log.heads(from)]),
  ].sort();
}

// Replays a plan onto a durable repository, one step at a time, in order.
// Every file another author writes is also granted to the owner, as the CLI
// does when it reshares files to members.
// Removes of a path the merged state no longer has are fine: the log just
// appends a tombstone. A land re-points `into` straight to the merged heads,
// which is what `Repo.land` persists under `allowAll` (the generator wants
// conflicts to reach main). It skips `Repo.land` because that always runs
// `conflicts()` on the merged view, the very cost the suite measures: it
// made fixture builds grow about as n^4 with history length. Pass `policy`
// to land through `Repo.land` under that policy instead, as tests do to
// compare the two paths or to check that a refused land fails the build.
export async function materializeFixture(
  plan: FixturePlan,
  backend: Backend,
  repoName = 'bench',
  opts: { policy?: LandPolicy } = {}
): Promise<Repo> {
  await ready();
  const authors = authorsOf(plan);
  const repo = await new Platform().createDurable(repoName, backend);

  for (const step of plan.steps) {
    switch (step.kind) {
      case 'fork':
        repo.log.fork(step.view, step.from);
        break;
      case 'write': {
        const op = await repo.log.write(
          step.view,
          step.path,
          contentFor(step),
          authors[step.author],
          { at: step.at }
        );
        // `store.put` seals an object to its writer alone. The real client
        // reshares every file to the repository's members before upload, so
        // the owner (author 0) is granted each other author's files.
        if (step.author !== 0 && op.payload !== null) {
          await repo.store.grant(
            op.payload,
            authors[0].toPublic(),
            authors[step.author]
          );
        }
        break;
      }
      case 'remove':
        await repo.log.remove(step.view, step.path, authors[step.author], {
          at: step.at,
        });
        break;
      case 'land': {
        if (isAlreadyLanded(repo, step.from, step.into)) break;
        if (opts.policy === undefined) {
          // `repoint` writes view/<into> through to the backend, as the
          // allowed branch of Repo.land does. Repo.land's dry-run view
          // (land/<into>/<n>) is set with `view()`, which is memory only, so
          // skipping it leaves the same records on disk.
          await repo.log.repoint(
            step.into,
            mergedHeads(repo, step.from, step.into)
          );
          break;
        }
        const result = await repo.land({
          from: step.from,
          into: step.into,
          policy: opts.policy,
        });
        // Any refusal here means the plan and the log disagree, which would
        // silently skew the fixture, so fail loudly.
        if (!result.landed) {
          throw new Error(`land ${step.from} failed: ${result.reason}`);
        }
        break;
      }
    }
  }
  return repo;
}
