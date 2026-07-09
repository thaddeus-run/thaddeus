import type { Op } from '@thaddeus.run/log';
import {
  type LandPolicy,
  requirePassingChecks,
  requireVerifiedProvenance,
  restrictPaths,
  standingQuery,
} from '@thaddeus.run/platform';
import type { ProvenanceLog } from '@thaddeus.run/provenance';

export interface RepoRestrictPathsPolicy {
  readonly protect: readonly string[];
  readonly allow: readonly string[];
  readonly name?: string;
}

export type RepoStandingQueryPolicy =
  | {
      readonly kind: 'forbidDeletes';
      readonly name?: string;
    }
  | {
      readonly kind: 'forbidPaths';
      readonly paths: readonly string[];
      readonly name?: string;
    };

export interface RepoPassingChecksPolicy {
  readonly checkerKinds: readonly string[];
}

export interface RepoPolicyRecord {
  readonly version: 1;
  readonly restrictPaths: readonly RepoRestrictPathsPolicy[];
  readonly standingQueries: readonly RepoStandingQueryPolicy[];
  readonly requireVerifiedProvenance: boolean;
  readonly requirePassingChecks: RepoPassingChecksPolicy | null;
}

const EMPTY_RESTRICT_PATHS: readonly RepoRestrictPathsPolicy[] = Object.freeze(
  []
);
const EMPTY_STANDING_QUERIES: readonly RepoStandingQueryPolicy[] =
  Object.freeze([]);

export const DEFAULT_REPO_POLICY: RepoPolicyRecord = Object.freeze({
  version: 1,
  restrictPaths: EMPTY_RESTRICT_PATHS,
  standingQueries: EMPTY_STANDING_QUERIES,
  requireVerifiedProvenance: false,
  requirePassingChecks: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(
  value: unknown,
  label: string,
  opts: { nonEmpty?: boolean; noTraversal?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError(`${label} must be an array of non-empty strings`);
    }
    if (opts.noTraversal === true && entry.split('/').includes('..')) {
      throw new TypeError(`${label} must not contain a ".." path segment`);
    }
    out.push(entry);
  }
  if (opts.nonEmpty === true && out.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return out;
}

function assertSupportedPathGlob(glob: string, label: string): void {
  if (!glob.includes('*')) {
    return;
  }
  if (glob === '**') {
    return;
  }
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    if (prefix.length > 0 && !prefix.includes('*')) {
      return;
    }
  }
  throw new TypeError(
    `${label} supports only exact paths, **, and prefix/** globs`
  );
}

function pathGlobs(value: unknown, label: string): string[] {
  const globs = stringArray(value, label, {
    nonEmpty: true,
    noTraversal: true,
  });
  for (const glob of globs) {
    assertSupportedPathGlob(glob, label);
  }
  return globs;
}

function optionalName(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} name must be a non-empty string`);
  }
  return value;
}

function normalizeRestrictPaths(value: unknown): RepoRestrictPathsPolicy {
  if (!isRecord(value)) {
    throw new TypeError('restrictPaths entries must be objects');
  }
  return {
    protect: pathGlobs(value.protect, 'restrictPaths.protect'),
    allow: stringArray(value.allow ?? [], 'restrictPaths.allow', {
      nonEmpty: true,
    }),
    name: optionalName(value.name, 'restrictPaths'),
  };
}

function normalizeStandingQuery(value: unknown): RepoStandingQueryPolicy {
  if (!isRecord(value)) {
    throw new TypeError('standingQueries entries must be objects');
  }
  if (value.kind === 'forbidDeletes') {
    return {
      kind: 'forbidDeletes',
      name: optionalName(value.name, 'standingQueries'),
    };
  }
  if (value.kind === 'forbidPaths') {
    return {
      kind: 'forbidPaths',
      paths: pathGlobs(value.paths, 'standingQueries.paths'),
      name: optionalName(value.name, 'standingQueries'),
    };
  }
  throw new TypeError(
    'standingQueries.kind must be forbidDeletes or forbidPaths'
  );
}

function normalizePassingChecks(
  value: unknown
): RepoPassingChecksPolicy | null {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (value === true) {
    return { checkerKinds: ['ci'] };
  }
  if (!isRecord(value)) {
    throw new TypeError('requirePassingChecks must be an object or null');
  }
  return {
    checkerKinds: stringArray(
      value.checkerKinds,
      'requirePassingChecks.checkerKinds',
      { nonEmpty: true }
    ),
  };
}

export function normalizeRepoPolicy(input: unknown): RepoPolicyRecord {
  if (!isRecord(input)) {
    throw new TypeError('policy must be an object');
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new TypeError('policy.version must be 1');
  }
  if (
    input.restrictPaths !== undefined &&
    !Array.isArray(input.restrictPaths)
  ) {
    throw new TypeError('restrictPaths must be an array');
  }
  if (
    input.standingQueries !== undefined &&
    !Array.isArray(input.standingQueries)
  ) {
    throw new TypeError('standingQueries must be an array');
  }
  if (
    input.requireVerifiedProvenance !== undefined &&
    typeof input.requireVerifiedProvenance !== 'boolean'
  ) {
    throw new TypeError('requireVerifiedProvenance must be a boolean');
  }
  return {
    version: 1,
    restrictPaths:
      input.restrictPaths !== undefined
        ? input.restrictPaths.map(normalizeRestrictPaths)
        : [],
    standingQueries:
      input.standingQueries !== undefined
        ? input.standingQueries.map(normalizeStandingQuery)
        : [],
    requireVerifiedProvenance:
      input.requireVerifiedProvenance === undefined
        ? false
        : input.requireVerifiedProvenance === true,
    requirePassingChecks: normalizePassingChecks(input.requirePassingChecks),
  };
}

function matchGlob(glob: string, path: string): boolean {
  if (path.split('/').includes('..')) {
    return false;
  }
  if (glob === '**') {
    return true;
  }
  if (glob.endsWith('/**')) {
    return path.startsWith(glob.slice(0, -2));
  }
  return glob === path;
}

function standingQueryGate(spec: RepoStandingQueryPolicy): LandPolicy {
  if (spec.kind === 'forbidDeletes') {
    return standingQuery({
      name: spec.name ?? 'forbid deletes',
      forbid: (op: Op) => op.payload === null,
    });
  }
  return standingQuery({
    name: spec.name ?? `forbid paths ${spec.paths.join(', ')}`,
    forbid: (op: Op) =>
      op.path.split('/').includes('..') ||
      spec.paths.some((glob) => matchGlob(glob, op.path)),
  });
}

export function repoPolicyGates(
  record: RepoPolicyRecord,
  provenance: ProvenanceLog
): LandPolicy[] {
  const gates: LandPolicy[] = [];
  for (const spec of record.restrictPaths) {
    gates.push(
      restrictPaths({
        protect: spec.protect,
        allow: spec.allow,
        name: spec.name,
      })
    );
  }
  for (const spec of record.standingQueries) {
    gates.push(standingQueryGate(spec));
  }
  if (record.requireVerifiedProvenance) {
    gates.push(requireVerifiedProvenance(provenance));
  }
  if (record.requirePassingChecks !== null) {
    gates.push(
      requirePassingChecks(provenance, record.requirePassingChecks.checkerKinds)
    );
  }
  return gates;
}
