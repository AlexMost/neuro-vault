# read_notes Preview Mode — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Tests are vitest; prefer DI over module-level mocks. Run
> `npm test`, `npm run lint`, and `npx tsc --noEmit` at each commit point — `tsc --noEmit`
> is authoritative (isolatedModules).
>
> Plan authored directly from tasks.md + design.md (the writing-plans skill's decomposition,
> applied manually) — the work is well-scoped and the code seams are known.

**Goal:** Replace `read_notes`' `fields` toggle with a `content: 'full' | 'preview' | 'frontmatter'`
mode (frontmatter always returned) whose default is count-based — one path → `full`, two or more →
`preview` — so the multi-note triage hop reads cheap previews without the agent opting in.

**Architecture:** A pure `previewBody` helper does bounded, boundary-cut truncation. The
`read_notes` handler resolves the effective mode from the de-duplicated path count (unless `content`
is explicit), then maps it to the existing reader's `fields` call and to its projection step; the
shared `VaultReader` (used by `query_notes` and the wikilink graph) is untouched. Guidance ships in
the tool description and `docs/guide/routing.md`.

**Tech Stack:** TypeScript (ESM, strict), Zod input schemas, vitest, tsup build.

---

## Task 1: Pure `previewBody` helper

- [ ] **Step 1:** Create `test/operations/preview-body.test.ts` (or colocate near tool-helpers tests). Add a failing test: `previewBody('short body')` → `{ content: 'short body', truncated: false }`.
- [ ] **Step 2:** Add failing tests for: body longer than `PREVIEW_CHAR_CAP` → result `content.length <= CAP + marker.length`, ends with `…`, cut at the last whitespace ≤ CAP, `truncated: true`; empty string → `{ content: '', truncated: false }`; long body with no whitespace before CAP → hard cut at CAP + marker, `truncated: true`.
- [ ] **Step 3:** Create the helper (e.g. `src/modules/operations/preview-body.ts`) exporting `PREVIEW_CHAR_CAP = 500`, a `PREVIEW_MARKER = '…'`, and `previewBody(body)`. Implement: if `body.length <= CAP` return `{ content: body, truncated: false }`; else find `lastWhitespace = body.lastIndexOf(' '/'\n')` within `[0, CAP]`, slice to that boundary (or CAP if none), trim trailing whitespace, append marker, return `{ content: slice + marker, truncated: true }`.
- [ ] **Step 4:** Run `npx vitest run preview-body` → green. Refactor for readability.
- [ ] **Commit:** `feat(read-notes): add pure previewBody truncation helper`

## Task 2: Types — swap `fields` for `content`, add `truncated`

- [ ] **Step 1:** In `src/modules/operations/types.ts`: remove `ReadNotesField`; on `ReadNotesToolInput` replace `fields?: ReadNotesField[]` with `content?: 'full' | 'preview' | 'frontmatter'`; add `truncated?: boolean` to `ReadNotesResultItemSuccess`.
- [ ] **Step 2:** `npx tsc --noEmit` → expect errors at the `read_notes` tool + tool-helpers (next tasks). This confirms the type change is load-bearing.
- [ ] **Commit:** fold into Task 3's commit (types alone don't build).

## Task 3: Validation helper

- [ ] **Step 1:** In `test/lib/input-coercion.test.ts` / the helper's test (wherever `validateReadNotesInput` is covered), add failing tests: omitted → `content: undefined` (default resolved later, not here); `content: 'frontmatter'|'preview'|'full'` pass through; unknown `content: 'none'` → throws `INVALID_ARGUMENT`.
- [ ] **Step 2:** In `src/modules/operations/tool-helpers.ts`: remove `VALID_FIELDS` / `DEFAULT_FIELDS` and the `fields` block from `validateReadNotesInput`; validate `content` (accept the three values, reject others via `invalidArgument(..., 'content')`, leave `undefined` untouched); change the return type to `{ paths, content }`.
- [ ] **Step 3:** `npx vitest run` for the helper test → green.
- [ ] **Commit:** `refactor(read-notes): validate content mode instead of fields`

## Task 4: `read_notes` handler + schema + description

