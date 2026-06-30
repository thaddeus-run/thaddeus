# @thaddeus.run/cli

The **Thaddeus** CLI — `thaddeus` (alias `thad`).

```sh
thaddeus serve --data ./srv-data &       # run a server
thaddeus init                            # create a self-owned identity
thaddeus create http://localhost:4000 me/notes
thaddeus clone http://localhost:4000 me/notes ~/notes
cd ~/notes && echo "# notes" > readme.md && thaddeus push
```

A git-like client over the untrusted remote: edit files on disk, `push` to
publish. All crypto is client-side; your identity seed lives in
`~/.config/thaddeus/`.

> **Status: spike.** Single-owner writes; online, full-set sync (see the CLI
> design spec).
