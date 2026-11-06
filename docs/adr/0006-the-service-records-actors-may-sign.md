# The service records changes, and actors may also sign them

The trusted service records every history advancement and change journal entry
for the credential that asked for it, and signs that record itself. An agent or
human may add its own signature over the same content, and only that signature
is ever shown as theirs. Requiring every agent to sign every entry would put key
handling on the path of every save, while letting a service record pass for an
agent's signature would break
[ADR 0001](0001-actor-attribution-is-a-declaration.md) and
[ADR 0003](0003-trusted-code-processing-service.md).

So a record has two separate parts. `requestedBy` is the principal, holder, kind
and credential the service took from the authorization, which is an attribution
and not a signature. `actorClaims` are signatures by actors over the exact
content, verified before the record is written and refused if they do not match.
Readers present `signedBy` from verified claims alone. This settles the question
the
[semantic authority design](../specs/2026-10-18-thaddeus-semantic-authority-design.md)
left to THA-150, and an owner no longer has to be online to sign each landing.
The
[authority design](../superpowers/specs/2026-11-06-tha-150-trusted-service-authority-design.md)
holds the record format.
