import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBackend } from '../src/file';
import { scoped } from '../src/scoped';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-restart-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('FileBackend — survives a restart on real fs', () => {
  test('write + repoint, then reload Store+OpLog from disk', async () => {
    const root = mkdtempSync(join(tmp, 'repo-'));
    const dev = Identity.create();

    const b1 = scoped(new FileBackend(root), 'repo/x/');
    const s1 = new MemoryStore(b1);
    const l1 = new OpLog(s1, b1);
    const op = await l1.write('main', 'src/a.rs', enc('fn a() {}'), dev);

    // Fresh backend over the SAME dir; rebuild store then log.
    const b2 = scoped(new FileBackend(root), 'repo/x/');
    const s2 = await MemoryStore.open(b2);
    const l2 = await OpLog.load(s2, b2);
    expect(l2.heads('main')).toEqual([op.id]);
    const ref = l2.materialize('main', dev).get('src/a.rs')?.ref;
    expect(ref).not.toBeNull();
    if (ref != null) {
      expect(dec(await s2.get(ref, dev))).toBe('fn a() {}');
    }
  });
});
