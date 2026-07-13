import type { Identity } from '@thaddeus.run/identity';
import {
  decodeHeadRecord,
  encodeHeadRecord,
  type HeadRecordWire,
  signHead,
} from '@thaddeus.run/log';

export function createRepoBody(
  name: string,
  owner: Identity
): {
  name: string;
  head: HeadRecordWire;
} {
  return {
    name,
    head: encodeHeadRecord(
      signHead(
        {
          repo: name,
          view: 'main',
          version: 0,
          previous: null,
          heads: [],
        },
        owner
      )
    ),
  };
}

export async function landBody(
  fetchImpl: (request: Request) => Promise<Response>,
  name: string,
  fromHeads: readonly string[],
  owner: Identity,
  into = 'main',
  extra: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(
    new Request(
      `http://t/repos/${encodeURIComponent(name)}/views/${encodeURIComponent(into)}`
    )
  );
  if (!response.ok) {
    throw new Error(`could not read current signed head: ${response.status}`);
  }
  const body = (await response.json()) as { head: HeadRecordWire };
  const current = decodeHeadRecord(body.head);
  const heads = [...new Set([...current.heads, ...fromHeads])].sort();
  return {
    fromHeads: [...fromHeads],
    into,
    ...extra,
    head: encodeHeadRecord(
      signHead(
        {
          repo: name,
          view: into,
          version: current.version + 1,
          previous: current.id,
          heads,
        },
        owner
      )
    ),
  };
}

export function createViewBody(
  name: string,
  view: string,
  heads: readonly string[],
  owner: Identity
): { head: HeadRecordWire } {
  return {
    head: encodeHeadRecord(
      signHead(
        {
          repo: name,
          view,
          version: 0,
          previous: null,
          heads: [...new Set(heads)].sort(),
        },
        owner
      )
    ),
  };
}
