# @thaddeus.run/fs

The virtual filesystem for **Thaddeus** — Pillar 05.

A `Workspace` is a copy-on-write working copy over a `@thaddeus.run/log`
operation log — the worktree-killer. It opens a private, zero-copy forked view
(pinned: peer ops never shift it), projects reads (`read`/`list`/`grep`) from
that view, stages edits (`write`/`rm`) in an in-memory overlay, and folds them
into signed ops on `commit`. `fork()` branches a working copy in O(1).
`read`/`grep` are decryption-bounded: you can only search what your identity is
allowed to read.

> **Status: spike.** In-memory, single process. Landing/merge onto a shared
> view, `sync()` of the pinned base, 3-way content merge, and `mv`/rename are
> deferred (see the design spec).
