import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Action,
  Authority,
  AuthorityError,
  type AuthorityErrorCode,
  type Authorization,
  type Grant,
  type IssueRequest,
  KeyCustody,
  LocalRootKey,
  type PolicyBody,
  type PrincipalKind,
  proveAction,
  proveChangePolicy,
  proveIssue,
  proveRevoke,
  type RevokeTarget,
} from '../src';

await ready();

export const START: number = Date.UTC(2026, 10, 6, 9, 0, 0);
export const MINUTE = 60_000;
export const HOUR: number = 60 * MINUTE;

// A test clock. Every authority in a test shares one, so time only moves when
// the test moves it.
export class Clock {
  #now: number;
  constructor(start: number = START) {
    this.#now = start;
  }
  now = (): number => this.#now;
  advance(ms: number): void {
    this.#now += ms;
  }
}

export type Durable = MemoryBackend | FileBackend;

export interface World {
  readonly clock: Clock;
  readonly service: Identity;
  readonly backend: Durable;
  readonly authority: Authority;
  readonly root: LocalRootKey;
  readonly rootBytes: Uint8Array;
  readonly custody: KeyCustody;
  // Opens a second authority (and custody) over the same backend, as a
  // restarted process would.
  reopen(backend?: Durable): Promise<World>;
}

export async function world(
  options: {
    backend?: Durable;
    clock?: Clock;
    service?: Identity;
    rootBytes?: Uint8Array;
  } = {}
): Promise<World> {
  const clock = options.clock ?? new Clock();
  const service = options.service ?? Identity.create();
  const backend = options.backend ?? new MemoryBackend();
  const rootBytes =
    options.rootBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const root = LocalRootKey.fromBytes(rootBytes);
  const authority = await Authority.open({
    backend,
    signer: service,
    now: clock.now,
  });
  const custody = new KeyCustody({ authority, backend, root });
  return {
    clock,
    service,
    backend,
    authority,
    root,
    rootBytes,
    custody,
    reopen: (next?: Durable) =>
      world({ backend: next ?? backend, clock, service, rootBytes }),
  };
}

/** A FileBackend in a fresh temporary directory, removed by `cleanup`. */
export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'thaddeus-authority-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function fileBackend(dir: string): FileBackend {
  return new FileBackend(dir);
}

export function member(
  who: Identity,
  kind: PrincipalKind,
  grants: Grant[]
): { subject: string; kind: PrincipalKind; grants: Grant[] } {
  return { subject: who.did, kind, grants };
}

export function policy(
  admins: Identity[],
  members: ReturnType<typeof member>[]
): PolicyBody {
  return { admins: admins.map((a) => a.did), members };
}

/** Issues a credential the way a member would: by signing the request. */
export async function issue(
  w: World,
  principal: Identity,
  request: Omit<IssueRequest, 'principal' | 'subject'> & { subject?: string }
): Promise<string> {
  const full: IssueRequest = {
    ...request,
    principal: principal.did,
    subject: request.subject ?? principal.did,
  };
  const { token } = await w.authority.issue(
    full,
    proveIssue(principal, full, { now: w.clock.now() })
  );
  return token;
}

/** One authorized use of a credential, signed by its holder. */
export function use(
  w: World,
  holder: Identity,
  token: string,
  action: Action
): Promise<Authorization> {
  return w.authority.authorize(
    token,
    action,
    proveAction(holder, token, action, { now: w.clock.now() })
  );
}

export function revoke(
  w: World,
  tenant: string,
  actor: Identity,
  target: RevokeTarget
): Promise<void> {
  const request = { tenant, actor: actor.did, target };
  return w.authority.revoke(
    request,
    proveRevoke(actor, request, { now: w.clock.now() })
  );
}

export function changePolicy(
  w: World,
  tenant: string,
  admin: Identity,
  expectedVersion: number,
  body: PolicyBody
): Promise<unknown> {
  const change = { tenant, admin: admin.did, expectedVersion, policy: body };
  return w.authority.changePolicy(
    change,
    proveChangePolicy(admin, change, { now: w.clock.now() })
  );
}

/** Asserts that `promise` rejects with an AuthorityError carrying `code`. */
export async function refused(
  promise: Promise<unknown> | (() => unknown),
  code: AuthorityErrorCode
): Promise<AuthorityError> {
  let caught: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AuthorityError);
  expect((caught as AuthorityError).code).toBe(code);
  return caught as AuthorityError;
}

export const bytes = (text: string): Uint8Array =>
  new TextEncoder().encode(text);
export const text = (data: Uint8Array): string =>
  new TextDecoder().decode(data);

export { Identity };
