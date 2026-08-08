# Inline `#tags` in listTags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list_tags` (and `get_vault_overview.top_tags`) count the per-note union of frontmatter tags and inline body `#tags`, deduplicated per note; query filters stay frontmatter-only.

**Architecture:** A new focused module `src/lib/obsidian/inline-tags.ts` extracts inline tags from a markdown body via an mdast walk (code/inlineCode skipped structurally). `FsVaultProvider.listTags` switches from the frontmatter-only scan to a batched frontmatter+content scan and counts each distinct per-note tag once. Nothing else changes: `extractTags`, `NoteRecord.tags`, `listProperties`, and the `search_notes`/`query_notes` filter legs are untouched.

**Tech Stack:** TypeScript strict/ESM, `mdast-util-from-markdown` (already a direct dep), vitest.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must pass before any commit (repo rule; `tsc --noEmit` is authoritative, not tsup).
- No new runtime dependencies.
- Tag grammar (design D2): `#` preceded by start-of-text or whitespace; tag chars `[A-Za-z0-9_/-]`; ≥1 non-numeric character; nested `#a/b` counted verbatim; case preserved; exact-string dedup.
- No vault-wide body retention: reads batched at `READ_BATCH_SIZE = 32` (same pattern as `src/lib/obsidian/query/query-notes.ts:36`), bodies dropped per batch.
- `{ name, count }` shape and count-desc/name-asc sort are existing contract — do not change `sortCounts`.
- Conventional Commits; work happens on a feature branch, PR to `main` via `gh pr create`.

---

### Task 1: `extractInlineTags` module

**Files:**
- Create: `src/lib/obsidian/inline-tags.ts`
- Test: `test/lib/obsidian/inline-tags.test.ts`

**Interfaces:**
- Consumes: `fromMarkdown` from `mdast-util-from-markdown`, `Nodes`/`Parent` types from `mdast` (both already deps; usage precedent: `src/lib/obsidian/lexical/blocks.ts`).
- Produces: `extractInlineTags(body: string): string[]` — deduped inline tags (no leading `#`, order not significant). Task 2 imports this.

- [ ] **Step 1: Write the failing test**

