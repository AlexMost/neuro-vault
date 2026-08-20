# ADR-0010 — Context reaches agents through tool descriptions and responses

- **Status**: Accepted
- **Date**: 2026-08-20

## Context

An MCP server has three ways to put text in front of an agent: the `instructions` string returned at `initialize`, each tool's `description`, and each tool's response. We had been treating `instructions` as the general-purpose channel, and it had grown to a 10,803-character preamble with fifteen headings — much of it restating what tool descriptions already said.

Measurement showed the channel does not deliver. Claude Code truncates `instructions` at exactly 2048 characters — characters, not bytes, verified with two ruler servers, one emitting three-byte characters, both cut at the same character index. Worse, sub-agents receive no `instructions` at all: not a truncated slice, absent entirely (verified on `general-purpose` and `Explore` against a control). Both are client behaviours we do not control, and other clients (Cursor, Windsurf) are untested and may cap differently again.

The concrete casualty was the vault owner's `for-external-agents.md`. It was appended last, so its block began past ~11k characters and was unreachable at any file size. The feature shipped, was documented, and delivered nothing to anybody. Tool descriptions and tool responses, by contrast, arrive intact in every client we have measured, sub-agents included.

## Decision

Treat tool descriptions and tool responses as the only channels that reach an external agent intact. Context that **must** arrive belongs in one of them. MCP `instructions` is best-effort: populate it, order it so the most irreplaceable content leads, but never let a capability's correctness depend on it.

Concretely:

- Anything a tool can say about itself — parameters, result shape, error codes, multi-vault fan-out behaviour, usage recipes — goes in that tool's `description`.
- Context the agent must act on goes in the tool `response`, and the description says the field is authoritative so the agent knows to read it that way.
- `instructions` carries only what no description can carry, ordered so that content leads, and sized against a 2048-character budget with a test that fails CI when the budget is exceeded.
- Removing prose from `instructions` is legitimate only where a description already carries it. Anything else moves into the relevant description rather than being deleted.

## Consequences

- The `instructions` preamble is now 693 characters and holds only cross-cutting guidance no single tool owns: the vault's role as a second brain, the operations-vs-semantic routing rule, and the project-scope discovery order. The per-tool sections and the multi-vault section are gone, because every multi-vault-aware description already carries the fan-out contract and the registered vault names, appended through `describeMultiVault` (`src/lib/vault-param.ts`).
- Vault conventions now travel primarily on the `get_vault_overview` response, where they are uncapped by the client and reach sub-agents. See [`docs/architecture/vault-conventions.md`](../architecture/vault-conventions.md).
- The next context-delivery feature starts from a description or a response, not from `instructions`. This is a real constraint: it means context that only makes sense globally has to be attached to whichever tool the agent would call anyway, or accept best-effort delivery.
- Tool descriptions carry more weight and therefore more prose. They are also the more expensive channel — every description is sent on every `tools/list` — so the discipline is to say each thing once, on the one tool that owns it, not to duplicate across descriptions.
- Duplication between `instructions` and the response channel is accepted. A client with no cap sees the conventions twice; that is cheaper than absence in the only channel that reaches sub-agents.
- Regressions are caught by a budget test rather than by review. Adding to the preamble without shrinking something else turns CI red.

## Alternatives considered

- **Keep `instructions` as the primary channel and merely shrink the preamble** — leaves the irreplaceable content behind a variable amount of prose, so the fix silently regresses the next time the preamble grows.
- **Enforce the budget in code, throwing at startup above N characters** — over-engineering for a constant; a test asserting what a truncating client actually sees covers it, and covers ordering too.
- **Fix the cap upstream and wait** — the truncation and the missing sub-agent `instructions` are client behaviours on someone else's release schedule; at most this is an upstream issue, never a dependency.
