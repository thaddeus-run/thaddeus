# ee

Everything under `ee/` is ThadHub: the hosted product built on top of the
open-source Thaddeus core. It is source-available, not open source.

## License

`ee/` is licensed under the Functional Source License, Version 1.1, ALv2 Future
License ([`LICENSE`](./LICENSE), SPDX `FSL-1.1-ALv2`). You may read, run, modify
and redistribute it for any purpose except offering it as a competing product or
service. Two years after a given version is made available, that version becomes
available under Apache-2.0, the same license as the rest of this repository.

The root [`LICENSE`](../LICENSE) carves `ee/` out of the Apache-2.0 grant that
covers everything else.

## What belongs here

Code that only makes sense as part of the hosted service: the ThadHub web
interface, sign-in and sessions, tenant and billing logic, hosted execution
runners, edge delivery, the status page if we ever write one, and deployment
configuration for `*.thaddeus.run` services.

Anything a self-hoster needs to run Thaddeus does not belong here. The server,
the CLI, every `@thaddeus.run/*` package, `lazythad`, the docs and the landing
page stay outside `ee/` under Apache-2.0. When in doubt, ask: would someone
running their own Thaddeus server need this? If yes, it is not `ee/`.

## Adding a project

Create `ee/<name>/` with its own `package.json` and `moon.yml`. Bun's
`workspaces` and moon's project globs both include `ee/*`, so nothing else needs
registering. In the package manifest set:

```json
{
  "private": true,
  "license": "FSL-1.1-ALv2"
}
```

Dependencies still come from the root `workspaces.catalog`, and the usual
`moon run <project>:<task>` commands apply.

## Contributions

External pull requests that touch `ee/` are not accepted at the moment, because
accepting them under the FSL needs a contributor agreement we do not have yet.
Open an issue instead. See [CONTRIBUTING.md](../CONTRIBUTING.md).
