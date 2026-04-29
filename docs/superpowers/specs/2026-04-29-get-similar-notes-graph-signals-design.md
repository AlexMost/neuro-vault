---
status: accepted
date: 2026-04-29
---

# Extend `get_similar_notes` with forward-link graph signals

## Goal

Make `get_similar_notes(path)` return notes that the source note explicitly references via `[[wikilinks]]` (forward links) **alongside** semantically similar notes — in a single tool call, in a single result list, with a structured `signals` object that tells the caller _why_ each result is here.

The motivating problem (validated on `Resources/LLM Wiki.md`): the strongest deterministic relevance signal in a vault — the author's own `[[wikilinks]]` — is currently invisible to `get_similar_notes`, while noisier semantic neighbours occupy the top of the result list. Forward links and embeddings are different kinds of signals; the tool should expose both as first-class.

This spec is the second of two; it depends on [`2026-04-29-extract-obsidian-lib-design.md`](./2026-04-29-extract-obsidian-lib-design.md) landing first. New utilities introduced here live in `src/lib/obsidian/` from day one.

## Scope

### In scope

- Forward links extracted from the **query note's** body and frontmatter values.
- New `signals` object on each result describing the kinds of evidence that put it there.
- Top-level `similarity` becoming **optional** (a result reachable purely via a forward link has no semantic score).
- `exclude_folders` parameter with sensible defaults (`Templates`, `System`, `Daily`, `Archive`).
- New `wikilink` utilities in `src/lib/obsidian/`.
- Test coverage for parsing, resolution, and the integrated tool handler.

### Out of scope (explicit)

- **Backlinks.** Computing "who links to me" requires an inverse index across the whole vault. We are explicitly deferring this to a later spec; the `signals` shape is forward-compatible (a `backlink?: true` field can be added without breaking the contract).
- Tag signals. Tags in this vault are too coarse-grained; they would dilute the result more than they enrich it.
- Wikilink resolution against notes that are **not** in the Smart Connections corpus. Targets are resolved via the in-memory `sources` map only — see Resolution Strategy below.
- An on-disk or warm cache for forward links. Each call re-reads the query note from disk; this is one file read, negligible cost.
- Backwards compatibility with the existing `SearchResult[]` shape. The tool is young, the consumer surface is small (the `agent-note` skill, mainly); a one-time call-site update is cheaper than carrying a flag forever.

## API

```ts
get_similar_notes({
  path: string,
  limit?: number,                 // default 10
  threshold?: number,             // default 0.5, range [0, 1]
  exclude_folders?: string[],     // default ['Templates', 'System', 'Daily', 'Archive']
}) => Array<{
  path: string,
  similarity?: number,            // present iff semantic ≥ threshold
  signals: {
    semantic?: number,            // mirrors top-level similarity for caller convenience
    forward_link?: true,          // the query note links to this result via [[...]]
  }
}>
```

Notes:

- `signals` is **always** present and **always** an object. At least one signal field is set; results with no signal are filtered out before return.
- A result with only `forward_link: true` (no `semantic`) has no top-level `similarity`. Callers ranking purely by similarity must guard for `undefined`.
- `exclude_folders` accepts a list of folder names / path prefixes. Each entry is normalized by stripping a trailing `/` and then matched as `path === entry || path.startsWith(entry + '/')` against the POSIX vault-relative path. So `Templates` matches `Templates/Foo.md` and `Templates/sub/Bar.md` but not `MyTemplates/Foo.md`. Case-sensitive. Empty array disables exclusions entirely.

### Existing parameters — unchanged behavior

`path`, `limit`, `threshold` keep their current semantics. `threshold` only filters the **semantic** branch; forward-linked results bypass it.

## Pipeline

For each call:

1. **Resolve query source.** Lookup `sources.get(path)` for the embedding. Same `NOT_FOUND` error path as today.
2. **Semantic candidates.** Call `searchEngine.findNeighbors({ queryVector, sources, threshold, limit: undefined, excludePath })`. We deliberately do not pass `limit` here so semantic candidates aren't truncated before the union (final truncation happens in step 7). Map results to `{ path, signals: { semantic: similarity } }`.
3. **Read query note.** New DI dep `readNoteContent: (vaultRelativePath) => Promise<string>`, defaulted in `createSemanticModule` to `fs.readFile(path.join(vaultPath, p), 'utf8')`.
4. **Extract forward links.** Use new `lib/obsidian/wikilink.ts` and `lib/obsidian/frontmatter-links.ts`:
   - Split frontmatter via existing `splitFrontmatter` (now under `lib/obsidian/`).
   - Extract `[[...]]` matches from body.
   - Recursively walk frontmatter object; for any string value, extract `[[...]]` matches. Frontmatter property keys are not whitelisted — any string anywhere in YAML that contains `[[X]]` is treated as a forward link.
