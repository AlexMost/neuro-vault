Tracked by: #212

## Why

A failed read of a vault's wikilink graph reaches the client unmapped. The causes include a
daemon timeout, a dropped connection, `GRAPH_FAILED` and `NOT_ATTACHED`. A single-vault call
answers with the raw message and no error code. A fan-out lists the vault in `failed_vaults` as
`INTERNAL_ERROR`, so daemon internals leak to the client. Clients cannot tell a transient
dependency failure from a bug. The lexical leg already answers the same failures with
`DEPENDENCY_ERROR` and a generic message, so graph reads should match it.

## What Changes

**A failed graph read is `DEPENDENCY_ERROR`**
- From: a `GraphReadError` propagates. It reaches the client with no code (single vault) or
  as `INTERNAL_ERROR` (fan-out), carrying the raw message.
- To: `DEPENDENCY_ERROR`, message `Graph read failed`, `details: { vault, operation }`. The
  cause is written to stderr and never sent to the client. This applies to `search_notes`,
  `get_note_links`, `get_vault_overview`, the `vault://overview` resources, `query_notes`,
  `read_daily` and `get_similar_notes`.
- Impact: the error code on the wire changes for these failures only. It is not breaking:
  success payloads and every other error are unchanged.

**Under `--no-semantic`, a failed graph build is a `GraphReadError` too**, so the mapping
above holds without a daemon.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `shared-wikilink-graph`: a failed graph read (from the view, or from the session's own graph
  under `--no-semantic`) fails that vault's call with `DEPENDENCY_ERROR`, a generic message, and
  the cause on stderr only.

## Impact

- **Code.** New: `src/lib/tool-graph.ts` (`graphForTool`) and
  `src/modules/semantic/graph/standalone-reader.ts`. Changed: the seven consumers listed above
  and `src/modules/semantic/index.ts`.
- **Docs.** `docs/architecture/wikilink-graph.md`, `docs/architecture/vault-registry.md`, and
  `docs/guide/` (the failure note in `finding-notes.md` and `reading-and-modifying.md`).
- **Not here.** Retrying a failed read and degrading instead of failing. The lexical leg's
  mapping is unchanged. Resource reads get the generic message, not a structured
  `DEPENDENCY_ERROR`: the resource error envelope is a separate change.
