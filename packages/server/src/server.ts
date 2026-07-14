import {
  AgentRegistry,
  type Delegation,
  delegationPolicy,
  verifyDelegation,
} from '@thaddeus.run/agent';
import { SymbolOpLog } from '@thaddeus.run/graph';
import { type Identity, PublicIdentity } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecord,
  type HeadRecordWire,
  type HeadVerification,
  type Op,
  verifyHeadChain,
  verifyHeadSnapshot,
} from '@thaddeus.run/log';
import {
  blockOnConflict,
  blockOnVeto,
  INTERNAL_VIEW_PREFIX,
  type LandPolicy,
  type LandResult,
  Platform,
  type Release,
  type Repo,
  requireReputationTier,
  verifyRelease,
} from '@thaddeus.run/platform';
import { ProvenanceLog } from '@thaddeus.run/provenance';
import {
  attest,
  type Contribution,
  type ContributionClaim,
  decodeReputationArchive,
  encodeReputationArchive,
  type ReputationArchive,
  ReputationLog,
  verifyClaim,
  verifyContribution,
} from '@thaddeus.run/reputation';
import { VetoLog } from '@thaddeus.run/review';
import {
  type Backend,
  type Capability,
  decodeRecord,
  DEFAULT_REPLAY_NONCE_CAPACITY,
  encodeRecord,
  MAX_REPLAY_NONCE_CAPACITY,
  publicDid,
  type ReplayNonceBackend,
  scoped,
  verifyCapability,
} from '@thaddeus.run/store';

import {
  type Bundle,
  decodeBundle,
  decodeCapability,
  decodeClaim,
  decodeDelegation,
  decodeRelease,
  encodeBundle,
  encodeCapability,
  encodeDelegation,
  encodeRelease,
} from './dto';
import {
  DEFAULT_REPO_POLICY,
  normalizeRepoPolicy,
  repoPolicyGates,
  type RepoPolicyRecord,
} from './repo-policy';
import {
  replayNonceKey,
  REQUEST_SKEW_MS,
  type SignedHeaders,
  verifyRequest as verifySignedEnvelope,
} from './sign';

// Parse a JSON request body, returning undefined on malformed input (so a handler
// can answer 400 rather than throwing a 500). Used by every body-parsing handler.
function safeParseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

// Decode a percent-encoded path segment, returning undefined on a malformed
// escape sequence (e.g. %E0%A4%A) rather than throwing. Callers respond 400.
function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export const DEFAULT_MAX_REQUEST_BODY_BYTES: number = 16 * 1024 * 1024;
const REQUEST_BODY_BUFFER_BLOCK_BYTES = 64 * 1024;

/** Resolves the inclusive application limit and rejects unsafe host values. */
function requestBodyLimit(value: number | undefined): number {
  let limit = DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (value !== undefined) {
    limit = value;
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > Number.MAX_SAFE_INTEGER - 1
  ) {
    throw new RangeError(
      'maxRequestBodyBytes must be a positive safe integer no greater than Number.MAX_SAFE_INTEGER - 1'
    );
  }
  return limit;
}

/** Resolves the canonical replay capacity and its deprecated alias. */
function replayNonceCapacity(config: ServerConfig): number {
  if (
    config.replayNonceCapacity !== undefined &&
    config.replayCacheCapacity !== undefined
  ) {
    throw new TypeError(
      'replayNonceCapacity and replayCacheCapacity cannot both be set'
    );
  }
  const capacity =
    config.replayNonceCapacity ??
    config.replayCacheCapacity ??
    DEFAULT_REPLAY_NONCE_CAPACITY;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= 0 ||
    capacity > MAX_REPLAY_NONCE_CAPACITY
  ) {
    throw new RangeError(
      `replayNonceCapacity must be a positive safe integer no greater than ${MAX_REPLAY_NONCE_CAPACITY}`
    );
  }
  return capacity;
}

/** Resolves the accepted timestamp skew within the protocol's five-minute cap. */
function requestTimestampSkew(value: number | undefined): number {
  const skew = value ?? REQUEST_SKEW_MS;
  if (!Number.isSafeInteger(skew) || skew < 1 || skew > REQUEST_SKEW_MS) {
    throw new RangeError(
      `requestSkewMs must be a positive safe integer no greater than ${REQUEST_SKEW_MS}`
    );
  }
  return skew;
}

export interface ServerConfig {
  backend: Backend & ReplayNonceBackend;
  // Largest request body accepted by application routes. Bun hosts use one
  // additional sentinel byte so the streamed guard can observe the boundary.
  maxRequestBodyBytes?: number;
  policy?: LandPolicy;
  now?: () => string;
  // Operational failures that can be isolated (for example, one repo's reveal
  // scan) are reported here while work for other repos continues.
  onError?: (
    error: unknown,
    context:
      | { operation: 'reveal'; repo?: string }
      | { operation: 'nonce-consumption' }
  ) => void;
  // An optional host identity turns this into an ATTESTING instance: on a
  // successful land it co-signs each client-pushed reputation claim (P07) for a
  // landed op, minting a host-vouched Contribution. Without it, the server holds
  // no keys and reputation does not accrue.
  host?: Identity;
  // When set, land is additionally gated on durable server-wide reputation:
  // every incoming op's author must have at least this many ATTESTED merges.
  minMerges?: number;
  // Host DIDs whose valid attestations count in this instance's profile and
  // reputation gates. The local `host`, when present, is trusted automatically.
  trustedReputationHosts?: readonly string[];
  // Maximum live durable nonces. Full stores fail closed until the oldest live
  // record passes its exact expiry boundary.
  replayNonceCapacity?: number;
  /** @deprecated Use replayNonceCapacity. */
  replayCacheCapacity?: number;
  // Accepted signed timestamp skew. The protocol ceiling is five minutes.
  requestSkewMs?: number;
}

export interface Server {
  fetch(req: Request): Promise<Response>;
  // Promote every scheduled public capability whose not_before is due. The
  // HTTP host calls this on an interval; exposing it keeps tests deterministic.
  revealDue(): Promise<number>;
}

interface RepoMeta {
  owner: string;
}

interface LandEffects {
  readonly repo: string;
  readonly view: string;
  readonly head: string;
  readonly meters: readonly {
    readonly agent: string;
    readonly changes: number;
  }[];
  readonly contributions: readonly Contribution[];
}

