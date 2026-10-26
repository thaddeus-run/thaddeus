import { ready } from '@thaddeus.run/identity';
import { signHead } from '@thaddeus.run/log';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { COMPLETE, fixtureDir, linkCopy } from '../fixtures/cache';
import { authorsOf } from '../fixtures/materialize';
import type { FixturePlan } from '../fixtures/plan';

// The server address a bench working copy names. Port 9 (discard) refuses
// connections, so a command that tried to reach the server would fail loudly
// instead of timing something that is not local.
export const UNUSED_SERVER = 'http://127.0.0.1:9';

// Builds, at `dir`, a working copy shaped like the one `thaddeus clone` leaves
// after cloning the seeded server root of the same plan, without a server:
//   - the fixture's store hard-linked into .thaddeus/store;
//   - the owner-signed head chain for main that the seeding server holds and
//     a clone imports: a genesis record (version 0, no heads) and version 1 at
//     main's heads, because seeding lands main once. Every command's
//     `Platform.openDurable` walks the head records, so without them status
//     and diff would skip that work;
//   - only the `main` view record, as a clone keeps (the fixture also holds a
//     record for each fork view of the serial plan);
//   - main written to disk as the owner reads it, and a config whose base is
//     main's heads.
// status and diff read only the store, the head records and the disk, and the
// slow test checks this copy against a real clone for the same status output
// and the same record kinds. A clone of a server that has seen more lands
// holds a longer head chain, and a clone also holds the pulled provenance and
// review logs, which the seeded root has none of. Commands that talk to a
// server would fail on the unused address, and no case runs them here. `dir`
// must be on the same filesystem as the fixture cache (see WORK_ROOT),
// because the store is hard-linked.
export async function thadWorkingCopy(
  plan: FixturePlan,
  dir: string
): Promise<void> {
  await ready();
  const store = join(dir, '.thaddeus', 'store');
  await linkCopy(await fixtureDir(plan), store);
  // The cache marker is not part of a store; a clone has none.
  rmSync(join(store, COMPLETE), { force: true });
  const [owner] = authorsOf(plan);
  const repo = await new Platform().openDurable(
    'bench',
    new FileBackend(store)
  );
  // Unlinks the other views' records; the hard-linked files they share with
  // the cache stay intact there.
  for (const view of repo.branches()) {
    if (view !== 'main') await repo.log.dropView(view);
  }
  const heads = [...repo.heads('main')];
  const genesis = signHead(
    { repo: 'bench', view: 'main', version: 0, previous: null, heads: [] },
    owner
  );
  await repo.headRecords.bootstrap(genesis);
  await repo.headRecords.advance(
    signHead(
      {
        repo: 'bench',
        view: 'main',
        version: 1,
        previous: genesis.id,
        heads,
      },
      owner
    )
  );
  for (const [path, entry] of repo.log.materialize('main', owner)) {
    if (entry.ref === null) continue;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, await repo.store.get(entry.ref, owner));
  }
  const config = {
    server: UNUSED_SERVER,
    repo: 'bench',
    base: heads,
    view: 'main',
  };
  writeFileSync(
    join(dir, '.thaddeus', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`
  );
}
