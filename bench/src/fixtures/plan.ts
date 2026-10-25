import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

import { createPrng } from '../prng';
import type { FixtureSpec } from './spec';

// Bump when the generator's output changes for the same spec, so old fixture
// caches and old results stop matching.
export const GENERATOR_VERSION = 1;

export type Step =
  | {
      kind: 'write';
      view: string;
      path: string;
      author: number;
      contentSeed: number;
      bytes: number;
      at: string;
    }
  | { kind: 'remove'; view: string; path: string; author: number; at: string }
  | { kind: 'fork'; view: string; from: string }
  | { kind: 'land'; from: string; into: 'main' };

export interface FixturePlan {
  spec: FixtureSpec;
  generatorVersion: number;
  authorSeeds: Uint8Array[];
  steps: Step[];
}

// The paths that currently exist in one view, with O(1) add, remove and
// random pick. A plain Set cannot pick a random member without copying.
class PathSet {
  private items: string[] = [];
  private index = new Map<string, number>();

  add(path: string): void {
    if (this.index.has(path)) return;
    this.index.set(path, this.items.length);
    this.items.push(path);
  }

  delete(path: string): void {
    const at = this.index.get(path);
    if (at === undefined) return;
    const last = this.items[this.items.length - 1];
    this.items[at] = last;
    this.index.set(last, at);
    this.items.pop();
    this.index.delete(path);
  }

  get size(): number {
    return this.items.length;
  }

  at(i: number): string {
    return this.items[i];
  }

  clone(): PathSet {
    const copy = new PathSet();
    for (const p of this.items) copy.add(p);
    return copy;
  }

  merge(other: PathSet): void {
    for (let i = 0; i < other.size; i++) this.add(other.at(i));
  }
}

const EPOCH_MS = Date.UTC(2026, 0, 1);

// Timestamp for the op at position `n`: 2026-01-01T00:00:00Z plus one second per op.
function timestamp(n: number): string {
  return new Date(EPOCH_MS + n * 1000).toISOString().replace('.000Z', 'Z');
}

// Turns a spec into the full list of steps to replay: forks, writes, removes
// and lands. It is pure (one seeded random stream, no crypto, no I/O), so the
// same spec always yields the same plan. Ops are spread round-robin over the
// views; a view forks from main just before its first op, and every
// `landEvery` ops the next forked view lands into main so that main collects
// several heads and the conflict path gets exercised.
export function generateFixture(spec: FixtureSpec): FixturePlan {
  const prng = createPrng(spec.seed);

  const authorSeeds: Uint8Array[] = [];
  for (let a = 0; a < spec.authors; a++) {
    const seed = new Uint8Array(32);
    for (let i = 0; i < seed.length; i++) seed[i] = prng.int(256);
    authorSeeds.push(seed);
  }

  const views = ['main'];
  for (let v = 1; v < spec.views; v++) views.push(`v${v}`);
  const paths = Array.from({ length: spec.files }, (_, i) => `src/f${i}.ts`);
  const hotCount = Math.max(1, Math.floor(spec.files * spec.hotFileShare));

  const state = new Map<string, PathSet>([['main', new PathSet()]]);
  const steps: Step[] = [];
  let nextLand = 1;

  for (let n = 0; n < spec.ops; n++) {
    const view = views[n % views.length];
    let files = state.get(view);
    if (files === undefined) {
      steps.push({ kind: 'fork', view, from: 'main' });
      files = state.get('main')!.clone();
      state.set(view, files);
    }

    const author = prng.int(spec.authors);
    const at = timestamp(n);
    const wantsRemove = prng.next() < spec.removeRatio;
    if (wantsRemove && files.size > 0) {
      const path = files.at(prng.int(files.size));
      files.delete(path);
      steps.push({ kind: 'remove', view, path, author, at });
    } else {
      const hot = prng.next() < 0.8;
      const path = paths[prng.int(hot ? hotCount : spec.files)];
      const bytes = 200 + prng.int(7_801);
      const contentSeed = prng.int(0x7fffffff);
      files.add(path);
      steps.push({ kind: 'write', view, path, author, contentSeed, bytes, at });
    }

    if (views.length > 1 && (n + 1) % spec.landEvery === 0) {
      const from = views[nextLand];
      nextLand = (nextLand % (views.length - 1)) + 1;
      const landed = state.get(from);
      if (landed !== undefined) {
        state.get('main')!.merge(landed);
        steps.push({ kind: 'land', from, into: 'main' });
      }
    }
  }

  return { spec, generatorVersion: GENERATOR_VERSION, authorSeeds, steps };
}

// JSON with object keys sorted, so the same data always serializes to the same
// text no matter how the objects were built.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Hash of everything that defines a fixture's inputs. Ciphertext is random on
// every run, so the hash covers the plan rather than the stored bytes: equal
// hashes mean two runs replayed identical operations.
export function manifestHash(plan: FixturePlan): string {
  const manifest = {
    generatorVersion: plan.generatorVersion,
    spec: plan.spec,
    authorSeeds: plan.authorSeeds.map((s) => bytesToHex(s)),
    steps: plan.steps,
  };
  return bytesToHex(blake3(new TextEncoder().encode(canonicalJson(manifest))));
}
