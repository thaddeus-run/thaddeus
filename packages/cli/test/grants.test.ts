import { ready } from '@thaddeus.run/identity';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run';
import { startServer } from '../src/serve';

beforeAll(async () => {
  await ready();
});

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-cli-grants-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('thaddeus grant/revoke/grants', () => {
  test('owner grants a teammate scoped push; out-of-scope and post-revoke are rejected', async () => {
    const s = startServer({ dataDir: mkdtempSync(join(tmp, 'srv-')), port: 0 });
    try {
      const out: string[] = [];
      const ownerHome = mkdtempSync(join(tmp, 'owner-'));
      const teammateHome = mkdtempSync(join(tmp, 'mate-'));
      const e = (cwd: string, home: string) => ({
        cwd,
        home,
        out: (l: string) => out.push(l),
      });

      await run(['init'], e(ownerHome, ownerHome));
      await run(['init'], e(teammateHome, teammateHome));
      // Read the teammate DID from their identity file.
      const teammateDid = (
        JSON.parse(
          readFileSync(
            join(teammateHome, '.config', 'thaddeus', 'identity.json'),
            'utf8'
          )
        ) as { did: string }
      ).did;

      // Owner creates + clones the repo, then grants the teammate src/**.
      await run(['create', s.url, 'proj'], e(ownerHome, ownerHome));
      const ownerWc = mkdtempSync(join(tmp, 'ownerwc-'));
      await run(['clone', s.url, 'proj', ownerWc], e(ownerWc, ownerHome));
      out.length = 0;
      expect(
        await run(
          ['grant', teammateDid, '--paths', 'src/**'],
          e(ownerWc, ownerHome)
        )
      ).toBe(0);
      expect(out.join('\n')).toContain(teammateDid);

      // Teammate clones, edits in scope → push lands.
      const mateWc = mkdtempSync(join(tmp, 'matewc-'));
      await run(['clone', s.url, 'proj', mateWc], e(mateWc, teammateHome));
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'x.rs'), 'fn x() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(0);
      expect(out.join('\n').toLowerCase()).toContain('published');

      // Out of scope → push reports the blocked land, and the reason names the
      // delegated-scope violation (not just "didn't land for some reason").
      writeFileSync(join(mateWc, 'readme.md'), 'hi');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
      expect(out.join('\n').toLowerCase()).toContain('not landed');
      expect(out.join('\n').toLowerCase()).toContain('scope');

      // grants lists the active grant; revoke then blocks the teammate.
      out.length = 0;
      await run(['grants'], e(ownerWc, ownerHome));
      expect(out.join('\n')).toContain(teammateDid);
      await run(['revoke', teammateDid], e(ownerWc, ownerHome));
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'z.rs'), 'fn z() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
    } finally {
      await s.stop();
    }
  });
});
