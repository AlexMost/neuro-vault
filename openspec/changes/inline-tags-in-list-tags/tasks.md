## 1. Inline tag extractor

- [x] 1.1 Write failing unit tests for `extractInlineTags` in `test/lib/obsidian/inline-tags.test.ts`: basic `#tag`; nested `#a/b` verbatim; ≥1-non-digit rule (`#123` rejected, `#1a` accepted); whitespace/start-of-text requirement (`x#tag`, `example.com/#section`, `[[Note#heading]]` rejected); code fence / indented code / inline code excluded; heading marker `## Heading` excluded but `# Heading #tag` counts `tag`; trailing punctuation `#tag.` → `tag`; dedup within a body; empty body → `[]`
- [x] 1.2 Implement `src/lib/obsidian/inline-tags.ts` — `extractInlineTags(body: string): string[]` via `fromMarkdown` walk collecting `text` node values, skipping `code`/`inlineCode` nodes, applying the grammar regex (design D2/D3); tests from 1.1 pass

## 2. listTags aggregation

- [x] 2.1 Update `test/operations/fs-vault-provider/list-tags.test.ts`: invert the `'counts frontmatter tags only, ignoring inline #tags'` test to assert inline tags ARE counted; add per-note dedup cases (frontmatter+inline same tag → 1; `tags: [alpha, alpha]` → 1); add exclusion case (fenced `#tag` not counted); add broken-frontmatter edge pin (design D5); keep sort-order and empty-vault cases green
- [x] 2.2 Rework `FsVaultProvider.listTags` (`src/modules/operations/fs-vault-provider.ts`): batched scan (`READ_BATCH_SIZE = 32`) over `readNotes({ fields: ['frontmatter', 'content'] })`, per-note `Set(extractTags(fm)) ∪ Set(extractInlineTags(content))`, one increment per member, `sortCounts` unchanged; `listProperties` keeps `scanFrontmatter()`; tests from 2.1 pass
- [x] 2.3 Extend `test/operations/fs-vault-provider/headless-overview.test.ts`: disk fixture with an inline-only tag appears in `top_tags`; confirm body-only vault case (`'# heading\n'`) still yields empty tags

## 3. Tool-surface text and docs

- [x] 3.1 Update `list_tags` description (`src/modules/operations/tools/list-tags.ts`) — counts include inline body `#tags` (deduped per note); note that `query_notes`/`search_notes` `tags` filters remain frontmatter-only. Update `query_notes` description (`src/modules/operations/tools/query-notes.ts`) tags sentence to name the same asymmetry. Adjust any SDK-gate/tool-description tests asserting the old text
- [x] 3.2 Add follow-up note to `docs/adr/0009-disk-direct-vault-operations.md` marking consequence (a) resolved by this change; update the relevant `docs/architecture/` page if it states frontmatter-only tag counting

## 4. Verification

- [x] 4.1 `npm test && npm run lint && npm run typecheck` all pass; `openspec validate --all` passes
- [x] 4.2 Manual smoke against a real vault: note with frontmatter `ttag` + inline `#fsprovider-smoke` — both appear in `list_tags`; `get_vault_overview.top_tags` consistent