Create `test/lib/obsidian/inline-tags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { extractInlineTags } from '../../../src/lib/obsidian/inline-tags.js';

const sorted = (body: string): string[] => [...extractInlineTags(body)].sort();

describe('extractInlineTags', () => {
  it('extracts a basic inline tag', () => {
    expect(sorted('body with #alpha here\n')).toEqual(['alpha']);
  });

  it('extracts a tag at start of text', () => {
    expect(sorted('#alpha starts the note\n')).toEqual(['alpha']);
  });

  it('keeps nested tags verbatim', () => {
    expect(sorted('work on #project/alpha today\n')).toEqual(['project/alpha']);
  });

  it('rejects all-numeric tags but accepts mixed ones', () => {
    expect(sorted('issue #123 fixed in #1a and #v2\n')).toEqual(['1a', 'v2']);
  });

  it('requires whitespace or start-of-text before #', () => {
    expect(sorted('x#glued https://example.com/#section [[Note#heading]]\n')).toEqual([]);
  });

  it('ignores tags inside fenced code blocks', () => {
    expect(sorted('```\n#fenced\n```\n\nreal #tag\n')).toEqual(['tag']);
  });

  it('ignores tags inside indented code blocks', () => {
    expect(sorted('para\n\n    #indented code\n\n#real\n')).toEqual(['real']);
  });

  it('ignores tags inside inline code', () => {
    expect(sorted('use `#inline` and #real\n')).toEqual(['real']);
  });

  it('does not treat heading markers as tags, but counts tags in heading text', () => {
    expect(sorted('## Heading\n\n# Title #tagged\n')).toEqual(['tagged']);
  });

  it('stops at trailing punctuation', () => {
    expect(sorted('done #tag., also (#paren)\n')).toEqual(['tag']);
  });

  it('finds tags inside lists and blockquotes', () => {
    expect(sorted('- item #listed\n\n> quote #quoted\n')).toEqual(['listed', 'quoted']);
  });

  it('dedupes within a body', () => {
    expect(sorted('#twice and #twice again\n')).toEqual(['twice']);
  });

  it('returns [] for an empty or tagless body', () => {
    expect(sorted('')).toEqual([]);
    expect(sorted('no tags here\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/obsidian/inline-tags.test.ts`
Expected: FAIL — cannot resolve `src/lib/obsidian/inline-tags.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/obsidian/inline-tags.ts`:

```ts
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Parent } from 'mdast';

/**
 * Obsidian-documented tag grammar: `#` preceded by start-of-text or
 * whitespace, tag characters restricted to `[A-Za-z0-9_/-]`. The ≥1
 * non-numeric-character rule is enforced separately below.
 */
const TAG_PATTERN = /(?<=^|\s)#([A-Za-z0-9_/-]+)/g;

/** A tag must contain at least one non-numeric character (`#123` is not a tag). */
const NON_NUMERIC = /[A-Za-z_/-]/;

/** Node types whose text must never yield tags (code fences, indented code, inline code). */
const SKIPPED_TYPES = new Set(['code', 'inlineCode']);

/**
 * Extract inline `#tags` from a markdown body, deduped, without the leading
 * `#`. Walks the mdast tree so code is excluded structurally; heading markers
 * never appear in text nodes, so `## Heading` cannot match while a literal
 * `#tag` inside heading text still does (Obsidian behavior).
 */
export function extractInlineTags(body: string): string[] {
  if (body === '') return [];
  const tags = new Set<string>();
  const visit = (node: Nodes): void => {
    if (SKIPPED_TYPES.has(node.type)) return;
    if (node.type === 'text') {
      for (const match of node.value.matchAll(TAG_PATTERN)) {
        const tag = match[1] as string;
        if (NON_NUMERIC.test(tag)) tags.add(tag);
      }
      return;
    }
    if ('children' in node) {
      for (const child of (node as Parent).children) visit(child as Nodes);
    }
  };
  visit(fromMarkdown(body));
  return [...tags];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/obsidian/inline-tags.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/obsidian/inline-tags.ts test/lib/obsidian/inline-tags.test.ts
git commit -m "feat(tags): add inline #tag extractor over mdast"
```

---

### Task 2: `listTags` counts frontmatter ∪ inline, deduped per note

**Files:**
- Modify: `src/modules/operations/fs-vault-provider.ts` (`listTags` at ~line 286; add `READ_BATCH_SIZE` const and one import)
- Test: `test/operations/fs-vault-provider/list-tags.test.ts`

**Interfaces:**
- Consumes: `extractInlineTags(body: string): string[]` from Task 1; existing `extractTags(frontmatter)` and `sortCounts` stay as-is.
- Produces: unchanged `listTags(): Promise<TagListEntry[]>` signature; only counting semantics change. `listProperties` and `scanFrontmatter` remain untouched.

- [ ] **Step 1: Update the test file to the new contract**

In `test/operations/fs-vault-provider/list-tags.test.ts`, replace the first test (`'counts frontmatter tags only, ignoring inline #tags'`, lines 6–18) with:

```ts
  it('counts frontmatter and inline #tags together', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [alpha, beta]\n---\nbody #inline\n',
      'b.md': '---\ntags: alpha\n---\n',
      'c.md': 'no frontmatter #beta\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([
      { name: 'alpha', count: 2 },
      { name: 'beta', count: 2 },
      { name: 'inline', count: 1 },
    ]);
  });
```

Replace the `'returns [] for a vault with no frontmatter'` test (its fixture has no inline tags either, so the name is now misleading) with:

```ts
  it('returns [] for a vault with no frontmatter and no inline tags', async () => {
    const root = await makeVault({ 'a.md': 'plain\n' });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([]);
  });
```

Append these tests inside the same `describe` block:

```ts
  it('counts a tag once per note when it appears in frontmatter and body', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [gamma]\n---\n#gamma again #gamma\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'gamma', count: 1 }]);
  });

  it('counts duplicated frontmatter entries once per note', async () => {
    const root = await makeVault({ 'a.md': '---\ntags: [alpha, alpha]\n---\n' });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'alpha', count: 1 }]);
  });

  it('excludes code, URL fragments, heading markers, and numeric pseudo-tags', async () => {
    const root = await makeVault({
      'a.md': '## Heading\n\nsee https://example.com/#section and #123\n\n```\n#fenced\n```\n\n`#inline` but #real\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'real', count: 1 }]);
  });

  it('counts nested inline tags verbatim', async () => {
    const root = await makeVault({ 'a.md': 'work #project/alpha\n' });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'project/alpha', count: 1 }]);
  });

  it('broken frontmatter: body scan sees the raw file (pinned edge, design D5)', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [unclosed\n---\nbody #real\n',
    });
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'real', count: 1 }]);
  });

  it('scans more notes than one read batch', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) files[`n${String(i).padStart(2, '0')}.md`] = 'note #bulk\n';
    const root = await makeVault(files);
    const provider = makeProvider(root);

    expect(await provider.listTags()).toEqual([{ name: 'bulk', count: 40 }]);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/operations/fs-vault-provider/list-tags.test.ts`
Expected: FAIL — the rewritten first test and the new inline-tag tests fail (inline tags absent, dedup absent); the untouched sort/empty-vault tests still pass.

- [ ] **Step 3: Rework `listTags`**

In `src/modules/operations/fs-vault-provider.ts`:

Add the import (next to the existing `extractTags` import at line 17):

```ts
import { extractInlineTags } from '../../lib/obsidian/inline-tags.js';
```

Add the batch constant next to `sortCounts` (top of file, after imports):

```ts
/** Same batching pattern as query-notes.ts — bound memory, never hold every body at once. */
const READ_BATCH_SIZE = 32;
```

Replace the `listTags` method (currently lines 286–292) with:

```ts
  async listTags(): Promise<TagListEntry[]> {
    const reader = this.reader;
    const counts = new Map<string, number>();
    const paths = await reader.scan();
    for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
      const slice = paths.slice(i, i + READ_BATCH_SIZE);
      const items = await reader.readNotes({ paths: slice, fields: ['frontmatter', 'content'] });
      for (const item of items) {
        if ('error' in item) continue;
        const noteTags = new Set([
          ...extractTags(item.frontmatter ?? {}),
          ...extractInlineTags(item.content),
        ]);
        for (const tag of noteTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return sortCounts(counts);
  }
```

Leave `listProperties` and `scanFrontmatter` exactly as they are (the `ReadNotesItemSuccess` import stays — `scanFrontmatter` still uses it).

- [ ] **Step 4: Run the provider and reader suites**

Run: `npx vitest run test/operations/fs-vault-provider/ test/lib/obsidian/vault-reader.test.ts`
Expected: PASS — including `list-properties.test.ts` (unchanged path) and the reader's frontmatter-only `content: ''` assertion (still true; `listTags` simply no longer uses that mode).

- [ ] **Step 5: Commit**

```bash
git add src/modules/operations/fs-vault-provider.ts test/operations/fs-vault-provider/list-tags.test.ts
git commit -m "feat(tags): count inline body #tags in list_tags, dedup per note"
```

---

### Task 3: overview integration coverage

**Files:**
- Test: `test/operations/fs-vault-provider/headless-overview.test.ts`

**Interfaces:**
- Consumes: the Task 2 `listTags` semantics through `computeVaultOverview` (no production code changes — `top_tags` already delegates to `provider.listTags()` in `src/lib/obsidian/vault-overview.ts`).
- Produces: nothing new; pins the wiring.

- [ ] **Step 1: Add the disk-integration test**

In `test/operations/fs-vault-provider/headless-overview.test.ts`, append inside the existing `describe` (reuse the file's existing helpers — it already builds a provider + `makeMockGraph()` and calls `computeVaultOverview`; copy the setup shape of the neighboring `top_tags` test):

```ts
  it('top_tags includes inline-only tags from note bodies', async () => {
    const root = await makeVault({
      'a.md': '---\ntags: [fm]\n---\nbody #inlineonly\n',
      'b.md': 'plain body #inlineonly\n',
    });
    const provider = makeProvider(root);
    const reader = new FsVaultReader({ vaultRoot: root });

    const overview = await computeVaultOverview({ reader, provider, graph: makeMockGraph() });

    expect(overview.top_tags).toEqual([
      { name: 'inlineonly', count: 2 },
      { name: 'fm', count: 1 },
    ]);
  });
```

(Adjust the `computeVaultOverview` call signature to match the file's existing tests verbatim — the fixture and assertion above are the contract; keep the existing `'# heading\n'` body-only test as-is, it proves heading markers still yield no tags.)

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/operations/fs-vault-provider/headless-overview.test.ts`
Expected: PASS without production changes (delegation already exists). If it fails, the wiring assumption is wrong — stop and investigate, don't patch the test.

- [ ] **Step 3: Commit**

```bash
git add test/operations/fs-vault-provider/headless-overview.test.ts
git commit -m "test(overview): pin inline-only tags flowing into top_tags"
```

---

### Task 4: tool-description asymmetry text

**Files:**
- Modify: `src/modules/operations/tools/list-tags.ts` (description, ~line 35)
- Modify: `src/modules/operations/tools/query-notes.ts` (description, the `tags` sentence at ~line 79)

**Interfaces:**
- Consumes: nothing from other tasks (text only).
- Produces: contract text the spec's "Inline-only tags are not filterable" scenario references.

- [ ] **Step 1: Update `list_tags` description**

In `src/modules/operations/tools/list-tags.ts`, replace the description's first sentence pair:

```ts
    description:
      'List all tags used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }`. Counts aggregate frontmatter `tags:` values and inline body `#tags` (Obsidian grammar), deduplicated per note — each distinct tag counts once per note. Note: the `tags` filter of `query_notes`/`search_notes` matches frontmatter tags only, so a tag that exists only inline is reported here but not filterable there.' +
```

- [ ] **Step 2: Update `query_notes` description**

In `src/modules/operations/tools/query-notes.ts`, change the sentence

`` `tags` is an array of strings (no leading `#`) extracted from the `tags:` frontmatter field ``

to

`` `tags` is an array of strings (no leading `#`) extracted from the `tags:` frontmatter field (inline body `#tags` are NOT included — `list_tags` counts them, this filter cannot match them) ``

leaving the rest of the description byte-identical.

- [ ] **Step 3: Run the tool suites and gates**

Run: `npx vitest run test/operations/tools/ && npm run lint && npm run typecheck`
Expected: PASS — no existing test pins the old description text (verified during planning); lint guards the long-string formatting.

- [ ] **Step 4: Commit**

```bash
git add src/modules/operations/tools/list-tags.ts src/modules/operations/tools/query-notes.ts
git commit -m "docs(tools): state list_tags counting vs tags-filter asymmetry"
```

---

### Task 5: docs, spec validation, full gate

**Files:**
- Modify: `docs/adr/0009-disk-direct-vault-operations.md` (consequence (a), ~line 24)
- Modify: `docs/architecture/query.md` (first "deliberately does not do" bullet, ~line 79)

**Interfaces:** none — documentation and verification.

- [ ] **Step 1: ADR-0009 follow-up note**

ADRs are immutable in their decision content; append a follow-up sentence to consequence (a) rather than rewriting it. After the existing text of bullet **(a)** in `docs/adr/0009-disk-direct-vault-operations.md`, append:

```markdown
 _Follow-up (2026-08, change `inline-tags-in-list-tags`): `list_tags` counting was re-extended to inline body `#tags` (per-note dedup) via a dedicated extractor; the `query_notes`/`search_notes` `tags` filter remains frontmatter-only._
```

- [ ] **Step 2: query.md bullet update**

In `docs/architecture/query.md`, replace the bullet

```markdown
- It does not parse inline `#tags` from the body. Only frontmatter `tags:` is
  read. Body parsing needs a tokenizer aware of code-fences, wikilink anchors,
  and headings; separate ticket.
```

with

```markdown
- It does not parse inline `#tags` from the body. Only frontmatter `tags:` is
  read by the query/filter path. (`list_tags` counting does include inline
  tags via `src/lib/obsidian/inline-tags.ts`; the filter leg deliberately
  does not follow — see change `inline-tags-in-list-tags`.)
```

- [ ] **Step 3: Full verification gate**

Run:

```bash
npm test && npm run lint && npm run typecheck && npx openspec validate --all
```

Expected: all PASS.

- [ ] **Step 4: Manual smoke (from the task note's repro)**

Against a scratch vault (or the tmp-fixture pattern), create a note with frontmatter tag `ttag` and body line `smoke #fsprovider-smoke`, run the server's `list_tags` (e.g. via `npm run dev` + an MCP client, or a quick vitest scratch using `makeProvider`): both `ttag` and `fsprovider-smoke` must appear; `get_vault_overview.top_tags` must agree.

- [ ] **Step 5: Commit docs**

```bash
git add docs/adr/0009-disk-direct-vault-operations.md docs/architecture/query.md
git commit -m "docs: record inline-tag counting follow-up in ADR-0009 and query notes"
```

---

## Self-review notes

- Spec coverage: every scenario in `specs/headless-vault-operations/spec.md` maps to a test — frontmatter counting (existing aggregate test), inline counting (Task 2 step 1 first test), once-per-note (gamma test), duplicated frontmatter (alpha,alpha test), exclusions (`#123`/fence/inline-code/URL/heading test), nested verbatim (project/alpha test), asymmetry (Task 4 descriptions; unfilterability already pinned by `query_notes` frontmatter-only tests), properties (untouched `list-properties.test.ts`).
- The `'error' in item` guard preserves current behavior (unreadable notes skipped, matching `scanFrontmatter`'s filter).
- Batch test (40 notes > 32) exercises the loop boundary.
- PR flow after Task 5: push branch, `gh pr create` → `main` (never local-merge); single PR — the change is one coherent deliverable.
