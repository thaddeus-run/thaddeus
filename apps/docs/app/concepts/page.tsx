import { Fragment, type ReactNode } from 'react';

// The concepts / vocabulary page: a static, end-user-facing glossary of the
// nouns Strata redefines, plus how they compose into one substrate. No crypto
// runs here — it is plain prose, so it stays a server component.

type Status = 'built' | 'in build' | 'coming';

type Term = {
  name: string; // Strata's word
  was: string; // the Git-world framing it replaces
  status: Status;
  where: string; // pillar + package, e.g. "Pillar 01 · store"
  body: ReactNode; // one plain-language paragraph
};

// The shipped + in-build vocabulary, in the order a reader meets it: who acts,
// what a value is, who may read it, when, then how change is recorded.
const TERMS: Term[] = [
  {
    name: 'Identity / Principal',
    was: 'an unverified user.name string',
    status: 'built',
    where: 'Pillar 01 · identity',
    body: (
      <>
        A principal is whoever acts on the code — and in Strata that is always a
        keypair that <em>signs</em>, never a display name you can type. Its
        public half, written as a <code>did:key</code>, <em>is</em> the name.
        The same kind of identity stands for a human or an agent, and every
        operation, capability, and signature traces back to one. Git trusts a{' '}
        <code>user.name</code> anyone can set; Strata trusts a signature only
        the holder of the key can produce.
      </>
    ),
  },
  {
    name: 'Object',
    was: 'a file blob in a tree',
    status: 'built',
    where: 'Pillar 01 · store',
    body: (
      <>
        An object is an encrypted, content-addressed snapshot of a value. It is
        named by the hash of its <em>ciphertext</em>, so an untrusted mirror can
        store and verify it without ever being able to read it. Where
        Git&rsquo;s blob is plaintext anyone with the repo can read, a Strata
        object is sealed at rest — the bytes and the permission to read them are
        two different things.
      </>
    ),
  },
  {
    name: 'Capability',
    was: 'clone the repo, hold every byte',
    status: 'built',
    where: 'Pillar 01 · store',
    body: (
      <>
        A capability is an object&rsquo;s content key, sealed to exactly one
        identity. It <em>is</em> permission: hold the capability and you can
        decrypt the object; don&rsquo;t and you can&rsquo;t, no matter how many
        copies of the ciphertext you have. Granting access wraps the key for
        someone new; revoking rotates the key and re-wraps it for everyone who
        is left. Permission lives on the secret, not on the repository.
      </>
    ),
  },
  {
    name: 'The Membrane',
    was: 'a public / private repo flag',
    status: 'built',
    where: 'Pillar 02 · store',
    body: (
      <>
        The membrane is visibility expressed as a policy over{' '}
        <em>object × identity × time</em>, instead of one switch on a whole
        repo. Because the bytes are encrypted, revealing something is not a flag
        flip — it is a <em>key-release</em>: at a chosen moment the content key
        re-wraps to a well-known public identity, and ciphertext that sat in the
        open the whole time becomes readable at once. This is what lets a
        security fix stay sealed until its disclosure deadline.
      </>
    ),
  },
  {
    name: 'Operation (Op)',
    was: 'a commit a human curates',
    status: 'in build',
    where: 'Pillar 03 · log',
    body: (
      <>
        An operation is a single signed change a principal makes — the unit that
        replaces the commit. It splits in two: cleartext metadata (which path,
        which parents, a logical clock, the author) that any peer can use to
        order and merge it, and a capability-gated payload only grantees can
        actually read. You never stage or curate it; recording history is a side
        effect of editing.
      </>
    ),
  },
  {
    name: 'Operation log',
    was: 'history is a chain of snapshots',
    status: 'in build',
    where: 'Pillar 03 · log',
    body: (
      <>
        The operation log is the source of truth: an append-only, signed history
        of operations. Snapshots of files still exist, but as a <em>derived</em>{' '}
        projection of the log — the inverse of Git, where the snapshot is the
        truth and history is a story told about snapshots. Because operations
        carry their own order, the log converges continuously instead of being
        merged in discrete events.
      </>
    ),
  },
  {
    name: 'View',
    was: 'a branch you check out into a working copy',
    status: 'in build',
    where: 'Pillar 03 · log',
    body: (
      <>
        A view is a named pointer over the converging graph — what a branch
        becomes once history is a log instead of a pile of files.{' '}
        <code>main</code> is just a view. Forking one copies a handful of
        head-ids, not the tree, so every agent can have its own for free.
        &ldquo;Merging&rdquo; is not a special event either: it is simply an
        operation whose parents join two heads.
      </>
    ),
  },
];

// Named but not yet built — specified in the architecture brief, ledgered as
// pending. Listed so the vocabulary is honest about what the substrate can and
// cannot yet demonstrate.
const COMING: { name: string; gloss: string; where: string }[] = [
  {
    name: 'Provenance',
    gloss: 'the signed why behind an operation — intent, prompt, reasoning',
    where: 'Pillar 04',
  },
  {
    name: 'Semantic graph',
    gloss: 'code addressed as symbols and types, not lines of text',
    where: 'Pillar 08',
  },
  {
    name: 'Agent principals',
    gloss:
      'agents as first-class signers with their own reputation and budgets',
    where: 'Pillar 09',
  },
  {
    name: 'Repository → view',
    gloss: 'the repo dissolves into a capability-scoped slice you never clone',
    where: 'Pillar 05',
  },
];

