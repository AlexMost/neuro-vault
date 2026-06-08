# Tasks — read-notes-preview

Parallel-safe vs sequential (read by the apply phase's subagent-driven-development):

- **Group 1 (preview helper)** — self-contained, no shared state. Parallel-safe with Group 5 docs.
- **Group 2 (tool surface)** — depends on Group 1; sequential within itself (types → helper → handler).
- **Group 3 (read_notes tests)** — depends on Group 2.
- **Group 4 (other call-sites)** — depends on Group 2; parallel-safe with Group 3.
- **Group 5 (docs)** — independent of code; parallel-safe with Groups 1–4.
- **Group 6 (quality gates)** — sequential, last; depends on all.

## 1. Preview-truncation helper (pure, TDD) — parallel-safe

- [ ] 1.1 Write failing tests for a pure `previewBody(body: string): { content: string; truncated: boolean }`: short body (≤ cap) returns unchanged with `truncated: false`; long body returns a slice ≤ cap cut on a whitespace/newline boundary, ending in the marker, with `truncated: true`; empty body returns `{ content: '', truncated: false }`; a body with no whitespace before the cap hard-cuts at the cap.
- [ ] 1.2 Implement `previewBody` with `PREVIEW_CHAR_CAP` (≈500) and the marker (`…`) until tests pass; refactor for clarity.

## 2. `read_notes` tool surface (`content` enum) — sequential, depends on Group 1

- [ ] 2.1 In `src/modules/operations/types.ts`: replace `ReadNotesField` / `fields` on `ReadNotesToolInput` with `content?: 'full' | 'preview' | 'frontmatter'`; add optional `truncated?: boolean` to `ReadNotesResultItemSuccess`.
- [ ] 2.2 In `src/modules/operations/tool-helpers.ts`: replace `validateReadNotesInput`'s `fields` handling (and `VALID_FIELDS` / `DEFAULT_FIELDS`) with `content` validation — accept `'full' | 'preview' | 'frontmatter'`, reject unknown values with `INVALID_ARGUMENT`, and pass through `undefined` when omitted (the default is resolved later from path count, not here); return `{ paths, content }`.
- [ ] 2.3 In `src/modules/operations/tools/read-notes.ts`: drop `fields` from the input schema, add `content: z.enum(['full','preview','frontmatter']).optional()`. After de-duplication, resolve the effective mode: `effective = content ?? (dedupedPaths.length === 1 ? 'full' : 'preview')`. Map it to the reader call (`frontmatter` → `fields:['frontmatter']`, else `fields:['frontmatter','content']`) and to projection (`frontmatter` omits body; `preview` runs `previewBody` and sets `truncated`; `full` returns body as-is).
- [ ] 2.4 Update the `read_notes` tool description: document `content: 'full' | 'preview' | 'frontmatter'`, the count-based default (one path → `full`, two or more → `preview`) with explicit `content` overriding, the `truncated` flag, and the rule "re-read a previewed note with `content: 'full'` before citing or editing it."

## 3. `read_notes` tests — depends on Group 2

- [ ] 3.1 Rewrite `test/operations/tools/read-notes.test.ts`: drop the `fields`-based cases (`['frontmatter']`, `['content']`, empty/unknown-field). Add: single path + no `content` → full body; two+ paths + no `content` → preview bodies (`truncated` present); duplicate single path → full (counts as one); `content: 'full'` on a multi-path call → all full (override); `content: 'preview'` on a single path → preview (override); `content: 'frontmatter'` → frontmatter only, no `content`/`truncated`; `content: 'preview'` short body intact (`truncated:false`) and long body cut + marker (`truncated:true`); invalid `content` value (e.g. `'none'`) → `INVALID_ARGUMENT`. Keep paths/dedup/per-item-error coverage.

## 4. Other call-sites referencing the removed `fields` — depends on Group 2, parallel-safe with Group 3

- [ ] 4.1 Grep `fields` across `src/` and `test/`; confirm `VaultReader.readNotes`/`query_notes`/wikilink-graph keep their internal `fields` (unchanged) and only fix references to the **tool's** `fields` param. Update `test/operations/tools.test.ts` and any module/server test that drives `read_notes` with `fields`.

## 5. Docs & contract — parallel-safe with code groups

- [ ] 5.1 `README.md`: update the `read_notes` reference to `content` modes + `truncated`.
- [ ] 5.2 `docs/guide/vault-operations.md`: update `read_notes` usage to `content` modes.
- [ ] 5.3 `docs/guide/routing.md`: on the `search/query_notes → read_notes` path, note that multi-note reads default to `preview` (truncated, `truncated:true`) and that a note should be re-read with `content:'full'` before citing/editing; thread it into the existing `search_notes → read_notes` example.
- [ ] 5.4 `docs/architecture/mcp-parameter-dictionary.md`: add a one-line note that `content` is a `read_notes`-local body-granularity selector (not a shared concept), and that removing `fields` is the anticipated breaking change.

## 6. Quality gates — sequential, last

- [ ] 6.1 Run `npm test`, `npm run lint`, `npx tsc --noEmit` — all green; vitest count does not silently drop. Confirm the breaking change is captured for a major (11.0.0) release in the commit footer.