5. **Resolve targets to vault paths.** For each raw `[[Target]]`:
   - Strip `#heading` and `|alias` suffixes.
   - If the target contains `/`, treat as a path; lookup directly in `sources`.
   - Otherwise, basename lookup against a basename → paths index built once per `createSemanticModule` invocation from `sources` keys. Multiple matches → pick lexicographically first. Zero matches → silently skip (broken link).
   - Targets resolving to the query path itself are dropped.
   - Map resolved targets to `{ path, signals: { forward_link: true } }`.
6. **Union by path.** Merge semantic and forward-link candidates, keyed by path. When a path appears in both, the merged record carries both `signals.semantic` (number) and `signals.forward_link` (`true`); top-level `similarity` is set from the semantic value.
7. **Filter** out: query path, `exclude_folders` prefix matches, `pathExists === false` (existing stale-path guard).
8. **Sort** the union by composite key:
   1. `forward_link` first (a `true` ranks above `undefined`).
   2. Within the same `forward_link` bucket, by `signals.semantic` desc (treat `undefined` as `-Infinity`).
   3. Within the same similarity, by `path` ascending (stable, deterministic).
9. **Truncate** to `limit`. Forward-linked items count against the budget; if there are more forward links than `limit`, lower-`similarity` semantic-only results fall out first because of the sort, and the truncation honours the explicit-link priority. There is no soft "always include all forward links" override — `limit` is hard, the caller controls response size.

### Why this ranking

The forward link is an explicit relevance assertion by the note's author; semantic similarity is an inferred guess. When budget-constrained, the explicit signal wins. Within the linked bucket, secondary semantic similarity is used to order. Lex-by-path is the tie-breaker for determinism.

## New code in `src/lib/obsidian/`

### `wikilink.ts`

```ts
/** Parse [[Target]], [[Target#Heading]], [[Target|alias]] from arbitrary text. Returns the raw target strings (without brackets, before # or |). */
export function parseWikilinks(text: string): string[];

/** Strip "#heading" and "|alias" suffixes, returning the bare target. */
export function normalizeWikilinkTarget(raw: string): string;
```

Regex: `/\[\[([^\[\]\n]+)\]\]/g`. Embeds `![[...]]` _are_ matched and treated as forward links — embedding a note in another note is also a relevance assertion.

### `frontmatter-links.ts`

```ts
/** Recursively walk a frontmatter object; collect [[...]] targets from every string value. */
export function extractWikilinksFromFrontmatter(fm: Record<string, unknown>): string[];
```

Walk arrays and nested objects. Non-string leaves (numbers, booleans, nulls) are ignored.

### `link-resolver.ts`

```ts
export interface BasenameIndex {
  resolve(target: string): string | null;
}

/** Build a basename → first-matching-path index from an iterable of vault paths. Multiple paths sharing a basename: keep the lexicographically smallest. */
export function buildBasenameIndex(paths: Iterable<string>): BasenameIndex;
```

The resolver takes a normalized target (after `normalizeWikilinkTarget`) and returns the resolved vault path or `null`. Targets containing `/` are looked up as exact paths against the source set rather than by basename.

These three files are the only **new** Obsidian-format additions in this spec. Everything else is consumed via the existing `lib/obsidian/` surface.

## Changes to existing files

### `src/modules/semantic/tools/get-similar-notes.ts`

- Add new fields to `GetSimilarNotesDeps`:
  - `readNoteContent: (vaultRelativePath: string) => Promise<string>`
  - `basenameIndex: BasenameIndex` (built at module init from `sources` keys)
- Replace the current `findNeighbors → filter → return` pipeline with the 9-step pipeline above.
- Update the Zod input schema to add `exclude_folders: z.array(z.string()).optional()`.
- Tool description updated to mention forward links: _"Find related notes — both semantically similar and explicitly linked from this note via `[[wikilinks]]`."_
- Output type changes from `SearchResult[]` to a new `SimilarNoteResult[]` defined in `semantic/types.ts`.

### `src/modules/semantic/types.ts`

- Add:
  ```ts
  export interface SimilarNoteResult {
    path: string;
    similarity?: number;
    signals: {
      semantic?: number;
      forward_link?: true;
    };
  }
  ```
