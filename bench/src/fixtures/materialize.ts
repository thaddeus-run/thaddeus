import { Identity, ready } from '@thaddeus.run/identity';
import { allowAll, Platform } from '@thaddeus.run/platform';
import type { Repo } from '@thaddeus.run/platform';
import type { Backend } from '@thaddeus.run/store';

import { contentFor } from './content';
import type { FixturePlan } from './plan';

// The plan's author identities, derived from their seeds. Author 0 is the
// repository owner. Call `ready()` first: identity needs its crypto loaded.
export function authorsOf(plan: FixturePlan): Identity[] {
  return plan.authorSeeds.map((seed) => Identity.fromSeed(seed));
}

// Replays a plan onto a durable repository, one step at a time, in order.
// Removes of a path the merged state no longer has are fine: the log just
// appends a tombstone. Lands use `allowAll` because the generator wants
// conflicts to reach main, and the default policy would block them.
export async function materializeFixture(
  plan: FixturePlan,
  backend: Backend,
  repoName = 'bench'
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
        const result = await repo.land({
          from: step.from,
          into: step.into,
          policy: allowAll,
        });
        if (!result.landed && result.reason !== undefined) {
          // "No incoming ops" is harmless; anything else means the plan and
          // the log disagree, which would silently skew the fixture.
          if (!result.reason.startsWith('no incoming ops')) {
            throw new Error(`land ${step.from} failed: ${result.reason}`);
          }
        }
        break;
      }
    }
  }
  return repo;
}
