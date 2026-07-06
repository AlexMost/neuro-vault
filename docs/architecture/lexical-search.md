# Lexical Search

The lexical leg of `search_notes` (`mode: "hybrid"`, the default, or `mode: "lexical"`) — a hand-rolled, deterministic exact/substring matcher over note titles, headings, and body, fully independent of the Smart Connections embedding corpus (it never touches the corpus loader and works on a cold or absent index).

## What it is

`src/lib/obsidian/lexical/` exports `LexicalIndex` (`lexical-index.ts`), a per-vault, in-process cache over the vault's markdown that the `search_notes` tool handler queries on every call:

```typescript
class LexicalIndex {
  constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: StatFn });
  search(opts: {
    queries: string[];
    allowed?: Set<string>; // pre-filter scope, shared with the semantic leg
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): Promise<{ notes: RankedNote[]; truncated: boolean }>;
}
```

One `LexicalIndex` instance is created lazily per vault name (a module-level `Map` inside `buildSearchNotesTool`) and lives for the server process's lifetime — so its mtime cache persists across calls, not just within one request.

## Pipeline

```
VaultReader.scan()  ──► scoped paths (optionally narrowed by `filter`'s allowed set)
   │
   ▼
mtime cache (refresh) ──► stat every scoped file; re-parse only changed ones
   │
   ▼
mdast block extraction (blocks.ts) ──► title unit + heading/body units, each with line positions
   │
   ▼
normalize (normalize.ts) ──► lowercase → NFKD → strip marks → apostrophe unify → whitespace collapse
   │
   ▼
AND-substring match (match.ts) ──► phrase match, else all-tokens-present, else no match
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

`reader.scan()` returns every vault-relative path. When `search_notes` received a `filter`, the tool handler has already computed an `allowed` path set via `listMatchingPaths` (the same pre-filter step the semantic leg uses) and passes it through; `LexicalIndex.search` intersects it with the scan before anything else runs. This is why `filter` behaves identically on both legs — same allowed-set, evaluated twice.

### 2. mtime cache

`refresh()` stats every scoped file (`Promise.all`), drops cache entries for paths no longer in scope (deletions, or notes that fell outside `allowed` on a scoped call), and re-parses only files whose `mtimeMs` differs from the cached value. A file that vanishes between `scan()` and `stat()`, or between `stat()` and `readFile()`, is dropped from the cache rather than surfaced as an error — the same "scan↔read race" tolerance `query_notes` uses.

### 3. mdast block extraction

`parseNote` (`blocks.ts`) runs the note body through `mdast-util-from-markdown` and walks the resulting tree:

- The **title** unit is the file basename (no extension) — always compared separately from the body.
- **Heading** nodes become their own unit (with the heading's own text and line range) and also become `currentHeading`, attached to subsequent body units so a body match can report its enclosing section.
- **Paragraph, code, and table** nodes become **body** units (raw + normalized text, line range, enclosing heading).
- **List, list item, and blockquote** nodes are containers — recursed into rather than treated as leaf units, so a checklist item or quoted paragraph becomes its own body unit.

Line positions come straight from mdast node positions, offset by `lineOffset` (the number of lines the frontmatter fence occupied) so `lines` in the response are file-relative, matching what a caller would see opening the note in Obsidian.

Why AST blocks instead of raw lines (see design decision D5 below): markdown paragraphs are frequently hard-wrapped across source lines, so line-based matching would miss phrases split across wrap points; a code fence's contents would be indistinguishable from a heading without a stateful line-scanner. AST blocks give phrase matching across wraps, unambiguous code-fence handling, and heading context for free from node structure.

### 4. Normalize chain

`normalizeWithMap` (`normalize.ts`) is: **lowercase → NFKD decomposition → strip combining marks (`\p{M}`) → apostrophe unification → whitespace collapse (+ trim)**. It keeps an offset map from each normalized character back to its raw-string index, so a match found in normalized coordinates can be projected back onto the original text for snippeting.

**Apostrophe unification** is a deliberate, explicit step: Ukrainian text uses several codepoint-distinct apostrophe variants (`'`, `ʼ`, `'`, `'`) that Unicode NFKD does **not** fold into one form. Without an explicit unification pass, `об'єкт` / `обʼєкт` / `об'єкт` would be treated as three different strings. The normalizer folds all four into a single straight `'`.

Query tokenization (`tokenizeQuery`) runs the query through the same normalize step and splits on whitespace — punctuation stays attached to tokens, so the query side and the document side always compare like-for-like.

A deliberate side effect: NFKD folds `й`→`и` and `ї`→`і`, which is accepted as a recall bias (pinned by test, not a surprise) — `і`/`и` themselves are distinct letters and are **not** merged.

Matching is **substring**, not word-boundary, by design: Ukrainian declensions make substring the right recall bias (`пошук` is a substring of `пошуком`), and it lets `tolerant arguments` match `tolerant-arguments` / `tolerant_arguments` without a tokenizer that understands hyphenation.

### 5. AND-substring matching

`matchUnit` (`match.ts`) first checks whether the whole normalized query appears as a contiguous substring in the unit — a **phrase match**. If not, it requires that every query token appear *somewhere* in the unit (AND semantics across tokens); if any token is missing, the unit does not match at all. Either way it records a **density** (matched characters ÷ unit length, capped at 1) and the first match position, used for tiering and snippeting respectively.

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

- **Global note cap** (`noteCap`): in `mode: "lexical"`, the caller's `limit` steers it directly (falling back to the `effort` default — 5 quick / 10 deep); in `mode: "hybrid"`, `limit` is reserved for the semantic leg, so the lexical cap always uses the `effort` default regardless of `limit`.
- **Per-note match cap** (`perNoteCap`, ~3): a note's matches are deduplicated across queries by `(matched_in, first line)`, sorted by tier then density, and sliced to the cap — so a note that matches many times still surfaces only its strongest evidence rows.
- **Snippet** (`snippet.ts`): a ~150-character window centered on the match, computed over **graphemes** (`Intl.Segmenter`) so multi-codepoint characters are never split mid-cluster, projected from normalized match coordinates back onto the raw text via the offset map, with `…` ellipses when the window doesn't reach an edge. Text shorter than the window is returned whole.

## Response mapping

The tool handler maps each `RankedNote` into the MCP-facing `lexical_matches[]` item: `{ path, backlink_count, vault, matched_queries? (multi-query only), matches: [{ matched_in, snippet, lines?, heading? }] }`. There is **no numeric score** on lexical items — `similarity` remains a semantic-only concept; order plus `matched_in` (title > heading > body, phrase > tokens) carry the ranking signal instead. See the guide for the full response contract: [`docs/guide/finding-notes.md`](../guide/finding-notes.md#one-search-entry-point).

## Why no search index

The matcher is a per-request scan over in-memory parsed blocks, not a persisted search index (no FlexSearch, MiniSearch, or SQLite FTS5). This was a deliberate choice (design decision **D5** in [`openspec/changes/hybrid-search-notes/design.md`](../../openspec/changes/hybrid-search-notes/design.md#d5-hand-rolled-matcher-over-markdown-ast-blocks-no-search-index)): a spike against FlexSearch found no material feature gain for this use case — no match positions (snippets are computed manually regardless), no phrase-adjacency need beyond the top ranking tier, no desire for a numeric score (the response deliberately has none), and Cyrillic support that amounts to the same generic Unicode normalization written here anyway. Candidate selection over the vault's actual scale (~700 notes, <15 MB of markdown) runs in the millisecond range without an index; an index would add lifecycle and staleness management against live Obsidian edits for no corresponding benefit. Revisit if the vault scale grows past roughly 100k notes.

## Freshness model (shared with `query_notes`)

Same precedent as [`query_notes`](./query.md): **no watcher, no background timers, no persisted index** — freshness comes from re-scanning per request and stat-ing every scoped file. The difference is *what* gets cached: `query_notes` does no caching at all (it re-reads frontmatter every call), while `LexicalIndex` keeps a `path → { mtime, parsed }` cache so unchanged files are not re-parsed, only re-confirmed via `stat`. This bounds the per-call cost to "stat every scoped file, parse only the ones that changed" rather than "parse the whole vault every call" — correctness against live Obsidian edits follows directly from the mtime check, by construction, exactly like `query_notes`'s per-request read.

## What it deliberately does not do

- Never touches the Smart Connections corpus loader or the embedding provider — the lexical leg works identically whether the corpus is warm, cold, or entirely absent.
- No numeric score in the response (design decisions D3/D10) — ordinal position and `matched_in` are considered sufficient signal for an LLM consumer, and it keeps the `similarity`-is-semantic invariant intact.
- No word-boundary, regex, or fuzzy matching — pure normalized-substring AND, chosen deliberately for recall over Ukrainian declensions (see the normalize chain above). `mode: "semantic"`-style fuzzy tolerance is out of scope for this leg by design.
- No BM25 or other opaque scoring — ranking is six ordinal tiers plus a density tie-break, chosen for determinism (design decision D7).
- No cross-block phrase matching — a phrase split across two AST blocks matches only as independent tokens, and only if every token lands in one block.
