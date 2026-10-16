# Hosted remote workspaces and external agents come first

Thaddeus is built first for large-scale parallel agent development on one
repository, and the design target is 1,000 or more simultaneous agents. Agents
such as Claude Code and Codex already exist and need a workspace to connect to
before Thaddeus needs an orchestrator of its own. Delivery follows this order:

1. Thaddeus-hosted remote workspaces over shared code.
2. Local-folder compatibility for existing checkouts and the current CLI, which
   keep working but no longer set the design.
3. Customer hosting of the trusted service from
   [ADR 0003](0003-trusted-code-processing-service.md).
4. First-party orchestration, once external agents can connect through the
   remote workspace API.

One ordered build queue in Linear replaces milestones, cycles and due dates. The
view is called "Thaddeus build order" and sorts by title ascending. The
[architecture contract](../agent-first-architecture.md) holds the repository
copy of that order.
