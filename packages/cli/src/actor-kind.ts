export type CliActorKindResult = { kind: string } | { error: string };

// Validate the signer's declaration before a command can commit or upload edits.
export function parseCliActorKind(
  raw: string | undefined,
  message: string | undefined
): CliActorKindResult {
  if (raw === undefined) return { kind: 'human' };
  if (
    raw !== 'human' &&
    /^agent:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._+-]*$/.exec(
      raw
    )?.[0] !== raw
  ) {
    return {
      error: 'invalid --actor-kind: use human or agent:<name>@<version>',
    };
  }
  if (message === undefined || message.trim().length === 0) {
    return { error: '--actor-kind requires a nonempty -m message' };
  }
  return { kind: raw };
}
