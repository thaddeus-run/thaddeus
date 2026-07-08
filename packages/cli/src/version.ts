// The CLI version, read from package.json at build time. A JSON import is
// bundled by `bun build --compile` into the standalone binary and resolves
// relative to this file in the dev (`bun src/bin.ts`) and dist (`dist/*.js`)
// layouts alike, so a single source of truth stays correct everywhere.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = (pkg as { version: string }).version;
