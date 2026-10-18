// The glossary. Definitions follow CONTEXT.md and the package READMEs; keep
// them true to the shipped behaviour, not the direction. Order is the order a
// new user tends to meet the words, not alphabetical.

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export const glossary: readonly GlossaryEntry[] = [
  {
    term: 'operation',
    definition:
      'One signed change to one file, attributed to whoever signed it. A push carries several. Everything else here is built out of these.',
  },
  {
    term: 'upload',
    definition:
      'Sending operations to a server. Uploaded is not landed; nothing has been agreed to yet.',
  },
  {
    term: 'land',
    definition:
      'An operation becoming part of a shared view, after policy says yes and the owner signs. The verb we use where Git says merge.',
  },
  {
    term: 'merge',
    definition:
      'Not a thing here. Operations land or they do not, and policy decides which. See land.',
  },
  {
    term: 'shared view',
    definition:
      'A name such as main that points at a set of operation heads. It moves only when something lands, and every move is owner-signed.',
  },
  {
    term: 'workspace',
    definition:
      'Your own view over a repository: the base you started from plus your changes and nobody else’s. Copy-on-write, so opening one copies nothing.',
  },
  {
    term: 'policy',
    definition:
      'The rules a landing has to pass. Out of the box that is a conflict check. Owners can add protected paths, required checks, a required why, or a ban on deletes.',
  },
  {
    term: 'protected path',
    definition:
      'A path pattern nothing lands into unless the author is on its allow list. src/auth/** is the usual first one.',
  },
  {
    term: 'operation budget',
    definition:
      'A lifetime cap on how many operations a delegated identity can land in a repository. Uploads that never land do not count, and neither do refusals.',
  },
  {
    term: 'veto',
    definition:
      'A signed, standing no from an owner or a reviewer. While it stands the operation does not land, however good the why is.',
  },
  {
    term: 'reviewer',
    definition:
      'An identity the owner has allowed to veto within certain paths. That is the whole grant: no write access, no read access, no keys.',
  },
  {
    term: 'identity',
    definition:
      'A did:key you generate yourself and keep. It signs every write. There is no account behind it.',
  },
  {
    term: 'the signed why',
    definition:
      'A signed explanation attached to an operation: who, what they intended, and the reasoning. It is signed on its own, so someone other than the author can explain a change, and a record with a bad signature is kept and labelled unverified.',
  },
  {
    term: 'store',
    definition:
      'Where objects live, addressed by content hash and stored as ciphertext. Reading one needs a key sealed to your identity. The server keeps what it cannot read.',
  },
  {
    term: 'nightly',
    definition:
      'main, published every six hours if it changed, untested. The version string says so: 0.1.11-nightly.20261017.42. Alpha releases are cut on purpose.',
  },
  {
    term: 'thad',
    definition:
      'The short alias for the thaddeus command. Eight letters, many times a day, was too many.',
  },
  {
    term: 'lazythad',
    definition:
      'A terminal UI for all of the above, in Rust, named after lazygit. It holds no keys, so it browses the ciphertext mirror like everyone else.',
  },
];
