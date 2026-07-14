import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Fly config stays attached to the live Amsterdam data volume', () => {
  const fly = readFileSync(join(import.meta.dir, '../../../fly.toml'), 'utf8');
  expect(fly).toMatch(/^app = "thaddeus"$/m);
  expect(fly).toMatch(/^primary_region = "ams"$/m);
  expect(fly).not.toMatch(/^\s*THADDEUS_HOST\s*=/m);
  expect(fly).toContain('THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN');
  expect(fly).toMatch(/^\s*source = "data"$/m);
  expect(fly).toMatch(/^\s*destination = "\/data"$/m);
});
