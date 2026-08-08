## Context

`FsVaultProvider.listTags` ([fs-vault-provider.ts:286](../../../src/modules/operations/fs-vault-provider.ts)) aggregates `{ name, count }` over `scanFrontmatter()` — a full-vault `readNotes({ fields: ['frontmatter'] })`. `readOne` already reads every note body off disk and discards it; the frontmatter-only mode exists specifically so vault-wide scans don't retain bodies in memory ([vault-reader.ts:144-146](../../../src/lib/obsidian/vault-reader.ts)). Tag extraction is `extractTags(frontmatter)` ([note-record.ts:15](../../../src/lib/obsidian/query/note-record.ts)), shared with the `query_notes` / `search_notes` `tags` filter, whose tool contract promises frontmatter-only semantics. `get_vault_overview.top_tags` delegates to `provider.listTags()` — no separate path.

Frontmatter-only counting was an accepted trade-off of `migrate-off-obsidian-cli` (spec scenario "Inline body tags are not counted"; ADR-0009 §Consequences (a)). This change re-adds inline `#tag` counting without disturbing the filter semantics that trade-off was protecting.

Constraints: strict TS/ESM; no new runtime deps (mdast-util-from-markdown already direct); no vault-wide body retention; `{ name, count }` shape and count-desc/name-asc sort are existing contract.

## Goals / Non-Goals

**Goals:**

- `list_tags` (and `get_vault_overview.top_tags`) count the per-note union of frontmatter tags and inline body `#tags`.
- Inline extraction follows Obsidian's documented tag grammar and excludes code fences, inline code, URL fragments, and heading markers.
- Per-note dedup: the same tag in frontmatter and body — or repeated in either — counts once per note.
- Memory profile of the scan stays bounded (batched reads, no body retention).

**Non-Goals:**

- Changing `query_notes` / `search_notes` `filter.tags` semantics or `extractTags` / `NoteRecord.tags` (stays frontmatter-only; asymmetry documented, potential follow-up change).
- `listProperties` (unchanged, keeps `scanFrontmatter()`).
- Full Obsidian parity: Unicode letters in tags, `%%comment%%` stripping, callout/task-specific behavior.
- Caching or incremental scanning for `listTags`.

## Decisions

### D1: Scope — counting only, filters untouched

- **Choice**: only `listTags` learns about inline tags; a new extractor is added rather than widening `extractTags`.
- **Rationale**: the task note scopes to `list_tags` + overview; `extractTags` is contract-guarded on three tool surfaces (`query_notes` description, `search_notes` filter leg, hybrid-search spec "filter applies identically to both legs") and widening it forces body reads on every query.
- **Alternative considered**: extend filters too, restoring counting↔filtering symmetry. Rejected: separate contract change with its own perf cost; the reopened asymmetry (inline-only tags visible in `list_tags` but unfilterable) is accepted and documented in both tool descriptions.

### D2: Tag grammar — Obsidian-documented rules (user-confirmed 2026-08-08)

- **Choice**: a tag is `#` + `[A-Za-z0-9_/-]+` containing ≥1 non-numeric character, preceded by start-of-text or whitespace. Nested `#a/b` counts as one tag, verbatim (no splitting into ancestors). Case preserved as written; dedup is exact-string (matches existing frontmatter handling).
- **Rationale**: matches Obsidian's documented grammar; the ≥1-non-digit rule keeps `#123`/issue-number noise out; whitespace-before rule kills `example.com/#section` and `[[Note#heading]]` without URL parsing.
- **Alternatives considered**: bare `#[\w/-]+` regex (admits `#123`, needs hand-rolled fence handling — rejected); full Obsidian parity incl. Unicode (test-surface cost out of proportion for counters — declined by user).

### D3: Extraction seam — mdast walk in a new module

- **Choice**: `src/lib/obsidian/inline-tags.ts` exporting `extractInlineTags(body: string): string[]` (deduped). Parses with `fromMarkdown` and walks the tree collecting `text` node values, skipping `code` and `inlineCode` nodes, then applies the D2 regex per text value.
- **Rationale**: structural exclusion of fenced/indented/inline code beats regex heuristics; heading markers never appear in `text` nodes so `## Heading` is excluded for free while a genuine `#tag` inside heading text still counts (Obsidian behavior). Dep already present.
- **Alternative considered**: reuse `lexical/blocks.ts` `parseNote` — rejected, it *includes* `code` nodes by design and carries normalization baggage; a focused module gets its own unit-test surface.

### D4: Aggregation — per-note union with dedup, batched scan

- **Choice**: `listTags` switches from `scanFrontmatter()` to a batched loop (`READ_BATCH_SIZE = 32`, same pattern as [query-notes.ts:36](../../../src/lib/obsidian/query/query-notes.ts)) over `readNotes({ fields: ['frontmatter', 'content'] })`; per note compute `Set(extractTags(fm)) ∪ Set(extractInlineTags(content))` and increment each member once. Bodies are dropped with each batch. `sortCounts` unchanged.
- **Rationale**: respects the no-body-retention constraint the reader documents; per-note dedup is what "count = number of notes carrying the tag" means, and it also fixes the pre-existing double-count of duplicated frontmatter entries (`tags: [alpha, alpha]` → 1) — folded into the same requirement.
- **Alternative considered**: keep unbatched all-paths read with content — rejected, holds every body in memory simultaneously, exactly what `vault-reader.ts:144` warns against.

### D5: Broken-frontmatter edge — accept

- **Choice**: when YAML parsing fails, `splitFrontmatter` returns the whole raw file as `content`; the inline scan may see `#`-strings inside the broken block. Accepted as-is, pinned by one test.
- **Rationale**: the note contributes no frontmatter tags in that state anyway; guarding it means re-implementing fence detection for a rare corruption case.

## Risks / Trade-offs

- [Trade-off] Counting↔filtering asymmetry: `list_tags` can report tags `query_notes`' `tags` filter can't match. → Accepted per D1; named explicitly in both tool descriptions so agents aren't surprised; follow-up change can extend filters.
- [Risk] Non-ASCII inline tags (e.g. Cyrillic) are not counted under the D2 charset. → Documented limit; frontmatter tags of any script still count; revisit only if it bites in practice.
- [Risk] `listTags` gets slower (mdast parse per note, full-body processing). → It's an infrequent, agent-invoked operation; batching keeps memory flat; no caching until proven needed (wikilink-graph precedent exists if it is).
- [Risk] Count changes may surprise existing consumers comparing before/after. → Non-breaking shape; release notes via Conventional Commits describe the counting change.
- [Trade-off] Duplicated-frontmatter double-count silently becomes 1. → Intended fix; covered by an explicit scenario so it's contract, not accident.

## Migration Plan

N/A — no deployment, schema, or response-shape change. Ships as a normal minor release (`feat`); rollback = revert the PR. Acceptance: `npm test && npm run lint && npm run typecheck` pass; spec delta synced via `/opsx:sync` at archive time; ADR-0009 follow-up note added.

## Open Questions

None — the task note's single open question (grammar fidelity) was resolved with the user (D2).
