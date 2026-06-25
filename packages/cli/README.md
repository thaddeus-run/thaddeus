# @thaddeus.run/cli

The **Thaddeus** CLI — `thaddeus` (alias `thad`).

```sh
thaddeus init                       # create a self-owned identity
thaddeus create <server> <repo>     # create a repo on a server
thaddeus clone <server> <repo> [dir] # clone to a working tree
thaddeus status                     # show changes
thaddeus push                       # commit + upload + land into main
thaddeus push --no-land             # upload only (run 'thaddeus land' to publish)
thaddeus land                       # land uploaded-but-unmerged commits
```

A git-like client over the untrusted remote: edit files on disk, `push` to
publish. All crypto is client-side; your identity seed lives in
`~/.config/thaddeus/`.

> **Status: spike.** Single-owner writes; online, full-set sync (see the CLI
> design spec).