// One edit's path through every noun — reuses the home page's pipe primitive so
// the two pages read as one system.
type PipeNode = {
  title: string;
  detail?: string;
  tag?: 'cipher' | 'cap' | 'id';
};
const COMPOSE: PipeNode[] = [
  { title: 'write bytes' },
  { title: 'Object', detail: 'encrypted', tag: 'cipher' },
  { title: 'Operation', detail: 'signed', tag: 'id' },
  { title: 'Capability', detail: 'who holds the key', tag: 'cap' },
  { title: 'Membrane', detail: 'when it opens', tag: 'cipher' },
  { title: 'View', detail: 'names the head' },
];

// Where each noun lives. One package per npm release; together, the substrate.
const PACKAGES: { pkg: string; holds: string; tier: string }[] = [
  { pkg: '@thaddeus.run/identity', holds: 'principals', tier: 'Tier 0' },
  {
    pkg: '@thaddeus.run/store',
    holds: 'objects · capabilities · the membrane',
    tier: 'Tier 0–1',
  },
  {
    pkg: '@thaddeus.run/log',
    holds: 'operations · the log · views',
    tier: 'Tier 1',
  },
];

const STATUS_CLASS: Record<Status, string> = {
  built: 'cx-pill--built',
  'in build': 'cx-pill--inbuild',
  coming: 'cx-pill--coming',
};

export default function ConceptsPage(): ReactNode {
  return (
    <main className="pm-shell">
      <p className="pm-eyebrow">Strata · concepts &amp; vocabulary</p>
      <h1 className="pm-h1">
        New words, because the old ones name the wrong thing.
      </h1>
      <p className="pm-lede">
        Git&rsquo;s nouns — repository, commit, branch, clone — quietly assume
        one public pile of files, on a real disk, that one human reads. Strata
        rejects those assumptions, so the vocabulary changes with the model.
        Here is the language, defined for the people who have to use it, with
        each term marked for how real it is today.
      </p>

      <section className="cx-terms" aria-label="Vocabulary">
        {TERMS.map((t) => (
          <article className="cx-term" key={t.name}>
            <div className="cx-term__head">
              <h2 className="cx-term__name">{t.name}</h2>
              <span className={`cx-pill ${STATUS_CLASS[t.status]}`}>
                {t.status}
              </span>
              <span className="cx-term__where">{t.where}</span>
            </div>
            <p className="cx-term__was">
              <span className="cx-term__was-k">was</span> {t.was}
            </p>
            <p className="cx-term__body">{t.body}</p>
          </article>
        ))}
      </section>

      <section className="cx-coming" aria-label="Coming vocabulary">
        <h2 className="cx-coming__h">
          Named, not yet built
          <span className={`cx-pill ${STATUS_CLASS.coming}`}>coming</span>
        </h2>
        <p className="cx-coming__lede">
          These are specified in the architecture brief but not yet implemented.
          Strata ships one primitive at a time — and says so.
        </p>
        <ul className="cx-coming__list">
          {COMING.map((c) => (
            <li className="cx-coming__item" key={c.name}>
              <span className="cx-coming__name">{c.name}</span>
              <span className="cx-coming__gloss">{c.gloss}</span>
              <span className="cx-coming__where">{c.where}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="cx-structure" aria-label="How it composes">
        <h2 className="cx-structure__h">How it composes</h2>
        <p className="cx-structure__lede">
          These are not separate features bolted together — they are one
          substrate. Here is a single edit flowing through every noun:
        </p>
        <div className="pm-pipe cx-pipe">
          {COMPOSE.map((node, i) => (
            <Fragment key={node.title}>
              {i > 0 ? (
                <span className="pm-arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
              <div
                className={
                  node.tag !== undefined
                    ? `pm-node pm-node--${node.tag}`
                    : 'pm-node'
                }
              >
                <span className="pm-node__t">{node.title}</span>
                {node.detail !== undefined ? (
                  <span className="pm-node__d">{node.detail}</span>
                ) : null}
              </div>
            </Fragment>
          ))}
        </div>

        <p className="cx-structure__lede cx-structure__lede--map">
          And here is where each noun lives. Each package is one npm release;
          together they are the substrate.
        </p>
        <ul className="cx-map">
          {PACKAGES.map((p) => (
            <li className="cx-map__row" key={p.pkg}>
              <code className="cx-map__pkg">{p.pkg}</code>
              <span className="cx-map__holds">{p.holds}</span>
              <span className="cx-map__tier">{p.tier}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="pm-foot">
        This vocabulary is the architecture brief made concrete, one package at
        a time. Terms marked <b>built</b> run today in your browser on the{' '}
        <a href="/">permission-model page</a>; <b>in&nbsp;build</b> is specified
        and underway; <b>coming</b> is specified and ledgered. Strata earns each
        word by shipping the primitive behind it.
      </p>
    </main>
  );
}
