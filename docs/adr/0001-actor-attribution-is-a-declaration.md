# Actor attribution is a signed declaration

The CLI will let an explanation's signer explicitly declare actor kind,
preserving the human default, because delegation can belong to either a human
collaborator or an agent. The signature authenticates the declaration; it does
not prove agent behavior or confer authorization. Keep actor attribution
separate from write delegation and reviewer authority rather than inferring it
from either grant.

The declaration is per invocation on `push -m` and `rename -m`, using
`--actor-kind human|agent:<name>@<version>`. An explicit declaration requires a
nonempty message and validation before mutation. Restricting the interface to
human and agent declarations avoids exposing arbitrary checker labels through
this option; existing CI policy gates can match those labels. Retries append
claims and preserve earlier signatures rather than relabeling history.
