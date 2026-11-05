import { afterEach, expect, test } from 'bun:test';

import { createPrng } from '../src/prng';
import { type FaultProxy, startProxy } from '../src/workload/proxy';

// A fake server that records each request it gets and answers with a status
// chosen per call, so a test can see what the proxy forwarded.
function upstream(status: (n: number) => number) {
  const seen: { method: string; path: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        body: await req.text(),
      });
      return new Response(`answer ${seen.length}`, {
        status: status(seen.length),
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, server };
}

const NO_FAULTS = { duplicateRate: 0, delayRate: 0, maxDelayMs: 0 };
const SIGNED = { 'x-thaddeus-nonce': 'n1', 'content-type': 'application/json' };

let proxy: FaultProxy | undefined;
let fake: ReturnType<typeof upstream> | undefined;
afterEach(async () => {
  await proxy?.stop();
  await fake?.server.stop(true);
  proxy = undefined;
  fake = undefined;
});

test('forwards method, path, body and status, and counts the bytes', async () => {
  fake = upstream(() => 201);
  proxy = startProxy(1, NO_FAULTS);
  proxy.setUpstream(fake.url);
  const res = await fetch(`${proxy.url}/repos/x/push?a=1`, {
    method: 'POST',
    body: 'hello',
  });
  expect(res.status).toBe(201);
  expect(await res.text()).toBe('answer 1');
  expect(fake.seen).toEqual([
    { method: 'POST', path: '/repos/x/push?a=1', body: 'hello' },
  ]);
  const stats = proxy.stats();
  expect(stats.requests).toBe(1);
  expect(stats.requestBytes).toBe(5);
  expect(stats.responseBytes).toBe('answer 1'.length);
});

test('with no upstream it answers 502 and counts the request as unreachable', async () => {
  proxy = startProxy(1, NO_FAULTS);
  const res = await fetch(`${proxy.url}/version`);
  expect(res.status).toBe(502);
  expect(proxy.stats().unreachable).toBe(1);
});

test('replays a signed write after the original answered and records the copy', async () => {
  // The first copy is accepted, the replay refused, as a server with replay
  // protection answers.
  fake = upstream((n) => (n === 1 ? 200 : 409));
  proxy = startProxy(1, { ...NO_FAULTS, duplicateRate: 1 });
  proxy.setUpstream(fake.url);
  const res = await fetch(`${proxy.url}/repos/x/land`, {
    method: 'POST',
    headers: SIGNED,
    body: '{"v":1}',
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('answer 1');
  await proxy.settle();
  expect(fake.seen).toHaveLength(2);
  expect(fake.seen[1]).toEqual(fake.seen[0]);
  expect(proxy.stats().duplicates).toEqual([
    { method: 'POST', path: '/repos/x/land', status: 409 },
  ]);
});

test('never replays reads or unsigned requests', async () => {
  fake = upstream(() => 200);
  proxy = startProxy(1, { ...NO_FAULTS, duplicateRate: 1 });
  proxy.setUpstream(fake.url);
  await (await fetch(`${proxy.url}/version`)).text();
  await (
    await fetch(`${proxy.url}/repos/x/pull`, { method: 'POST', body: '{}' })
  ).text();
  await proxy.settle();
  expect(fake.seen).toHaveLength(2);
  expect(proxy.stats().duplicates).toEqual([]);
});

// The first seed whose draws delay request 1 by at least `minMs` and leave
// request 2 alone. The proxy draws three numbers per request, in this order:
// delay or not, the delay in ms, duplicate or not.
function seedDelayingOnlyTheFirst(rate: number, maxMs: number, minMs: number) {
  for (let seed = 0; ; seed++) {
    const prng = createPrng(seed);
    const first = prng.next() < rate;
    const firstMs = 1 + prng.int(maxMs);
    prng.next();
    const second = prng.next() < rate;
    if (first && firstMs >= minMs && !second) return seed;
  }
}

test('a delayed request is overtaken by one sent after it', async () => {
  fake = upstream(() => 200);
  const seed = seedDelayingOnlyTheFirst(0.5, 300, 150);
  proxy = startProxy(seed, {
    duplicateRate: 0,
    delayRate: 0.5,
    maxDelayMs: 300,
  });
  proxy.setUpstream(fake.url);
  const first = fetch(`${proxy.url}/first`);
  await Bun.sleep(20);
  const second = fetch(`${proxy.url}/second`);
  await Promise.all([first, second]);
  expect(proxy.stats().delayed).toBe(1);
  expect(fake.seen.map((r) => r.path)).toEqual(['/second', '/first']);
});

test('the same seed draws the same faults in arrival order', async () => {
  const draw = async (): Promise<number> => {
    const f = upstream(() => 200);
    const p = startProxy(42, {
      duplicateRate: 0,
      delayRate: 0.5,
      maxDelayMs: 1,
    });
    p.setUpstream(f.url);
    for (let i = 0; i < 20; i++) await (await fetch(`${p.url}/r${i}`)).text();
    const delayed = p.stats().delayed;
    await p.stop();
    await f.server.stop(true);
    return delayed;
  };
  expect(await draw()).toBe(await draw());
});
