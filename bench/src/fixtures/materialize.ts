import { Identity, ready } from '@thaddeus.run/identity';
import { allowAll, Platform } from '@thaddeus.run/platform';
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

// Replays a plan onto a durable repository, one step at a time, in order.
// Removes of a path the merged state no longer has are fine: the log just
// appends a tombstone. Lands use `allowAll` because the generator wants
// conflicts to reach main, and the default policy would block them.
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
      case 'write':
        await repo.log.write(
          step.view,
          step.path,
          contentFor(step),
          authors[step.author],
          { at: step.at }
        );
        break;
      case 'remove':
        await repo.log.remove(step.view, step.path, authors[step.author], {
          at: step.at,
        });
        break;
      case 'land': {
        if (isAlreadyLanded(repo, step.from, step.into)) break;
        const result = await repo.land({
          from: step.from,
          into: step.into,
          policy: opts.policy ?? allowAll,
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
