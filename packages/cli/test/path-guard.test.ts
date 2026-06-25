import { ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import { safeTarget } from '../src/workcopy';

beforeAll(async () => {
  await ready();
});

describe('safeTarget (path-traversal guard)', () => {
  test('normal relative path is allowed', () => {
    expect(safeTarget('/root', 'src/main.rs')).toBe('/root/src/main.rs');
  });

  test('file at root is allowed', () => {
    expect(safeTarget('/root', 'README.md')).toBe('/root/README.md');
  });

  test('path escaping root via .. is rejected', () => {
    expect(safeTarget('/root', '../../etc/passwd')).toBeNull();
  });

  test('absolute path is rejected', () => {
    expect(safeTarget('/root', '/etc/passwd')).toBeNull();
  });

  test('.thaddeus/ prefix is rejected', () => {
    expect(safeTarget('/root', '.thaddeus/config.json')).toBeNull();
  });

  test('.thaddeus itself is rejected', () => {
    expect(safeTarget('/root', '.thaddeus')).toBeNull();
  });

  test('path with .. in the middle that stays inside is allowed', () => {
    expect(safeTarget('/root', 'src/../lib/mod.rs')).toBe('/root/lib/mod.rs');
  });

  test('path attempting to reach .thaddeus via .. is rejected', () => {
    expect(
      safeTarget('/root', 'src/../../root/.thaddeus/config.json')
    ).toBeNull();
  });
});
