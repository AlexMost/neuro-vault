<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — inline `#tags` in the listTags scan

## Background

Source: a private vault task note on inline `#tags` in the listTags scan (created 2026-07-17).

After the headless fs-migration (`migrate-off-obsidian-cli`), `FsVaultProvider.listTags` counts **frontmatter tags only**. The old obsidian-cli backend counted frontmatter + inline `#tags` in note bodies, so counts diverged after the migration. Smoke test that surfaced it: a note with frontmatter tag `ttag` and inline `#fsprovider-smoke` in the body — `ttag` counted, `#fsprovider-smoke` absent from `list_tags` entirely.

The divergence was a **deliberate, documented trade-off** in the parent change:

- `openspec/changes/migrate-off-obsidian-cli/design.md` (trade-off entry): frontmatter-only accepted for consistency with `query_notes`' tag definition.
- `openspec/specs/headless-vault-operations/spec.md` — requirement "Tag and property listings aggregate from the frontmatter scan" with an explicit scenario "Inline body tags are not counted".
- `docs/adr/0009-disk-direct-vault-operations.md` §Consequences (a) — listed as a known regression.

This change closes that gap: the task note says "тепер закриваємо".

## Current-state findings (code exploration)

- `FsVaultProvider.listTags` (`src/modules/operations/fs-vault-provider.ts:286`) aggregates over `scanFrontmatter()` — `reader.readNotes({ paths, fields: ['frontmatter'] })`, all paths in one unbatched `Promise.all`. Bodies **are read from disk** by `readOne` and discarded (`vault-reader.ts:144-146` comment warns against retaining them vault-wide).
- Tag extraction is `extractTags(frontmatter)` (`src/lib/obsidian/query/note-record.ts:15`) — shared with `query_notes` and `search_notes` `filter.tags`. `query_notes` tool description promises "extracted from the `tags:` frontmatter field".
- Counting today does **not dedupe within a note** (`tags: [alpha, alpha]` counts alpha twice).
- `get_vault_overview.top_tags` delegates to `provider.listTags()` (`src/lib/obsidian/vault-overview.ts`) — no separate path.
- No inline-tag extractor or code-fence stripping exists in `src/`. The only markdown parser is `mdast-util-from-markdown` via `src/lib/obsidian/lexical/blocks.ts` (already a direct dep); its walk currently *includes* `code` nodes, so inline-tag use needs a variant, not reuse.
- Batching precedent: `READ_BATCH_SIZE = 32` in `query-notes.ts` and `wikilink-graph.ts`.
- `splitFrontmatter` failure mode: unparseable YAML → `{ frontmatter: null, content: raw }` where `content` includes the raw frontmatter block — an inline scan could pick tags out of broken YAML.

## Decision chain

### Q1 — Scope: which tools gain inline tags?

**Decision: `list_tags` (and therefore `get_vault_overview.top_tags`) only.** `query_notes` / `search_notes` `filter.tags` stay frontmatter-only.

- The task note scopes explicitly to "`list_tags` (і tags-секція `get_vault_overview`)".
- `extractTags` is shared and contract-guarded (`query_notes` description, `note-record.test.ts`, hybrid-search spec "filter applies identically to both legs"). Touching it would silently widen filter semantics on two other tools and force body reads on every query — separate contract change, out of scope.
- Consequence accepted: `list_tags` may report a tag that a `query_notes` `tags` filter can't find (inline-only tags). This asymmetry is documented in the spec delta and both tool descriptions; a follow-up change can extend filters if it ever hurts in practice.

### Q2 — Tag grammar fidelity? (open question in the task note; resolved with user, 2026-08-08)

**Decision: Obsidian-documented grammar, not full parity, not bare regex.**

- Allowed characters: `[A-Za-z0-9_/-]`; nested tags (`#a/b`) supported.
- A tag must contain **≥1 non-numeric character** (`#123` is not a tag — matches Obsidian's documented rule).
- Must be preceded by start-of-text or whitespace (kills `example.com/#section`, `[[Note#heading]]`).
- Extraction runs over mdast text content with `code` / `inlineCode` nodes skipped — code fences, indented code, and inline code are excluded structurally, not by regex heuristics. Heading markers (`## Heading`) never appear in text nodes, so they're excluded for free; a genuine `#tag` inside heading text still counts (matches Obsidian).
- Declined alternatives: bare `#[\w/-]+` regex (lets `#123` and fence contents through, or needs hand-rolled fence stripping); full Obsidian parity incl. Unicode letters and `%%comment%%` handling (test-surface cost out of proportion for counters). Known limit of the decision: non-ASCII (e.g. Cyrillic) inline tags won't be counted — noted as a risk, acceptable for now.

### Q3 — Where does extraction live?

**Decision: new small module `src/lib/obsidian/inline-tags.ts`** exporting `extractInlineTags(body: string): string[]` (deduped, order-insignificant). Uses `fromMarkdown` directly (like `blocks.ts` does) with a walk that skips `code`/`inlineCode`. Keeps `blocks.ts` untouched and gives the extractor its own unit-test surface.

### Q4 — Aggregation & memory profile

**Decision: per-note union + per-note dedup, batched reads.**

- Per note: `set = dedupe(frontmatterTags) ∪ inlineTags`; each tag in the set increments its count once. This also fixes the existing double-count of duplicated frontmatter entries (`tags: [alpha, alpha]` → 1) — behavior change folded into the same spec requirement.
- `listTags` switches from `scanFrontmatter()` to a batched scan (`READ_BATCH_SIZE = 32`, same constant/pattern as `query-notes.ts`) with `fields: ['frontmatter', 'content']`, extracting per batch and never retaining bodies — respects the memory constraint `vault-reader.ts` documents. `listProperties` keeps using `scanFrontmatter()` unchanged.
- Sort contract unchanged: count desc, then name asc.

### Q5 — Broken-frontmatter edge

When YAML parsing fails, `content` is the whole raw file including the broken `---` block; inline scan would see `#`-strings inside it. **Decision: accept as-is** — mdast will mostly treat the stray `---` block as thematic breaks/paragraphs; the note has no frontmatter tags in that state anyway, and guarding it means re-implementing fence detection. Not worth it for counters. Documented as a known edge, covered by one test pinning current behavior.

## Acceptance criteria

- `npm test`, `npm run lint`, `npm run typecheck` pass.
- A note with only inline `#beta` contributes `beta` to `list_tags`; frontmatter+inline same-tag note counts once; `#123`, fenced/inline-code `#tags`, URL fragments, and heading markers do not count.
- `get_vault_overview.top_tags` reflects the new counts (via `listTags`, no separate wiring).
- Spec `headless-vault-operations` amended (scenario "Inline body tags are not counted" inverted); ADR-0009 gets a follow-up note; `list_tags` + `query_notes` descriptions clarify the counting-vs-filtering asymmetry.

## Promotion criteria check

1. Scope locked — inline-tag counting in `list_tags`/overview only; filters untouched. ✅
2. Design forks resolved — grammar (user-confirmed), extraction seam, aggregation, scope. ✅
3. Cross-system deps — none external; all in-repo, ready. ✅
4. Acceptance criteria stateable — above. ✅
5. Converging — remaining work is mechanical. ✅
