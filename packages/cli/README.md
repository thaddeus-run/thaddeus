# @thaddeus.run/cli

The **Thaddeus** CLI — `thaddeus` (alias `thad`).

```sh
thaddeus serve --data ./srv-data &       # run a server
thaddeus init                            # create a self-owned identity
thaddeus create http://localhost:4000 me/notes
thaddeus clone http://localhost:4000 me/notes ~/notes
cd ~/notes && echo "# notes" > readme.md && thaddeus push
```

A git-like client over the untrusted remote: edit files on disk, then upload and
owner-sign shared updates. Pulls verify complete signed head history and exact
operation closure before moving a working view. Repository content crypto is
client-side; your identity seed lives in `~/.config/thaddeus/`. An optional
server reputation attester is a separate host-security role described below.

## Commands

| Command                                                                  | Description                            |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `init`                                                                   | Create a self-owned `did:key` identity |
| `create <server> <repo>`                                                 | Create a repo on a server              |
| `clone <server> <repo> [dir] [--owner DID]`                              | Clone and pin a signed head chain      |
| `pull [--bootstrap-head]`                                                | Verify and fetch signed remote changes |
| `status`                                                                 | Show working-tree changes              |
| `push [--no-land]`                                                       | Commit/upload; owner-sign the landing  |
| `land`                                                                   | Owner-land uploaded commits            |
| `grant <did> [--paths a,b] [--max-changes N] [--max-changes-per-hour N]` | Grant push rights to a DID/agent       |
| `revoke <did>`                                                           | Revoke a previously granted delegation |
| `grants`                                                                 | List active grants for this repo       |
| `policy [set\|clear]`                                                    | Show or select repo land policy        |
| `query <kind> ...`                                                       | Query history and the semantic graph   |
| `watch [symbol] [--kind <event>]...`                                     | Stream remote semantic changes         |
| `schedule-reveal <path> --at <ISO>`                                      | Make committed content public later    |
| `reveal <path>`                                                          | Trigger a due public reveal            |
| `reputation <did>`                                                       | Show trusted/untrusted reputation      |
| `reputation export <did> [--output path]`                                | Export a public reputation archive     |
| `reputation import <path\|->` / `import --from URL`                      | Import or directly copy your archive   |
| `serve [--port 4000] [--data DIR] [--attestation-aws-kms-key-arn ARN]`   | Run a durable server                   |

## Signed remote heads

`create` signs an empty `main` genesis. `clone` verifies the complete signed
chain and pins its owner; use `--owner did:key:...` when you have an owner DID
through another trusted channel. Without it, the first valid owner is trusted on
first use. Every later pull rejects an owner change, rollback, conflicting
history, broken link, or a bundle that omits or injects operations.

Unsigned legacy views fail closed. Their owner can migrate a clean, not-ahead
working copy with `thaddeus pull --bootstrap-head`; it signs the copy's saved
base, never the server's raw view pointer or unpublished local heads.

## Server request limits

`thaddeus serve` accepts request bodies through 16 MiB by default. Override the
inclusive limit with `--max-request-body-bytes N`; values must be positive
integers no greater than `Number.MAX_SAFE_INTEGER - 1`. Invalid values stop
startup before the listening socket opens. The container entrypoint exposes the
same setting as `THADDEUS_MAX_REQUEST_BODY_BYTES`.

Durable replay protection retains up to 100,000 live signed-request nonces by
default. `--replay-nonce-capacity N` accepts positive decimal integers through
1,000,000. `--request-skew-ms N` narrows timestamp acceptance from the
300,000-ms default/protocol ceiling down to 1 ms. The container equivalents are
`THADDEUS_REPLAY_NONCE_CAPACITY` and `THADDEUS_REQUEST_SKEW_MS`. Invalid,
fractional, signed, whitespace-padded, notation, unsafe, zero, or over-limit
values stop startup before a listener opens.

## Reputation attestation

Production servers attest with an exact AWS KMS key ARN:

```sh
thaddeus serve --data ./srv-data \
  --attestation-aws-kms-key-arn arn:aws:kms:eu-west-1:123456789012:key/... \
  --attestation-rate-limit 20 \
  --trust-host did:key:z6Mk...
```

