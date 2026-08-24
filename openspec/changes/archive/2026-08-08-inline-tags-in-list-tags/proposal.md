## Why

After the headless fs-migration (`migrate-off-obsidian-cli`), `list_tags` counts frontmatter tags only; inline `#tags` in note bodies are ignored. The obsidian-cli backend counted both, so tag counts silently diverged from what the vault actually contains — a note tagged only inline is invisible to `list_tags` and to `get_vault_overview.top_tags`. The gap was accepted as a documented trade-off in the parent change (ADR-0009 §Consequences (a)); a private vault task note now closes it so tag listings reflect the real tagging picture.

## What Changes

**`list_tags` counting (and `get_vault_overview.top_tags` via `listTags`)**

- From: counts aggregate frontmatter `tags:` values only; inline body `#tags` are excluded by requirement; duplicated frontmatter entries in one note count multiple times.
- To: counts aggregate the per-note union of frontmatter tags and inline body `#tags` (Obsidian-documented grammar: `[A-Za-z0-9_/-]`, nested `#a/b`, ≥1 non-numeric char, whitespace/start-of-text before `#`; code fences, inline code, URL fragments, and heading markers excluded), deduplicated within a note — each distinct tag counts once per note.
- Reason: fs-provider counts must reflect actual vault tagging, matching pre-migration behavior.
- Impact: non-breaking response shape (`{ name, count }` unchanged, sort order contract unchanged); counts change for vaults using inline tags or duplicated frontmatter entries.

**Counting vs. filtering asymmetry (documented, not changed)**

- `query_notes` / `search_notes` `filter.tags` remain frontmatter-only (`extractTags` untouched). `list_tags` and `query_notes` descriptions gain a sentence naming the asymmetry: `list_tags` may report inline-only tags that a `tags` filter cannot match.

**Docs**

- ADR-0009 gets a follow-up note (the known regression (a) is resolved); `docs/architecture/` page for vault operations updated if it states frontmatter-only counting.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `headless-vault-operations`: the requirement "Tag and property listings aggregate from the frontmatter scan" changes — tag counting includes inline body tags with per-note dedup; the scenario "Inline body tags are not counted" is inverted.

## Impact

- Code: `src/modules/operations/fs-vault-provider.ts` (`listTags` → batched frontmatter+content scan), new `src/lib/obsidian/inline-tags.ts` extractor (mdast-based, dep already present), tool-description text in `list-tags.ts` / `query-notes.ts`.
- Unchanged: `listProperties` (keeps frontmatter-only scan), `extractTags` / `NoteRecord.tags`, `search_notes` filter leg, response envelopes.
- Tests: `test/operations/fs-vault-provider/list-tags.test.ts` (frontmatter-only assertion inverted), new `inline-tags` unit tests, overview disk-integration test extended.
- Perf/memory: `listTags` reads bodies it previously discarded, in batches of 32 (existing `READ_BATCH_SIZE` pattern); no body retention across the vault.
