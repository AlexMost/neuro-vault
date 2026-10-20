# Brainstorm — graph-read-errors

Tracked by #212. Follow-up from PR #211 (graph-in-daemon, #172).

## Background

Since the graph-in-daemon change, every tool reads a vault's wikilink graph through
`IGraphReader`. With vault clients (the default and `--no-shared`), the reader is
`createGraphReaderView(client)`. It turns every failure into a `GraphReadError`: `GRAPH_FAILED`,
`NOT_ATTACHED`, `VAULT_UNAVAILABLE`, a timeout, a dropped connection, or an answer of the wrong
shape. Nothing above the view maps that error. A single-vault tool call therefore answers with
the raw message and no code. A fan-out lists the vault in `failed_vaults` as `INTERNAL_ERROR`
with the raw message, so daemon internals reach the client. Under `--no-semantic`, the reader
is `createGraphReader` over the session's own `WikilinkGraphIndex`, and a failed build propagates
as whatever the build threw.

The lexical leg settled the same question earlier. `LexicalSearchError` is the one error a
lexical reader throws (the standalone reader wraps its in-process failures too).
`search_notes` maps it to `DEPENDENCY_ERROR` with the message `Lexical search failed` and
`details: { vault, operation: 'search_notes' }`, and writes the cause to stderr only.

## Brief (from the session that started this work)

Map a `GraphReadError` that can reach a client to
`ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault, operation }, cause })`
and write the cause to stderr. Places: `search_notes` (backlink stamping), `get_note_links`,
`get_vault_overview` and the `vault://overview` resource, `query_notes`, `read_daily`, and
`get_similar_notes` (forward-link resolve). Use one shared helper, not per-tool copies.

## Decision log

**Q1 — Where does the mapping live?** It lives in a decorator over the reader. The decorator
takes `(entry, operation)` and returns an `IGraphReader` whose reads map `GraphReadError`. Each
consumer passes it where it passes `entry.graph` today.
- Rejected: a `try/catch` around each tool's whole body. It would catch any `GraphReadError`
  thrown anywhere inside, and the lib functions (`runQueryNotes`, `computeVaultOverview`,
  `getNoteLinks`) would stay unaware either way. The decorator catches only graph reads, and it
  is one line per consumer.
- Rejected: mapping inside the view. The view is below the tool layer and does not know the
  operation. It also serves the daemon-agnostic `IGraphReader` contract, which other hosts
  reuse.

**Q2 — What passes through unmapped?** Anything that is not a `GraphReadError`. A bug (a
`TypeError`) keeps reading as one, as it does for the lexical leg.

**Q3 — `--no-semantic`.** (My call; not in the brief.) Under `--no-semantic`, the session's
graph reader wraps a failed build in `GraphReadError`. Without that, a failed in-process build
would bypass the mapping, and "a failed graph read is `DEPENDENCY_ERROR`" would hold only with a
daemon. The standalone lexical reader already does the same for `LexicalSearchError`. The
shared `createGraphReader` stays unwrapped, because the vault entry's daemon service maps its
own failures to `GRAPH_FAILED`.

**Q4 — Fail or degrade?** (My call; consistent with the brief.) The call fails. A failed read
fails that vault's call: the whole call for a single-vault target, or one `failed_vaults` entry
in a fan-out. `DEPENDENCY_ERROR` is not a fatal-class code, so a fan-out keeps the other vaults.
Degrading was rejected. For example, `search_notes` with `backlink_count: 0` or `read_daily`
without `notes_today` would quietly return wrong numbers, which is worse than a retryable error.

**Q5 — `details.operation`.** It is the tool's name. For the resource it is the resource's URI
(`vault://overview` or `vault://<name>/overview`), because no tool name applies.

**Q6 — stderr line.** It mirrors the lexical one:
`neuro-vault graph: <operation> failed for vault "<vault>": <cause message>`. `search_notes`
passes its injectable `warn`. Every other caller writes with `console.error`, as the lexical
leg's default does.

## Size

Small. The work is one helper, a standalone wrapper, seven one-line call-site changes, tests,
a spec requirement and docs. It ships in one PR with `Closes #212`.