- `SearchResult` is unchanged; it stays the internal type used by `findNeighbors` and the unrelated tools (`search_notes`, `find_duplicates`).

### `src/modules/semantic/index.ts` (`createSemanticModule`)

- Build `basenameIndex` from `corpus.sources` keys after corpus load (one pass, O(n) memory in number of notes — acceptable).
- Default `readNoteContent` to a closure over `vaultPath`.
- Pass both into `buildGetSimilarNotesTool`.

## Error handling

| Condition                                             | Behavior                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `path` not in `sources`                               | `ToolHandlerError('NOT_FOUND')` (unchanged)                                                        |
| Query note file disappeared after corpus load         | `ToolHandlerError('NOT_FOUND')` with `details.path`. Race window in practice; cheap to handle.     |
| `readNoteContent` throws non-ENOENT                   | Wrap as `DEPENDENCY_ERROR` (existing pattern via `wrapDependencyError`)                            |
| Frontmatter parse fails                               | Already handled by `splitFrontmatter`: warns, returns null frontmatter; we proceed with body only. |
| Wikilink target cannot be resolved                    | Silently skip — broken or unembedded link, no result emitted.                                      |
| Wikilink target resolves to query path                | Silently skip.                                                                                     |
| Wikilink target resolves to an `exclude_folders` path | Filtered out at step 7.                                                                            |

## Tests

### Unit — `test/lib/obsidian/wikilink.test.ts`

- Single bare link: `[[Foo]]` → `["Foo"]`.
- Heading variant: `[[Foo#Bar]]` → `["Foo#Bar"]` (raw); `normalizeWikilinkTarget` strips → `"Foo"`.
- Alias variant: `[[Foo|Bar]]` → normalized → `"Foo"`.
- Embed variant: `![[Foo]]` → `["Foo"]`.
- Multiple links in one paragraph: extracted in order.
- Malformed: unmatched `[[`, nested `[[a[[b]]c]]`, link spanning newline — no matches / clean failure.
- Empty / no-link input → `[]`.

### Unit — `test/lib/obsidian/frontmatter-links.test.ts`

- Top-level string with link: `{ source: "[[X]]" }` → `["X"]`.
- Array of strings: `{ related: ["[[A]]", "[[B]]"] }` → `["A", "B"]`.
- Nested object: `{ meta: { parent: "[[P]]" } }` → `["P"]`.
- Mixed with non-link strings: `{ note: "no links here", related: "[[A]]" }` → `["A"]`.
- Non-string leaves ignored: `{ count: 5, active: true, when: null }` → `[]`.
- Empty object → `[]`.

### Unit — `test/lib/obsidian/link-resolver.test.ts`

- Path-form target (`Folder/X`) resolves to exact match.
- Basename target with single match resolves.
- Basename target with multiple matches resolves to lexicographically smallest path.
- Unknown target → `null`.
- Empty source set → all targets → `null`.

### Integration — `test/semantic/tools/get-similar-notes.test.ts` (extend existing)

Vault fixture has notes A, B, C, D, E with embeddings; A has body `Some text [[B]] and [[C]]` and frontmatter `related: "[[D]]"`.

- A's call returns B, C, D as `forward_link: true` even when their semantic similarity is below threshold.
- E (high semantic similarity, no link) returns with `signals.semantic` set.
- Sort: linked B/C/D rank ahead of semantic-only E regardless of E's similarity.
- A path that is both linked and semantically close has both `signals.semantic` and `signals.forward_link` set, and a top-level `similarity`.
- `exclude_folders: ['Folder1']` removes results whose path begins with `Folder1/`.
- `limit: 2` truncates to two results, preserving the linked-first ordering.
- Broken `[[Nonexistent]]` link is silently skipped (no error, no result).
- A note that is in the corpus but its file was deleted after load: `pathExists` filters it out.

## Definition of Done

1. `npm test` — green; new tests added (parsers, resolver, extended integration).
2. `npm run lint` — clean.
3. `npx tsc --noEmit` — clean.
4. README updated with the new `signals` shape and `exclude_folders` parameter.
5. The breaking change to `get_similar_notes` output shape is called out clearly in the changelog body so external callers (e.g. the user's `agent-note` skill, which lives outside this repo) have the migration cue. Internal callers in this repo, if any, are updated in the same PR.
6. Single PR to `main`. After merge: `npm run release` on `main` produces a **major** version bump — `get_similar_notes` output shape is breaking.

## Architecture doc

Update `docs/architecture/obsidian-lib.md` (created in Spec 1) with a new section listing the wikilink utilities and the basename-index resolver. No new top-level architecture doc.
