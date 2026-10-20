## Context

Every tool reads a vault's wikilink graph through `IGraphReader` (`entry.graph`). With vault
clients, the reader is `createGraphReaderView(client)`, which throws only `GraphReadError`. Under
`--no-semantic`, it is `createGraphReader` over the session's own `WikilinkGraphIndex`, which wraps
nothing. Neither path is mapped above the reader. `search_notes` already maps the lexical leg's
`LexicalSearchError` to `DEPENDENCY_ERROR` (`Lexical search failed`,
`details: { vault, operation }`, cause to stderr). This change gives graph reads the same
treatment (brainstorm.md, Q1–Q6).

## Goals / Non-Goals

**Goals:**
- Every `GraphReadError` that can reach a client becomes
  `ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault, operation }, cause })`.
  The cause goes to stderr.
- One helper owns the mapping. Each consumer changes one expression.
- Under `--no-semantic`, a failed graph build is a `GraphReadError`, so the mapping holds there
  too.

**Non-Goals:**
- Retrying, or degrading to `backlink_count: 0` or an empty `notes_today`.
- Changing the lexical leg's mapping or the view's own error mapping.
- Mapping errors that are not a `GraphReadError`.

## Decisions

### D1: A decorator over the reader, `graphForTool(entry, operation, warn?)`
- **Choice**: `src/lib/tool-graph.ts` exports `graphForTool(entry, operation, warn = console.error)`.
  `entry` is a `Pick<IRegisteredVault, 'name' | 'graph'>`, and the function returns an
  `IGraphReader`. Each read delegates to `entry.graph`. A rejection with a `GraphReadError`
  writes `neuro-vault graph: <operation> failed for vault "<name>": <message>` through `warn`, then
  throws `ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault, operation }, cause })`.
  Any other rejection is rethrown as is.
- **Why**: it catches only graph reads. Each consumer swaps `entry.graph` for
  `graphForTool(entry, '<operation>')`, and the lib functions that take a reader
  (`runQueryNotes`, `computeVaultOverview`, `getNoteLinks`) stay unchanged.
- **Alternatives considered**: a `try/catch` around each tool body. It is a per-tool copy, and
  it would also catch a `GraphReadError` from anywhere else in the body. Mapping inside the view
  was also considered: the view does not know the operation, and it implements the host-neutral
  `IGraphReader`.

### D2: The `--no-semantic` graph wraps its failures
- **Choice**: `createStandaloneGraphReader(graph)` in `src/modules/semantic/graph/standalone-reader.ts`
  wraps `createGraphReader(() => graph)`. It rethrows any rejection as
  `GraphReadError('graph read failed: <message>', { cause })`, and passes a `GraphReadError`
  through. `createLexicalOnlyVaultFactories().graphFactory` uses it.
- **Why**: it mirrors `createStandaloneLexicalReader`, which wraps in-process failures in
  `LexicalSearchError`. `createGraphReader` stays unwrapped, because the vault entry's `graph`
  service maps its failures to `GRAPH_FAILED` itself.
- **Alternatives considered**: an option on `createGraphReader`. It would be a flag that only
  one caller sets, while a named module per host matches the lexical side.

### D3: A failed read fails the vault's call
- **Choice**: no degrade. For a single-vault target the whole call fails. In a fan-out the vault
  becomes a `failed_vaults` entry: `DEPENDENCY_ERROR` is not fatal-class, so the other vaults
  still answer.
- **Why**: a silent `backlink_count: 0` or a missing `notes_today` is a wrong answer that looks
  right. A retryable error is better.

### D4: `operation` names
- **Choice**: the tool name. The overview resource uses its URI (`vault://overview`,
  `vault://<name>/overview`).

## Risks / Trade-offs

- [Risk] A consumer added later reads `entry.graph` directly and misses the mapping. →
  Mitigation: the architecture doc's consumer table names `graphForTool` as the way in, and
  `IRegisteredVault.graph`'s doc comment points to it.
- [Trade-off] The client loses the cause text (for example "daemon did not answer
  graph.backlinkCounts in time"). → Accepted: it goes to stderr, as the lexical leg's does, and
  the code tells the client to retry.
- [Risk] A test asserts the mapping on only one path (single vault or fan-out). → Mitigation:
  tests cover both shapes, through the registration gate. `search_notes` covers a fan-out
  `failed_vaults` entry, `get_note_links` a single-vault call.

## Migration Plan

N/A. No deploy or data change. Clients that branched on `INTERNAL_ERROR` for these failures see
`DEPENDENCY_ERROR` instead.

## Open Questions

None.
