# Deploying a Thaddeus server

`thaddeus serve` is normally an untrusted HTTP remote: it verifies signed
repository data and serves ciphertext without repository decryption keys. It is
a stateful, single-node process whose durable `FileBackend` must live on a
persistent volume. Production reputation signing is a separate AWS KMS role;
private signing key bytes never live on that volume.

Timed reveal is the deliberate content-key exception. It temporarily handles a
deliberately publishable content key using the world-known public identity seed,
so the selected host is trusted as embargo custodian until release.

> **Pre-alpha.** Run one server process against each backend. The durable rate
> limiter and replay protection serialize correctly within this supported
> single-server boundary; distributed coordination remains deferred.

## What it needs

- A container running the compiled `thaddeus` binary from the
  [Dockerfile](../Dockerfile).
- A persistent volume mounted at `/data` for the durable substrate only.
- One HTTP port. The deployment platform terminates TLS at its edge.
- For production attestation, an AWS KMS customer-managed Ed25519 signing key
  and short-lived workload identity authorized to use that exact key.

## Container configuration

| Variable                               | Default    | Meaning                                                |
| -------------------------------------- | ---------- | ------------------------------------------------------ |
| `PORT`                                 | `4000`     | listen port                                            |
| `THADDEUS_DATA`                        | `/data`    | durable substrate directory                            |
| `THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN` | —          | exact production KMS key ARN                           |
| `THADDEUS_ATTESTATION_RATE_LIMIT`      | `20`       | per-subject rolling-hour issuance cap (`0..20`)        |
| `THADDEUS_MIN_MERGES`                  | —          | gate land on unique trusted merge events per author    |
| `THADDEUS_TRUST_HOSTS`                 | —          | comma-separated exact foreign attester DID allowlist   |
| `THADDEUS_MAX_REQUEST_BODY_BYTES`      | `16777216` | inclusive request-body limit                           |
| `THADDEUS_REPLAY_NONCE_CAPACITY`       | `100000`   | maximum live durable replay nonces (maximum `1000000`) |
| `THADDEUS_REQUEST_SKEW_MS`             | `300000`   | accepted signed timestamp skew (maximum `300000`)      |

The entrypoint does not run `thaddeus init`, interpret `THADDEUS_HOST` or
`THADDEUS_HOME`, or create an identity beneath `/data`. The active KMS DID is
trusted automatically. Previous/foreign DIDs count only while explicitly listed
in `THADDEUS_TRUST_HOSTS`; there is no recursive web of trust.

## Run locally

A non-attesting container needs only its data volume:

```sh
docker build -t thaddeus .
docker run --rm -p 4000:4000 -v thaddeus_data:/data thaddeus
curl http://localhost:4000/repos
curl http://localhost:4000/metrics
```

For development-only local attestation, use the CLI outside the production
container. This loads the private seed from the normal CLI home and warns:

```sh
thaddeus init
thaddeus serve --host --data ./thaddeus-data --attestation-rate-limit 20
```

Never use `--host` as an automatic fallback when KMS is unavailable.

## Fly.io and AWS KMS

The checked-in [`fly.toml`](../fly.toml) targets the existing Amsterdam `ams`
deployment and `/data` volume. Its closest current AWS region is `eu-west-1`,
which is the required KMS region for this deployment.

### Provision the signing key

Create a customer-managed `ECC_NIST_EDWARDS25519` `SIGN_VERIFY` key in
`eu-west-1`, then point an alias at the returned exact key ARN:

```sh
aws kms create-key \
  --region eu-west-1 \
  --origin AWS_KMS \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_EDWARDS25519 \
  --description 'Thaddeus reputation attester v1'

aws kms create-alias \
  --region eu-west-1 \
  --alias-name alias/thaddeus-reputation-attester-v1 \
  --target-key-id '<exact-key-arn>'
```

Keep key administration, disablement, and deletion permissions in a separate
administrative role. The workload role needs only the following statements, with
the exact ARN substituted:

```json
[
  {
    "Effect": "Allow",
    "Action": ["kms:DescribeKey", "kms:GetPublicKey"],
    "Resource": "arn:aws:kms:eu-west-1:ACCOUNT:key/KEY_ID"
  },
  {
    "Effect": "Allow",
    "Action": "kms:Sign",
    "Resource": "arn:aws:kms:eu-west-1:ACCOUNT:key/KEY_ID",
    "Condition": {
      "StringEquals": {
        "kms:SigningAlgorithm": "ED25519_SHA_512"
      }
    }
  }
]
```

