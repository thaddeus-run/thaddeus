#!/usr/bin/env bun
import { ready } from '@thaddeus.run/identity';
import { homedir } from 'node:os';

import { run } from './run';

try {
  await ready();
  // Set process.exitCode instead of calling process.exit() so buffered
  // stdout/stderr fully flushes before the process ends. On Windows terminals
  // (where stdio is an async pipe, e.g. an IDE's integrated shell) process.exit()
  // truncates pending output — a `status`/`push` that printed its result would
  // otherwise appear to do nothing. `serve` never returns, so it is unaffected.
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    home: homedir(),
    stdin: () => Bun.stdin.text(),
  });
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