// Every op reachable from `heads` by walking parents (inclusive), in
// (lamport, id) order.
function reachableOps(all: readonly Op[], heads: readonly string[]): Op[] {
  const byId = new Map(all.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const op = byId.get(id);
    if (op !== undefined) {
      stack.push(...op.parents);
    }
  }
  return all
    .filter((o) => seen.has(o.id))
    .sort((x, y) =>
      x.lamport !== y.lamport ? x.lamport - y.lamport : x.id < y.id ? -1 : 1
    );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

// Compose LandPolicies: allow only if every policy allows; the first rejection
// (with its reason) wins. Each policy is awaited since policies may be async.
function all(...policies: LandPolicy[]): LandPolicy {
  return async (p) => {
    for (const policy of policies) {
      const decision = await policy(p);
      if (!decision.allow) {
        return decision;
      }
    }
    return { allow: true };
  };
}

// Merge capabilities by logical grant, preserving unrelated concurrent grants.
// Incoming caps overwrite matching stored caps so a re-wrapped key supersedes
// its stale seal instead of leaving the read path to select the stale one first.
function unionCaps(
  existing: readonly Capability[],
  incoming: readonly Capability[]
): Capability[] {
  const byGrant = new Map<string, Capability>();
  for (const cap of [...existing, ...incoming]) {
    const key = `${cap.grantee}\n${cap.granted_by}\n${cap.not_before}`;
    byGrant.set(key, cap);
  }
  return [...byGrant.values()];
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isValidPublicCapability(capability: Capability): boolean {
  try {
    return (
      verifyCapability(capability) &&
      capability.grantee === publicDid() &&
      !Number.isNaN(Date.parse(capability.not_before))
    );
  } catch {
    return false;
  }
}

// A recall replacement keeps the signed reveal schedule but must wrap the new
// content key. Requiring different sealed bytes catches a clone that merely
// echoes the server's old pending capability instead of re-wrapping it.
function replacesPendingReveal(
  previous: Capability,
  replacement: Capability
): boolean {
  let valid = false;
  try {
    valid = verifyCapability(replacement);
  } catch {
    valid = false;
  }
  return (
    valid &&
    replacement.grantee === publicDid() &&
    !Number.isNaN(Date.parse(replacement.not_before)) &&
    replacement.object === previous.object &&
    replacement.granted_by === previous.granted_by &&
    replacement.not_before === previous.not_before &&
    !sameBytes(replacement.wrapped_key, previous.wrapped_key)
  );
}

/**
 * Creates a Bun-compatible handler over a durable platform. It verifies and
 * serves ciphertext; timed reveals are the explicit store-honest exception to
 * the normal key-free trust boundary. Request validation stays ahead of
 * authentication and persistence. Per-node caches and counters rebuild from
 * the backend or intentionally reset after restart.
 */
export function createServer(config: ServerConfig): Server {
  const maxRequestBodyBytes = requestBodyLimit(config.maxRequestBodyBytes);
  const configuredReplayNonceCapacity = replayNonceCapacity(config);
  const configuredRequestSkewMs = requestTimestampSkew(config.requestSkewMs);
  const platform = new Platform();
  const policy = config.policy ?? blockOnConflict;
  const now = config.now ?? ((): string => new Date().toISOString());
  const trustedReputationHosts = new Set<string>();
  for (const did of config.trustedReputationHosts ?? []) {
    try {
      PublicIdentity.fromDid(did);
    } catch {
      throw new TypeError(`invalid trusted reputation host DID: ${did}`);
    }
    trustedReputationHosts.add(did);
  }
  if (config.host !== undefined) trustedReputationHosts.add(config.host.did);
  const repoCache = new Map<string, Repo>();
  // Per-repo promise chain: each mutation awaits the previous, so a land's
  // read-heads -> re-point can't interleave with a concurrent push.
  const locks = new Map<string, Promise<unknown>>();
  const metaBackend = (name: string): Backend =>
    scoped(config.backend, `repo/${name}/`);

  async function readMeta(name: string): Promise<RepoMeta | undefined> {
    const bytes = await metaBackend(name).get('meta/repo');
    return bytes === undefined ? undefined : (decodeRecord(bytes) as RepoMeta);
  }

  async function readRepoPolicy(name: string): Promise<RepoPolicyRecord> {
    const bytes = await metaBackend(name).get('meta/policy');
    if (bytes === undefined) {
      return DEFAULT_REPO_POLICY;
    }
    try {
      return normalizeRepoPolicy(decodeRecord(bytes));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`stored repo policy is invalid: ${msg}`);
    }
  }

  function policyReadFailure(err: unknown): Response {
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: msg });
  }

  // Durable per-repo AgentRegistry cache, keyed by the in-flight BUILD promise
  // (not the resolved registry) so registryFor is single-flight: two concurrent
  // cold-cache callers share ONE AgentRegistry instance, mutated in place. If we
  // cached the resolved value instead, both callers would build separate
  // registries and the last `set` would clobber a grant/revoke on the other.
  const registries = new Map<string, Promise<AgentRegistry>>();

  // Single-flight cacher: store the build promise synchronously (before any
  // await) so a second caller in the same tick reuses it. Callers already
  // `await registryFor(name)`, so they all share the one instance.
  function registryFor(name: string): Promise<AgentRegistry> {
    let p = registries.get(name);
    if (p === undefined) {
      // Evict a REJECTED build so a transient load error self-heals on the next
      // request instead of poisoning the repo until restart (the success promise
      // stays cached for single-flight).
      p = buildRegistry(name).catch((e: unknown) => {
        registries.delete(name);
        throw e;
      });
      registries.set(name, p);
    }
    return p;
  }

  // Durable per-repo ProvenanceLog cache — the "why" (P04) alongside the code.
  // Single-flight like registries so concurrent callers share one instance.
  const provenances = new Map<string, Promise<ProvenanceLog>>();

  async function buildProvenance(name: string): Promise<ProvenanceLog> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      throw new Error(`no repo ${name}`);
    }
    return ProvenanceLog.load(repo.store, metaBackend(name));
  }

  function provenanceFor(name: string): Promise<ProvenanceLog> {
    let p = provenances.get(name);
    if (p === undefined) {
      // Evict a REJECTED load so a transient backend error self-heals next call
      // rather than caching the failure forever (same fix as registryFor).
      p = buildProvenance(name).catch((e: unknown) => {
        provenances.delete(name);
        throw e;
      });
      provenances.set(name, p);
    }
    return p;
  }

  // Durable per-repo VetoLog cache — the standing human "no" (P10) alongside the
  // code. Single-flight like provenances so concurrent callers share one
  // instance; store-free (a veto carries no capability-gated payload).
  const vetoes = new Map<string, Promise<VetoLog>>();

  function vetoFor(name: string): Promise<VetoLog> {
    let p = vetoes.get(name);
    if (p === undefined) {
      // Evict a REJECTED load so a transient backend error self-heals next call.
      p = VetoLog.load(metaBackend(name)).catch((e: unknown) => {
        vetoes.delete(name);
        throw e;
      });
      vetoes.set(name, p);
    }
    return p;
  }

  // Durable per-repo SymbolOpLog cache — the signed semantic-graph ops (P08)
  // alongside the code. Single-flight + evict-on-reject like vetoFor.
  const symops = new Map<string, Promise<SymbolOpLog>>();

  function symopFor(name: string): Promise<SymbolOpLog> {
    let p = symops.get(name);
    if (p === undefined) {
      p = SymbolOpLog.load(metaBackend(name)).catch((e: unknown) => {
        symops.delete(name);
        throw e;
      });
      symops.set(name, p);
    }
    return p;
  }

  // The durable server-wide ReputationLog (P07). Reputation spans repos, so it is
  // held ONCE over the un-scoped backend (top-level `rep/` prefix), not a per-repo
  // scope. Single-flight so concurrent callers share one instance; evict a
  // rejected load so a transient backend error self-heals.
  let reputationPromise: Promise<ReputationLog> | undefined;
  function reputationLog(): Promise<ReputationLog> {
    reputationPromise ??= ReputationLog.load(config.backend).catch(
      (e: unknown) => {
        reputationPromise = undefined;
        throw e;
      }
    );
    return reputationPromise;
  }

  // Apply a committed land's secondary durable effects from a write-ahead
  // record. Fixed per-head meter keys and content-addressed contributions make
  // retries idempotent after any partial failure.
  async function recoverLandEffects(
    name: string,
    repo: Repo,
    reg: AgentRegistry
  ): Promise<void> {
    const backend = metaBackend(name);
    const keys = [...(await backend.list('meta/land-effects/'))].sort();
    for (const key of keys) {
      const bytes = await backend.get(key);
      if (bytes === undefined) continue;
      const effects = decodeRecord(bytes) as LandEffects;
      if (
        effects === null ||
        typeof effects !== 'object' ||
        effects.repo !== name ||
        typeof effects.view !== 'string' ||
        typeof effects.head !== 'string' ||
        !Array.isArray(effects.meters) ||
        !Array.isArray(effects.contributions)
      ) {
        throw new Error(`stored land effects are invalid: ${key}`);
      }
      const committed = repo.headRecords
        .history(effects.view)
        .some((record) => record.id === effects.head);
      if (!committed) {
        await backend.delete(key);
        continue;
      }
      for (const meter of effects.meters) {
        if (
          typeof meter.agent !== 'string' ||
          !Number.isSafeInteger(meter.changes) ||
          meter.changes < 0
        ) {
          throw new Error(`stored land meter is invalid: ${key}`);
        }
        const meterKey = `meter-land/${effects.head}/${encodeURIComponent(meter.agent)}`;
        const meterBytes = encodeRecord({
          head: effects.head,
          agent: meter.agent,
          changes: meter.changes,
          spend: 0,
        });
        let created = false;
        if (backend.putIfAbsent !== undefined) {
          created = await backend.putIfAbsent(meterKey, meterBytes);
        } else if ((await backend.get(meterKey)) === undefined) {
          await backend.put(meterKey, meterBytes);
          created = true;
        }
        if (created && reg.delegationFor(meter.agent) !== undefined) {
          reg.record(meter.agent, meter.changes, 0);
        }
      }
      if (effects.contributions.length > 0) {
        const reps = await reputationLog();
        for (const contribution of effects.contributions) {
          const verification = verifyContribution(contribution);
          if (
            contribution.repo !== name ||
            !verification.authentic ||
            !verification.attested
          ) {
            throw new Error(`stored land contribution is invalid: ${key}`);
          }
          await reps.ingest(contribution);
        }
      }
      await backend.delete(key);
    }
  }

  // Build the durable AgentRegistry for a repo: register every persisted grant,
  // replay the persisted meters, then apply revocations. Load order matters —
  // record() throws for an unregistered agent, so grants must be registered
  // before their meters replay; revocations apply last.
  async function buildRegistry(name: string): Promise<AgentRegistry> {
    const reg = new AgentRegistry();
    const b = metaBackend(name);
    for (const key of await b.list('grant/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        try {
          reg.register(decodeRecord(bytes) as Delegation);
        } catch {
          // skip a corrupt/invalid persisted grant
        }
      }
    }
    for (const key of await b.list('meter/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        const agent = key.slice('meter/'.length);
        const m = decodeRecord(bytes) as { changes: number; spend: number };
        try {
          // replayMeter, not record: restoring durable lifetime totals must not
          // stamp them into the current hour's rate window (P9).
          reg.replayMeter(agent, m.changes, m.spend);
        } catch {
          // a meter for an agent with no grant — skip
        }
      }
    }
    for (const key of await b.list('meter-land/')) {
      const bytes = await b.get(key);
      if (bytes === undefined) continue;
      try {
        const meter = decodeRecord(bytes) as {
          agent: string;
          changes: number;
          spend: number;
        };
        reg.replayMeter(meter.agent, meter.changes, meter.spend);
      } catch {
        // A corrupt or orphaned delta confers no additional usage authority.
      }
    }
    for (const key of await b.list('revoked/')) {
      reg.revoke(key.slice('revoked/'.length));
    }
    return reg;
  }

  async function getRepo(name: string): Promise<Repo | undefined> {
    const cached = repoCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return undefined; // unknown repo
    }
    const repo = await platform.openDurable(name, config.backend);
    if (
      repo.headRecords.owner !== undefined &&
      repo.headRecords.owner !== meta.owner
    ) {
      throw new Error(
        `signed-head owner disagrees with repo metadata: ${name}`
      );
    }
    // Signed history is authoritative for shared views. Raw view/* values may
    // still hold local or legacy projections, but they are never trust input.
    for (const view of repo.headRecords.views()) {
      const current = repo.headRecords.current(view);
      if (current !== undefined) {
        repo.log.view(view, current.heads);
      }
    }
    await recoverLandEffects(name, repo, await registryFor(name));
    repoCache.set(name, repo);
    return repo;
  }

  // Serialize mutations per repo.
  function withRepoLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      name,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  function headers(req: Request): SignedHeaders | null {
    const did = req.headers.get('x-thaddeus-did');
    const timestamp = req.headers.get('x-thaddeus-timestamp');
    const nonce = req.headers.get('x-thaddeus-nonce');
    const signature = req.headers.get('x-thaddeus-signature');
    if (
      did === null ||
      timestamp === null ||
      nonce === null ||
      signature === null
    ) {
      return null;
    }
    return { did, timestamp, nonce, signature };
  }

  const signedRequestOutcomes = {
    accepted: 0,
    invalid: 0,
    replayed: 0,
    capacity: 0,
    store_error: 0,
  };
  let cleanedReplayNonceRecords = 0;

  /**
   * Verifies and durably consumes a signed envelope before route processing.
   * No parsing, locking, or persistence mutation happens before this returns.
   */
  async function verifyRequest(
    method: string,
    pathWithQuery: string,
    body: Uint8Array,
    signedHeaders: SignedHeaders | null,
    nowMs: number
  ): Promise<string | Response> {
    const signer = verifySignedEnvelope(
      method,
      pathWithQuery,
      body,
      signedHeaders,
      nowMs,
      configuredRequestSkewMs
    );
    if (signer === null || signedHeaders === null) {
      signedRequestOutcomes.invalid += 1;
      return json(401, { error: 'unsigned or invalid request' });
    }

    try {
      const result = await config.backend.consumeNonce({
        key: replayNonceKey(signer, signedHeaders.nonce),
        expiresAt: Date.parse(signedHeaders.timestamp) + REQUEST_SKEW_MS,
        now: nowMs,
        capacity: configuredReplayNonceCapacity,
      });
      cleanedReplayNonceRecords += result.cleanedCount;
      if (result.status === 'replayed') {
        signedRequestOutcomes.replayed += 1;
        return json(401, { error: 'unsigned or invalid request' });
      }
      if (result.status === 'capacity') {
        signedRequestOutcomes.capacity += 1;
        const response = json(429, {
          error: 'replay protection capacity exceeded',
          code: 'replay_capacity_exceeded',
        });
        response.headers.set(
          'retry-after',
          String(Math.max(1, Math.ceil((result.retryAt - nowMs) / 1_000)))
        );
        return response;
      }
      signedRequestOutcomes.accepted += 1;
      return signer;
    } catch (error) {
      signedRequestOutcomes.store_error += 1;
      config.onError?.(error, { operation: 'nonce-consumption' });
      return json(503, {
        error: 'replay protection unavailable',
        code: 'replay_store_unavailable',
      });
    }
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const headError = (
    status: number,
    verification: Exclude<HeadVerification, { ok: true }>
  ): Response =>
    json(status, {
      error: verification.message,
      code: verification.code,
    });

  function decodeHead(wire: unknown): HeadRecord | Response {
    try {
      return decodeHeadRecord(wire);
    } catch (error) {
      return json(400, {
        error:
          error instanceof Error
            ? error.message
            : 'malformed signed head record',
        code: 'malformed_record',
      });
    }
  }

  function unsignedView(repo: Repo, view: string): boolean {
    return (
      repo.headRecords.current(view) === undefined && repo.log.hasView(view)
    );
  }

  const bodyRejections = {
    declared_too_large: 0,
    streamed_too_large: 0,
    invalid_content_length: 0,
  };

  /** Cancels an unread body without allowing cleanup failure to mask a reply. */
  const cancelBody = async (body: ReadableStream<Uint8Array> | null) => {
    try {
      await body?.cancel();
    } catch {
      // The response is already determined. Cancellation is best-effort cleanup
      // and must not turn a stable client error into a 500.
    }
  };

  /** Builds a stable JSON body error and closes the partially read connection. */
  const bodyError = (status: number, body: unknown): Response => {
    const response = json(status, body);
    response.headers.set('connection', 'close');
    return response;
  };

  /** Builds the application-detected 413 response with its configured limit. */
  const bodyTooLarge = (): Response =>
    bodyError(413, {
      error: 'request body too large',
      maxBytes: maxRequestBodyBytes,
    });

  /**
   * Reads a body without retaining more than the configured payload maximum.
   * Declared overflow is rejected without pulling; streamed input is coalesced
   * into bounded blocks before the exact bytes are assembled at end-of-stream.
   */
  async function readRequestBody(req: Request): Promise<Uint8Array | Response> {
    const contentLength = req.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) {
        bodyRejections.invalid_content_length += 1;
        await cancelBody(req.body);
        return bodyError(400, { error: 'invalid content-length header' });
      }
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes)) {
        bodyRejections.invalid_content_length += 1;
        await cancelBody(req.body);
        return bodyError(400, { error: 'invalid content-length header' });
      }
      if (declaredBytes > maxRequestBodyBytes) {
        bodyRejections.declared_too_large += 1;
        await cancelBody(req.body);
        return bodyTooLarge();
      }
    }

    if (req.body === null) {
      return new Uint8Array();
    }

    const bodyStream = req.body;
    const reader = (() => {
      try {
        return bodyStream.getReader();
      } catch {
        return undefined;
      }
    })();
    if (reader === undefined) {
      await cancelBody(req.body);
      return bodyError(400, { error: 'invalid request body' });
    }
    const chunks: Uint8Array[] = [];
    let pendingChunk: Uint8Array | undefined;
    let pendingChunkBytes = 0;
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.byteLength > maxRequestBodyBytes - totalBytes) {
          bodyRejections.streamed_too_large += 1;
          try {
            await reader.cancel();
          } catch {
            // Best-effort cleanup; preserve the stable 413 response.
          }
          return bodyTooLarge();
        }
        if (value.byteLength === 0) {
          continue;
        }

        // Coalesce arbitrarily small stream reads into fixed-size blocks. This
        // keeps object overhead bounded alongside payload bytes instead of
        // retaining one Uint8Array wrapper per adversarial one-byte read.
        let valueOffset = 0;
        while (valueOffset < value.byteLength) {
          if (pendingChunk === undefined) {
            pendingChunk = new Uint8Array(
              Math.min(
                REQUEST_BODY_BUFFER_BLOCK_BYTES,
                maxRequestBodyBytes - totalBytes - valueOffset
              )
            );
            pendingChunkBytes = 0;
          }
          const copiedBytes = Math.min(
            pendingChunk.byteLength - pendingChunkBytes,
            value.byteLength - valueOffset
          );
          pendingChunk.set(
            value.subarray(valueOffset, valueOffset + copiedBytes),
            pendingChunkBytes
          );
          pendingChunkBytes += copiedBytes;
          valueOffset += copiedBytes;
          if (pendingChunkBytes === pendingChunk.byteLength) {
            chunks.push(pendingChunk);
            pendingChunk = undefined;
            pendingChunkBytes = 0;
          }
        }
        totalBytes += value.byteLength;
      }
    } catch {
      try {
        await reader.cancel();
      } catch {
        // The stream has already failed; there is nothing else to clean up.
      }
      return bodyError(400, { error: 'invalid request body' });
    } finally {
      reader.releaseLock();
    }

    if (pendingChunk !== undefined && pendingChunkBytes > 0) {
      chunks.push(pendingChunk.subarray(0, pendingChunkBytes));
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  /** Renders configured limits and fixed-label process-local rejection counts. */
  function metrics(): Response {
    const lines = [
      '# HELP thaddeus_http_request_body_limit_bytes Maximum request body bytes accepted by application routes.',
      '# TYPE thaddeus_http_request_body_limit_bytes gauge',
      `thaddeus_http_request_body_limit_bytes ${maxRequestBodyBytes}`,
      '# HELP thaddeus_http_request_body_transport_limit_bytes Bun transport request body ceiling, including the overflow sentinel byte.',
      '# TYPE thaddeus_http_request_body_transport_limit_bytes gauge',
      `thaddeus_http_request_body_transport_limit_bytes ${maxRequestBodyBytes + 1}`,
      '# HELP thaddeus_http_request_body_rejections_total Request bodies rejected by the application guard.',
      '# TYPE thaddeus_http_request_body_rejections_total counter',
      `thaddeus_http_request_body_rejections_total{reason="declared_too_large"} ${bodyRejections.declared_too_large}`,
      `thaddeus_http_request_body_rejections_total{reason="streamed_too_large"} ${bodyRejections.streamed_too_large}`,
      `thaddeus_http_request_body_rejections_total{reason="invalid_content_length"} ${bodyRejections.invalid_content_length}`,
      '# HELP thaddeus_replay_nonce_capacity Maximum live replay nonces configured for this process.',
      '# TYPE thaddeus_replay_nonce_capacity gauge',
      `thaddeus_replay_nonce_capacity ${configuredReplayNonceCapacity}`,
      '# HELP thaddeus_request_skew_ms Accepted signed request timestamp skew in milliseconds.',
      '# TYPE thaddeus_request_skew_ms gauge',
      `thaddeus_request_skew_ms ${configuredRequestSkewMs}`,
      '# HELP thaddeus_signed_request_outcomes_total Signed request authentication outcomes.',
      '# TYPE thaddeus_signed_request_outcomes_total counter',
      `thaddeus_signed_request_outcomes_total{outcome="accepted"} ${signedRequestOutcomes.accepted}`,
      `thaddeus_signed_request_outcomes_total{outcome="invalid"} ${signedRequestOutcomes.invalid}`,
      `thaddeus_signed_request_outcomes_total{outcome="replayed"} ${signedRequestOutcomes.replayed}`,
      `thaddeus_signed_request_outcomes_total{outcome="capacity"} ${signedRequestOutcomes.capacity}`,
      `thaddeus_signed_request_outcomes_total{outcome="store_error"} ${signedRequestOutcomes.store_error}`,
      '# HELP thaddeus_replay_nonce_records_cleaned_total Expired replay nonce records cleaned by signed requests.',
      '# TYPE thaddeus_replay_nonce_records_cleaned_total counter',
      `thaddeus_replay_nonce_records_cleaned_total ${cleanedReplayNonceRecords}`,
      '',
    ];
    return new Response(lines.join('\n'), {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      },
    });
  }

  /** Creates a repository after consuming and authorizing its signed envelope. */
  async function createRepo(req: Request, body: Uint8Array): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      '/repos',
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    // Authentication and nonce persistence stay outside the repository lock.
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { name, head: wire } = parsed as { name: string; head?: unknown };
    if (typeof name !== 'string' || name.length === 0) {
      return json(400, { error: 'missing repo name' });
    }
    const decoded = decodeHead(wire);
    if (decoded instanceof Response) {
      return decoded;
    }
    if (decoded.owner !== signer) {
      return json(403, { error: 'head signer is not the repository owner' });
    }
    if (
      decoded.repo !== name ||
      decoded.view !== 'main' ||
      decoded.version !== 0 ||
      decoded.previous !== null ||
      decoded.heads.length !== 0
    ) {
      return json(400, {
        error: 'repository genesis must sign empty main at version 0',
        code: 'wrong_repo',
      });
    }
    // Wrap the existence-check-through-write in the per-repo lock so two
    // concurrent creates for the same name cannot both pass the existence check
    // (TOCTOU). The second request sees the meta written by the first → 409.
    return withRepoLock(name, async () => {
      if ((await readMeta(name)) !== undefined) {
        return json(409, { error: `repo ${name} already exists` });
      }
      const repo = await platform.createDurable(name, config.backend);
      await repo.headRecords.bootstrap(decoded);
      repo.log.view('main', decoded.heads);
      // Metadata is written last: it remains the repository visibility marker,
      // so a failed signed-head write cannot expose an unsigned repository.
      await metaBackend(name).put('meta/repo', encodeRecord({ owner: signer }));
      repoCache.set(name, repo);
      return json(201, {
        name,
        owner: signer,
        head: encodeHeadRecord(decoded),
      });
    });
  }

  async function repoNames(): Promise<string[]> {
    // Repos are the `meta/repo` keys across the backend: list `repo/*/meta/repo`.
    const keys = await config.backend.list('repo/');
    return keys
      .filter((k) => k.endsWith('/meta/repo'))
      .map((k) => k.slice('repo/'.length, -'/meta/repo'.length))
      .sort();
  }

  async function listRepos(): Promise<Response> {
    const names = await repoNames();
    // Include each repo's owner DID so a client can list "repos I own" without a
    // second round-trip. Owners are already public on the mirror (they sign
    // every op), so this leaks nothing new.
    const owners: Record<string, string> = {};
    for (const name of names) {
      const meta = await readMeta(name);
      if (meta !== undefined) {
        owners[name] = meta.owner;
      }
    }
    return json(200, { repos: names, owners });
  }

  function objectIsReferenced(repo: Repo, plaintextId: string): boolean {
    return repo.log
      .ops()
      .some((op) => op.payload?.plaintext_id === plaintextId);
  }

  function currentObjectConflict(
    repo: Repo,
    plaintextId: string,
    objectId: unknown
  ): Response | undefined {
    if (typeof objectId !== 'string') {
      return json(400, { error: 'missing current ciphertext id' });
    }
    const current = repo.store.current(plaintextId);
    if (current === undefined || current.id !== objectId) {
      return json(409, {
        error: 'local ciphertext is stale; pull and retry',
      });
    }
    return undefined;
  }

  // Owner schedules a client-created public capability. The server validates
  // its signature and current ciphertext, then holds it as embargo custodian.
  /** Schedules a signed public reveal for an encrypted object. */
  async function scheduleReveal(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { capability: wire, object } = parsed as {
      capability?: unknown;
      object?: unknown;
    };
    if (typeof wire !== 'string') {
      return json(400, { error: 'missing reveal capability' });
    }
    let capability: Capability;
    try {
      capability = decodeCapability(wire);
    } catch {
      return json(400, { error: 'malformed reveal capability' });
    }
    if (capability.granted_by !== signer) {
      return json(403, { error: 'reveal was not granted by the repo owner' });
    }
    return withRepoLock(name, async () => {
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (!objectIsReferenced(repo, capability.object)) {
        return json(400, { error: 'object is not referenced by this repo' });
      }
      const conflict = currentObjectConflict(repo, capability.object, object);
      if (conflict !== undefined) {
        return conflict;
      }
      let scheduled: boolean;
      try {
        scheduled = await repo.store.ingestReveal(capability);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(400, { error: message });
      }
      const ref = { id: String(object), plaintext_id: capability.object };
      const released = await repo.store.reveal(ref, now());
      const isPublic = repo.store
        .caps(capability.object)
        .some((cap) => cap.grantee === publicDid());
      return json(scheduled ? 201 : 200, {
        object: capability.object,
        at: capability.not_before,
        scheduled,
        released,
        public: isPublic,
      });
    });
  }

  // Owner-triggered reveal. A trigger cannot bypass the embargo because the
  // store receives the server's trusted clock, never a client-provided time.
  /** Applies a due signed reveal and publishes its object capability. */
  async function reveal(
    name: string,
    plaintextId: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { object } = parsed as { object?: unknown };
    return withRepoLock(name, async () => {
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (!objectIsReferenced(repo, plaintextId)) {
        return json(400, { error: 'object is not referenced by this repo' });
      }
      const conflict = currentObjectConflict(repo, plaintextId, object);
      if (conflict !== undefined) {
        return conflict;
      }
      const released = await repo.store.reveal(
        { id: String(object), plaintext_id: plaintextId },
        now()
      );
      const isPublic = repo.store
        .caps(plaintextId)
        .some((cap) => cap.grantee === publicDid());
      return json(200, { object: plaintextId, released, public: isPublic });
    });
  }

  // Owner-only read of reveal schedules. Include both withheld capabilities
  // and already-served public capabilities so promotion between pull and this
  // request cannot make recall erase a newly public grant.
  /** Lists pending reveal schedules visible to the repository owner. */
  async function pendingReveals(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { objects } = parsed as { objects?: unknown };
    if (
      !Array.isArray(objects) ||
      objects.some((id) => typeof id !== 'string')
    ) {
      return json(400, { error: 'objects must be an array of plaintext ids' });
    }
    return withRepoLock(name, async () => {
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      const capabilities = [...new Set(objects as string[])]
        .filter((id) => objectIsReferenced(repo, id))
        .flatMap((id) => [
          ...repo.store.pendingReveals(id),
          ...repo.store
            .caps(id)
            .filter(
              (capability) =>
                capability.grantee === publicDid() &&
                capability.granted_by === meta.owner
            ),
        ])
        .map(encodeCapability);
      const uniqueCapabilities = [...new Set(capabilities)];
      return json(200, { capabilities: uniqueCapabilities });
    });
  }

  // DELETE /repos/:name — owner-only. Drops every backend key under the repo's
  // scope and evicts its per-repo caches. Irreversible (no GC/undo yet). The
  // server-wide ReputationLog (top-level `rep/`) spans repos and is NOT removed.
  /** Deletes a repository after owner-envelope authentication. */
  async function deleteRepo(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'DELETE',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (signer !== meta.owner) {
        return json(403, { error: 'not the repo owner' });
      }
      const b = metaBackend(name);
      for (const key of await b.list('')) {
        await b.delete(key);
      }
      repoCache.delete(name);
      registries.delete(name);
      provenances.delete(name);
      vetoes.delete(name);
      symops.delete(name);
      return json(200, { deleted: name });
    });
  }

  // Public shared-view reads expose only owner-signed authority and its complete
  // chain. A legacy raw pointer fails closed until the owner bootstraps it.
  async function getView(name: string, view: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const head = repo.headRecords.current(view);
    if (head === undefined) {
      return unsignedView(repo, view)
        ? json(428, { error: `view ${view} requires owner head bootstrap` })
        : json(404, { error: `no view ${view}` });
    }
    return json(200, {
      view,
      head: encodeHeadRecord(head),
      chain: repo.headRecords.history(view).map(encodeHeadRecord),
    });
  }

  // GET /repos/:name/views — the repo's branches and their heads. A public read,
  // like the rest of the mirror: head ids are already public.
  async function listViews(name: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const views: Record<string, HeadRecordWire> = {};
    for (const view of repo.headRecords.views()) {
      const head = repo.headRecords.current(view);
      if (head !== undefined) {
        views[view] = encodeHeadRecord(head);
      }
    }
    return json(200, { views });
  }

  // Public immutable release reads. Corrupt records are skipped from the list;
  // a direct lookup reports the stored corruption instead of serving it.
  async function listReleases(name: string): Promise<Response> {
    if ((await readMeta(name)) === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const releases: Release[] = [];
    const backend = metaBackend(name);
    for (const key of await backend.list('meta/releases/')) {
      const bytes = await backend.get(key);
      if (bytes === undefined) continue;
      try {
        const release = decodeRecord(bytes) as Release;
        if (verifyRelease(release) && release.repo === name) {
          releases.push(release);
        }
      } catch {
        // Keep a single torn metadata record from sinking the public list.
      }
    }
    releases.sort((a, b) => {
      const newestFirst = b.at.localeCompare(a.at);
      return newestFirst !== 0 ? newestFirst : a.tag.localeCompare(b.tag);
    });
    return json(200, { releases: releases.map(encodeRelease) });
  }

  async function getRelease(name: string, tag: string): Promise<Response> {
    if ((await readMeta(name)) === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const bytes = await metaBackend(name).get(
      `meta/releases/${encodeURIComponent(tag)}`
    );
    if (bytes === undefined) {
      return json(404, { error: `no release tag ${tag}` });
    }
    try {
      const release = decodeRecord(bytes) as Release;
      if (
        !verifyRelease(release) ||
        release.repo !== name ||
        release.tag !== tag
      ) {
        throw new Error('invalid release record');
      }
      return json(200, { release: encodeRelease(release) });
    } catch {
      return json(500, { error: `stored release ${tag} is invalid` });
    }
  }

  // Signed create under the repo lock: policy, active delegation, current view
  // snapshot, duplicate tag, persistence, and optional attestation are one
  // serialized decision against server-side committed history.
  /** Persists a signed immutable release record for a repository tag. */
  async function createRelease(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { release: wire, claim: claimWire } = parsed as {
      release?: unknown;
      claim?: unknown;
    };
    if (typeof wire !== 'string') {
      return json(400, { error: 'missing release' });
    }
    let release: Release;
    try {
      release = decodeRelease(wire);
    } catch {
      return json(400, { error: 'malformed release' });
    }
    if (!verifyRelease(release)) {
      return json(400, { error: 'invalid release signature' });
    }
    if (release.signed_by !== signer) {
      return json(403, {
        error: 'release signer does not match request signer',
      });
    }
    if (release.repo !== name) {
      return json(400, { error: `release repo must be ${name}` });
    }
    let claim: ContributionClaim | undefined;
    if (typeof claimWire === 'string') {
      try {
        claim = decodeClaim(claimWire);
      } catch {
        // A malformed optional claim never invalidates the signed release.
      }
    }

    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      let repoPolicy: RepoPolicyRecord;
      try {
        repoPolicy = await readRepoPolicy(name);
      } catch (err) {
        return policyReadFailure(err);
      }
      let authorized = signer === meta.owner;
      if (!authorized && repoPolicy.release.creators === 'delegates') {
        const registry = await registryFor(name);
        authorized =
          registry.delegationFor(signer) !== undefined &&
          !registry.isRevoked(signer);
      }
      if (!authorized && repoPolicy.release.creators === 'allowList') {
        authorized = repoPolicy.release.allow.includes(signer);
      }
      if (!authorized) {
        return json(403, { error: 'not authorized to create releases' });
      }

      const backend = metaBackend(name);
      const key = `meta/releases/${encodeURIComponent(release.tag)}`;
      if ((await backend.get(key)) !== undefined) {
        return json(409, {
          error: `release tag ${release.tag} already exists`,
        });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      const signedHead = repo.headRecords.current(release.view);
      if (signedHead === undefined) {
        return unsignedView(repo, release.view)
          ? json(428, {
              error: `view ${release.view} requires owner head bootstrap`,
            })
          : json(404, { error: `no branch ${release.view}` });
      }
      const heads = [...signedHead.heads];
      const commits = reachableOps(repo.log.ops(), heads).map((op) => op.id);
      if (
        !sameStringSet(release.heads, heads) ||
        !sameStringSet(release.commits, commits)
      ) {
        return json(409, {
          error: `view ${release.view} changed; refresh and retry release`,
        });
      }

      await backend.put(key, encodeRecord(release));
      if (
        config.host !== undefined &&
        claim !== undefined &&
        claim.repo === name &&
        claim.ref === release.id &&
        claim.kind === 'release' &&
        claim.subject === release.signed_by &&
        verifyClaim(claim)
      ) {
        try {
          await (await reputationLog()).ingest(attest(claim, config.host));
        } catch {
          // The release and its host-vouched contribution are one create from
          // the caller's perspective. If the second durable write fails, remove
          // the tag while still holding the repo lock so a clean retry can
          // create and attest it instead of getting a permanent duplicate 409.
          try {
            await backend.delete(key);
          } catch {
            return json(500, {
              error:
                'release attestation failed and release rollback failed; inspect the stored tag before retrying',
            });
          }
          return json(500, {
            error: 'release attestation failed; release was rolled back',
          });
        }
      }
      return json(201, { release: encodeRelease(release) });
    });
  }

  // GET /repos/:name/policy — public read of the repo's active land policy.
  async function getPolicy(name: string): Promise<Response> {
    if ((await readMeta(name)) === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    try {
      return json(200, { policy: await readRepoPolicy(name) });
    } catch (err) {
      return policyReadFailure(err);
    }
  }

  // POST /repos/:name/policy — owner-selectable repo policy, no restart.
  /** Replaces a repository's signed policy record. */
  async function setPolicy(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    let next: RepoPolicyRecord;
    try {
      const candidate =
        'policy' in parsed ? (parsed as { policy?: unknown }).policy : parsed;
      next = normalizeRepoPolicy(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(400, { error: msg });
    }
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    return withRepoLock(name, async () => {
      const lockedMeta = await readMeta(name);
      if (lockedMeta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (lockedMeta.owner !== meta.owner) {
        return json(409, { error: 'repo changed; retry policy set' });
      }
      await metaBackend(name).put('meta/policy', encodeRecord(next));
      return json(200, { policy: next });
    });
  }

  // Owner-created branches begin their own signed version-0 history. Delegates
  // may upload operations but cannot create shared authority records.
  /** Creates a signed repository view rooted at an existing frontier. */
  async function createView(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const decoded = decodeHead((parsed as { head?: unknown }).head);
    if (decoded instanceof Response) return decoded;
    const view = decoded.view;
    if (view.startsWith(INTERNAL_VIEW_PREFIX)) {
      return json(400, { error: `reserved view name ${view}` });
    }
    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (signer !== meta.owner || decoded.owner !== meta.owner) {
        return json(403, {
          error: 'shared view creation requires the repo owner',
        });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      if (
        repo.headRecords.current(view) !== undefined ||
        repo.log.hasView(view)
      ) {
        return json(409, { error: `view ${view} already exists` });
      }
      if (
        decoded.repo !== name ||
        decoded.version !== 0 ||
        decoded.previous !== null
      ) {
        return json(400, {
          error: 'new view requires a scoped version-0 head',
        });
      }
      const snapshot = verifyHeadSnapshot(
        decoded,
        reachableOps(repo.log.ops(), decoded.heads)
      );
      if (!snapshot.ok) return headError(400, snapshot);
      await repo.headRecords.bootstrap(decoded);
      repo.log.view(view, decoded.heads);
      return json(201, {
        view,
        head: encodeHeadRecord(decoded),
        heads: [...decoded.heads],
      });
    });
  }

  // Legacy migration: the owner selects and signs a genesis head. The old raw
  // pointer is checked only for view existence and is never used as trust input.
  /** Establishes the first signed monotonic head for a repository view. */
  async function bootstrapHead(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const decoded = decodeHead((parsed as { head?: unknown }).head);
    if (decoded instanceof Response) return decoded;
    return withRepoLock(name, async () => {
      const meta = await readMeta(name);
      if (meta === undefined) return json(404, { error: `no repo ${name}` });
      if (signer !== meta.owner || decoded.owner !== meta.owner) {
        return json(403, { error: 'head bootstrap requires the repo owner' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) return json(404, { error: `no repo ${name}` });
      if (repo.headRecords.current(decoded.view) !== undefined) {
        return json(409, { error: `view ${decoded.view} is already signed` });
      }
      if (!repo.log.hasView(decoded.view)) {
        return json(404, { error: `no legacy view ${decoded.view}` });
      }
      if (
        decoded.repo !== name ||
        decoded.version !== 0 ||
        decoded.previous !== null
      ) {
        return json(400, {
          error: 'bootstrap requires a scoped version-0 head',
        });
      }
      const snapshot = verifyHeadSnapshot(
        decoded,
        reachableOps(repo.log.ops(), decoded.heads)
      );
      if (!snapshot.ok) return headError(400, snapshot);
      await repo.headRecords.bootstrap(decoded);
      repo.log.view(decoded.view, decoded.heads);
      return json(200, { head: encodeHeadRecord(decoded) });
    });
  }

  // Returns the reachable bundle for a view: ops in lamport order, plus the
  // CURRENT ciphertext object and its served caps for each plaintext_id an
  // op's payload references. Use this for clone (pull main).
  async function pull(name: string, view: string): Promise<Response> {
    const repo = await getRepo(name);
    if (repo === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const head = repo.headRecords.current(view);
    if (head === undefined) {
      return unsignedView(repo, view)
        ? json(428, { error: `view ${view} requires owner head bootstrap` })
        : json(404, { error: `no view ${view}` });
    }
    const ops = reachableOps(repo.log.ops(), head.heads);
    const snapshot = verifyHeadSnapshot(head, ops);
    if (!snapshot.ok) return headError(400, snapshot);
    // For every plaintext_id an op's payload references, the CURRENT ciphertext
    // object + its served caps (store.get decrypts the current object, so the
    // client needs current — not a historical version — to read after rotation).
    const objects = [];
    const caps = [];
    const seen = new Set<string>();
    for (const op of ops) {
      const pid = op.payload?.plaintext_id;
      if (pid === undefined || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      const current = repo.store.current(pid);
      if (current !== undefined) {
        objects.push(current);
        caps.push(...repo.store.caps(pid));
      }
    }
    // The signed "why" for every op in the view (P04), so a clone carries the
    // meaning, not just the code. The standing "no" (P10) travels the same way,
    // so a clone can see (and re-serve) any veto over the view's ops.
    const provLog = await provenanceFor(name);
    const prov = ops.flatMap((op) => [...provLog.forOp(op.id)]);
    const vetoLog = await vetoFor(name);
    const veto = ops.flatMap((op) => [...vetoLog.forOp(op.id)]);
    // The semantic-graph ops (P08) are keyed by symbol, not by a P03 op, so a
    // clone carries the repo's whole structural history (e.g. rename chains).
    const symopLog = await symopFor(name);
    const symop = [...symopLog.all()];
    return json(200, {
      view,
      head: encodeHeadRecord(head),
      chain: repo.headRecords.history(view).map(encodeHeadRecord),
      ...encodeBundle(ops, objects, caps, prov, veto, symop),
    });
  }

  async function ingestBundle(
    name: string,
    repo: Repo,
    bundle: ReturnType<typeof decodeBundle>,
    acceptPending = false
  ): Promise<{
    accepted: {
      objects: number;
      ops: number;
      caps: number;
      prov: number;
      veto: number;
      symop: number;
      pending: number;
    };
    rejected: { kind: string; id: string; reason: string }[];
  }> {
    const rejected: { kind: string; id: string; reason: string }[] = [];
    let objectsOk = 0;
    let capsOk = 0;
    let opsOk = 0;
    let pendingOk = 0;
    const repoOwner = (await readMeta(name))?.owner;
    const recallOwner = acceptPending ? repoOwner : undefined;
    const consumedPending = new Set<Capability>();
    // Verify each cap at the push boundary before grouping. Caps with invalid
    // or malformed signatures are rejected immediately so they never reach
    // store.ingest; only valid caps are grouped and counted in accepted.caps.
    const capsByPid = new Map<string, Capability[]>();
    const trustedNow = Date.parse(now());
    for (const cap of bundle.caps) {
      let valid = false;
      try {
        valid = verifyCapability(cap);
      } catch {
        valid = false;
      }
      const publicTimestamp =
        cap.grantee === publicDid() ? Date.parse(cap.not_before) : undefined;
      if (
        valid &&
        cap.grantee === publicDid() &&
        publicTimestamp !== undefined &&
        Number.isNaN(publicTimestamp)
      ) {
        rejected.push({
          kind: 'cap',
          id: cap.object ?? '?',
          reason: 'invalid public capability timestamp',
        });
      } else if (
        valid &&
        cap.grantee === publicDid() &&
        publicTimestamp !== undefined &&
        publicTimestamp > trustedNow
      ) {
        rejected.push({
          kind: 'cap',
          id: cap.object ?? '?',
          reason: 'future public capabilities require the reveal route',
        });
      } else if (valid) {
        const list = capsByPid.get(cap.object) ?? [];
        list.push(cap);
        capsByPid.set(cap.object, list);
      } else {
        rejected.push({
          kind: 'cap',
          id: cap.object ?? '?',
          reason: 'invalid capability signature',
        });
      }
    }
    for (const object of bundle.objects) {
      try {
        const pushed = capsByPid.get(object.plaintext_id) ?? [];
        // `store.ingest` is authoritative-replace, and a client only sends the
        // caps ITS store holds — so a pusher with a stale view would silently
        // erase a capability another member was just granted. Union the pushed
        // caps with the ones already served, but ONLY when the ciphertext is
        // unchanged: a new ciphertext means a new content key, and the old caps
        // would unwrap the wrong one, so those must be replaced outright.
        const stored = repo.store.current(object.plaintext_id);
        const sameKey = stored !== undefined && stored.id === object.id;
        let replacements: Capability[] = [];
        if (!sameKey) {
          const existingPending = repo.store.pendingReveals(
            object.plaintext_id
          );
          const existingPublic = repo.store
            .caps(object.plaintext_id)
            .filter(
              (capability) =>
                capability.grantee === publicDid() &&
                capability.granted_by === repoOwner
            );
          const eligiblePending = bundle.pending.filter(
            (capability) =>
              capability.object === object.plaintext_id &&
              capability.granted_by === recallOwner &&
              isValidPublicCapability(capability)
          );
          const protectedReveals = [...existingPending, ...existingPublic];
          if (protectedReveals.length > 0 && !acceptPending) {
            throw new TypeError(
              'ciphertext replacement with a pending reveal requires owner-authorized recall'
            );
          }
          if (
            acceptPending &&
            protectedReveals.some(
              (previous) =>
                ![...pushed, ...eligiblePending].some((replacement) =>
                  replacesPendingReveal(previous, replacement)
                )
            )
          ) {
            throw new TypeError(
              'recall must re-wrap every pending reveal before rotating ciphertext'
            );
          }
          if (acceptPending && eligiblePending.length > 0) {
            replacements = eligiblePending;
            replacements.forEach((capability) =>
              consumedPending.add(capability)
            );
          }
        }
        if (replacements.length > 0) {
          await repo.store.ingestRecall(object, pushed, replacements);
          pendingOk += replacements.length;
        } else {
          await repo.store.ingest(
            object,
            sameKey
              ? unionCaps(repo.store.caps(object.plaintext_id), pushed)
              : pushed
          );
        }
        objectsOk += 1;
        capsOk += pushed.length;
      } catch (err) {
        rejected.push({
          kind: 'object',
          id: object.id ?? '?',
          reason: String(err),
        });
      }
    }
    // Pending public capabilities are never accepted on the general push path:
    // serving one early would disclose the key. The owner-only recall path may
    // carry them after rotated objects so a scheduled reveal survives rekeying.
    for (const capability of bundle.pending) {
      if (consumedPending.has(capability)) {
        continue;
      }
      if (!acceptPending) {
        rejected.push({
          kind: 'reveal',
          id: capability.object ?? '?',
          reason: 'pending reveals require an owner-authorized recall',
        });
        continue;
      }
      if (capability.granted_by !== recallOwner) {
        rejected.push({
          kind: 'reveal',
          id: capability.object ?? '?',
          reason: 'reveal was not granted by the repo owner',
        });
        continue;
      }
      try {
        if (await repo.store.ingestReveal(capability)) {
          pendingOk += 1;
        }
      } catch (err) {
        rejected.push({
          kind: 'reveal',
          id: capability.object ?? '?',
          reason: String(err),
        });
      }
    }
    for (const op of bundle.ops) {
      try {
        await repo.log.ingest(op);
        opsOk += 1;
      } catch (err) {
        rejected.push({ kind: 'op', id: op.id ?? '?', reason: String(err) });
      }
    }
    // Ingest the signed "why" (P04): keep-and-label + durable write-through, so
    // a restarted server still serves the reason behind each change. An
    // unverifiable why poisons nothing (it is kept and rendered `unverified`).
    let provOk = 0;
    const provLog = await provenanceFor(name);
    for (const p of bundle.prov) {
      try {
        await provLog.ingest(p);
        provOk += 1;
      } catch (err) {
        rejected.push({ kind: 'prov', id: p.op ?? '?', reason: String(err) });
      }
    }
    // Ingest the standing "no" (P10) the same way: keep-and-label + durable
    // write-through so a restarted server still blocks a vetoed land. A forged
    // veto is kept but rendered `unverified`, and the land gate never counts it.
    let vetoOk = 0;
    const vetoLog = await vetoFor(name);
    for (const v of bundle.veto) {
      try {
        await vetoLog.ingest(v);
        vetoOk += 1;
      } catch (err) {
        rejected.push({ kind: 'veto', id: v.op ?? '?', reason: String(err) });
      }
    }
    // Ingest the signed semantic-graph ops (P08) the same way, so a restarted
    // server still serves a symbol's rename chain. Keep-and-label — an
    // unverifiable structural claim is kept and rendered unverifiable.
    let symopOk = 0;
    const symopLog = await symopFor(name);
    for (const s of bundle.symop) {
      try {
        await symopLog.ingest(s);
        symopOk += 1;
      } catch (err) {
        rejected.push({
          kind: 'symop',
          id: s.id ?? '?',
          reason: String(err),
        });
      }
    }
    return {
      accepted: {
        objects: objectsOk,
        ops: opsOk,
        caps: capsOk,
        prov: provOk,
        veto: vetoOk,
        symop: symopOk,
        pending: pendingOk,
      },
      rejected,
    };
  }

  // Verify signature + owner, then ingest each object (with its caps) and each
  // op under the repo lock. Per-item failures go to rejected[] — a single bad
  // item does not abort the whole request. Views are never advanced here; only
  // land moves views.
  /** Ingests a signed encrypted bundle without advancing the shared head. */
  async function push(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    let bundle: ReturnType<typeof decodeBundle>;
    try {
      bundle = decodeBundle(parsed as Parameters<typeof decodeBundle>[0]);
    } catch {
      return json(400, { error: 'malformed bundle' });
    }
    return withRepoLock(name, async () => {
      // Owner-or-delegate gate INSIDE the lock: re-check against the one-true
      // registry AFTER acquiring the lock, so a revoke that ran just before is
      // seen. The owner is always authorized; a non-owner must hold a
      // non-revoked delegation for this repo.
      const reg = await registryFor(name);
      if (
        signer !== meta.owner &&
        !(reg.delegationFor(signer) !== undefined && !reg.isRevoked(signer))
      ) {
        return json(403, { error: 'not authorized to write this repo' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      return json(200, await ingestBundle(name, repo, bundle));
    });
  }

  // Only the owner may advance shared authority. Uploaded operations may still
  // be delegate-authored; all existing policy gates run before the signed record
  // is persisted and projected into the hot log.
  /** Lands signed operations and advances the repository's shared head. */
  async function land(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const {
      fromHeads,
      into,
      contrib,
      head: wire,
    } = parsed as {
      fromHeads: string[];
      into?: string;
      contrib?: string[];
      head?: unknown;
    };
    if (into !== undefined && typeof into !== 'string') {
      return json(400, { error: 'into must be a string' });
    }
    if (
      !Array.isArray(fromHeads) ||
      fromHeads.some((head) => typeof head !== 'string')
    ) {
      return json(400, { error: 'fromHeads must be an array of op ids' });
    }
    const decoded = decodeHead(wire);
    if (decoded instanceof Response) return decoded;
    // Decode any client-pushed reputation claims (P07). A malformed entry is
    // dropped rather than failing the whole land.
    const claims: ContributionClaim[] = [];
    if (Array.isArray(contrib)) {
      for (const s of contrib) {
        try {
          claims.push(decodeClaim(s));
        } catch {
          // skip a malformed claim
        }
      }
    }
    return withRepoLock(name, async () => {
      // Shared head signatures are owner-only even when every incoming operation
      // was validly authored and uploaded by a delegate.
      const reg = await registryFor(name);
      if (signer !== meta.owner || decoded.owner !== meta.owner) {
        return json(403, { error: 'shared landing requires the repo owner' });
      }
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      try {
        await recoverLandEffects(name, repo, reg);
      } catch (error) {
        return json(500, {
          error: `pending land bookkeeping could not be recovered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      // Every head must be an op the server has already ingested; a reference to
      // unknown history means the closure is partial and land would be wrong.
      const known = new Set(repo.log.ops().map((o) => o.id));
      if (fromHeads.some((h) => !known.has(h))) {
        return json(400, {
          error: 'fromHeads references an op the server has not ingested',
        });
      }
      // Capture the target frontier BEFORE land re-points the view; the
      // incoming closure is the ops reachable from fromHeads but not from here.
      // NOTE: this `?? 'main'` default MUST match Repo.land's own `into` default
      // — they share the same frontier, and a drift would mis-meter delegates.
      const target = into ?? 'main';
      const history = repo.headRecords.history(target);
      const current = history.at(-1);
      if (current === undefined) {
        return unsignedView(repo, target)
          ? json(428, { error: `view ${target} requires owner head bootstrap` })
          : json(404, { error: `no view ${target}` });
      }
      if (decoded.repo !== name || decoded.view !== target) {
        return json(400, {
          error: 'head record is bound to the wrong repository or view',
          code: decoded.repo !== name ? 'wrong_repo' : 'wrong_view',
        });
      }
      if (decoded.version <= current.version) {
        return headError(409, {
          ok: false,
          code:
            decoded.version === current.version && decoded.id !== current.id
              ? 'fork'
              : 'rollback',
          message:
            decoded.version === current.version && decoded.id !== current.id
              ? 'head record conflicts at the current version'
              : 'head successor is stale',
        });
      }
      if (decoded.version > current.version + 1) {
        return headError(409, {
          ok: false,
          code: 'gap',
          message: 'head successor skips one or more versions',
        });
      }
      const chainVerification = verifyHeadChain([...history, decoded], {
        repo: name,
        view: target,
        owner: meta.owner,
        prefix: history,
      });
      if (!chainVerification.ok) {
        return headError(409, chainVerification);
      }
      const expectedHeads = [
        ...new Set([...current.heads, ...fromHeads]),
      ].sort();
      if (
        decoded.heads.length !== expectedHeads.length ||
        decoded.heads.some((head, index) => head !== expectedHeads[index])
      ) {
        return json(409, {
          error: 'signed successor does not contain the exact merged heads',
          code: 'dropped_heads',
        });
      }
      const snapshot = verifyHeadSnapshot(
        decoded,
        reachableOps(repo.log.ops(), decoded.heads)
      );
      if (!snapshot.ok) return headError(400, snapshot);
      const priorInto = [...current.heads];
      repo.log.view(target, current.heads);
      // Ephemeral in-memory source view: reuse a constant name so the view
      // count stays bounded. Safe because withRepoLock serializes land calls
      // per repo — each land overwrites the view before reading it. It lives
      // under the internal prefix so it never surfaces as a branch.
      const src = `${INTERNAL_VIEW_PREFIX}incoming`;
      repo.log.view(src, fromHeads);
      // Compose the base policy with delegation enforcement AND the durable
      // standing veto: every non-owner op is path+budget gated (the owner is
      // exempt), and — no matter how green every automated gate is — a verified
      // veto pushed for any incoming op is the ceiling that blocks the land. With
      // no vetoes recorded, blockOnVeto allows, so this is a safe always-on gate.
      const vetoLog = await vetoFor(name);
      const provLog = await provenanceFor(name);
      let repoPolicy: RepoPolicyRecord;
      try {
        repoPolicy = await readRepoPolicy(name);
      } catch (err) {
        return policyReadFailure(err);
      }
      const gates: LandPolicy[] = [
        policy,
        ...repoPolicyGates(repoPolicy, provLog),
        delegationPolicy(reg, (a) => a === meta.owner),
        blockOnVeto(vetoLog),
      ];
      // When configured with a reputation floor, add a durable tier gate: every
      // incoming op's author must clear `minMerges` ATTESTED merges. Self-claimed
      // reputation never counts, so the gate honors only host-vouched history.
      // Loaded lazily — a server with no host and no floor never touches `rep/`.
      if (config.minMerges !== undefined) {
        gates.push(
          requireReputationTier(
            await reputationLog(),
            config.minMerges,
            trustedReputationHosts
          )
        );
      }
      // Prepare secondary effects before committing authority, then durably
      // stage them. Recovery applies only outboxes whose head actually landed.
      const priorSet = new Set(
        reachableOps(repo.log.ops(), priorInto).map((op) => op.id)
      );
      const incoming = reachableOps(repo.log.ops(), fromHeads).filter(
        (op) => !priorSet.has(op.id)
      );
      const countByAuthor = new Map<string, number>();
      for (const op of incoming) {
        if (op.author !== meta.owner) {
          countByAuthor.set(op.author, (countByAuthor.get(op.author) ?? 0) + 1);
        }
      }
      const meters = [...countByAuthor]
        .filter(([agent]) => reg.delegationFor(agent) !== undefined)
        .map(([agent, changes]) => ({ agent, changes }));
      const contributions: Contribution[] = [];
      if (config.host !== undefined && claims.length > 0) {
        const byId = new Map(incoming.map((op) => [op.id, op]));
        for (const claim of claims) {
          const op = byId.get(claim.ref);
          if (
            op !== undefined &&
            claim.subject === op.author &&
            verifyClaim(claim)
          ) {
            contributions.push(attest(claim, config.host));
          }
        }
      }
      const effects: LandEffects = {
        repo: name,
        view: target,
        head: decoded.id,
        meters,
        contributions,
      };
      const effectsBackend = metaBackend(name);
      const effectsKey = `meta/land-effects/${decoded.id}`;
      await effectsBackend.put(effectsKey, encodeRecord(effects));

      let result: LandResult;
      try {
        result = await repo.land({
          from: src,
          into: target,
          author: PublicIdentity.fromDid(signer),
          policy: all(...gates),
          headRecord: decoded,
        });
      } catch (error) {
        await effectsBackend.delete(effectsKey).catch(() => {});
        throw error;
      }
      if (!result.landed) {
        await effectsBackend.delete(effectsKey).catch(() => {});
      } else {
        // Authority is already committed. A secondary write failure must not
        // turn success into a retryable error; the durable outbox remains.
        await recoverLandEffects(name, repo, reg).catch(() => {});
      }
      return json(200, {
        ...result,
        ...(result.landed ? { head: encodeHeadRecord(decoded) } : {}),
      });
    });
  }

  // Owner-signed grant: register + persist a P09 Delegation for the repo. The
  // delegation's operator must be the repo owner too, so an owner cannot launder
  // a third-party-issued grant through their own signed request.
  /** Persists an owner-signed agent delegation for a repository. */
  async function grant(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { delegation } = parsed as { delegation?: string };
    if (typeof delegation !== 'string') {
      return json(400, { error: 'missing delegation' });
    }
    let d: Delegation;
    try {
      d = decodeDelegation(delegation);
    } catch {
      return json(400, { error: 'malformed delegation' });
    }
    if (d.operator !== meta.owner) {
      return json(403, { error: 'delegation operator is not the repo owner' });
    }
    if (!verifyDelegation(d)) {
      return json(400, { error: 'invalid delegation signature' });
    }
    return withRepoLock(name, async () => {
      const reg = await registryFor(name);
      // Revocation is terminal (P09): register() would replace the grant record
      // but never clear the quarantine, so a re-grant would 200 yet leave the
      // agent permanently blocked (and absent from GET /grants). Reject it
      // explicitly so the terminal semantics are unambiguous — issue a fresh DID.
      if (reg.isRevoked(d.agent)) {
        return json(409, {
          error:
            'agent is revoked; revocation is terminal — grant a fresh identity',
        });
      }
      // register() can throw on a malformed delegation; map it to a 400 rather
      // than letting it escape as a 500 (defense-in-depth after verifyDelegation).
      try {
        reg.register(d);
      } catch {
        return json(400, { error: 'invalid delegation' });
      }
      await metaBackend(name).put(`grant/${d.agent}`, encodeRecord(d));
      return json(200, {
        agent: d.agent,
        paths: [...d.paths],
        maxChanges: d.maxChanges,
        maxSpend: d.maxSpend,
      });
    });
  }

  // Owner-signed revoke: quarantine + persist (terminal). A revoked agent stays
  // blocked across reloads.
  /** Persists an owner-signed agent revocation for a repository. */
  async function revoke(
    name: string,
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const meta = await readMeta(name);
    if (meta === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    if (signer !== meta.owner) {
      return json(403, { error: 'not the repo owner' });
    }
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const { agent, recall } = parsed as { agent?: string; recall?: Bundle };
    if (typeof agent !== 'string') {
      return json(400, { error: 'missing agent' });
    }
    let recallBundle: ReturnType<typeof decodeBundle> | undefined;
    if (recall !== undefined) {
      try {
        recallBundle = decodeBundle(recall);
      } catch {
        return json(400, { error: 'malformed recall bundle' });
      }
    }
    return withRepoLock(name, async () => {
      const repo = await getRepo(name);
      if (repo === undefined) {
        return json(404, { error: `no repo ${name}` });
      }
      const recalled =
        recallBundle === undefined
          ? undefined
          : await ingestBundle(name, repo, recallBundle, true);
      const reg = await registryFor(name);
      reg.revoke(agent);
      await metaBackend(name).put(`revoked/${agent}`, encodeRecord(true));
      return json(200, { agent, revoked: true, recalled });
    });
  }

  // Public: the active (non-revoked) grants for a repo, each as a wire delegation.
  async function listGrants(name: string): Promise<Response> {
    if ((await readMeta(name)) === undefined) {
      return json(404, { error: `no repo ${name}` });
    }
    const reg = await registryFor(name);
    const b = metaBackend(name);
    const grants: string[] = [];
    for (const key of await b.list('grant/')) {
      const bytes = await b.get(key);
      if (bytes !== undefined) {
        let d: Delegation;
        try {
          d = decodeRecord(bytes) as Delegation;
        } catch {
          // skip a corrupt/invalid persisted grant (mirror buildRegistry)
          continue;
        }
        if (!reg.isRevoked(d.agent)) {
          grants.push(encodeDelegation(d));
        }
      }
    }
    return json(200, { grants });
  }

  // Public: a subject's server-wide reputation profile — trusted-attested,
  // valid-but-untrusted, and claimed counts. The tier gate reads the same log
  // with the same destination trust set.
  async function reputationProfile(did: string): Promise<Response> {
    const reps = await reputationLog();
    const profile = reps.profile(did, trustedReputationHosts);
    return json(200, {
      subject: profile.subject,
      attested: profile.attested.length,
      untrusted: profile.untrusted.length,
      claimed: profile.claimed.length,
      byKind: profile.byKind,
    });
  }

  // Public export: portable reputation is cleartext signed metadata. The
  // archive carries all valid host proofs; the destination applies its trust.
  async function reputationExport(did: string): Promise<Response> {
    try {
      const archive = (await reputationLog()).archive(did);
      return json(200, { archive: encodeReputationArchive(archive) });
    } catch {
      return json(400, { error: 'reputation subject must be a valid did:key' });
    }
  }

  // Subject-authorized strict import. Every contribution is independently
  // verified by decodeReputationArchive before the one-write durable merge.
  /** Imports a signed reputation archive through an authenticated envelope. */
  async function reputationImport(
    req: Request,
    body: Uint8Array
  ): Promise<Response> {
    const signer = await verifyRequest(
      'POST',
      new URL(req.url).pathname,
      body,
      headers(req),
      Date.parse(now())
    );
    if (signer instanceof Response) return signer;
    const parsed = safeParseJson(body);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return json(400, { error: 'invalid JSON body' });
    }
    const archiveJson = (parsed as { archive?: unknown }).archive;
    if (typeof archiveJson !== 'string') {
      return json(400, { error: 'missing reputation archive' });
    }
    let archive: ReputationArchive;
    try {
      archive = decodeReputationArchive(archiveJson);
    } catch (error) {
      return json(400, {
        error:
          error instanceof Error ? error.message : 'invalid reputation archive',
      });
    }
    if (signer !== archive.subject) {
      return json(403, { error: 'only the archive subject may import it' });
    }
    const reps = await reputationLog();
    const result = await reps.ingestArchive(archive);
    return json(200, {
      subject: archive.subject,
      ...result,
      total: reps.archive(archive.subject).contributions.length,
    });
  }

  return {
    async revealDue(): Promise<number> {
      let released = 0;
      let names: readonly string[];
      try {
        names = await repoNames();
      } catch (error) {
        config.onError?.(error, { operation: 'reveal' });
        return 0;
      }
      for (const name of names) {
        try {
          released += await withRepoLock(name, async () => {
            const repo = await getRepo(name);
            return repo === undefined ? 0 : repo.store.revealDue(now());
          });
        } catch (error) {
          config.onError?.(error, { operation: 'reveal', repo: name });
        }
      }
      return released;
    },

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const emptyBody = new Uint8Array();
      /** Loads a matched POST body before invoking authentication or handlers. */
      const withBody = async (
        handler: (body: Uint8Array) => Promise<Response>
      ): Promise<Response> => {
        const body = await readRequestBody(req);
        return body instanceof Response ? body : handler(body);
      };
      /** Cancels a body before returning the route's stable malformed-path error. */
      const malformedPath = async (): Promise<Response> => {
        await cancelBody(req.body);
        return json(400, { error: 'malformed path' });
      };

      if (req.method !== 'POST') {
        await cancelBody(req.body);
      }

      if (path === '/repos' && req.method === 'GET') {
        return listRepos();
      }
      if (path === '/metrics' && req.method === 'GET') {
        return metrics();
      }
      if (path === '/reputation/import' && req.method === 'POST') {
        return withBody((body) => reputationImport(req, body));
      }
      const repExportMatch = path.match(/^\/reputation\/(.+)\/export$/);
      if (repExportMatch !== null && req.method === 'GET') {
        const did = safeDecode(repExportMatch[1]);
        if (did === undefined) return malformedPath();
        return reputationExport(did);
      }
      // GET /reputation/:did — the subject's server-wide profile.
      const repMatch = path.match(/^\/reputation\/(.+)$/);
      if (repMatch !== null && req.method === 'GET') {
        const did = safeDecode(repMatch[1]);
        if (did === undefined) {
          return malformedPath();
        }
        return reputationProfile(did);
      }
      if (path === '/repos' && req.method === 'POST') {
        return withBody((body) => createRepo(req, body));
      }
      // DELETE /repos/:name — owner-only. (Suffixed routes below are GET/POST,
      // so this bare-name match never steals a push/land/grants path.)
      const deleteMatch = path.match(/^\/repos\/(.+)$/);
      if (deleteMatch !== null && req.method === 'DELETE') {
        const repoName = safeDecode(deleteMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return deleteRepo(repoName, req, emptyBody);
      }
      // /repos/:name/policy — read or owner-select the active land policy.
      const policyMatch = path.match(/^\/repos\/(.+)\/policy$/);
      if (policyMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(policyMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return getPolicy(repoName);
      }
      if (policyMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(policyMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => setPolicy(repoName, req, body));
      }
      // /repos/:name/releases and /repos/:name/releases/:tag — immutable
      // signed release metadata. Match detail first so it is not a collection.
      const releaseMatch = path.match(/^\/repos\/(.+)\/releases\/([^/]+)$/);
      if (releaseMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(releaseMatch[1]);
        const tag = safeDecode(releaseMatch[2]);
        if (repoName === undefined || tag === undefined) {
          return malformedPath();
        }
        return getRelease(repoName, tag);
      }
      const releasesMatch = path.match(/^\/repos\/(.+)\/releases$/);
      if (releasesMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(releasesMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return listReleases(repoName);
      }
      if (releasesMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(releasesMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => createRelease(repoName, req, body));
      }
      // /repos/:name/views — list the branches, or create one.
      const viewsMatch = path.match(/^\/repos\/(.+)\/views$/);
      if (viewsMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(viewsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return listViews(repoName);
      }
      if (viewsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(viewsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => createView(repoName, req, body));
      }
      // /repos/:name/views/:view  and  /repos/:name/pull
      // Names can contain '/' (e.g. "acme/web"); split on the fixed suffixes.
      const viewMatch = path.match(/^\/repos\/(.+)\/views\/([^/]+)$/);
      if (viewMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(viewMatch[1]);
        const viewName = safeDecode(viewMatch[2]);
        if (repoName === undefined || viewName === undefined) {
          return malformedPath();
        }
        return getView(repoName, viewName);
      }
      const pullMatch = path.match(/^\/repos\/(.+)\/pull$/);
      if (pullMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(pullMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return pull(repoName, url.searchParams.get('view') ?? 'main');
      }
      const bootstrapHeadMatch = path.match(
        /^\/repos\/(.+)\/heads\/bootstrap$/
      );
      if (bootstrapHeadMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(bootstrapHeadMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => bootstrapHead(repoName, req, body));
      }
      // Timed public capabilities: owner schedules one for the current
      // ciphertext, or manually triggers a due reveal for one plaintext id.
      const pendingRevealsMatch = path.match(
        /^\/repos\/(.+)\/reveals\/pending$/
      );
      if (pendingRevealsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(pendingRevealsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => pendingReveals(repoName, req, body));
      }
      const revealMatch = path.match(/^\/repos\/(.+)\/reveals\/([^/]+)$/);
      if (revealMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(revealMatch[1]);
        const plaintextId = safeDecode(revealMatch[2]);
        if (repoName === undefined || plaintextId === undefined) {
          return malformedPath();
        }
        return withBody((body) => reveal(repoName, plaintextId, req, body));
      }
      const revealsMatch = path.match(/^\/repos\/(.+)\/reveals$/);
      if (revealsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(revealsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => scheduleReveal(repoName, req, body));
      }
      // push / land: POST /repos/:name/push and POST /repos/:name/land
      // Match before the generic catch-all; names can contain '/'.
      const pushMatch = path.match(/^\/repos\/(.+)\/push$/);
      if (pushMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(pushMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => push(repoName, req, body));
      }
      const landMatch = path.match(/^\/repos\/(.+)\/land$/);
      if (landMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(landMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => land(repoName, req, body));
      }
      // grants / revoke: GET+POST /repos/:name/grants and POST /repos/:name/revoke
      const grantsMatch = path.match(/^\/repos\/(.+)\/grants$/);
      if (grantsMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(grantsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => grant(repoName, req, body));
      }
      if (grantsMatch !== null && req.method === 'GET') {
        const repoName = safeDecode(grantsMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return listGrants(repoName);
      }
      const revokeMatch = path.match(/^\/repos\/(.+)\/revoke$/);
      if (revokeMatch !== null && req.method === 'POST') {
        const repoName = safeDecode(revokeMatch[1]);
        if (repoName === undefined) {
          return malformedPath();
        }
        return withBody((body) => revoke(repoName, req, body));
      }
      await cancelBody(req.body);
      return json(404, { error: 'not found' });
    },
  };
}
