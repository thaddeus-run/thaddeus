import { Identity, ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  canonicalProvenance,
  signProvenance,
  verifyProvenance,
} from '../src/provenance';

beforeAll(async () => {
  await ready();
});

const fields = (op: string) => ({
  op,
  actor_kind: 'agent:claude-code@1.2',
  intent: 'fix race in token refresh',
  reasoning: 'refresh() re-entered before lock; added a mutex',
  task: 'STRATA-417' as string | null,
  prompt_ref: null,
  prompt: null,
});

describe('Provenance record', () => {
  test('signProvenance produces a verifiable record bound to the op + actor', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(p.op).toBe('opid');
    expect(p.actor).toBe(actor.did);
    expect(p.actor_kind).toBe('agent:claude-code@1.2');
    expect(verifyProvenance(p)).toBe(true);
  });

  test('tampering with ANY signed field breaks verification', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(verifyProvenance({ ...p, op: 'other' })).toBe(false);
    expect(verifyProvenance({ ...p, actor_kind: 'human' })).toBe(false);
    expect(verifyProvenance({ ...p, intent: 'lie' })).toBe(false);
    expect(verifyProvenance({ ...p, reasoning: 'lie' })).toBe(false);
    expect(verifyProvenance({ ...p, task: 'STRATA-000' })).toBe(false);
    expect(verifyProvenance({ ...p, prompt_ref: 'deadbeef' })).toBe(false);
    // The prompt Ref is in the signed tuple too: swapping null → a Ref breaks it.
    expect(
      verifyProvenance({ ...p, prompt: { id: 'x', plaintext_id: 'y' } })
    ).toBe(false);
  });

  test('verifyProvenance returns false (never throws) on malformed input', () => {
    const actor = Identity.create();
    const p = signProvenance(fields('opid'), actor);
    expect(verifyProvenance({ ...p, actor: 'did:key:not-a-real-key' })).toBe(
      false
    );
    expect(verifyProvenance({ ...p, sig: new Uint8Array([1, 2, 3]) })).toBe(
      false
    );
  });

  test('an absent task/prompt (null) still verifies', () => {
    const actor = Identity.create();
    const p = signProvenance({ ...fields('opid'), task: null }, actor);
    expect(p.task).toBeNull();
    expect(verifyProvenance(p)).toBe(true);
  });

  test('canonical bytes are domain-tagged (cross-protocol separation)', () => {
    // The domain tag is the first element of the signed tuple, so a provenance
    // signature can never be confused with an op signature (thaddeus.log.op.v1)
    // or another protocol's payload. (Acceptance 10.)
    const bytes = canonicalProvenance(fields('opid'), 'did:key:zActor');
    expect(new TextDecoder().decode(bytes)).toContain('thaddeus.provenance.v1');
    expect(new TextDecoder().decode(bytes)).not.toContain('thaddeus.log.op.v1');
  });
});
