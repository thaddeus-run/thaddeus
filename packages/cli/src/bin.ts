#!/usr/bin/env bun
import { ready } from '@thaddeus.run/identity';
import { homedir } from 'node:os';

import { run } from './run';

await ready();
process.exit(
  await run(process.argv.slice(2), { cwd: process.cwd(), home: homedir() })
);
