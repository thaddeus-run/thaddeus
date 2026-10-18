// The features grid. "shipped" means real and tested in the current release;
// "planned" follows the public build queue in docs/agent-first-architecture.md.

export type FeatureStatus = 'shipped' | 'planned';

export interface Feature {
  name: string;
  description: string;
  status: FeatureStatus;
}

export const features: readonly Feature[] = [
  {
    name: 'Copy-on-write workspaces',
    description: 'One shared object store, any number of isolated views.',
    status: 'shipped',
  },
  {
    name: 'Self-owned identity',
    description: 'A did:key signs every write. No accounts.',
    status: 'shipped',
  },
  {
    name: 'Signed operations',
    description: 'Nonce-bound, replay-rejected, attributable to an author.',
    status: 'shipped',
  },
  {
    name: 'The signed why',
    description:
      'A provenance claim on every operation. Ask why a line exists.',
    status: 'shipped',
  },
  {
    name: 'Scoped delegation',
    description: 'Protected paths and operation budgets per agent.',
    status: 'shipped',
  },
  {
    name: 'Reviewer veto',
    description: 'A standing veto that blocks landing until it is lifted.',
    status: 'shipped',
  },
  {
    name: 'Keyless server',
    description: 'Verifies signatures, serves ciphertext, holds no keys.',
    status: 'shipped',
  },
  {
    name: 'lazythad',
    description: 'A terminal UI for the whole flow, written in Rust.',
    status: 'shipped',
  },
  {
    name: 'Hosted remote workspaces',
    description: 'External agents connect to workspaces Thaddeus hosts.',
    status: 'planned',
  },
  {
    name: 'Semantic queries',
    description: 'Symbol identity, impact evidence, symbol-scoped authority.',
    status: 'planned',
  },
  {
    name: 'Git gateway',
    description: 'Import and export Git history.',
    status: 'planned',
  },
  {
    name: 'Checkpoint execution',
    description: 'Run checks against a checkpoint and keep the evidence.',
    status: 'planned',
  },
];