Startup validates that the ARN names an enabled, AWS-origin, customer-managed
Ed25519 `SIGN_VERIFY` key before opening the HTTP port. The default credential
chain supports short-lived Fly/AWS workload identity. The process receives no
private signing key bytes, although its IAM authorization to request signatures
is security-sensitive. `serve --host` instead loads the local identity seed and
is retained only for development; it is mutually exclusive with KMS and prints a
warning.

`--trust-host` is an exact, repeatable DID allowlist, not a web of trust. The
active attester is added automatically. All valid proofs remain visible, but
gates count one event per `(subject, repo, kind, ref)`, regardless of timestamp
or how many trusted hosts signed it. Hosts do not attest owner-authored merges
into the owner's repository. Merge and release issuance shares a durable
per-subject rolling-hour cap of 20; `--attestation-rate-limit 0` disables
issuance and values above 20 are rejected. These controls do not eliminate
colluding allowed hosts or Sybil identities, and the current proof cannot
reconstruct historical repository ownership independently.

Ordinary hosting still has no repository decryption keys. Timed reveal is a
deliberate exception: the server temporarily handles a deliberately publishable
content key through the world-known public identity seed.

## Query the committed branch

```sh
thaddeus query why <op>                          # signed provenance
thaddeus query touched-since 2026-07-01          # time-window history
thaddeus query by did:key:z6Mk... --since 2026-07-01
thaddeus query callers refreshToken              # live semantic callers
thaddeus query references refreshToken           # live use sites
```

All query forms accept `--json`. They run locally over the current committed
branch, include only code your identity can decrypt, and never pull, commit, or
include dirty disk edits. `thaddeus why <op>` remains a compatibility alias.

## Watch remote semantic changes

```sh
thaddeus watch [symbol] [--kind <event>]... [--interval <duration>] [--json]
```

`watch` polls this working copy's remote branch. Its initial pull establishes a
silent baseline; later events are one line each in text mode or one
`SemanticEvent` per line in JSON mode (JSONL). Repeat `--kind` to select
`defined`, `removed`, `renamed`, `moved`, or `references-changed`. The optional
symbol may be a current name, stable id, or unique id prefix, and continues to
follow that stable id through signed remote renames. The interval defaults to
`2s` and accepts `ms`, `s`, or `m` durations of at least `100ms`.

The watcher pulls public ciphertext through the existing atomic pull route into
an isolated in-memory mirror. It derives semantic events locally, bounded by the
content your identity can decrypt, and never updates or cleans checked-out files
or the durable working-copy store. Run `thaddeus pull` explicitly when you want
to update the working tree. Transient polling errors are reported and retried;
Ctrl-C exits cleanly.

## Timed public content

```sh
thaddeus schedule-reveal announcement.md --at 2030-01-01T00:00:00Z
thaddeus reveal announcement.md # optional manual trigger; cannot release early
```

The owner creates a future-dated public capability locally; the server stores it
outside ordinary pulls and promotes it automatically when due. A fresh clone can
then read the content without a grant. Because the public identity is
well-known, this opts into trusting the selected host as embargo custodian for
the scheduled file; the current membrane is store-honest, not trustless. These
commands reveal committed file content—the path and operation metadata are
already visible on the ciphertext mirror—and ignore dirty disk edits.

## Collaboration example

```sh
# Owner: grant a teammate scoped push rights on src/**
thaddeus grant did:key:z6Mk… --paths 'src/**'

# Teammate: clone, edit, and upload signed operations
thaddeus clone http://localhost:4000 proj ~/proj
cd ~/proj && mkdir -p src && echo "fn main() {}" > src/main.rs && thaddeus push
#   owner signature required to publish; uploaded head IDs: 8c4d…

# The owner reviews the uploaded heads and signs the landing. Delegation scope,
# budget, conflict, provenance, veto, and reputation policy run at that landing.
# A delegate cannot create a shared branch or land independently.

# An upload outside the grant is accepted as content but cannot pass owner land:
echo "oops" > README.md && thaddeus push
#   owner signature required to publish; uploaded head IDs: 1ae2…

# Owner: revoke to cut off further pushes
thaddeus revoke did:key:z6Mk…
```

> **Status: spike.** Online, full-set sync (see the CLI design spec).
