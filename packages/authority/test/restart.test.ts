import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { tempDir } from './helpers';

const FIXTURE = join(import.meta.dir, 'fixtures', 'service-process.ts');

function run(mode: string, dir: string) {
  return Bun.spawnSync(['bun', FIXTURE, mode, dir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('a real process crash and restart', () => {
  test('revocation, replay state, tickets, the head chain and sealed content all hold', () => {
    const { dir, cleanup } = tempDir();
    try {
      const crash = run('crash', dir);
      expect(crash.stderr.toString()).toBe('');
      expect(crash.signalCode).toBe('SIGKILL');

      const recover = run('recover', dir);
      expect(recover.stderr.toString()).toBe('');
      expect(recover.exitCode).toBe(0);
      const result = JSON.parse(recover.stdout.toString());
      expect(result).toMatchObject({
        read: 'ok',
        plaintext: 'survives a crash',
        revoked: 'revoked',
        replayed: 'replayed',
        headVersion: 0,
        headSame: true,
        redeem: 'ok',
        redeemAgain: 'ticket_used',
      });
      // The crashed process's audit records are still there, in order.
      expect(result.audit.slice(0, 2)).toEqual([
        'tenant.create:allow',
        'credential.issue:allow',
      ]);
      expect(result.audit).toContain('history.advance:allow');
      expect(result.audit).toContain('credential.revoke:allow');
      expect(result.audit.at(-1)).toBe('ticket.redeem:deny');
    } finally {
      cleanup();
    }
  }, 30_000);
});
