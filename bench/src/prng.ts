// mulberry32: a tiny seeded generator. Benchmarks need the same "random"
// numbers on every machine and every run, so Math.random is off limits.
// `next` returns a float in [0, 1); `int(n)` returns an integer in [0, n).
export function createPrng(seed: number): {
  next(): number;
  int(n: number): number;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}
