// A loop of plausible operations for the live ledger. Each entry is one signed
// operation with its signed why and the landing decision it ended up with.

export type LedgerState = 'landed' | 'refused' | 'vetoed';

export interface LedgerOp {
  who: string;
  op: string;
  why: string;
  state: LedgerState;
  note?: string;
}

export const ledgerOps: readonly LedgerOp[] = [
  {
    who: 'agent:refactor-07',
    op: 'edit src/auth/session.ts',
    why: 'split session refresh out of login',
    state: 'landed',
  },
  {
    who: 'agent:docs-02',
    op: 'edit docs/getting-started.md',
    why: 'document the nightly channel',
    state: 'landed',
  },
  {
    who: 'agent:refactor-07',
    op: 'edit src/auth/secret.ts',
    why: 'rotate the auth secret',
    state: 'refused',
    note: 'protected path src/auth/**',
  },
  {
    who: 'agent:perf-11',
    op: 'edit packages/store/src/index.ts',
    why: 'batch object writes per snapshot',
    state: 'landed',
  },
  {
    who: 'agent:perf-11',
    op: 'delete packages/store/src/legacy.ts',
    why: 'remove the unbatched write path',
    state: 'vetoed',
    note: 'reviewer z6Mkp…R2a',
  },
  {
    who: 'moritz',
    op: 'land op_8f2a op_91c0 op_a3e1',
    why: 'owner-signed landing',
    state: 'landed',
  },
  {
    who: 'agent:test-04',
    op: 'add integration/test/budget.test.ts',
    why: 'cover budget exhaustion on the second repo',
    state: 'landed',
  },
  {
    who: 'agent:test-04',
    op: 'edit integration/test/budget.test.ts',
    why: 'tighten the deadline assertion',
    state: 'refused',
    note: 'operation budget exhausted 2/2',
  },
];
