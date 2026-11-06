import { signDelegation } from '@thaddeus.run/agent';
import {
  Authority,
  type Authorization,
  type Grant,
  KeyCustody,
  LocalRootKey,
  proveAction,
  proveIssue,
  type Scope,
} from '@thaddeus.run/authority';
import { Client } from '@thaddeus.run/client';
import { Identity, ready } from '@thaddeus.run/identity';
import { FileBackend, MemoryBackend } from '@thaddeus.run/persist';
import type { Repo } from '@thaddeus.run/platform';
import { createServer } from '@thaddeus.run/server';
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MigrationError,
  type MigrationErrorCode,
  Migrator,
  Source,
} from '../src';

await ready();

export const bytes = (text: string): Uint8Array =>
  new TextEncoder().encode(text);
export const text = (data: Uint8Array): string =>
  new TextDecoder().decode(data);

// A clock the trusted service reads, so tests can expire a consent.
export class Clock {
  #now: number = Date.now();
  now = (): number => this.#now;
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** A keyless server in this process, reached through `fetch`. */
export interface Keyless {
  readonly url: string;
  readonly fetch: (req: Request) => Promise<Response>;
}

export function keyless(url = 'http://keyless.test'): Keyless {
  const server = createServer({ backend: new MemoryBackend() });
  return { url, fetch: server.fetch.bind(server) };
}

/** One identity's view of a source repository: its client and a clone. */
export class Author {
  readonly identity: Identity;
  readonly client: Client;
  readonly name: string;
  repo: Repo;
  #work = 0;

  constructor(identity: Identity, client: Client, name: string, repo: Repo) {
    this.identity = identity;
    this.client = client;
    this.name = name;
    this.repo = repo;
  }

  static async create(
    server: Keyless,
    owner: Identity,
    name: string
  ): Promise<Author> {
    const client = new Client(server.url, owner, server.fetch);
    await client.createRepo(name);
    const { repo } = await client.clone(name, new MemoryBackend());
    return new Author(owner, client, name, repo);
  }

  static async join(
    server: Keyless,
    who: Identity,
    name: string
  ): Promise<Author> {
    const client = new Client(server.url, who, server.fetch);
    const { repo } = await client.clone(name, new MemoryBackend());
    return new Author(who, client, name, repo);
  }

  /**
   * Commits `files` (null deletes) on a fresh view forked from `base` and
   * uploads them. `shareWith` also gets a capability for each new file, as
   * the CLI does for the owner when a delegate pushes.
   */
  async commit(
    files: Record<string, string | null>,
    options: { base?: string; shareWith?: Identity } = {}
  ): Promise<string[]> {
    const view = `work/${this.#work++}`;
    this.repo.log.fork(view, options.base ?? 'main');
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        await this.repo.log.remove(view, path, this.identity);
        continue;
      }
      const op = await this.repo.log.write(
        view,
        path,
        bytes(content),
        this.identity
      );
      if (options.shareWith !== undefined && op.payload !== null) {
        await this.repo.store.grant(
          op.payload,
          options.shareWith.toPublic(),
          this.identity
        );
      }
    }
    const heads = [...this.repo.log.heads(view)];
    await this.client.push(this.name, this.repo, heads);
    return heads;
  }

  /** Lands heads onto a shared view; only the owner can sign that. */
  async land(heads: readonly string[], into = 'main'): Promise<void> {
    const outcome = await this.client.land(this.name, this.repo, heads, into);
    expect(outcome.landed).toBe(true);
  }

  async publish(
    files: Record<string, string | null>,
    into = 'main'
  ): Promise<string[]> {
    const heads = await this.commit(files, { base: into });
    await this.land(heads, into);
    await this.client.pull(this.name, this.repo, new MemoryBackend(), into);
    return heads;
  }

  async grant(who: Identity): Promise<void> {
    await this.client.grant(
      this.name,
      signDelegation(
        { agent: who.did, paths: ['**'], maxChanges: 100, maxSpend: 100 },
        this.identity
      )
    );
  }
}

/** The trusted service: authority, key custody and migrator over one backend. */
export interface Service {
  readonly clock: Clock;
  readonly identity: Identity;
  readonly backend: MemoryBackend | FileBackend;
  readonly rootBytes: Uint8Array;
  readonly authority: Authority;
  readonly custody: KeyCustody;
  readonly migrator: Migrator;
  reopen(): Promise<Service>;
}