- [ ] **Step 1:** In `src/modules/operations/tools/read-notes.ts`: drop `readNotesFieldSchema` and the `fields` field from `inputSchema`; add `content: z.enum(['full', 'preview', 'frontmatter']).optional()`. Update the `Input` interface.
- [ ] **Step 2:** In the handler, after building `deduped`: resolve `const effective = content ?? (deduped.length === 1 ? 'full' : 'preview')`. Build the reader `fields` from it: `const readerFields = effective === 'frontmatter' ? ['frontmatter'] : ['frontmatter', 'content']`. Call `entry.reader.readNotes({ paths: validPaths, fields: readerFields })`.
- [ ] **Step 3:** Rework the projection (driven by `effective`): always set `out.frontmatter`. For body: `frontmatter` → omit; `full` → `out.content = item.content`; `preview` → `const { content: c, truncated } = previewBody(item.content); out.content = c; out.truncated = truncated`.
- [ ] **Step 4:** Update the tool `description`: document `content: 'full' | 'preview' | 'frontmatter'`, the count-based default (one path → `full`, two or more → `preview`; explicit `content` overrides), that frontmatter is always returned, the `truncated` flag, and the rule "re-read a previewed note with `content: 'full'` before citing or editing it."
- [ ] **Step 5:** `npx tsc --noEmit` → green.
- [ ] **Commit:** `feat(read-notes)!: replace fields with content full|preview|frontmatter mode` (note the `!` — breaking change, major version).

## Task 5: Rewrite `read_notes` tool tests

- [ ] **Step 1:** In `test/operations/tools/read-notes.test.ts`: delete the `fields`-based cases (`['frontmatter']`, `['content']`, empty `fields`, unknown field, the "replaces 8 read_property" frontmatter-only case → re-express as `content: 'frontmatter'`).
- [ ] **Step 2:** Add: single path + no `content` → full `{path, frontmatter, content}`; two+ paths + no `content` → preview (each item has `truncated`); duplicate single path → full (counts as one); `content: 'full'` on a multi-path call → all full (override); `content: 'preview'` on a single path → preview (override); `content: 'frontmatter'` → `{path, frontmatter}` with no `content`/`truncated`; `content: 'preview'` short body intact (`truncated: false`) and long body cut + marker (`truncated: true`); invalid `content` (e.g. `'none'`) → rejects `INVALID_ARGUMENT`. Keep dedup / per-item-error / paths-string-or-array coverage.
- [ ] **Step 3:** `npx vitest run read-notes` → green.
- [ ] **Commit:** `test(read-notes): cover content full|preview|none modes`

## Task 6: Fix other call-sites referencing the tool's `fields`

- [ ] **Step 1:** `grep -rn "fields" src/ test/` and triage: the reader (`vault-reader.ts`), `query_notes`, and the wikilink graph legitimately keep their internal `fields` — leave them. Fix only references that drove the **`read_notes` tool** with `fields` (e.g. `test/operations/tools.test.ts`, any server/module test).
- [ ] **Step 2:** `npx tsc --noEmit` and `npx vitest run` → green.
- [ ] **Commit:** `test: update read_notes call-sites to content mode`

## Task 7: Docs & parameter dictionary

- [ ] **Step 1:** `README.md` — update the `read_notes` reference to `content` modes + `truncated`.
- [ ] **Step 2:** `docs/guide/vault-operations.md` — update `read_notes` usage to `content` modes.
- [ ] **Step 3:** `docs/guide/routing.md` — note on the `search/query_notes → read_notes` path that multi-note reads default to `preview` (truncated, `truncated:true`) and a note should be re-read with `content:'full'` before citing/editing; thread it into the existing `search_notes → read_notes` example.
- [ ] **Step 4:** `docs/architecture/mcp-parameter-dictionary.md` — one-line note that `content` is a `read_notes`-local body-granularity selector (not a shared concept), and that removing `fields` is the anticipated breaking change.
- [ ] **Commit:** `docs(read-notes): document content modes and triage-preview rule`

## Task 8: Final quality gates

- [ ] **Step 1:** `npm test` (full suite — count must not silently drop), `npm run lint`, `npx tsc --noEmit` → all green.
- [ ] **Step 2:** Confirm the breaking commit footer is present so `npm run release` cuts **11.0.0**.
- [ ] **Step 3:** Open the PR to `main` (`gh pr create`); note the metric to watch post-merge (next weekly report: `read_notes` payload ~14 KB → ~6–8 KB).
