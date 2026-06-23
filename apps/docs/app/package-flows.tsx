import { Fragment, type ReactNode } from 'react';

type Tag = 'key' | 'cipher' | 'cap' | 'id';
type FlowNode = { title: string; detail?: string; tag?: Tag };
type Op = { label: string; nodes: FlowNode[] };
type Flow = { pkg: string; blurb: string; ops: Op[] };

const FLOWS: Flow[] = [
  {
    pkg: '@thaddeus.run/identity',
    blurb:
      'One keypair per identity — its public half, written out, is the name.',
    ops: [
      {
        label: 'create()',
        nodes: [
          { title: 'random seed' },
          { title: 'ed25519 keypair', detail: 'signing', tag: 'key' },
          { title: 'x25519 keypair', detail: 'derived · sealing', tag: 'key' },
          { title: 'did:key', detail: 'z6Mk… · public name', tag: 'id' },
        ],
      },
      {
        label: 'sign / verify',
        nodes: [
          { title: 'message' },
          { title: 'sign()', detail: 'ed25519 private' },
          { title: 'signature', tag: 'cap' },
          { title: 'verify()', detail: 'anyone, from the did:key' },
          { title: '✓ / ✗' },
        ],
      },
      {
        label: 'seal / unseal',
        nodes: [
          { title: 'secret' },
          { title: 'seal()', detail: 'to a did:key (x25519 pub)' },
          { title: 'sealed box', detail: 'anonymous', tag: 'cipher' },
          { title: 'unseal()', detail: 'x25519 private' },
          { title: 'secret' },
        ],
      },
    ],
  },
  {
    pkg: '@thaddeus.run/store',
    blurb:
      'A value is ciphertext at rest; access is a key sealed to an identity.',
    ops: [
      {
        label: 'put()',
        nodes: [
          { title: 'value' },
          { title: 'content key', detail: 'random', tag: 'key' },
          { title: 'encrypt', detail: 'xchacha20poly1305' },
          {
            title: 'Object',
            detail: 'ciphertext · id = blake3(ct)',
            tag: 'cipher',
          },
          { title: 'Capability', detail: 'key sealed to owner', tag: 'cap' },
        ],
      },
      {
        label: 'get()',
        nodes: [
          { title: 'reader' },
          { title: 'find capability', detail: 'signature ✓ · not-before' },
          { title: 'unseal key', tag: 'key' },
          { title: 'decrypt' },
          { title: 'plaintext' },
        ],
      },
      {
        label: 'grant()',
        nodes: [
          { title: "granter's capability", tag: 'cap' },
          { title: 'unseal key', tag: 'key' },
          { title: 're-seal to grantee' },
          { title: 'new Capability', tag: 'cap' },
        ],
      },
      {
        label: 'revoke()  =  key rotation',
        nodes: [
          { title: 'unwrap old key', tag: 'key' },
          { title: 'decrypt' },
          { title: 'mint NEW key', tag: 'key' },
          {
            title: 're-encrypt',
            detail: 'new id · same plaintext_id',
            tag: 'cipher',
          },
          {
            title: 're-issue caps',
            detail: 'everyone except the revoked',
            tag: 'cap',
          },
        ],
      },
    ],
  },
];

const TAGS: { tag: Tag; label: string }[] = [
  { tag: 'key', label: 'key' },
  { tag: 'cipher', label: 'ciphertext' },
  { tag: 'cap', label: 'capability' },
  { tag: 'id', label: 'identity' },
];

function NodeBox({ node }: { node: FlowNode }): ReactNode {
  const cls =
    node.tag !== undefined ? `pm-node pm-node--${node.tag}` : 'pm-node';
  return (
    <div className={cls}>
      <span className="pm-node__t">{node.title}</span>
      {node.detail !== undefined ? (
        <span className="pm-node__d">{node.detail}</span>
      ) : null}
    </div>
  );
}

function Pipe({ nodes }: { nodes: FlowNode[] }): ReactNode {
  return (
    <div className="pm-pipe">
      {nodes.map((node, i) => (
        <Fragment key={`${node.title}-${i.toString()}`}>
          {i > 0 ? (
            <span className="pm-arrow" aria-hidden="true">
              →
            </span>
          ) : null}
          <NodeBox node={node} />
        </Fragment>
      ))}
    </div>
  );
}

export default function PackageFlows(): ReactNode {
  return (
    <section className="pm-flows" aria-label="Package flow diagrams">
      <h2 className="pm-flows__h">How the two packages work</h2>
      <div className="pm-legend">
        {TAGS.map((t) => (
          <span key={t.tag} className={`pm-tag pm-tag--${t.tag}`}>
            {t.label}
          </span>
        ))}
      </div>
      {FLOWS.map((flow) => (
        <div className="pm-flow" key={flow.pkg}>
          <div className="pm-flow__head">
            <code className="pm-flow__pkg">{flow.pkg}</code>
            <span className="pm-flow__blurb">{flow.blurb}</span>
          </div>
          {flow.ops.map((op) => (
            <div className="pm-op" key={op.label}>
              <span className="pm-op__label">{op.label}</span>
              <Pipe nodes={op.nodes} />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
