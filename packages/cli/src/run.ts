import { Client } from '@thaddeus.run/client';
import { parseArgs } from 'node:util';

import { initIdentity, loadIdentity } from './identity';

export interface CliEnv {
  cwd: string;
  home: string;
  // FetchLike matches the server's fetch(req: Request) shape, keeping it
  // structurally compatible with both the injected server handler and global
  // fetch (which also accepts Request). NOT `typeof fetch` to avoid the
  // overloaded global type mismatch with createServer(...).fetch.
  fetchImpl?: (req: Request) => Promise<Response>;
  out?: (line: string) => void;
}

const USAGE = `thaddeus — the Thaddeus CLI
  init                              create a self-owned identity
  create <server> <repo>           create a repo on a server
  clone  <server> <repo> [dir]     clone a repo to a working tree
  status                           show working-tree changes
  push   [--no-land]               commit + upload + land into main
  land                             land uploaded-but-unmerged commits`;

// The injectable entry point. Returns a process exit code.
export async function run(
  argv: readonly string[],
  env: CliEnv
): Promise<number> {
  const out = env.out ?? ((l: string): void => console.log(l));
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'init': {
        const { values } = parseArgs({
          args: [...rest],
          options: { force: { type: 'boolean' } },
          allowPositionals: true,
        });
        const { did, created } = initIdentity(env.home, values.force === true);
        out(created ? `created identity ${did}` : `identity ${did}`);
        return 0;
      }
      case 'create': {
        const [server, repo] = rest;
        if (server === undefined || repo === undefined) {
          out('usage: thaddeus create <server> <repo>');
          return 2;
        }
        const client = new Client(
          server,
          loadIdentity(env.home),
          env.fetchImpl
        );
        const created = await client.createRepo(repo);
        out(`created ${created.name} (owner ${created.owner})`);
        return 0;
      }
      // clone / status / push / land are added in Tasks 5–6.
      case undefined:
      case 'help':
      case '--help':
        out(USAGE);
        return 0;
      default:
        out(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return 1;
  }
}
