export type CliActorKindResult = { kind: string } | { error: string };

const AGENT_KIND =
  /^agent:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Validate the signer's declaration before a command can commit or upload edits.
export function parseCliActorKind(
  raw: string | undefined,
  message: string | undefined
): CliActorKindResult {
  if (raw === undefined) return { kind: 'human' };
  if (raw !== 'human' && !AGENT_KIND.test(raw)) {
    return {
      error: 'invalid --actor-kind: use human or agent:<name>@<version>',
    };
  }
  if (message === undefined || message.trim().length === 0) {
    return { error: '--actor-kind requires a nonempty -m message' };
  }
  return { kind: raw };
}
