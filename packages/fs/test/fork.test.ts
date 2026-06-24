import { Identity, ready } from '@thaddeus.run/identity';
import { OpLog } from '@thaddeus.run/log';
import { MemoryStore } from '@thaddeus.run/store';
import { beforeAll, describe, expect, test } from 'bun:test';

import { Workspace } from '../src/workspace';

beforeAll(async () => {
  await ready();
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('Workspace — fork (cheap COW branch)', () => {
  test('forked workspaces diverge: committed edits do not cross', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const a = Workspace.open(log, store, { source: 'main', reader: author });
    a.write('shared.rs', enc('base'));
    await a.commit(author);

    const b = a.fork();
    a.write('shared.rs', enc('from-a'));
    await a.commit(author);
    b.write('shared.rs', enc('from-b'));
    await b.commit(author);

    expect(dec((await a.read('shared.rs'))!)).toBe('from-a');
    expect(dec((await b.read('shared.rs'))!)).toBe('from-b');
  });

  test('fork carries in-flight (uncommitted) staged edits, then diverges', async () => {
    const store = new MemoryStore();
    const log = new OpLog(store);
    const author = Identity.create();
    const a = Workspace.open(log, store, { source: 'main', reader: author });
    a.write('draft.rs', enc('wip')); // staged, NOT committed

    const b = a.fork();
    expect(dec((await b.read('draft.rs'))!)).toBe('wip'); // carried over

    b.write('draft.rs', enc('b-wip'));
    expect(dec((await a.read('draft.rs'))!)).toBe('wip');
    expect(dec((await b.read('draft.rs'))!)).toBe('b-wip');
  });
});
