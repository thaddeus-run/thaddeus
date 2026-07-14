import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-entrypoint-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('entrypoint forwards managed attestation settings without initializing an identity', () => {
  const bin = join(tmp, 'bin');
  const data = join(tmp, 'data');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'id'),
    '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then echo 10001; else exec /usr/bin/id "$@"; fi\n'
  );
  writeFileSync(
    join(bin, 'thaddeus'),
    '#!/bin/sh\nprintf "argument=<%s>\\n" "$@"\n'
  );
  chmodSync(join(bin, 'id'), 0o755);
  chmodSync(join(bin, 'thaddeus'), 0o755);

  const result = Bun.spawnSync(
    ['/bin/sh', join(import.meta.dir, '../../../docker-entrypoint.sh')],
    {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        PORT: '4321',
        THADDEUS_DATA: data,
        THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN:
          'arn:aws:kms:eu-west-1:123456789012:key/test-key',
        THADDEUS_ATTESTATION_RATE_LIMIT: '7',
        THADDEUS_MIN_MERGES: '3',
        THADDEUS_TRUST_HOSTS: 'did:key:first,did:key:second',
        // Legacy variables must not restore volume-seed behavior.
        THADDEUS_HOST: '1',
        THADDEUS_HOME: join(data, '.home'),
      },
    }
  );

  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain('argument=<serve>');
  expect(output).toContain('argument=<--port>\nargument=<4321>');
  expect(output).toContain(`argument=<--data>\nargument=<${data}>`);
  expect(output).toContain(
    'argument=<--attestation-aws-kms-key-arn>\nargument=<arn:aws:kms:eu-west-1:123456789012:key/test-key>'
  );
  expect(output).toContain('argument=<--attestation-rate-limit>\nargument=<7>');
  expect(output).toContain('argument=<--trust-host>\nargument=<did:key:first>');
  expect(output).toContain(
    'argument=<--trust-host>\nargument=<did:key:second>'
  );
  expect(output).not.toContain('argument=<init>');
  expect(output).not.toContain('--host');
  expect(output).not.toContain('.home');
});