Create the Fly OIDC provider and an IAM workload role by following
[Fly workload identity](https://fly.io/docs/security/openid-connect/). Restrict
the trust policy claims to the exact Fly organization and the `thaddeus` app; do
not grant another app or organization access. Do not create long-lived AWS
access keys.

Configure the role and exact key ARN as deploy-specific secrets, then deploy:

```sh
fly secrets set \
  AWS_ROLE_ARN='arn:aws:iam::ACCOUNT:role/ROLE' \
  THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN='arn:aws:kms:eu-west-1:ACCOUNT:key/KEY_ID'

fly deploy
```

The AWS SDK consumes Fly's short-lived web-identity token. Startup calls
`DescribeKey` and `GetPublicKey`, validates the custody/usage/algorithm, derives
the host DID, and performs all of this before binding the HTTP port. Invalid
metadata, credentials, or initial KMS access therefore prevents startup.

Use `fly launch --copy-config --no-deploy` only when creating a new app. A bare
`fly launch` can replace the checked-in internal port with `8080`; this image
listens on `4000`. The existing deployment should retain one machine and the
existing `data` volume in `ams`.

### Cut over an existing volume-seed attester

1. Record the old DID from `/data/.home/.config/thaddeus/identity.json` without
   copying or logging the seed.
2. Preserve every existing foreign trust entry and add that old public DID to
   `THADDEUS_TRUST_HOSTS`.
3. Deploy the KMS configuration and record the startup-reported KMS DID.
4. Verify a delegated merge receives one new-host proof and that an imported
   old-host proof still counts. Multiple proofs for the same event must still
   count once.
5. Remove `/data/.home/.config/thaddeus/identity.json`, confirm a restart does
   not recreate it, and delete or expire volume snapshots/backups containing the
   old seed.
6. Retain only the old public DID in the trust list. Private-seed rollback is
   intentionally unavailable after cleanup.

## Reputation security model

Attestation trust is an exact DID allowlist. Valid unlisted proofs remain
auditable but cannot satisfy a gate. Trusted proofs are deduplicated by
`(subject, repo, kind, ref)`, so a new timestamp or a second trusted signature
does not multiply reputation. A repository owner cannot earn merge reputation
from operations authored into their own repository. Merge and release issuance
share a durable cap of 20 successful proofs per subject in the preceding hour.

This prevents straightforward replay and owner farming, not collusion by an
allowed host or the creation of Sybil identities. The current contribution proof
does not independently reconstruct historical repository ownership; consumers
trust allowed hosts to have enforced the policy when issuing proofs.

The KMS-backed process holds no private signing key bytes, but its short-lived
IAM authorization can request signatures and must be protected and monitored.
Ordinary content hosting holds no repository decryption keys. Development-only
`--host` does load a private signing seed. Timed reveal uses the world-known
public seed as described above.

## Rotation and recovery

AWS KMS asymmetric keys require
[manual rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys-manually.html):

1. Create and validate a new Ed25519 KMS key.
2. Ensure the outgoing DID is in the explicit trust list.
3. Temporarily grant the workload role access to both exact keys.
4. Change `THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN` and deploy.
5. Verify the new DID signs and that old/new proofs for one event count once.
6. Remove the old key's `Sign` permission, then disable or schedule deletion
   after the rollback window.
7. Keep the outgoing DID trusted for as long as its historical proofs should
   count.

If KMS is unreachable at startup, fix access or configure a replacement key;
never start an unidentified or volume-seed fallback attester. If KMS fails at
runtime, land and release remain available but responses and metrics report
`signer_unavailable`. Limiter storage failures likewise report
`limiter_unavailable` and issue no proof. Recover access to the existing key or
switch to a replacement while explicitly trusting the outgoing DID.

Alert on signer/limiter unavailability and unexpected KMS administrative
CloudTrail events. The metrics intentionally contain no subjects, repository
names, refs, signatures, credentials, or KMS ARNs.

See the AWS documentation for
[Ed25519 key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
the
[Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html),
and the
[KMS key-store model](https://docs.aws.amazon.com/kms/latest/developerguide/key-store-overview.html).

## Other platforms

Railway or a plain VPS can run a non-attesting server with `/data` persisted.
Production attestation additionally requires a short-lived AWS credential
provider capable of assuming the narrowly scoped KMS role; do not inject static
access keys. Put a TLS-terminating proxy such as Caddy in front of a VPS.

## Backups

Snapshot `/data` using the platform's volume tooling. It contains the durable
substrate, replay records, rate-limit reservations, and attestation outbox—not a
production signing key. During the legacy cutover, expire every backup that
still contains `/data/.home/.config/thaddeus/identity.json`.

An S3-compatible backend and distributed linearizable coordination remain
deferred. The current FileBackend guarantee is single-node and survives process
restart.
