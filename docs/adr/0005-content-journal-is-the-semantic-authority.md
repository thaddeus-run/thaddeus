# File content and a change journal are the semantic authority

Thaddeus will treat immutable file content plus an append-only change journal
per workspace as the authority for semantic editing, and the symbol graph as a
projection it can rebuild from the journal. Making the graph authoritative would
give symbols built-in identity. It would also mean storing every comment and
byte of formatting in a tree, keeping a second store for files no parser
understands, refusing to save files that do not parse, and changing stored code
whenever the parser changes, while external agents keep writing plain text.

Each transaction, whether it holds file edits, structured edits or both, commits
as one journal entry. The entry records the structured intent, the byte edits
that intent produced and the resulting content. An interrupted rename can then
no longer leave the text and the rename record in different places, which the
shipped CLI does today. A symbol keeps its identity only through renames and
moves that an edit declares, and a structured edit runs only against a graph
built for the exact state it commits on. TypeScript and JavaScript are the
proposed first language family, which nothing implements yet. The
[design](../specs/2026-10-18-thaddeus-semantic-authority-design.md) holds the
rules, the comparison and the observed baseline.
