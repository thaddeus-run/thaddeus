import type { ReactNode } from 'react';

import { Section } from './section';

function Tile({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="border-rule bg-surface overflow-hidden rounded-md border">
      <div className="border-rule relative h-[150px] border-b">
        <svg
          viewBox="0 0 210 150"
          className="[&_text]:fill-muted absolute inset-0 h-full w-full font-mono"
          aria-hidden="true"
        >
          {children}
        </svg>
      </div>
      <h3 className="px-3.5 pt-3 text-[13px]">{title}</h3>
      <p className="text-muted mx-3.5 mt-1.5 mb-3.5 text-xs leading-relaxed">
        {body}
      </p>
    </div>
  );
}

// Three looping sketches: a workspace per agent, the signed operation and its
// signed why, and landing as a policy gate. The loops are CSS (see styles.css)
// and start mid-cycle so no tile is ever empty.
export function HowItWorks(): ReactNode {
  const wsBoxes = [
    { x: 22, y: 66, label: 'ws 01', delay: '-7s' },
    { x: 81, y: 66, label: 'ws 02', delay: '-6s' },
    { x: 140, y: 66, label: 'ws 03', delay: '-5s' },
    { x: 52, y: 36, label: 'ws 04', delay: '-4s' },
    { x: 111, y: 36, label: 'ws 05', delay: '-3s' },
  ];
  return (
    <Section title="How it works.">
      <div className="grid gap-[18px] md:grid-cols-3">
        <Tile
          title="A workspace per agent"
          body="Each agent works in its own view over one shared store. Views are copy-on-write, so opening one copies nothing."
        >
          <rect
            x="22"
            y="96"
            width="166"
            height="30"
            rx="3"
            className="fill-tint stroke-accent"
          />
          <text x="32" y="115" fontSize="10" className="fill-accent!">
            shared store, base r.41
          </text>
          {wsBoxes.map((b) => (
            <g
              key={b.label}
              className="loop-ws"
              style={{ animationDelay: b.delay }}
            >
              <rect
                x={b.x}
                y={b.y}
                width="48"
                height="22"
                rx="3"
                className="fill-surface stroke-ink"
              />
              <text x={b.x + 8} y={b.y + 14} fontSize="9">
                {b.label}
              </text>
            </g>
          ))}
          <text x="22" y="22" fontSize="9">
            copy-on-write views over one base
          </text>
        </Tile>
        <Tile
          title="Signed operation, signed why"
          body="The change and its reason both carry a signature you can verify later."
        >
          <text x="18" y="40" fontSize="10" className="fill-ink!">
            edit src/auth/session.ts
          </text>
          <text x="18" y="58" fontSize="9" fontStyle="italic">
            “split refresh out of login”
          </text>
          <line
            x1="18"
            y1="78"
            x2="158"
            y2="78"
            className="loop-sig-line stroke-accent"
            style={{ animationDelay: '-5s' }}
          />
          <text
            x="18"
            y="98"
            fontSize="9"
            className="loop-sig-text fill-accent!"
            style={{ animationDelay: '-5s' }}
          >
            signed did:key:z6MkhaXg…Qp7
          </text>
          <text
            x="18"
            y="113"
            fontSize="9"
            className="loop-sig-text fill-accent!"
            style={{ animationDelay: '-5s' }}
          >
            why signed did:key:z6MkhaXg…Qp7
          </text>
          <text
            x="166"
            y="82"
            fontSize="11"
            className="loop-tick fill-accent!"
            style={{ animationDelay: '-5s' }}
          >
            ok
          </text>
        </Tile>
        <Tile
          title="Landing is policy"
          body="Protected paths, budgets, proofs and a standing human veto decide what lands."
        >
          <line x1="10" y1="75" x2="200" y2="75" className="stroke-rule" />
          <rect
            x="92"
            y="52"
            width="26"
            height="46"
            rx="3"
            className="stroke-ink fill-none"
          />
          <text x="80" y="42" fontSize="9">
            policy
          </text>
          <text x="10" y="120" fontSize="9">
            upload
          </text>
          <text x="170" y="120" fontSize="9">
            landed
          </text>
          <circle
            cx="12"
            cy="75"
            r="3.5"
            className="loop-land fill-accent"
            style={{ animationDelay: '-2s' }}
          />
          <circle
            cx="12"
            cy="75"
            r="3.5"
            className="loop-refuse fill-refuse"
            style={{ animationDelay: '-5.5s' }}
          />
        </Tile>
      </div>
    </Section>
  );
}
