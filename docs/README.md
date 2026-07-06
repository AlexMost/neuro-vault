# Documentation

Where each kind of documentation lives in this repo, and which single question it answers. For how a change goes from idea to merged, see [`workflow.md`](workflow.md).

## The five locations

Each answers one question, so they don't overlap:

- [`adr/`](adr/INDEX.md) — **WHY**: architecture decisions and their rationale. Immutable once Accepted; supersede via Status.
- [`architecture/`](architecture/README.md) — **HOW**: one file per concept, describing the **current** state (living, not historical). A reader should understand any one concept by reading exactly one file.
- `../openspec/specs/<capability>/` — **WHAT (current)**: the living, normative contract per capability (SHALL + scenarios). Updated on `openspec archive`.
- `../openspec/changes/<name>/` — **WHAT (proposed)**: a change in flight — spec delta + brainstorm/design/tasks/plan/verify/retrospective.
- [`superpowers/specs/`](superpowers/specs/README.md) (committed) + `superpowers/plans/` (gitignored) — **FROZEN** pre-OpenSpec record. Readable, not migrated; nothing new is added.

## Also in `docs/`

- [`guide/`](guide/README.md) — user-facing guide: installation, configuration, finding notes (hybrid search + structured queries), reading & modifying, tool routing.
- [`workflow.md`](workflow.md) — the idea → merged flow. Whether a change is an opsx change or a direct PR is decided by [`../.claude/rules/opsx-routing.md`](../.claude/rules/opsx-routing.md).
