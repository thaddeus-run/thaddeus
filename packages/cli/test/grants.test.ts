import { Client } from '@thaddeus.run/client';
import { ready } from '@thaddeus.run/identity';
import { FileBackend } from '@thaddeus.run/persist';
import { Platform } from '@thaddeus.run/platform';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadIdentity } from '../src/identity';
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
      mkdirSync(join(ownerWc, 'src'), { recursive: true });
      writeFileSync(join(ownerWc, 'src', 'secret.rs'), 'fn secret() {}\n');
      expect(
        await run(['push', '-m', 'seed secret'], e(ownerWc, ownerHome))
      ).toBe(0);
      out.length = 0;
      expect(
        await run(
          ['grant', teammateDid, '--paths', 'src/**'],
          e(ownerWc, ownerHome)
        )
      ).toBe(0);
      expect(out.join('\n')).toContain(teammateDid);

      // Teammate clones and uploads an in-scope edit. Shared landing requires
      // the owner, and the CLI prints the head IDs for that handoff.
      const mateWc = mkdtempSync(join(tmp, 'matewc-'));
      await run(['clone', s.url, 'proj', mateWc], e(mateWc, teammateHome));
      expect(readFileSync(join(mateWc, 'src', 'secret.rs'), 'utf8')).toBe(
        'fn secret() {}\n'
      );
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'x.rs'), 'fn x() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
      expect(out.join('\n')).toContain('owner signature required');
      expect(out.join('\n')).toContain('uploaded head IDs');
      expect(out.join('\n').toLowerCase()).not.toContain('published to');
      const ownerClient = new Client(s.url, loadIdentity(ownerHome));
      let mateLocal = await new Platform().openDurable(
        'proj',
        new FileBackend(join(mateWc, '.thaddeus', 'store'))
      );
      expect(
        await ownerClient.land('proj', mateLocal, mateLocal.log.heads('main'))
      ).toMatchObject({ landed: true });

      // The delegate can still upload an out-of-scope edit, but the owner's
      // attempted landing runs policy and rejects the delegated-scope violation.
      writeFileSync(join(mateWc, 'readme.md'), 'hi');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
      expect(out.join('\n')).toContain('owner signature required');
      mateLocal = await new Platform().openDurable(
        'proj',
        new FileBackend(join(mateWc, '.thaddeus', 'store'))
      );
      const scopeDenied = await ownerClient.land(
        'proj',
        mateLocal,
        mateLocal.log.heads('main')
      );
      expect(scopeDenied).toMatchObject({ landed: false });
      expect(scopeDenied.reason).toContain('scope');

      // grants lists the active grant; revoke then blocks the teammate.
      out.length = 0;
      await run(['grants'], e(ownerWc, ownerHome));
      expect(out.join('\n')).toContain(teammateDid);
      out.length = 0;
      expect(await run(['revoke', teammateDid], e(ownerWc, ownerHome))).toBe(0);
      expect(out.join('\n')).toContain('rotated');
      const ownerBackend = new FileBackend(join(ownerWc, '.thaddeus', 'store'));
      const ownerLocal = await new Platform().openDurable('proj', ownerBackend);
      expect(
        ownerLocal.log.views().filter((v) => v.startsWith('land/'))
      ).toEqual([]);
      const postRevokeClone = mkdtempSync(join(tmp, 'mate-reclone-'));
      expect(
        await run(
          ['clone', s.url, 'proj', postRevokeClone],
          e(postRevokeClone, teammateHome)
        )
      ).toBe(0);
      expect(existsSync(join(postRevokeClone, 'src', 'secret.rs'))).toBe(false);
      mkdirSync(join(mateWc, 'src'), { recursive: true });
      writeFileSync(join(mateWc, 'src', 'z.rs'), 'fn z() {}');
      out.length = 0;
      expect(await run(['push'], e(mateWc, teammateHome))).toBe(1);
      // After revoke the delegate fails the push GATE with "not authorized to
      // write this repo" — distinct from the earlier out-of-scope failure — so
      // assert the failure is authorization-specific, not the residual scope one.
      expect(out.join('\n').toLowerCase()).toContain('not authorized');
    } finally {
      await s.stop();
    }
  });

  test('an hourly rate cap rejects the landing that exceeds it', async () => {
    const s = startServer({
      dataDir: mkdtempSync(join(tmp, 'srv2-')),
      port: 0,
    });
    try {
      const out: string[] = [];
      const ownerHome = mkdtempSync(join(tmp, 'owner2-'));
      const mateHome = mkdtempSync(join(tmp, 'mate2-'));
      const e = (cwd: string, home: string) => ({
        cwd,
        home,
        out: (l: string) => out.push(l),
      });
      await run(['init'], e(ownerHome, ownerHome));
      await run(['init'], e(mateHome, mateHome));
      const mateDid = (
        JSON.parse(
          readFileSync(
            join(mateHome, '.config', 'thaddeus', 'identity.json'),
            'utf8'
          )
        ) as { did: string }
      ).did;

      await run(['create', s.url, 'proj2'], e(ownerHome, ownerHome));
      const ownerWc = mkdtempSync(join(tmp, 'ownerwc2-'));
      await run(['clone', s.url, 'proj2', ownerWc], e(ownerWc, ownerHome));
      mkdirSync(join(ownerWc, 'src'), { recursive: true });
      writeFileSync(join(ownerWc, 'src', 'seed.rs'), 'fn seed() {}\n');
      expect(await run(['push', '-m', 'seed'], e(ownerWc, ownerHome))).toBe(0);

      // Bad flag value → exit 2 with a terse message.
      out.length = 0;
      expect(
        await run(
          ['grant', mateDid, '--max-changes-per-hour', 'nope'],
          e(ownerWc, ownerHome)
        )
      ).toBe(2);
      expect(out.join('\n')).toContain('invalid --max-changes-per-hour');

      // An explicit empty or whitespace-only value must not coerce to 0 (a
      // script with an unset/blank variable would otherwise sign a
      // fully-blocking zero-cap grant): Number('') and Number(' ') are both 0.
      for (const blank of ['', ' ', '\t']) {
        out.length = 0;
        expect(
          await run(
            ['grant', mateDid, '--max-changes-per-hour', blank],
            e(ownerWc, ownerHome)
          )
        ).toBe(2);
        expect(out.join('\n')).toContain('invalid --max-changes-per-hour');
        out.length = 0;
        expect(
          await run(
            ['grant', mateDid, '--max-changes', blank],
            e(ownerWc, ownerHome)
          )
        ).toBe(2);
        expect(out.join('\n')).toContain('invalid --max-changes');
      }

      // Grant one landed op per hour.
      out.length = 0;
      expect(
        await run(
          [
            'grant',
            mateDid,
            '--paths',
            'src/**',
            '--max-changes-per-hour',
            '1',
          ],
          e(ownerWc, ownerHome)
        )
      ).toBe(0);

      // grants output shows the cap.
      out.length = 0;
      expect(await run(['grants'], e(ownerWc, ownerHome))).toBe(0);
      expect(out.join('\n')).toContain('1/h');

      // First in-scope upload is handed to the owner and fits the window.
      const mateWc = mkdtempSync(join(tmp, 'matewc2-'));
      await run(['clone', s.url, 'proj2', mateWc], e(mateWc, mateHome));
      writeFileSync(join(mateWc, 'src', 'a.rs'), 'fn a() {}');
      out.length = 0;
      expect(await run(['push', '-m', 'a'], e(mateWc, mateHome))).toBe(1);
      expect(out.join('\n')).toContain('owner signature required');
      const ownerClient = new Client(s.url, loadIdentity(ownerHome));
      let mateLocal = await new Platform().openDurable(
        'proj2',
        new FileBackend(join(mateWc, '.thaddeus', 'store'))
      );
      expect(
        await ownerClient.land('proj2', mateLocal, mateLocal.log.heads('main'))
      ).toMatchObject({ landed: true });

      // Second upload is accepted, but the owner-signed landing exceeds the cap.
      writeFileSync(join(mateWc, 'src', 'b.rs'), 'fn b() {}');
      out.length = 0;
      const code = await run(['push', '-m', 'b'], e(mateWc, mateHome));
      expect(code).not.toBe(0);
      expect(out.join('\n')).toContain('owner signature required');
      mateLocal = await new Platform().openDurable(
        'proj2',
        new FileBackend(join(mateWc, '.thaddeus', 'store'))
      );
      const rateDenied = await ownerClient.land(
        'proj2',
        mateLocal,
        mateLocal.log.heads('main')
      );
      expect(rateDenied).toMatchObject({ landed: false });
      expect(rateDenied.reason).toContain('hourly rate window');
    } finally {
      await s.stop();
    }
  });
});
