# CLI demonstrations

Complete the toolchain and dependency setup in
[CONTRIBUTING](../../CONTRIBUTING.md), then run from the repository root with
Make available:

```sh
make demo
```

The equivalent Moon command works from anywhere in the checkout:

```sh
CI= moon run example-cli:agent-demo
```

Moon compiles the current checkout's CLI first. The driver uses that executable
for the server and all three identities. It creates its own temporary homes,
server directory, and checkouts. It needs no installed Thaddeus binary, external
server, model service, or recording tool. The live narrated run is the demo;
generated identities, operation IDs, paths, and ports differ each time.

The story runs through:

1. An owner adopting source files and publishing the initial history.
2. A scoped agent delegation with a two-operation budget and a protected auth
   path.
3. An agent uploading an allowed change with an explicit signed explanation,
   followed by the owner signing its landing.
4. A protected-path proposal being rejected at land, with accepted history
   unchanged.
5. Querying the agent's accepted operation and verifying its explanation.
6. A second repository accepting one operation and rejecting the next for budget
   exhaustion.
7. An independent reviewer vetoing another candidate, blocking its landing.

`--actor-kind agent:thaddeus-demo@<version>` is a signed declaration by this
deterministic script. It does not establish agent behavior or grant permissions.
Budgets count accepted operations, not pushes, attempted uploads, or money.
Rejected candidates start from separate clones so one refusal cannot mask
another.

The owner's `land` runs from the agent's candidate checkout, using the owner's
separate identity. For the final act, the reviewer receives that local checkout
and a scoped `reviewer grant`. The handoff supplies candidate access; the grant
supplies veto authority. A reviewer grant does not supply decryption keys or
make unlanded operations appear in a fresh clone.

Expected refusals print their real nonzero command exits. The driver requires
the specific refusal reason and checks remote main through fresh clones. An
unexpected result exits nonzero. Success stops and reaps all child processes and
removes the run directory. Failure or interruption retains the transcript and
state at the printed `Demo evidence retained:` path. The driver has a 120-second
deadline, command and startup deadlines of 15 seconds, and a 5-second graceful
shutdown allowance before forced termination.

Run the lifecycle tests, including two complete runs, actual server death,
SIGINT, and SIGTERM:

```sh
CI= moon run example-cli:test
```

The existing introductory and grant/revocation examples remain available:

```sh
CI= moon run example-cli:demo
CI= moon run example-cli:grant-demo
```
