# Lexical Search

The lexical leg of `search_notes` (`mode: "hybrid"`, the default, or `mode: "lexical"`) — a hand-rolled, deterministic exact word-prefix matcher over note titles, headings, and body, fully independent of the embedding corpus (it never touches the corpus loader and works on a cold or absent index). The matcher and its cache live in the [vault entry](./vault-entry.md) — in the shared daemon by default — and a session reads them through an `ILexicalReader` ([Who holds the cache](#who-holds-the-cache)).

## What it is

`src/lib/obsidian/lexical/` exports `LexicalIndex` (`lexical-index.ts`), a per-vault cache over the vault's markdown. It is a member of the vault entry (`IVaultEntry.lexicalSearch`, [`vault-entry.md`](./vault-entry.md#what-it-is)), so there is one cache per vault directory per daemon, whatever the number of sessions, and a session served by the daemon parses no note for this leg:

```typescript
class LexicalIndex {
  constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: StatFn; readFile?: ReadFn; warn?: (message: string) => void });
  search(opts: {
    queries: string[];
    allowed?: ReadonlySet<string>; // pre-filter scope, shared with the semantic leg
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): Promise<{
    notes: RankedNote[];
    truncated: boolean; // pool-cap overflow: candidates.length > noteCap, pre-slice
    perQueryCounts: Record<string, number>; // pre-noteCap hits per input query
    perQueryTokenCounts: Record<string, Record<string, number>>; // failure-path only, see below
    totalNotes: number; // scoped scan().length, pre-`filter` — feeds rank-fusion's adaptive k
  }>;
  warm(): Promise<void>; // one refresh; never rejects
  info(): { warmed: boolean; notes: number; lastRefresh?: { at: Date; parsed: number; ms: number } };
}
```

The entry builds one `LexicalIndex` and one `WikilinkGraphIndex` with itself, both over its scoped reader — the graph is the vault's one graph, which also answers `graph.*` ([`wikilink-graph.md`](./wikilink-graph.md#wiring)) — and `IVaultEntry.lexicalSearch` refreshes the graph, then searches with the graph's `getBacklinkCount` as the density tie-break's last key. Both live as long as the entry: a scope change rebuilds them over the new reader, and `dispose()` drops them. They have no idle timer of their own, and an entry attached with `profiles: []` (a vault with `"semantic": false`) keeps them. The cache therefore persists across calls, and across sessions.

### Who holds the cache

A session never builds a `LexicalIndex` for the daemon's or the fallback's sake: it holds an `ILexicalReader` (`reader.ts`), `IRegisteredVault.lexical` ([`vault-registry.md`](./vault-registry.md)), and the pipeline depends on that seam alone:

```typescript
interface ILexicalReader {
  search(opts: { queries: string[]; allowed?: ReadonlySet<string>; noteCap: number; perNoteCap: number }): Promise<ILexicalResult>;
  warm(): Promise<void>; // starts whatever makes the first search fast; never rejects
}
```

`ILexicalResult` has the five fields above (`notes`, `truncated`, `perQueryCounts`, `perQueryTokenCounts`, `totalNotes`). The reader owns the backlink tie-break and the freshness of whatever feeds it, so `getBacklinkCount` is not part of the pipeline's dependencies. Two implementations (`src/modules/semantic/lexical/`), chosen per vault by the session's vault clients ([`semantic-backend.md`](./semantic-backend.md#the-vault-clients)):

| Reader | Used when | What it does |
| --- | --- | --- |
| View (`createLexicalReaderView`) | The semantic module on: the vault's daemon client by default (`--shared`), its in-process client under `--no-shared` | A view over the vault's client, the one its semantic backend is a view over too: a search is `client.call('lexical.search', …)` with the queries, the caps and `allowed` (when given) as an array, mapped back to an `ILexicalResult`; `warm()` is the client's. Over the daemon the call goes over the connection ([`shared-daemon.md`](./shared-daemon.md#the-lexical-service)), 30 s per call, after the vault's one attach; once the process's switch went in-process, or under `--no-shared`, the same call runs the daemon's `lexical` handler in-process over this process's own `VaultEntries` ([`semantic-backend.md`](./semantic-backend.md#the-in-process-side)). |
| Standalone (`createStandaloneLexicalReader`) | `--no-semantic` | A `LexicalIndex` over the session's own reader, tie-broken by the session's own graph — the one `--no-semantic` session graph per vault that its graph reader also reads (`createLexicalOnlyVaultFactories`); the index is constructed with the reader and fills on the first search. No vault clients exist, so nothing attaches and no daemon starts. This is the path every vault had before the cache moved, and `eval/pipelines.ts` uses it. |

`warm()` attaches the vault in the background at startup (every registered vault, a `"semantic": false` one included, with no profile); the standalone reader has nothing to start early. The standalone reader and the view over either client return byte-identical results for the same disk state: a frozen copy of the pre-move index is the oracle the parity tests (`test/semantic/lexical/parity.test.ts`) compare each of the three against.

**Errors.** A reader throws `LexicalSearchError` and nothing else from `search`: an error of the entry's service (`LEXICAL_FAILED`, `VAULT_UNAVAILABLE` from the attach, `NOT_ATTACHED` for an entry that was detached), a timeout, a dropped connection, closed services, a search that threw. The view maps them, and they read the same on both sides because the in-process side answers with the daemon's own handlers. `search_notes` maps it to `DEPENDENCY_ERROR` ("Lexical search failed", `details: { vault, operation: "search_notes" }`) for that vault, and the cause is written to stderr. The failure is that call's alone: it never flips the process's daemon-or-in-process switch (only a failed daemon start does), and a `NOT_ATTACHED` makes the vault's client forget its attach so the next search attaches again. A `search_notes` that arrives while the daemon is still being located or started waits for that connect (typically under a second, at most `POLL_TIMEOUT_MS` in `daemon-connection.ts`, after which the process falls back to its in-process entry); the vault's status still reads `indexing` 0/0 at once.

`notes[]` (the ranked, capped, per-note-grouped result set) is one of the three ordered rank sources `search_notes` fuses into `matches[]` — see [`rank-fusion.md`](./rank-fusion.md). The other fields feed the tool boundary directly rather than the fusion math: `truncated` folds into the tool's top-level `truncated` (leg-level pool overflow, see [rank-fusion.md's truncated-observability section](./rank-fusion.md#truncated-observability-the-1-over-fetch)); `perQueryCounts` is the lexical half of `query_stats` (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md)); `perQueryTokenCounts` is a failure-path diagnostic layered on top of `perQueryCounts` (see [Per-token diagnostic for AND-killed queries](#per-token-diagnostic-for-and-killed-queries) below); `totalNotes` is `N` in rank-fusion's adaptive-`k` formula — the scoped `scan().length` (vault-scope-excluded paths never counted, see [`vault-scope.md`](./vault-scope.md)), taken before `allowed` narrows the search, so `k` does not shrink under a `filter`.

## Pipeline

```
VaultReader.scan()  ──► vault-scope-filtered paths
   │
   ▼
mtime cache (refresh) ──► stat every scoped file; re-parse only changed ones
   │
   ▼
`filter`'s allowed set ──► narrows the candidates; evicts nothing
   │
   ▼
mdast block extraction (blocks.ts) ──► title unit + heading/body units, each with line positions
   │
   ▼
normalize (normalize.ts) ──► lowercase → NFKD → strip marks → apostrophe unify → whitespace collapse
   │
   ▼
AND word-prefix match (match.ts) ──► phrase match, else all-tokens-present, else no match
   │
   ▼
six-tier ranking + density tie-break (rank.ts)
   │
   ▼
global note cap + per-note match cap
   │
   ▼
snippet extraction (snippet.ts) ──► grapheme-safe window, raw-text coordinates
```

### 1. Scan and scope

`reader.scan()` returns every vault-relative path **visible under the vault's scope** — see [`vault-scope.md`](./vault-scope.md) for the exclusion layers (dot-paths, `Templates/`, root `.gitignore`, `.neuro-vault/config.json`); a path excluded there never reaches this leg. When `search_notes` received a `filter`, the tool handler has already computed an `allowed` path set via `listMatchingPaths` (the same pre-filter step the semantic leg uses) and passes it through; `LexicalIndex.search` applies it to the candidates after the refresh, so it narrows what is ranked but never what is cached. This is why `filter` behaves identically on both legs — same allowed-set, evaluated twice.

### 2. mtime cache

`refresh()` runs over the **whole scope**, never over `allowed`: it scans, drops cache entries for paths the scan no longer lists (deletions, vault-scope exclusion), stats every scanned file (`Promise.all`), and re-parses only files whose `mtimeMs` differs from the cached value. `allowed` is applied afterwards, to the candidate map handed to `rankNotes`, and **never evicts**: the cache is shared by every session, so one session's `filter` must not cost the next session a re-parse. `totalNotes` is the scoped count before `allowed`. A file that vanishes between `scan()` and `stat()`, or between `stat()` and `readFile()`, is dropped from the cache rather than surfaced as an error — the same "scan↔read race" tolerance `query_notes` uses.

Refreshes are **serialised**, so a shared cache never runs two at once: a call that finds nothing running starts a refresh; a call that finds one running awaits it and then shares one follow-up refresh with every other call that arrived during the same run. A call is therefore always served by a refresh that began after it arrived (never by a scan that predates it), and a burst costs at most two refreshes. Each refresh hands its callers a snapshot of the notes it saw, so a later refresh mutating the cache cannot change what a waiting call ranks. `warm()` runs one refresh through the same rule and never rejects: a failure goes to the owner's `warn` and the next `search()` refreshes again. `info()` reports whether a refresh has completed, the cached note count and the last refresh (`at`, notes `parsed`, `ms`); the entry maps it to `daemon status`'s `lexical` line ([`shared-daemon.md`](./shared-daemon.md#reporting-vault-state)).

### 3. mdast block extraction

`parseNote` (`blocks.ts`) runs the note body through `mdast-util-from-markdown` and walks the resulting tree:

- The **title** unit is the file basename (no extension) — always compared separately from the body.
- **Heading** nodes become their own unit (with the heading's own text and line range) and also become `currentHeading`, attached to subsequent body units so a body match can report the nearest heading before it — a label, not a `read_notes` address (see [`note-structure.md`](./note-structure.md#selections)).
- **Paragraph, code, and table** nodes become **body** units (raw + normalized text, line range, enclosing heading).
- A **code** node whose language is `compressed-json` produces no unit: it is the payload of an Excalidraw drawing (the plugin's encoded scene), and its letter runs matched short query tokens. The drawing's `Text Elements` section is ordinary paragraphs and stays searchable; a `json` or any other fence is still a body unit, so a drawing saved with compression turned off (its scene in a `json` fence) still matches on its payload.
- **List, list item, and blockquote** nodes are containers — recursed into rather than treated as leaf units, so a checklist item or quoted paragraph becomes its own body unit.

Line positions come straight from mdast node positions, offset by `lineOffset` (the number of lines the frontmatter fence occupied) so `lines` in the response are file-relative, matching what a caller would see opening the note in Obsidian.

Why AST blocks instead of raw lines (see design decision D5 below): markdown paragraphs are frequently hard-wrapped across source lines, so line-based matching would miss phrases split across wrap points; a code fence's contents would be indistinguishable from a heading without a stateful line-scanner. AST blocks give phrase matching across wraps, unambiguous code-fence handling, and heading context for free from node structure.

### 4. Normalize chain

`normalizeWithMap` (`normalize.ts`) is: **lowercase → NFKD decomposition → strip combining marks (`\p{M}`) → apostrophe unification → whitespace collapse (+ trim)**. It also returns an offset map from each normalized character back to its raw-string index, so a match found in normalized coordinates can be projected back onto the original text for snippeting. The map is **not cached**: a cached unit holds only `raw` and `norm` (one JS number per character made the map about two thirds of the cache's heap), and `makeSnippet` rebuilds the map from `raw` when it builds a snippet.

**Apostrophe unification** is a deliberate, explicit step: Ukrainian text uses several codepoint-distinct apostrophe variants (`'`, `ʼ`, `'`, `'`) that Unicode NFKD does **not** fold into one form. Without an explicit unification pass, `об'єкт` / `обʼєкт` / `об'єкт` would be treated as three different strings. The normalizer folds all four into a single straight `'`.

Query tokenization (`tokenizeQuery`) runs the query through the same normalize step and splits on whitespace — punctuation stays attached to tokens, so the query side and the document side always compare like-for-like.

A deliberate side effect: NFKD folds `й`→`и` and `ї`→`і`, which is accepted as a recall bias (pinned by test, not a surprise) — `і`/`и` themselves are distinct letters and are **not** merged.

Matching is **word-prefix**: a token matches only where it starts a word, and its end is free. A stem therefore still matches its Ukrainian inflections (`пошук` matches `пошуком`), while a short token no longer matches inside a longer word, an identifier or a URL path segment (`api` does not match `rapid`). Whole-word matching was rejected because it loses those inflections. The rule was chosen in #228 on the extended eval, where every lexical hit on a control query had been one of those in-word matches.

### 5. AND word-prefix matching

`matchUnit` (`match.ts`) first checks whether the whole normalized query occurs contiguously in the unit at a word start — a **phrase match**. If not, it requires that every query token occur *somewhere* in the unit at a word start (AND semantics across tokens); if any token is missing, the unit does not match at all. Either way it records a **density** (matched characters ÷ unit length, capped at 1) and the first match position, used for tiering and snippeting respectively.

A **word start** is index 0, or a position whose preceding code point is not a word character. A word character is a letter (`\p{L}`), a digit (`\p{N}`) or `_`, as in `\w`; the unified apostrophe is one only after a word character, so it stays inside a word (`об'єкт`, `o'brien`) while an opening quote (`'vector'`, `‘пошук’`, folded to `'` by normalization) still starts one. So `tolerant arguments` matches `tolerant-arguments` token by token (`-` is a boundary) but not `tolerant_arguments`, whose second part follows `_`; the whole identifier and its first part still match. A phrase or token whose first character is not a letter or digit (`/api`, `#tag`, `.env`) is its own boundary and matches at any occurrence. `matchUnit` takes the first qualifying occurrence, scanning past in-word ones, so the recorded position — and the snippet — is the match that counted.

A multiword query split across two separate AST blocks does not match as a phrase — only as tokens, and only if every token lands within the *same* unit. This is an accepted trade-off (see design decision D7), not a bug: block boundaries are the matching unit.

### 6. Six-tier deterministic ranking

`rankNotes` (`rank.ts`) assigns each unit hit a tier: `kindBase + (phrase ? 0 : 1)`, where `kindBase` is title=0, heading=2, body=4 — giving six tiers in ranked order:

1. phrase in title
2. tokens (AND) in title
3. phrase in heading
4. tokens in heading
5. phrase in body block
6. tokens in body block

A note's overall tier is the **best** (lowest-numbered) tier across all its unit hits. Within the same tier, notes are broken by **density** descending (a short title that's *entirely* the query phrase outranks a passing mention buried in a long paragraph), then `backlink_count` descending, then `path` ascending — fully deterministic, byte-for-byte testable, no opaque scoring (contrast with BM25-style ranking, rejected in design decision D7 as unnecessary on this corpus size and non-deterministic across corpus edits).

### 7. Caps and snippets

- **Global note cap** (`noteCap`): set by `effort` through `lexicalPool` (`effort-profiles.ts`). Beside the semantic leg it is the effort's lexical cap (5 quick / 10 deep); when the lexical leg is the only source (`mode: "lexical"`, or no semantic leg to run) it is the effort's merged cap (5 quick / 12 deep), since a smaller pool would only return fewer notes than the call allows (#229). `limit` no longer steers any leg's internal pool — it bounds only the final fused `matches[]` list (see [`rank-fusion.md`](./rank-fusion.md)); a caller who wants a larger lexical candidate pool raises `effort`, not `limit`.
- **Per-note match cap** (`perNoteCap`, ~3): a note's matches are deduplicated across queries by `(matched_in, first line)`, sorted by tier then density, and sliced to the cap — so a note that matches many times still surfaces only its strongest evidence rows.
- **Snippet** (`snippet.ts`): a ~150-character window centered on the match, computed over **graphemes** (`Intl.Segmenter`) so multi-codepoint characters are never split mid-cluster, projected from normalized match coordinates back onto the raw text via an offset map rebuilt from the raw text, with `…` ellipses when the window doesn't reach an edge. Text shorter than the window is returned whole, without building the map. `rankNotes` builds snippets lazily, only for the matches that survive `noteCap` and `perNoteCap`, so the rebuild and the grapheme pass run for at most `noteCap × perNoteCap` units per call rather than for every hit.

### Per-token diagnostic for AND-killed queries

`rankNotes` also computes `perQueryTokenCounts`, a failure-path-only diagnostic that rides alongside `perQueryCounts` (step 6's output) rather than being its own pipeline stage. It exists to answer one question a bare `lexical: 0` can't: for a multi-token query that matched nothing, *which* token was the problem?

An entry appears in `perQueryTokenCounts` only for a query that both (a) tokenizes to two or more tokens and (b) has zero AND-matches in `perQueryCounts` — a single-token miss or any non-zero hit count gets no entry at all, keeping the diagnostic silent in the common case. For a qualifying query, each unique normalized token (deduplicated — a repeated token is counted once, not once per occurrence) is matched independently against the same note set, same normalization, and same `allowed`/`filter` scope as the AND match — `matchUnit(unit.norm, token, [token])` against the title and every body/heading unit — and mapped to the number of notes where that token alone hits. A token with count `0` names a token absent from the (filtered) note set entirely — that is what killed the AND match. Because this per-token count hits if the token appears in *any* unit while the AND match requires all tokens to co-occur within *one* unit (title/heading/paragraph — see `matchUnit`), a query can come back with every token non-zero and still have zero AND-matches: the tokens all exist somewhere, just never together in the same unit. Either way the fix is the same — split the query into an array so each token can match independently instead of requiring one unit to contain all of them.

This mirrors the AND word-prefix semantics exactly — it is not a fuzzy "closest match" search, just the same word-start check run per-token instead of per-query.

## Response mapping

`RankedNote[]` (the `notes[]` field of `search()`'s return value) does not reach the caller as its own top-level list — it is one of the three sources `rank-fusion.ts` fuses into `search_notes`' unified `matches[]` (see [`rank-fusion.md`](./rank-fusion.md)). A note surfaced by this leg gets a `"lexical:title"` / `"lexical:heading"` / `"lexical:body"` entry in that unified entry's `found_in` (one per distinct kind matched), and the `RankedNote`'s per-note match list is carried across verbatim as the entry's `lexical[]`: `{ matched_in, snippet, lines?, heading? }`, capped ~3/note. `matched_queries` (multi-query only) unions with the semantic leg's own `matched_queries` at the fusion boundary rather than staying a lexical-only field. There is **no numeric score** on this evidence — `similarity` remains a semantic-only concept; within this leg's own source order, `matched_in` (title > heading > body, phrase > tokens) carries the ranking signal, and RRF consumes that order rather than any score. See the guide for the full response contract: [`docs/guide/finding-notes.md`](../guide/finding-notes.md#one-search-entry-point).

## Why no search index

The matcher is a per-request scan over in-memory parsed blocks, not a persisted search index (no FlexSearch, MiniSearch, or SQLite FTS5). This was a deliberate choice (design decision **D5** in [`openspec/changes/archive/2026-07-05-hybrid-search-notes/design.md`](../../openspec/changes/archive/2026-07-05-hybrid-search-notes/design.md#d5-hand-rolled-matcher-over-markdown-ast-blocks-no-search-index)): a spike against FlexSearch found no material feature gain for this use case — no match positions (snippets are computed manually regardless), no phrase-adjacency need beyond the top ranking tier, no desire for a numeric score (the response deliberately has none), and Cyrillic support that amounts to the same generic Unicode normalization written here anyway. Candidate selection over the vault's actual scale (~700 notes, <15 MB of markdown) runs in the millisecond range without an index; an index would add lifecycle and staleness management against live Obsidian edits for no corresponding benefit. Revisit if the vault scale grows past roughly 100k notes.

## Freshness model (shared with `query_notes`)

Same precedent as [`query_notes`](./query.md): **no persisted index, no background timers, and nothing that depends on the watcher** — freshness comes from re-scanning per request and stat-ing every scoped file. The cache never consumes watcher events or the reconcile loop's passes: a search never waits on either, and an entry without a watcher (a vault with no corpus, [`vault-entry.md`](./vault-entry.md#the-watcher-follows-the-scope)) serves the same results. The difference from `query_notes` is *what* gets cached: `query_notes` does no caching at all (it re-reads frontmatter every call), while `LexicalIndex` keeps a `path → { mtime, parsed }` cache so unchanged files are not re-parsed, only re-confirmed via `stat`. This bounds the per-call cost to "stat every scoped file, parse only the ones that changed" rather than "parse the whole vault every call" — correctness against live Obsidian edits follows directly from the mtime check, by construction, exactly like `query_notes`'s per-request read. The only background work is `warm()`, one refresh when the entry is created (and again after a scope change) so the first search finds a warm cache.

The tie-break graph follows the same rule: `lexicalSearch` awaits the `ensureFresh()` of the entry's `WikilinkGraphIndex` before ranking (the graph's TTL is `DEFAULT_TTL_MS`, 3 min). The same graph answers the `graph.*` reads, so `search_notes`' per-match `backlink_count` — one `graph.backlinkCounts` over the matches — comes from the same note set as the tie-break, and from the same build unless the TTL ran out or the scope changed between the two calls (see [`wikilink-graph.md`](./wikilink-graph.md)).

## What it deliberately does not do

- Never touches the corpus loader or the embedding provider — the lexical leg works identically whether the corpus is warm, cold, or entirely absent.
- No readiness state on the wire: a search never waits on `warm()` beyond sharing its refresh, and `lexical: warming` appears only in `daemon status`.
- No watcher-driven invalidation and no FTS-backed implementation. Both would fit behind `lexical.search` later; today the cache is read-through.
- No second cache per session: a daemon-served session holds no `LexicalIndex` for this leg at all. Only the standalone reader (`--no-semantic`) builds one in the session.
- No numeric score in the response (design decisions D3/D10) — ordinal position and `matched_in` are considered sufficient signal for an LLM consumer, and it keeps the `similarity`-is-semantic invariant intact.
- No whole-word, regex, or fuzzy matching — normalized word-prefix AND, so a stem keeps matching its Ukrainian declensions (see the normalize chain above). `mode: "semantic"`-style fuzzy tolerance is out of scope for this leg by design.
- No BM25 or other opaque scoring — ranking is six ordinal tiers plus a density tie-break, chosen for determinism (design decision D7).
- No cross-block phrase matching — a phrase split across two AST blocks matches only as independent tokens, and only if every token lands in one block.