export async function service(
  options: {
    backend?: MemoryBackend | FileBackend;
    clock?: Clock;
    identity?: Identity;
    rootBytes?: Uint8Array;
  } = {}
): Promise<Service> {
  const clock = options.clock ?? new Clock();
  const identity = options.identity ?? Identity.create();
  const backend = options.backend ?? new MemoryBackend();
  const rootBytes =
    options.rootBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const authority = await Authority.open({
    backend,
    signer: identity,
    now: clock.now,
  });
  const custody = new KeyCustody({
    authority,
    backend,
    root: LocalRootKey.fromBytes(rootBytes),
  });
  const migrator = new Migrator({
    authority,
    custody,
    backend,
    now: clock.now,
  });
  return {
    clock,
    identity,
    backend,
    rootBytes,
    authority,
    custody,
    migrator,
    reopen: () => service({ backend, clock, identity, rootBytes }),
  };
}

export const ALL: Scope[] = ['read', 'edit', 'integrate'];

/** Creates a tenant whose members get every migration scope on `repos`. */
export async function tenant(
  s: Service,
  name: string,
  members: { who: Identity; repos: string[]; scopes?: Scope[] }[]
): Promise<void> {
  await s.authority.createTenant(name, {
    admins: [Identity.create().did],
    members: members.map(({ who, repos, scopes }) => ({
      subject: who.did,
      kind: 'human' as const,
      grants: repos.map(
        (repo): Grant => ({ repo, scopes: scopes ?? ALL, paths: ['**'] })
      ),
    })),
  });
}

export interface Steps {
  readonly edit: Authorization;
  readonly read: Authorization;
  readonly integrate: Authorization;
}

/** A human session for `who` and one authorization per migration scope. */
export async function steps(
  s: Service,
  who: Identity,
  tenantName: string,
  repo: string,
  scopes: Scope[] = ALL
): Promise<Steps> {
  const request = {
    service: s.authority.did,
    tenant: tenantName,
    principal: who.did,
    subject: who.did,
    kind: 'human' as const,
    grants: [{ repo, scopes, paths: ['**'] }],
  };
  const { token } = await s.authority.issue(
    request,
    proveIssue(who, request, { now: s.clock.now() })
  );
  const use = (scope: Scope) => {
    const action = { scope, tenant: tenantName, repo, paths: ['**'] };
    return s.authority.authorize(
      token,
      action,
      proveAction(who, token, action, { now: s.clock.now() })
    );
  };
  return {
    edit: await use('edit'),
    read: await use('read'),
    integrate: await use('integrate'),
  };
}

/** Reads `author`'s repository as its owner's client would for migration. */
export function readSource(
  server: Keyless,
  owner: Identity,
  name: string
): Promise<Source> {
  return Source.read(new Client(server.url, owner, server.fetch), name, {
    server: server.url,
  });
}

/** Asserts that `promise` rejects with a MigrationError carrying `code`. */
export async function refused(
  promise: Promise<unknown> | (() => unknown),
  code: MigrationErrorCode
): Promise<MigrationError> {
  let caught: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationError);
  expect((caught as MigrationError).code).toBe(code);
  return caught as MigrationError;
}

/** A FileBackend directory, removed by `cleanup`. */
export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'thaddeus-migrate-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every byte the service has stored, for scanning. */
export async function storedBytes(
  backend: MemoryBackend | FileBackend
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const key of await backend.list('')) {
    const value = await backend.get(key);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** True when `needle` occurs in any of `haystack`, raw or as hex or base64. */
export function contains(
  haystack: readonly Uint8Array[],
  needle: Uint8Array
): boolean {
  const forms = [
    Buffer.from(needle),
    Buffer.from(Buffer.from(needle).toString('hex')),
    Buffer.from(Buffer.from(needle).toString('base64')),
    Buffer.from(Buffer.from(needle).toString('base64url')),
  ];
  return haystack.some((bytesIn) => {
    const hay = Buffer.from(bytesIn);
    return forms.some((form) => hay.includes(form));
  });
}
