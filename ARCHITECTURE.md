# Thaddeus — Architecture & convergence spine

Thaddeus builds the Strata substrate **one primitive at a time**, releasing each
as a standalone npm package, while this document keeps the separately-built
pieces converging into one system. There is no "dumb primitive + smart platform"
seam: the packages compose; Strata is their composition.

## Shared primitives (reused, not duplicated)

| Primitive                             | Package                  | Reused by                                               |
| ------------------------------------- | ------------------------ | ------------------------------------------------------- |
| Identity (`did:key`)                  | `@thaddeus.run/identity` | P01 caps · P04 provenance · P07 reputation · P09 agents |
| Object (encrypted, content-addressed) | `@thaddeus.run/store`    | P01 · P02 membrane · P03 snapshots · P11 query          |
| Capability (sealed key)               | `@thaddeus.run/store`    | P01 · P02 reveal · P09 revocation                       |
| Op (operation log entry)              | `@thaddeus.run/log`      | P03 · P04 · P08 · P10                                   |

## Build order (each tier depends only on tiers below)

- **Tier 0 — Foundation:** `@thaddeus.run/identity`, `@thaddeus.run/store` (P01)
- **Tier 1 — Spine:** membrane/time (P02), operation log (P03)
- **Tier 2 — Why + surface:** provenance (P04), virtual FS (P05), platform (P06)
- **Tier 3 — Home + authors:** identity federation/reputation (P07), agents
  (P09)
- **Tier 4 — Meaning + governance:** semantic graph (P08), review (P10), live DB
  (P11)

## North-star flow (the continuous integration test)

`integration/test/one-edit-end-to-end.test.ts` runs the brief's "one edit, end
to end": write → snapshot → Op → provenance → policy → mirror. Tier 0 is real;
higher pillars are `test.todo`. After each primitive ships, one `test.todo`
becomes a real assertion. When the last stub is gone, the substrate is whole.

## Status / traceability

| Pillar                                | Package              | Status  | Resolves         |
| ------------------------------------- | -------------------- | ------- | ---------------- |
| 01 Encrypted objects + capabilities   | `identity` + `store` | built   | P1 P2 P4 P18 P21 |
| 02 Membrane (time-varying visibility) | `store`              | built   | P2 P4            |
| 03 Operation log                      | `log`                | built   | P5 P6 P12        |
| 04 Provenance ("why")                 | `provenance`         | built   | P12              |
| 05 Virtual FS                         | _(planned)_          | planned | P6 P7 P8 P11     |
| 06 Platform                           | _(planned)_          | planned | P9 P10 P11       |
| 07 Identity federation / reputation   | _(planned)_          | planned | P13 P19 P20      |
| 08 Semantic graph                     | _(planned)_          | planned | P14 P5 P18       |
| 09 Agents as principals               | _(planned)_          | planned | P16 P3 P21       |
| 10 Review as policy                   | _(planned)_          | planned | P15 P12          |
| 11 Live database                      | _(planned)_          | planned | P17 P10          |

## Per-primitive loop

read `ARCHITECTURE.md` → brainstorm → spec (`docs/specs/`) → plan
(`docs/plans/`) → build (TDD) → extend the north-star flow → update
`CHANGELOG.md` + this table.
