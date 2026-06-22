'use client';

import { Identity, ready } from '@thaddeus.run/identity';
import { AccessDenied, MemoryStore } from '@thaddeus.run/store';
import type { Ref } from '@thaddeus.run/store';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const SECRET = 'DATABASE_URL=postgres://app:hunter2@db.internal/prod';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const short = (s: string, head: number, tail: number): string =>
  s.length <= head + tail ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

type View = { readable: boolean; text: string };
type ObjectInfo = {
  address: string;
  cipherHex: string;
  verified: boolean;
  leaks: boolean;
};

export default function PermissionModelDemo(): ReactNode {
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const store = useRef<MemoryStore | null>(null);
  const alice = useRef<Identity | null>(null);
  const bob = useRef<Identity | null>(null);
  const obj = useRef<Ref | null>(null);

  const [aliceDid, setAliceDid] = useState('');
  const [bobDid, setBobDid] = useState('');
  const [object, setObject] = useState<ObjectInfo | null>(null);
  const [aliceView, setAliceView] = useState<View | null>(null);
  const [bobView, setBobView] = useState<View | null>(null);
  const [granted, setGranted] = useState(false);
  const [status, setStatus] = useState<ReactNode>(null);
  const [tick, setTick] = useState(0);

  const boot = useCallback(async (): Promise<void> => {
    await ready();
    store.current = new MemoryStore();
    alice.current = Identity.create();
    bob.current = Identity.create();
    obj.current = null;
    setAliceDid(alice.current.did);
    setBobDid(bob.current.did);
    setObject(null);
    setAliceView(null);
    setBobView(null);
    setGranted(false);
    setStatus(
      <>
        Two fresh identities, nothing stored yet. <b>Store the secret</b> to
        begin.
      </>
    );
    setPhase('ready');
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const readView = useCallback(async (who: Identity): Promise<View> => {
    const s = store.current;
    const ref = obj.current;
    if (s === null || ref === null) return { readable: false, text: '' };
    try {
      return { readable: true, text: dec(await s.get(ref, who)) };
    } catch (err) {
      if (err instanceof AccessDenied) {
        const raw = s.rawObject(ref.id);
        return {
          readable: false,
          text: raw !== undefined ? hex(raw.ciphertext) : '',
        };
      }
      throw err;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const s = store.current;
    const ref = obj.current;
    if (
      s === null ||
      ref === null ||
      alice.current === null ||
      bob.current === null
    ) {
      return;
    }
    const raw = s.rawObject(ref.id);
    if (raw !== undefined) {
      setObject({
        address: ref.id,
        cipherHex: hex(raw.ciphertext),
        verified: s.verify(ref.id),
        leaks: dec(raw.ciphertext).includes('DATABASE'),
      });
    }
    setAliceView(await readView(alice.current));
    setBobView(await readView(bob.current));
    setTick((t) => t + 1);
  }, [readView]);

  const doStore = useCallback(async (): Promise<void> => {
    if (store.current === null || alice.current === null) return;
    obj.current = await store.current.put(enc(SECRET), alice.current);
    await refresh();
    setStatus(
      <>
        Stored. The bytes are <b>ciphertext at rest</b> — Alice holds the only
        capability, so only she can read it. Bob sees the sealed bytes.
      </>
    );
  }, [refresh]);

  const doGrant = useCallback(async (): Promise<void> => {
    if (
      store.current === null ||
      alice.current === null ||
      bob.current === null ||
      obj.current === null
    ) {
      return;
    }
    await store.current.grant(
      obj.current,
      bob.current.toPublic(),
      alice.current
    );
    setGranted(true);
    await refresh();
    setStatus(
      <>
        Alice <b>sealed the content key to Bob</b>. His viewport just resolved
        to plaintext — same object, now legible to him.
      </>
    );
  }, [refresh]);

  const doRevoke = useCallback(async (): Promise<void> => {
    if (
      store.current === null ||
      alice.current === null ||
      bob.current === null ||
      obj.current === null
    ) {
      return;
    }
    await store.current.revoke(
      obj.current,
      bob.current.toPublic(),
      alice.current
    );
    setGranted(false);
    await refresh();
    setStatus(
      <>
        <b>Revoked — the content key rotated.</b> Bob&rsquo;s old key now opens
        nothing; Alice still reads. No secret was ever re-typed or re-shared.
      </>
    );
  }, [refresh]);

  if (phase === 'loading') {
    return (
      <p className="pm-loading">starting the substrate in your browser…</p>
    );
  }

  const stored = object !== null;

  return (
    <section aria-label="Permission model demo">
      <div className="pm-object">
        <div className="pm-object__bar">
          <span className="pm-object__title">the object</span>
          <span className="pm-addr">
            {stored ? (
              <>
                addr <b>{short(object.address, 12, 6)}</b>
              </>
            ) : (
              'not stored yet'
            )}
          </span>
        </div>
        <div className="pm-cipher">{stored ? object.cipherHex : '—'}</div>
        <div className="pm-facts">
          <div className="pm-fact">
            <span className="pm-fact__mark">
              {stored && object.verified ? '✓' : '·'}
            </span>
            a mirror re-hashed these bytes and they match the address — no key
            needed
          </div>
          <div className="pm-fact">
            <span className="pm-fact__mark">
              {stored ? (object.leaks ? '✗' : '✓') : '·'}
            </span>
            the plaintext never appears in the stored bytes
          </div>
        </div>
      </div>

      <div className="pm-actors">
        <Actor
          who="alice"
          name="Alice"
          role="owner"
          did={aliceDid}
          view={aliceView}
          tick={tick}
        />
        <Actor
          who="bob"
          name="Bob"
          role={granted ? 'granted' : 'no key'}
          did={bobDid}
          view={bobView}
          tick={tick}
        />
      </div>

      <div className="pm-controls">
        <button
          type="button"
          className="pm-btn"
          onClick={() => void doStore()}
          disabled={stored}
        >
          Store the secret
        </button>
        <button
          type="button"
          className="pm-btn pm-btn--bob"
          onClick={() => void doGrant()}
          disabled={!stored || granted}
        >
          Grant Bob
        </button>
        <button
          type="button"
          className="pm-btn pm-btn--revoke"
          onClick={() => void doRevoke()}
          disabled={!granted}
        >
          Revoke Bob
        </button>
        <button
          type="button"
          className="pm-btn pm-btn--ghost"
          onClick={() => void boot()}
        >
          Reset
        </button>
      </div>
      <p className="pm-status">{status}</p>
    </section>
  );
}

function Actor({
  who,
  name,
  role,
  did,
  view,
  tick,
}: {
  who: 'alice' | 'bob';
  name: string;
  role: string;
  did: string;
  view: View | null;
  tick: number;
}): ReactNode {
  const open = view !== null && view.readable;
  let modifier = '';
  if (view !== null) {
    modifier = open ? 'pm-viewport--open' : 'pm-viewport--sealed';
  }
  let label = '· awaiting an object';
  if (view !== null) {
    label = open ? '🔓 decrypted' : '🔒 sealed — no key';
  }
  let body = '—';
  if (view !== null) {
    if (open) {
      body = view.text;
    } else {
      body = view.text !== '' ? short(view.text, 44, 8) : 'no object';
    }
  }
  return (
    <div className="pm-actor" data-who={who}>
      <div className="pm-actor__head">
        <span className="pm-actor__name">{name}</span>
        <span className="pm-actor__role">{role}</span>
      </div>
      <p className="pm-did">{did !== '' ? short(did, 18, 6) : ''}</p>
      <div key={tick} className={`pm-viewport pm-flip ${modifier}`}>
        <span className="pm-viewport__label">{label}</span>
        <span className="pm-viewport__body">{body}</span>
      </div>
    </div>
  );
}
