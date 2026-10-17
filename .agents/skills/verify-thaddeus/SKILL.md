---
name: verify-thaddeus
description:
  Exercise a Thaddeus CLI, server, or client change through the real CLI against
  an isolated local server, covering the user path, restart recovery, and a
  second identity. Use before claiming a runtime change works, and to reproduce
  a reported bug.
---

<!-- Adapted from pingdotgg/t3code at 2fae0f9. -->

# Verify Thaddeus

Run the change through the compiled `thaddeus` CLI against a throwaway server,
then record what you observed. This is the verification standard in
[section 9 of the architecture contract](../../../docs/agent-first-architecture.md#9-verification-standard):
the real user path, failure and restart recovery, and a second identity.

Never touch `~/.config/thaddeus`, `ams1.thaddeus.run`, or a process you did not
start. Never run `thaddeus use --hosted`. Each identity gets its own `HOME`
because the CLI reads `homedir()` (`packages/cli/src/bin.ts:16`), and the server
gets its own `--data` and a free port.

Use the compiled binary, not `bun packages/cli/src/bin.ts`. Workspace packages
resolve to their `dist/` builds, so running from source loads stale server and
client code after you edit them. `moon run cli:compile` builds every dependency
first, so the binary always matches your working tree.

Each Bash call may start a fresh shell. The first step writes `env.sh`, and
every later block starts by sourcing it. Replace `<WORK>` with the directory
that step 1 prints.

## 1. Set up

Run from the repository root. `CI=` is required because the compile task skips
CI-marked shells.

```bash
export AGENT=1
cd "$(git rev-parse --show-toplevel)"
CI= moon run cli:compile
REPO=$PWD
WORK=$(mktemp -d)
OWNER_HOME=$(mktemp -d)
GUEST_HOME=$(mktemp -d)
PORT=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response("") }); console.log(s.port); await s.stop(true)')
mkdir "$WORK/data"
cat > "$WORK/env.sh" <<EOF
export AGENT=1 REPO='$REPO' WORK='$WORK' OWNER_HOME='$OWNER_HOME' GUEST_HOME='$GUEST_HOME'
export PORT='$PORT' SERVER='http://localhost:$PORT'
EOF
cat >> "$WORK/env.sh" <<'EOF'
CLI="$REPO/packages/cli/release/thaddeus"
owner() { HOME="$OWNER_HOME" "$CLI" "$@"; }
guest() { HOME="$GUEST_HOME" "$CLI" "$@"; }
start_server() {
  HOME="$OWNER_HOME" nohup "$CLI" serve --port "$PORT" --data "$WORK/data" >>"$WORK/server.log" 2>&1 &
  echo $! > "$WORK/server.pid"
  for _ in $(seq 50); do curl -sf "$SERVER/version" && echo && return 0; sleep 0.2; done
  echo "server did not start, see $WORK/server.log" >&2; return 1
}
stop_server() {
  local pid; pid=$(cat "$WORK/server.pid")
  kill -INT "$pid"
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null && sleep 0.2 || { echo "stopped server $pid"; return 0; }; done
  kill "$pid"; echo "killed server $pid"
}
EOF
echo "WORK=$WORK"
```

`stop_server` signals only the PID that `start_server` saved in
`<WORK>/server.pid`. `serve` defaults to port 4000 and `./thaddeus-data`, so
always pass both flags as `start_server` does.

## 2. Create two identities

```bash
. <WORK>/env.sh
owner --version
owner identity init && owner whoami
guest identity init && guest whoami
```

The two `did:key` values must differ. Record them.

## 3. Start the server

```bash
. <WORK>/env.sh
start_server
curl -si -H 'x-thaddeus-protocol: 999' "$SERVER/version" | head -1
```

`start_server` waits for the server and prints `{"version":"...","protocol":1}`.
The `curl` prints `HTTP/1.1 426 Upgrade Required`, because the server refuses a
mismatched wire protocol.

## 4. Walk the user path as the owner

This follows [getting started](../../../docs/getting-started.md) sections 2
to 5. Change the files below to exercise your change.

```bash
. <WORK>/env.sh
owner use "$SERVER"
mkdir -p "$WORK/owner/web/src" && cd "$WORK/owner/web"
printf 'fn main() {}\n' > src/main.rs
owner init acme/web
owner status
owner push -m "initial import"
printf 'fn main() { println!("hi"); }\n' > src/main.rs
owner status
owner push -m "print a greeting"
owner log
OP=$(owner log | awk '$1 ~ /^[0-9a-f]{10}$/ { print $1; exit }')
owner query why "$OP"
```

`status` must list the file as added, then modified. `push` must print
`published to main`. `query why` must show `[verified] human: print a greeting`.

## 5. Add the second identity

This follows getting started section 6, plus a check that the grant is what
unlocks reads. One step differs from that section's prose. A delegate's `push`
does not publish. It exits 1 with `owner signature required to publish` and the
uploaded head IDs, and the owner lands those heads by running `owner land`
inside the delegate's checkout.

```bash
. <WORK>/env.sh
mkdir -p "$WORK/guest" && cd "$WORK/guest"
guest use "$SERVER"
guest clone acme/web denied
(cd denied && guest status)
cd "$WORK/owner/web" && owner grant "$(guest whoami)"
cd "$WORK/guest" && guest clone acme/web web && cd web
cat src/main.rs
printf 'fn login() {}\n' > src/auth.rs
guest push -m "add login"; echo "guest push exit=$?"
owner land
cd "$WORK/owner/web" && owner pull
owner log
owner query why "$(owner log | awk '$1 ~ /^[0-9a-f]{10}$/ { print $1; exit }')"
cat src/auth.rs
cd "$WORK/guest/web" && guest pull && guest log > "$WORK/log-before-restart.txt"
```

Expect, in order:

- `denied` reports `file(s) not readable with your keys`, so the clone before
  the grant holds ciphertext only.
- After the grant, the guest's `cat src/main.rs` prints the owner's file.
- `guest push exit=1` with `owner signature required to publish`.
- `landed to main`, then the owner's `pull` brings `src/auth.rs`, and
  `query why` shows `[verified] human: add login` by the guest's DID.

## 6. Restart the server

```bash
. <WORK>/env.sh
stop_server
cd "$WORK/guest/web" && guest pull; echo "pull while down exit=$?"; guest status
start_server
cd "$WORK/guest" && guest clone acme/web after-restart && cd after-restart
guest log | diff - "$WORK/log-before-restart.txt" && echo "history identical after restart"
cat src/auth.rs
guest query why "$(guest log | awk '$1 ~ /^[0-9a-f]{10}$/ { print $1; exit }')"
cd "$WORK/owner/web" && printf '// after restart\n' >> src/main.rs
owner push -m "write after restart"
cd "$WORK/guest/web" && guest pull && guest log | head -3
```

Expect `pull while down` to fail with `Unable to connect` and exit 1, and
`status` to still report a clean checkout. After the restart on the same
`--data`, a fresh clone must show the same history and the same `why`, and a new
push must land and reach the guest.

## 7. Record and tear down

Write down what you observed, not what should happen: the commands, exit codes,
DIDs, op ids, and the error text from each failure check. Put them in the PR's
verification section. If one of the three checks does not apply to your change,
say which and why.

Stop only what you started, then remove only what you created. Do not run
`pkill thaddeus` or stop anything on port 4000.

```bash
. <WORK>/env.sh
stop_server
rm -rf "$WORK" "$OWNER_HOME" "$GUEST_HOME"
```

If the user asked to inspect the result, leave the server running and give them
the PID, the port, and `<WORK>`. An assistant turn ending is not teardown, so
stop the server yourself once they are done.
