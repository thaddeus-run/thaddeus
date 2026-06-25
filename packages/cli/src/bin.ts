#!/usr/bin/env bun
import { ready } from '@thaddeus.run/identity';
import { homedir } from 'node:os';

import { run } from './run';

try {
  await ready();
  process.exit(
    await run(process.argv.slice(2), { cwd: process.cwd(), home: homedir() })
  );
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
