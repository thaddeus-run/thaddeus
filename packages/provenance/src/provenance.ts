import { Identity, PublicIdentity } from '@thaddeus.run/identity';
import type { Ref } from '@thaddeus.run/store';

// A signed "why" attached to an Op.id (P03). The op is referenced by id, never
// embedded — P03 deliberately left no intent field on Op. Every semantic field
// is covered by `sig`, so nothing on the record is malleable on relay.
export interface Provenance {
  readonly op: string;
  readonly actor: string;
  readonly actor_kind: string;
  readonly intent: string;
  readonly reasoning: string;
  readonly task: string | null;
  readonly prompt_ref: string | null;
  readonly prompt: Ref | null;
  readonly sig: Uint8Array;
}

// The signable fields, before `actor`/`sig` are computed.
export interface ProvenanceFields {
  readonly op: string;
  readonly actor_kind: string;
  readonly intent: string;
  readonly reasoning: string;
  readonly task: string | null;
  readonly prompt_ref: string | null;
  readonly prompt: Ref | null;
}

// Domain tag prefixed into the signed tuple so a provenance signature can never
// be confused with an op signature (thaddeus.log.op.v1) or another protocol's
// payload that happens to serialize the same.
const PROVENANCE_DOMAIN = 'thaddeus.provenance.v1';

// Reject non-canonical field values before they are signed. Mirrors op.ts's
// assertCanonical: a required field that is empty or the wrong type throws, so
// verifyProvenance (try/catch) rejects such records and signProvenance fails
// fast on bad input.
function assertCanonical(fields: ProvenanceFields, actor: string): void {
  const required: [string, unknown][] = [
    ['op', fields.op],
    ['actor', actor],
    ['actor_kind', fields.actor_kind],
    ['intent', fields.intent],
    ['reasoning', fields.reasoning],
  ];
  for (const [name, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`provenance.${name} must be a non-empty string`);
    }
  }
  if (
    fields.task !== null &&
    (typeof fields.task !== 'string' || fields.task.length === 0)
  ) {
    throw new TypeError('provenance.task must be a non-empty string or null');
  }
  if (
    fields.prompt_ref !== null &&
    (typeof fields.prompt_ref !== 'string' || fields.prompt_ref.length === 0)
  ) {
    throw new TypeError(
      'provenance.prompt_ref must be a non-empty string or null'
    );
  }
  if (
    fields.prompt !== null &&
    (typeof fields.prompt.id !== 'string' ||
      typeof fields.prompt.plaintext_id !== 'string')
  ) {
    throw new TypeError(
      'provenance.prompt must have string id and plaintext_id'
    );
  }
}

// Deterministic bytes for the signature. `prompt` encodes as its Ref pair or
// null — the same convention Op.payload uses.
export function canonicalProvenance(
  fields: ProvenanceFields,
  actor: string
): Uint8Array {
  assertCanonical(fields, actor);
  const prompt =
    fields.prompt === null
      ? null
      : [fields.prompt.id, fields.prompt.plaintext_id];
  return new TextEncoder().encode(
    JSON.stringify([
      PROVENANCE_DOMAIN,
      fields.op,
      actor,
      fields.actor_kind,
      fields.intent,
      fields.reasoning,
      fields.task,
      fields.prompt_ref,
      prompt,
    ])
  );
}

// Build the full signed record. sig = actor over the canonical bytes covering
// every field, so no field is malleable.
export function signProvenance(
  fields: ProvenanceFields,
  actor: Identity
): Provenance {
  const bytes = canonicalProvenance(fields, actor.did);
  return {
    op: fields.op,
    actor: actor.did,
    actor_kind: fields.actor_kind,
    intent: fields.intent,
    reasoning: fields.reasoning,
    task: fields.task,
    prompt_ref: fields.prompt_ref,
    prompt: fields.prompt,
    sig: actor.sign(bytes),
  };
}

// Valid iff the signature verifies under the actor's did:key over the canonical
// bytes. Fails closed: any mismatch OR malformed input (an undecodable did:key,
// a wrong-length sig, a non-canonical field) returns false rather than throwing.
export function verifyProvenance(p: Provenance): boolean {
  try {
    const bytes = canonicalProvenance(p, p.actor);
    return PublicIdentity.fromDid(p.actor).verify(bytes, p.sig);
  } catch {
    return false;
  }
}
