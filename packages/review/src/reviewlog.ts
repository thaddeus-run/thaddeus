import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { type Backend, decodeRecord, encodeRecord } from '@thaddeus.run/store';

import {
  assertReviewLimits,
  DEFAULT_REVIEW_LIMITS,
  type ReviewerCapability,
  reviewerCapabilityId,
  ReviewError,
  type ReviewLimits,
  type ReviewRevocation,
  reviewScopeMatches,
  safeReviewPath,
  verifyReviewerCapability,
  verifyReviewRevocation,
  verifyVetoWithdrawal,
  type VetoWithdrawal,
} from './authority';
import { verifyVeto, type Veto, vetoId } from './veto';
export type ReviewEvent =
  | { kind: 'grant'; capability: ReviewerCapability }
  | { kind: 'revoke'; revocation: ReviewRevocation }
  | { kind: 'veto'; veto: Veto; receivedAt: number }
  | { kind: 'withdraw'; withdrawal: VetoWithdrawal };
export type ReviewStatus =
  | 'active'
  | 'revoked'
  | 'withdrawn'
  | 'unauthorized'
  | 'legacy'
  | 'unverified';
type Operation = { id: string; path: string };
const copy = <T>(value: T): T => structuredClone(value);
function fail(code: string, message: string): never {
  throw new ReviewError(code, message);
}
function eventId(event: ReviewEvent): string {
  return bytesToHex(blake3(encodeRecord(event)));
}
/** Finds the inclusive expiry boundary without rescanning a reviewer's history. */
function after(receipts: number[], cutoff: number): number {
  let low = 0;
  let high = receipts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (receipts[mid] <= cutoff) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Review authority grants no write, read, or decryption rights. Callers must
 * serialize mutations per repository, including separate instances of this log. */
export class ReviewLog {
  readonly #repo: string;
  readonly #owner: string;
  readonly #backend: Backend | undefined;
  readonly #events = new Map<string, ReviewEvent>();
  readonly #grants = new Map<string, ReviewerCapability>();
  readonly #revoked = new Set<string>();
  readonly #vetoes = new Map<string, Veto>();
  readonly #withdrawals = new Map<string, VetoWithdrawal[]>();
  readonly #receipts = new Map<string, number[]>();
  readonly #latestReceipt = new Map<string, number>();
  readonly #active = new Map<string, Set<string>>();
  constructor(repo: string, owner: string, backend?: Backend) {
    this.#repo = repo;
    this.#owner = owner;
    this.#backend = backend;
  }
  static async load(
    backend: Backend,
    repo: string,
    owner: string
  ): Promise<ReviewLog> {
    const log = new ReviewLog(repo, owner, backend);
    const events: ReviewEvent[] = [];
    for (const key of await backend.list('review/')) {
      const data = await backend.get(key);
      if (data === undefined) fail('corrupt', 'missing review event');
      let event: ReviewEvent;
      try {
        event = decodeRecord(data) as ReviewEvent;
      } catch {
        fail('corrupt', 'cannot decode review event');
      }
      let id: string;
      try {
        id = eventId(event);
      } catch {
        fail('corrupt', 'cannot encode review event');
      }
      if (key !== `review/${id}`)
        fail('corrupt', 'review content address mismatch');
      events.push(event);
    }
    const rank = { grant: 0, veto: 1, revoke: 2, withdraw: 3 };
    events.sort((a, b) => (rank[a.kind] ?? 99) - (rank[b.kind] ?? 99));
    for (const event of events) {
      log.#validate(event, true);
      log.#project(event);
    }
    return log;
  }
  async grant(capability: ReviewerCapability): Promise<void> {
    const event: ReviewEvent = copy({ kind: 'grant', capability });
    this.#validate(event);
    if (this.#revoked.has(reviewerCapabilityId(capability)))
      fail('revoked', 'review grant is revoked');
    await this.#commit(event);
  }
  async revoke(revocation: ReviewRevocation): Promise<void> {
    await this.import({ kind: 'revoke', revocation });
  }
  async withdraw(withdrawal: VetoWithdrawal): Promise<void> {
    const event: ReviewEvent = copy({ kind: 'withdraw', withdrawal });
    this.#validate(event);
    const target = this.#vetoes.get(withdrawal.veto);
    if (
      this.#withdrawals
        .get(withdrawal.veto)
        ?.some(
          (w) => w.actor === this.#owner || w.actor === target?.reviewer
        ) === true
    )
      return;
    await this.#commit(event);
  }
  async import(event: ReviewEvent): Promise<void> {
    const saved = copy(event);
    this.#validate(saved, true);
    await this.#commit(saved);
  }
  async submit(
    veto: Veto,
    signer: string,
    op: Operation,
    receivedAt: number,
    limits: ReviewLimits = DEFAULT_REVIEW_LIMITS
  ): Promise<boolean> {
    const v = copy(veto);
    assertReviewLimits(limits);
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0)
      fail('invalid', 'invalid receipt time');
    if (!verifyVeto(v)) fail('invalid_signature', 'invalid veto signature');
    if (signer !== v.reviewer)
      fail('signer_mismatch', 'request signer is not the reviewer');
    if (v.repo !== undefined && v.repo !== this.#repo)
      fail('wrong_repo', 'veto targets another repository');
    if (v.op !== op.id)
      fail('unknown_target', 'veto target does not match operation');
    if (!safeReviewPath(op.path))
      fail('out_of_scope', 'operation path is outside review authority');
    const ownerAuthority =
      v.reviewer === this.#owner &&
      (v.repo === undefined || v.grant === 'owner');
    if (!ownerAuthority) {
      const grant =
        v.grant === undefined ? undefined : this.#grants.get(v.grant);
      if (grant === undefined)
        fail('missing_review_authority', 'veto lacks review authority');
      if (grant.reviewer !== signer)
        fail('grant_mismatch', 'grant names another reviewer');
      if (this.#revoked.has(v.grant!))
        fail('revoked', 'review authority is revoked');
      if (!grant.paths.some((path) => reviewScopeMatches(path, op.path)))
        fail('out_of_scope', 'operation path is outside review authority');
    }
    if (this.status(v, op) === 'withdrawn')
      fail('withdrawn', 'veto was withdrawn');
    const id = vetoId(v);
    if (this.#vetoes.has(id)) return false;
    if (receivedAt < (this.#latestReceipt.get(signer) ?? 0))
      fail('clock_regressed', 'server clock precedes last accepted veto');
    const cap =
      v.grant === undefined || v.grant === 'owner'
        ? undefined
        : this.#grants.get(v.grant);
    const rate = Math.min(
      limits.maxVetoesPerHour,
      cap?.maxVetoesPerHour ?? Infinity
    );
    const active = Math.min(
      limits.maxActiveVetoes,
      cap?.maxActiveVetoes ?? Infinity
    );
    const receipts = this.#receipts.get(signer) ?? [];
    if (receipts.length - after(receipts, receivedAt - 3600000) >= rate)
      fail('rate_limit', 'reviewer hourly veto limit reached');
    if ((this.#active.get(signer)?.size ?? 0) >= active)
      fail('active_limit', 'reviewer active veto limit reached');
    await this.#commit({ kind: 'veto', veto: v, receivedAt });
    return true;
  }
  status(v: Veto, op: Operation): ReviewStatus {
    if (!verifyVeto(v)) return 'unverified';
    if (v.op !== op.id || !safeReviewPath(op.path)) return 'unauthorized';
    const legacy = v.repo === undefined;
    if (!legacy && v.repo !== this.#repo) return 'unauthorized';
    if (legacy && v.reviewer !== this.#owner) return 'legacy';
    const withdrawn = this.#withdrawals
      .get(vetoId(v))
      ?.some((w) => w.actor === this.#owner || w.actor === v.reviewer);
    if (withdrawn === true) return 'withdrawn';
    if (v.reviewer === this.#owner && (legacy || v.grant === 'owner'))
      return 'active';
    const cap = v.grant === undefined ? undefined : this.#grants.get(v.grant);
    if (
      cap === undefined ||
      cap.reviewer !== v.reviewer ||
      !cap.paths.some((p) => reviewScopeMatches(p, op.path))
    )
      return 'unauthorized';
    return this.#revoked.has(v.grant!) ? 'revoked' : 'active';
  }
  reviewers(): string[] {
    return [...new Set([this.#owner, ...this.grants().map((c) => c.reviewer)])];
  }
  grants(): ReviewerCapability[] {
    return [...this.#grants]
      .filter(([id]) => !this.#revoked.has(id))
      .map(([, c]) => copy(c));
  }
  vetoes(): Veto[] {
    return [...this.#vetoes.values()].map(copy);
  }
  *events(): IterableIterator<ReviewEvent> {
    for (const event of this.#events.values()) yield copy(event);
  }
  // Replay validates signed authority independently of current revocation status.
  // Old accepted vetoes remain available for revoked/withdrawn display.
  // Offline imports may arrive before their grants or targets. Such evidence
  // remains inert until status() can establish authority, including on reload.
  #validate(event: ReviewEvent, allowPending = false): void {
    if (event === null || typeof event !== 'object')
      fail('invalid', 'invalid review event');
    switch (event.kind) {
      case 'grant': {
        const c = event.capability;
        if (
          !verifyReviewerCapability(c) ||
          c.repo !== this.#repo ||
          c.issuer !== this.#owner
        )
          fail('unauthorized', 'invalid review grant');
        break;
      }
      case 'revoke': {
        const r = event.revocation;
        if (
          !verifyReviewRevocation(r) ||
          r.repo !== this.#repo ||
          r.actor !== this.#owner ||
          r.grant === 'owner'
        )
          fail('unauthorized', 'invalid review revocation');
        break;
      }
      case 'withdraw': {
        const w = event.withdrawal;
        if (!verifyVetoWithdrawal(w))
          fail('unauthorized', 'invalid veto withdrawal');
        const v = this.#vetoes.get(w.veto);
        if (
          w.repo !== this.#repo ||
          (!allowPending && v === undefined && w.actor !== this.#owner) ||
          (!allowPending &&
            v !== undefined &&
            w.actor !== this.#owner &&
            w.actor !== v.reviewer)
        )
          fail('unauthorized', 'invalid veto withdrawal');
        break;
      }
      case 'veto': {
        const v = event.veto;
        if (
          !verifyVeto(v) ||
          !Number.isSafeInteger(event.receivedAt) ||
          event.receivedAt < 0
        )
          fail('invalid', 'invalid review veto');
        if (
          v.reviewer === this.#owner &&
          (v.repo === undefined ||
            (v.repo === this.#repo && v.grant === 'owner'))
        )
          break;
        const cap =
          v.grant === undefined ? undefined : this.#grants.get(v.grant);
        if (
          v.repo !== this.#repo ||
          (cap === undefined && !allowPending) ||
          (!allowPending && cap !== undefined && cap.reviewer !== v.reviewer)
        )
          fail('unauthorized', 'invalid veto authority');
        break;
      }
      default:
        fail('corrupt', 'unknown review event');
    }
  }
  // Persist the event and trusted receipt together before changing projections.
  async #commit(event: ReviewEvent): Promise<void> {
    const id = eventId(event);
    if (
      this.#events.has(id) ||
      (event.kind === 'veto' && this.#vetoes.has(vetoId(event.veto)))
    )
      return;
    if (this.#backend !== undefined)
      await this.#backend.put(`review/${id}`, encodeRecord(event));
    this.#project(event);
  }
  #project(event: ReviewEvent): void {
    const id = eventId(event);
    if (this.#events.has(id)) return;
    this.#events.set(id, event);
    switch (event.kind) {
      case 'grant': {
        const cap = event.capability;
        const grant = reviewerCapabilityId(cap);
        this.#grants.set(grant, cap);
        if (!this.#revoked.has(grant))
          for (const [id, v] of this.#vetoes) {
            if (
              v.grant === grant &&
              v.reviewer === cap.reviewer &&
              this.#withdrawals
                .get(id)
                ?.some(
                  (w) => w.actor === this.#owner || w.actor === v.reviewer
                ) !== true
            ) {
              const active = this.#active.get(v.reviewer) ?? new Set<string>();
              active.add(id);
              this.#active.set(v.reviewer, active);
            }
          }
        break;
      }
      case 'revoke': {
        this.#revoked.add(event.revocation.grant);
        for (const [id, v] of this.#vetoes)
          if (v.grant === event.revocation.grant)
            this.#active.get(v.reviewer)?.delete(id);
        break;
      }
      case 'withdraw': {
        const w = event.withdrawal;
        const list = this.#withdrawals.get(w.veto) ?? [];
        list.push(w);
        this.#withdrawals.set(w.veto, list);
        const v = this.#vetoes.get(w.veto);
        if (
          v !== undefined &&
          (w.actor === this.#owner || w.actor === v.reviewer)
        )
          this.#active.get(v.reviewer)?.delete(w.veto);
        break;
      }
      case 'veto': {
        const v = event.veto;
        const id = vetoId(v);
        if (this.#vetoes.has(id)) break;
        this.#vetoes.set(id, v);
        // Prune only after a durable acceptance advances the receipt clock.
        // Reload can visit events out of order; the maximum keeps the same window.
        const latest = Math.max(
          this.#latestReceipt.get(v.reviewer) ?? 0,
          event.receivedAt
        );
        this.#latestReceipt.set(v.reviewer, latest);
        const previous = this.#receipts.get(v.reviewer) ?? [];
        const receipts = previous.slice(after(previous, latest - 3600000));
        if (event.receivedAt > latest - 3600000)
          receipts.splice(
            after(receipts, event.receivedAt),
            0,
            event.receivedAt
          );
        this.#receipts.set(v.reviewer, receipts);
        if (
          (v.reviewer === this.#owner ||
            this.#grants.get(v.grant ?? '')?.reviewer === v.reviewer) &&
          !this.#revoked.has(v.grant ?? '') &&
          this.#withdrawals
            .get(id)
            ?.some((w) => w.actor === this.#owner || w.actor === v.reviewer) !==
            true
        ) {
          const active = this.#active.get(v.reviewer) ?? new Set<string>();
          active.add(id);
          this.#active.set(v.reviewer, active);
        }
        break;
      }
    }
  }
}
