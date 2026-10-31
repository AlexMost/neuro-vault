# Structural Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** `read_notes` gains an outline mode, a structured preview, and per-item `heading` /
`lines` selections in file-relative coordinates shared with `search_notes`, and the corpus
chunker stops counting a phantom trailing line.

**Architecture:** the corpus chunker's heading model is run on the raw file at read time. A pure
projection (`src/lib/obsidian/corpus/note-structure.ts`) turns it into heading entries plus body
and preamble spans. `read_notes` resolves each item's selection against that projection
(`src/modules/operations/selection.ts`), lists and collapses outline entries
(`src/modules/operations/outline.ts`), then applies the call's `content` mode to the selection.

**Tech Stack:** TypeScript (strict, ESM), zod v4, mdast-util-from-markdown, vitest.

**Spec:** `openspec/changes/structural-reads/` holds `design.md` (decisions D1–D12),
`specs/read-notes-selections/spec.md`, `specs/read-notes-content-modes/spec.md`,
`specs/embed-text-extraction/spec.md` and `brainstorm.md` (rationale, Q1–Q13). Read the specs
before each group, because they hold the exact scenarios this plan's tests pin.

## Global Constraints

- **Coordinates:** every `lines` is `[start, end]`, file-relative, 1-based, inclusive, frontmatter
  counted.
- **Outline entry:** exactly `{ heading, level, lines }`, plus `hidden` only when collapsed. The
  item adds `collapsed: true` only when collapsed.
- **Collapse cap:** 100 entries. `PREVIEW_CHAR_CAP` stays 500 and `PREVIEW_MARKER` stays `…`.
- **Misses:** `HEADING_NOT_FOUND`, `AMBIGUOUS_MATCH`, `LINES_OUT_OF_RANGE`, per item. A miss item
  never carries `frontmatter`.
- **Argument faults** fail the whole call:
  - `INVALID_PARAMS` (gate, zod) for a blank `heading`, and for a `lines` value that is not two
    integers or has start < 1 or start > end;
  - `INVALID_ARGUMENT` (handler) for `heading` + `lines` on one item. ADR-0015.
- **Additive contract:** a bare-path `preview` returns `content` and `truncated` byte-identical to
  today's output, and a bare-path `full` returns `content` as today.
- **Tool tests go through `registerTool` + `callTool` / `expectToolError` (`test/_gate.ts`)**,
  never `buildXTool(deps).handler`.
- **Lint:** `src/**` is stricter than `test/**`:
  - no `async` function without an `await`;
  - no untyped mock closure parameters.
- **Commits:** Conventional Commits, body lines ≤ 100 chars, each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Every PR passes** `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`,
  `npm run build`, `npx openspec validate --all` and `npx commitlint --from origin/main --to HEAD`.
- **PR bodies:** PRs 1–3 carry `Refs #239`, `Refs #152`, `Refs #189` and no closing keyword
  anywhere. PR 4 closes all three.
- **Wording source:** `git show origin/prototype/structured-reads-wording:prototype/wording/read-notes.A-full.md`
  and `…:prototype/wording/search-notes.addition.md`. Port the text, never merge the branch. The
  draft's last MISSES line predates Q13: write it as "`INVALID_PARAMS` for an empty `heading` or
  malformed `lines` (two integers, 1 ≤ start ≤ end); `INVALID_ARGUMENT` for both selectors in one
  item."
- **Privacy:** no private vault paths or note titles in code, tests, docs or PRs.

## Review Focus

Inputs the spec implies but no scenario names. Each one's test is added to the task that owns
the code.

1. **Malformed frontmatter YAML.** The reader returns `frontmatter: null` with `content` equal to
   the raw file, yet the chunker still treats the fence as frontmatter. A `full` bare path then
   echoes `lines: [1, last]` (the span of the text actually returned). Outline entries and
   selections still use the chunker's spans. Owner: Task 2.1.
2. **A frontmatter-only or empty note** (no body line). The item carries no `lines` and no
   `preamble`, and `outline: []`. Any `lines` selector is `LINES_OUT_OF_RANGE`, and the miss item
   carries no `lines`. Owner: Task 1.3 (projection) and Task 3.3.
3. **CRLF files.** Heading names carry no `\r`, and line counts equal the LF version of the same
   note. `NoteStructure.lines` keeps a trailing `\r` on CRLF lines, so text returned from a span
   must not end in a dangling `\r`. Owner: Task 1.3 (names, spans) and Tasks 3.3/3.4 (returned text).
4. **Non-Latin heading names in the normalized fallback.** `heading: 'нотатки зустрічі'` resolves to
   `## Нотатки зустрічі` (case folding is Unicode, via `toLocaleLowerCase('und')` or `toLowerCase`).
   Owner: Task 3.4.
5. **An object item with an unsafe path** (`{ path: '../x.md', lines: [1, 2] }`) is a per-item
   `INVALID_ARGUMENT`, exactly like the bare string today, and does not fail the call. Owner:
   Task 3.2.

---

## Group 1 — Foundation, PR 1/4 (no tool contract change)

### Task 1.1: Chunker counts real lines only

**Files:**
- Modify: `src/lib/obsidian/corpus/chunker.ts`
- Test: `test/lib/obsidian/corpus/chunker.test.ts`

**Interfaces:**
- Produces: `export function splitNoteLines(content: string): string[]` in `chunker.ts`. It is
  `content.split('\n')` without the final empty element when `content` ends with `'\n'`, and it
  is the only line splitter `chunkNote` and `note-structure.ts` use. `''` → `['']` (unchanged).

- [ ] **Step 1: Write the failing tests** in `chunker.test.ts`:

```ts
it('a trailing newline adds no line', () => {
  const blocks = chunkNote('# A\ntext\n');
  const a = blocks.find((b) => b.key === '#A')!;
  expect(a.lines).toEqual([1, 2]);
  expect(a.text).toBe('# A\ntext');
});

it('a note without a trailing newline chunks identically', () => {
  expect(chunkNote('# A\ntext')).toEqual(chunkNote('# A\ntext\n'));
});

it('the preamble of a headless note ending in a newline ends on its last real line', () => {
  const pre = chunkNote('one\ntwo\n').find((b) => b.key === '#')!;
  expect(pre.lines).toEqual([1, 2]);
});
```

- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`. Expected: the
  first and third tests FAIL with `[1, 3]`.
- [ ] **Step 3:** Implement `splitNoteLines` and use it in `chunkNote` (replace
  `content.split('\n')`).
- [ ] **Step 4:** Run the whole corpus suite, `npx vitest run test/lib/obsidian/corpus`. Expected:
  PASS. Fix only fixtures whose expected last span was the phantom `+1`. Leave every other
  expectation unchanged.
- [ ] **Step 5:** Commit `fix(corpus): a trailing newline ends the last line, not a new one`.

### Task 1.2: Bump `EMBED_VERSION` so the corpus rebuilds

**Files:**
- Modify: `src/lib/obsidian/corpus/types.ts:104` (`EMBED_VERSION = 3`)
- Test: `test/lib/obsidian/corpus/types.test.ts:18`, `test/lib/obsidian/corpus/identity.test.ts`

- [ ] **Step 1:** Change the expectation in `types.test.ts` to `toBe(3)`. In `identity.test.ts`,
  add a test that `identityMatches({ ...recorded, embed_version: 2 }, corpusIdentityOf(embedding))`
  is `false` (reuse that file's existing fixture identity).
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/types.test.ts test/lib/obsidian/corpus/identity.test.ts`.
  Expected: FAIL on `toBe(3)`.
- [ ] **Step 3:** Set `EMBED_VERSION = 3`. Add a one-line comment saying what version 3 changed
  (last-line spans).
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Any test pinning `embed_version 2` in a rebuild
  message is updated to 3.
- [ ] **Step 5:** Commit `feat(corpus): embed_version 3 rebuilds the corpus on the corrected spans`.
  The body says that a rebuild happens once on upgrade.

### Task 1.3: Read-time heading projection

**Files:**
- Modify: `src/lib/obsidian/corpus/chunker.ts`. Export the heading scan as the single source of
  heading sections, so `chunkNote` and the projection cannot drift.
- Create: `src/lib/obsidian/corpus/note-structure.ts`
- Test: `test/lib/obsidian/corpus/note-structure.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HeadingEntry { heading: string; level: number; lines: [number, number] }
export interface NoteStructure {
  /** splitNoteLines(raw) — every line, 1-based index = file line. */
  lines: string[];
  /** Last frontmatter line, 0 when none (the chunker's frontmatterEnd). */
  frontmatterEnd: number;
  /** [frontmatterEnd + 1, lines.length]; null when the note has no body line. */
  body: [number, number] | null;
  /** Text before the first heading, only when non-blank. */
  preamble: [number, number] | null;
  /** Heading blocks in source order: chunker spans and heading names. */
  headings: HeadingEntry[];
}
export function noteStructure(raw: string): NoteStructure;
```

  `heading` equals the chunker's `ChunkedBlock.heading` for that block (`[n]` included), and
  `lines` equals its span. To get there, refactor `chunkNote`'s heading loop into an exported
  `headingBlocks(lines, fmEnd): HeadingBlock[]` (each block carries `title`, `level`, `start`,
  `end`, `key` and its numbered `chunks`; it reserves the `#{n}` chunk keys as each block closes).
  `chunkNote` consumes it, so keys and output stay byte-identical (the existing chunker tests are
  the guard).

- [ ] **Step 1: Write the failing tests:**
  - `noteStructure('---\na: 1\n---\n\nintro\n# Top\n## Inner\nx\n')`:
    - `frontmatterEnd` 3;
    - `body` `[4, 8]`;
    - `preamble` `[4, 5]`;
    - `headings` `[{ heading: 'Top', level: 1, lines: [6, 8] }, { heading: 'Inner', level: 2, lines: [7, 8] }]`.
  - Two `## Notes` under one `# P` give entries named `Notes` and `Notes[2]`.
  - A heading inside a list item, a blockquote, a code fence, and a setext heading each produce
    no entry.
  - A headless note gives `headings: []`, with `preamble` equal to `body` when the text is
    non-blank.
  - A frontmatter-only note `'---\na: 1\n---\n'` gives `body: null`, `preamble: null` and
    `headings: []` (Review Focus 2).
  - The CRLF version of the first fixture gives the same spans and heading names with no `\r`
    (Review Focus 3).
  - A parity test over every fixture in `test/lib/obsidian/corpus/fixtures`: each heading entry
    equals the `chunkNote` block with the same `[start, end]` and non-empty `heading` other than
    `---frontmatter---`, and the counts match.
- [ ] **Step 2:** Run `npx vitest run test/lib/obsidian/corpus/note-structure.test.ts`. Expected:
  FAIL (module missing).
- [ ] **Step 3:** Implement `headingBlocks` (refactor) and `noteStructure`.
- [ ] **Step 4:** Run `npx vitest run test/lib/obsidian/corpus`. Expected: PASS, including the
  unchanged chunker tests.
- [ ] **Step 5:** Commit `feat(corpus): a read-time projection of a note's heading blocks`.

### Task 1.4: Docs, glossary and change artifacts

**Files:**
- Modify: `docs/architecture/own-corpus.md`, `docs/guide/finding-notes.md`
- Add: `GLOSSARY.md` (the pending *Note structure* terms) and `openspec/changes/structural-reads/`

- [ ] **Step 1:** In `own-corpus.md`, state that spans count real lines (a trailing newline ends
  the last line) and that `embed_version` 3 rebuilds once.
- [ ] **Step 2:** In `finding-notes.md`, fix the `blocks[].heading` example. The code carries the
  bare heading name (`"What is an embedding"`), not `"Notes/embeddings.md#…"`.
- [ ] **Step 3:** Commit `GLOSSARY.md` exactly as it stands in the main checkout (*Block*,
  *Heading block*, *Heading name*, *Own text*, *Selection* and the rest of its pending additions).
  If the worktree lacks them, copy them from the main checkout, and do not rewrite them.
- [ ] **Step 4:** Run `npm run format` and `npx openspec validate --all`. Expected: PASS.
- [ ] **Step 5:** Commit `docs: corpus line spans, the bare blocks[].heading, structural-reads change`.

### Task 1.5: Ship PR 1/4

- [ ] **Step 1:** Run every gate in Global Constraints. Expected: all pass.
- [ ] **Step 2:** Push, then `gh pr create`. Use the title
  `feat(corpus): real-line spans and a read-time heading projection (1/4)` and the body
  `Refs #239` / `#152` / `#189`, the rebuild note, and no closing keyword.
- [ ] **Step 3:** Start a separate reviewer session (fresh context: the PR diff, this change, the
  repo standards). Fix every Critical and Important finding. Fix each Minor or decline it with a
  reason in the PR. The reviewer re-checks.
- [ ] **Step 4:** **Stop. Wait for the user before Group 2.**

---

## Group 2 — Outline mode, PR 2/4

### Task 2.1: `content: 'outline'` and the span echo on `full`

**Files:**
- Modify: `src/lib/obsidian/vault-reader.ts`. `ReadNotesField` gains `'raw'`, and
  `ReadNotesItemSuccess` gains `raw?: string` (the whole file), set only when requested.
- Modify: `src/modules/operations/types.ts`, `src/modules/operations/tools/read-notes.ts`
- Create: `src/modules/operations/outline.ts` (entry listing; collapse comes in Task 2.2)
- Modify: `test/operations/tools/_helpers.ts`. Add
  `readerOverFiles(files: Record<string, string>): VaultReader`, which serves `frontmatter` /
  `content` through `splitFrontmatter` and `raw` verbatim.
- Test: `test/operations/tools/read-notes.test.ts`, `test/lib/obsidian/vault-reader.test.ts`

**Interfaces:**
- Consumes: `noteStructure` (Task 1.3).
- Produces:

```ts
export type ContentMode = 'full' | 'outline' | 'preview' | 'frontmatter';
export interface OutlineEntry { heading: string; level: number; lines: [number, number]; hidden?: number }
export interface ReadNotesResultItemSuccess {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  content?: string;
  truncated?: boolean;
  lines?: [number, number];
  heading?: string;
  level?: number;
  preamble?: [number, number];
  outline?: OutlineEntry[];
  collapsed?: true;
}
// outline.ts
export function entriesWithin(structure: NoteStructure, span: [number, number] | null): OutlineEntry[];
```

  `entriesWithin` returns the heading entries whose heading line (`lines[0]`) lies in `span`, with
  their true spans, in source order. `null` → `[]`.

- [ ] **Step 1: Write the failing tests** through `callTool`, with `readerOverFiles`:
  - **Outline item.** `content: 'outline'` on `'---\na: 1\n---\n\nintro\n# Top\n## Inner\nx\n'`
    returns exactly
    `{ path, frontmatter: { a: 1 }, lines: [4, 8], preamble: [4, 5], outline: [...] }`, with the two
    entries of Task 1.3 and no `content` / `truncated`.
  - **No `preamble` key** when the text before the first heading is blank.
  - **Span echo on `full`.** A bare `full` read of that note carries `lines: [4, 8]` and the
    unchanged `content`.
  - **Malformed YAML** (Review Focus 1): `full` returns the raw `content` and `lines: [1, last]`,
    and `outline` mode still lists the chunker's entries.
  - **Frontmatter-only note** (Review Focus 2) under `outline`: no `lines`, no `preamble`,
    `outline: []`.
  - **`content: 'none'`** fails `INVALID_PARAMS`, and the message names the four values.
  - **`fields: ['frontmatter','raw']`** in `vault-reader.test.ts` returns `raw` equal to the file.
    Without `'raw'`, the item has no `raw` key.
- [ ] **Step 2:** Run `npx vitest run test/operations/tools/read-notes.test.ts test/lib/obsidian/vault-reader.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement:
  - **Reader:** `'raw'` support.
  - **Handler:** request `raw` whenever the effective mode is not `frontmatter`. Build
    `noteStructure(raw)` per item.
  - **`outline` mode:** `{ path, frontmatter, lines: body, preamble?, outline: entriesWithin(s, body) }`.
  - **`full` mode:** add `lines`. That is `body` when `frontmatter !== null`, or when the file has
    no frontmatter prefix; otherwise (malformed YAML) it is `[1, lines.length]`.
  - **Absent keys:** omit any key whose value is `null`.
  - **Order:** the input-schema enum, the type and the handler branch land together.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): outline mode and the body span on full reads`.

### Task 2.2: Depth collapse at 100 entries

**Files:**
- Modify: `src/modules/operations/outline.ts`
- Test: `test/operations/outline.test.ts`; one gate test in `read-notes.test.ts`

**Interfaces:**
- Produces: `export const OUTLINE_ENTRY_CAP = 100;` and
  `export function collapseOutline(entries: OutlineEntry[]): { outline: OutlineEntry[]; collapsed: boolean }`.

  **Algorithm** (the tests do not fix it alone):
  - An entry's depth is the number of other entries whose span contains it (`a ⊆ b`, `b` starts
    earlier).
  - While `entries.length > 100` and the maximum depth exceeds the minimum, drop every entry at
    the maximum depth.
  - Each kept entry gets `hidden` = the count of dropped entries whose span lies inside it, set only
    on entries with at least one dropped descendant.
  - `collapsed` is true iff anything was dropped.

- [ ] **Step 1: Write the failing tests:**
  - **The 12 × 10 case.** One `#` title, 12 `##`, each with 10 `###` (133 entries) → 13 entries. Each
    `##` has `hidden: 10`, the title has no `hidden`, and `collapsed` is true.
  - **150 `#` headings** → all 150 kept, `collapsed` false.
  - **100 entries** → unchanged, no `hidden` keys.
  - **A case needing two passes:** 60 `##`, each with one `###`, each with one `####` (180
    entries). The first pass drops `####` (120 left), the second drops `###` → 60 entries, each
    `##` with `hidden: 2` (both dropped depths counted).
  - **Gate test:** `outline` mode on a 133-heading note carries `collapsed: true`.
- [ ] **Step 2:** Run `npx vitest run test/operations/outline.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `collapseOutline`. Apply it in `outline` mode, and set `collapsed: true`
  on the item only when it is true.
- [ ] **Step 4:** Run `npx vitest run test/operations`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): collapse an outline past 100 entries by depth`.

### Task 2.3: Description — coordinates and the outline

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts` (the description)
- Test: `test/operations/tools.test.ts:103-110`

- [ ] **Step 1:** Replace the `read_notes` description test with phrase assertions:
  - `/file-relative/`, `/1-based/`, `/inclusive/`;
  - `/1[–-]50/`;
  - `/hidden: n/` with `/headings below it/`;
  - `/outline/`;
  - `/Obsidian need not run/`;
  - `/per[- ]item/i` (per-item errors).
- [ ] **Step 2:** Run `npx vitest run test/operations/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Port candidate A's opening line, LINE COORDINATES, CONTENT and READING THE
  OUTLINE, trimmed to what is shipped:
  - drop every selector clause (`{ path, heading }`, `{ path, lines }`, drill-down, `AMBIGUOUS_MATCH`)
    and the own-text "read it with" sentence;
  - keep `paths` as today's string / array sentence;
  - keep the count default as today's;
  - keep the existing NOT_FOUND / per-item-errors sentence.
- [ ] **Step 4:** Run `npx vitest run test/operations`. Expected: PASS.
- [ ] **Step 5:** Commit `docs(read-notes): describe line coordinates and the outline`.

### Task 2.4: Architecture doc, dictionary, guide and ADR (parallel-safe with 2.3)

**Files:**
- Create: `docs/architecture/note-structure.md`, `docs/adr/0024-structural-reads-share-search-coordinates.md`
- Modify: `docs/adr/INDEX.md`, `docs/architecture/README.md` (index row),
  `docs/architecture/mcp-parameter-dictionary.md:36`, `docs/guide/reading-and-modifying.md`

- [ ] **Step 1:** Write `note-structure.md`:
  - the read-time projection;
  - heading names;
  - coordinates;
  - the body span;
  - the collapse rule.

  Selection resolution is added in Task 3.8.
- [ ] **Step 2:** Write ADR-0024 in the repo's ADR format. Decision: structural reads use the
  chunker heading model at read time, with file-relative 1-based inclusive lines shared with search.
  Alternatives: body-relative coordinates, a dual system, the lexical model. Consequence:
  `embed_version` 3. Add the `INDEX.md` row.
- [ ] **Step 3:** In the dictionary, `content` values become `'full'` / `'outline'` / `'preview'` /
  `'frontmatter'`.
- [ ] **Step 4:** In `reading-and-modifying.md`, cover the outline and line coordinates, taken from
  the prototype branch's guide diff (`git diff origin/main origin/prototype/structured-reads-wording -- docs/guide/reading-and-modifying.md`)
  and trimmed to shipped behaviour. Then `grep -rn "read_notes" docs/` and fix any stale mode list.
- [ ] **Step 5:** Run `npm run format`. Commit `docs: note structure, ADR-0024, outline in the guide`.

### Task 2.5: Ship PR 2/4

- [ ] Run the gates. Open PR `feat(read-notes): outline mode (2/4)` with `Refs` only. Run the reviewer
  session, fix its findings and re-review. **Stop. Wait for the user before Group 3.**

---

## Group 3 — Selection reads, PR 3/4

### Task 3.1: The item schema and gate coercion

**Files:**
- Modify: `src/lib/input-coercion.ts`, `src/modules/operations/tools/read-notes.ts` (input shape only)
- Modify: `docs/architecture/input-coercion.md`
- Test: `test/lib/input-coercion.test.ts`, `test/operations/tools/read-notes.test.ts`

**Interfaces:**
- Produces, in `read-notes.ts`:

```ts
export const EMPTY_HEADING_MESSAGE =
  'heading must name a heading block; read a block without a heading with { path, lines: [start, end] }';
const pathItem = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    heading: z.string().refine((s) => s.trim() !== '', { message: EMPTY_HEADING_MESSAGE }).optional(),
    lines: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .refine(([a, b]) => a <= b, { message: 'lines: start must not exceed end' })
      .optional(),
  }).strict(),
]);
// paths: z.union([z.string().min(1), z.array(pathItem).min(1).max(50)])
```

  Coercion (`coerceFieldValue`) learns three things:
  - A union string whose JSON parses to an array is returned, then coerced element-wise when every
    element is a string or a plain object. Today it requires all strings.
  - A `ZodArray` / `ZodTuple` value is coerced element-wise against its element / item schemas.
  - A `ZodUnion` non-string value is coerced against the first option it fits structurally (a
    plain object → the object option), and a `ZodObject` value is coerced key-wise.

  Coercion never changes a value's shape otherwise.

- [ ] **Step 1: Write the failing tests:**
  - **`input-coercion.test.ts`, unit:**
    - `'["a.md",{"path":"b.md","lines":[3,9]}]'` → the mixed array;
    - `{ path: 'a.md', lines: ['10', '20'] }` inside an array → `[10, 20]`;
    - `'["a.md","b.md"]'` still → string array;
    - `'not json'` stays a string.
  - **`read-notes.test.ts`, gate:**
    - the stringified mixed array reads two items;
    - `lines: ['10','20']` is accepted;
    - `INVALID_PARAMS` for `heading: ''`, `heading: '  '` (message contains `{ path, lines`),
      `lines: [20, 10]`, `[10]`, `[10, 20, 30]`, `[1.5, 3]`, `[0, 3]`, and
      `{ path: 'a.md', content: 'full' }` (unrecognized key).
- [ ] **Step 2:** Run `npx vitest run test/lib/input-coercion.test.ts test/operations/tools/read-notes.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement the coercion and the schema. Until Task 3.2, the handler maps an object
  item with no selector to its path and treats a selector item as its whole note, so the tree stays
  green.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS. Then update
  `input-coercion.md` §Coverage.
- [ ] **Step 5:** Commit `feat(read-notes): paths items may carry a heading or lines selector`.

### Task 3.2: The item model, de-duplication and the per-item default

**Files:**
- Create: `src/modules/operations/selection.ts`
- Modify: `src/modules/operations/tools/read-notes.ts`
- Test: `test/operations/tools/read-notes.test.ts`

**Interfaces:**
- Produces:

```ts
export type Selector = { kind: 'whole' } | { kind: 'heading'; heading: string } | { kind: 'lines'; lines: [number, number] };
export interface ReadRequestItem { path: string; selector: Selector }
export function toRequestItems(paths: string | Array<string | { path: string; heading?: string; lines?: [number, number] }>): ReadRequestItem[];
export function itemKey(item: ReadRequestItem): string; // exact-dedupe identity: path + selector
export function effectiveMode(item: ReadRequestItem, itemCount: number, explicit?: ContentMode): ContentMode;
```

  `toRequestItems` throws `ToolHandlerError('INVALID_ARGUMENT', "an item names one selection: pass either heading or lines, not both (<path>)")`
  when an item carries both. The handler calls it before any read.

- [ ] **Step 1: Write the failing tests** through `callTool`:
  - **Both selectors** (`heading` + `lines` on one item) → `INVALID_ARGUMENT`, and the reader is
    not called.
  - **`[{ path: 'a.md' }]`** deep-equals `['a.md']`'s result.
  - **Exact de-duplication:** `['a.md', { path: 'a.md', lines: [1, 2] }]` → 2 items; the same
    object twice → 1.
  - **Per-item default:** `['a.md', { path: 'b.md', lines: [5, 6] }]` gives `a.md` as a preview
    (has `truncated`) and `b.md` as `full` (has `content`, no `truncated`).
  - **Selector items count:** `['a.md', { path: 'a.md', heading: 'Top' }]` gives `a.md` a preview.
  - **Unsafe path** (Review Focus 5): `{ path: '../x.md', lines: [1, 2] }` beside a valid item →
    that item is a per-item `INVALID_ARGUMENT`, and the other succeeds.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement. De-duplicate on `itemKey` before normalization, as today for strings,
  and count items after de-duplication.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): per-item selections and their default mode`.

### Task 3.3: `lines` selections

**Files:**
- Modify: `src/modules/operations/selection.ts`, `src/modules/operations/types.ts`,
  `src/modules/operations/tools/read-notes.ts`
- Test: `test/operations/selection.test.ts`, `test/operations/tools/read-notes.test.ts`

**Interfaces:**
- Produces:

```ts
export type Resolved =
  | { ok: true; span: [number, number]; heading?: string; level?: number }
  | { ok: false; code: 'HEADING_NOT_FOUND' | 'AMBIGUOUS_MATCH' | 'LINES_OUT_OF_RANGE'; message: string; matches?: OutlineEntry[] };
export function resolveSelector(structure: NoteStructure, selector: Selector, path: string): Resolved;
```

  `ReadNotesResultItemError.error.code` widens to include the three codes, and the error item
  gains optional `lines`, `outline`, `collapsed` and `matches`. This lands in this task together
  with the handler code that sets them.

- [ ] **Step 1: Write the failing tests:**
  - **Clip at the front:** frontmatter ending on line 4 and `lines: [2, 9]` → the text of lines
    5–9, `lines: [5, 9]`.
  - **Clip at the end:** a 40-line note and `[30, 45]` → `lines: [30, 40]`.
  - **One line:** `[7, 7]` → line 7.
  - **Inside frontmatter:** `[1, 3]` → `error.code: 'LINES_OUT_OF_RANGE'` with body `lines` and no
    `frontmatter`.
  - **Past the end:** `[50, 60]` on a 40-line note → the same miss.
  - **Frontmatter-only note** (Review Focus 2): `[1, 1]` → a miss with no `lines` key.
  - **`errors`** counts the miss.
  - **The message** names the range and the body span (`/body: lines 5–40/`).
  - **Selection text** is verbatim: `structure.lines.slice(s - 1, e).join('\n')`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the `lines` branch of `resolveSelector` and the `full` rendering of a
  selection (`content`, `lines`).
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): read a line range, clipped to the body`.

### Task 3.4: `heading` selections

**Files:**
- Modify: `src/modules/operations/selection.ts`, `src/modules/operations/tools/read-notes.ts`
- Test: `test/operations/selection.test.ts`, `test/operations/tools/read-notes.test.ts`

**Interfaces:**
- Produces: `export function normalizeHeadingName(s: string): string`. It strips a leading `#{1,6}`
  and the space after it, reduces `[[target|Shown]]` → `Shown` and `[[target]]` → `target`, reduces
  `[text](url)` → `text`, removes `**`, `__`, `*`, `_` and backticks, collapses whitespace, trims,
  and lower-cases. It does not strip emoji or punctuation.

- [ ] **Step 1: Write the failing tests:**
  - **Whole block on an exact match:** `heading: 'Progress'` on `## Progress` (lines 7–40, with
    `### Week 1`) → `content` includes `### Week 1`, `lines: [7, 40]`, `heading: 'Progress'`,
    `level: 2`.
  - **Normalized fallback:** `'open questions'` → `## **Open** questions`, echoing
    `heading: '**Open** questions'`. `'## Progress'` → `Progress`.
  - **Wikilink text:** `'Alpha'` matches `## [[notes/alpha|Alpha]]`.
  - **Non-Latin case folding** (Review Focus 4): `'нотатки зустрічі'` → `## Нотатки зустрічі`.
  - **Sibling suffix:** `'Notes[2]'` → the second sibling.
  - **No prefix match:** `'2026-01'` against `## 2026-01-15 standup` → `HEADING_NOT_FOUND`.
  - **Not-found retry data:** the miss carries body `lines` and the collapsed `outline` (plus
    `collapsed` when collapsed), and no `frontmatter`.
  - **Cross-parent duplicate:** `'Notes'` under two parents → `AMBIGUOUS_MATCH` with
    `matches: [{ heading: 'Notes', level: 3, lines: [...] }, { ... }]`, and the message names
    `{ path, lines`.
  - **Ambiguous fallback:** a fallback hitting two blocks (`## Plan` and `## plan`, queried as
    `'PLAN'`) → `AMBIGUOUS_MATCH`.
  - **Exact wins:** `'plan'` there → the exact `## plan`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the heading branch: exact over `structure.headings[].heading`, else a
  normalized comparison accepted only on exactly one hit. Then the miss rendering with
  `collapseOutline(entriesWithin(structure, body))`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): read a heading block by its heading name`.

### Task 3.5: Content modes over a selection

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts`, `src/modules/operations/outline.ts`
- Test: `test/operations/tools/read-notes.test.ts`, `test/operations/outline.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - **Drill-down:** `content: 'outline'` + `{ path, heading: '2026-01' }` → `heading`, `level` and
    `lines` echoed, and `outline` = `2026-01` and its descendants only, with true spans.
  - **Unclipped entries:** `content: 'outline'` + `{ path, lines: [12, 30] }`, where `## B` spans
    20–45 → `B` is listed with `lines: [20, 45]`.
  - **Collapse counted from the selection:** a heading selection holding 133 entries collapses with
    its own shallowest level kept.
  - **`frontmatter` + selector:** `content: 'frontmatter'` + `{ path, lines: [5, 6] }` →
    `{ path, frontmatter }` only. With `{ path, heading: 'Missing' }` → a `HEADING_NOT_FOUND` miss.
  - **`preamble` ∩ selection:** a `lines` selection over the preamble carries `preamble` clipped to
    the selection. A heading selection never carries `preamble`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Request `raw` whenever any item has a selector, the `frontmatter`
  mode included. Every mode renders from the resolved span:
  - **`full`:** text + echo;
  - **`outline`:** echo + `preamble?` + collapsed `entriesWithin(structure, span)`;
  - **`frontmatter`:** resolve, then `{ path, frontmatter }` or the miss.

  `preview` over a selection is Task 4.1.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): content modes apply to each item's selection`.

### Task 3.6: Round trip from search evidence

**Files:**
- Test: `test/operations/tools/read-notes-round-trip.test.ts`

- [ ] **Step 1:** Write the tests against a fixture note: frontmatter, a non-blank preamble, a
  `## Decisions` heading block, and a heading with two own paragraphs (so `#{n}` sub-blocks exist).
  - **Every block by `lines`:** for every `chunkNote(raw)` block except `---frontmatter---`,
    `callTool(read_notes, { paths: [{ path, lines: block.lines }] })` returns `content === block.text`
    and `lines` deep-equal to `block.lines`.
  - **The non-empty-`heading` block by name:** `{ path, heading: block.heading }` returns the same
    `content` and `lines`.
  - **A lexical match:** for a `parseNote({ path, body, lineOffset })` body unit
    (`src/lib/obsidian/lexical/blocks.ts`, with the lexical index's offset), `{ path, lines: unit.lines }`
    returns text that contains the unit's matched text.
- [ ] **Step 2:** Run `npx vitest run test/operations/tools/read-notes-round-trip.test.ts`. Expected:
  PASS. These pin Tasks 3.3–3.4. If any fails, fix the source, never the expectation.
- [ ] **Step 3:** Commit `test(read-notes): search evidence reads back through its lines`.

### Task 3.7: Description — paths, misses, search hand-off

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts`, `src/modules/semantic/tools/search-notes.ts`
- Test: `test/operations/tools.test.ts`, `test/semantic/tools/search-notes-description.test.ts`

- [ ] **Step 1:** Add the phrase assertions:
  - **`read_notes`:**
    - `/one value for the whole call/`, `/never inside an item/`;
    - `/HEADING_NOT_FOUND/`, `/AMBIGUOUS_MATCH/`, `/LINES_OUT_OF_RANGE/`;
    - `/\{ path, lines: row\.lines \}/`;
    - `/INVALID_PARAMS/`.
  - **`search_notes`:** `/file-relative/`, `/1-based/`, `/inclusive/`, `/\{ path, lines \}/`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Port candidate A in full: PATHS, the selector clauses removed in 2.3, MISSES
  (with the Q13 line from Global Constraints) and FROM A SEARCH HIT. Add the two `search_notes`
  RESPONSE SHAPE lines after its `matches[]` line.
- [ ] **Step 4:** Run `npx vitest run test/operations test/semantic`. Expected: PASS.
- [ ] **Step 5:** Commit `docs(read-notes): selections, misses and the search hand-off`.

### Task 3.8: Guide, dictionary and architecture (parallel-safe with 3.7)

**Files:**
- Modify: `docs/guide/reading-and-modifying.md`, `docs/guide/finding-notes.md`,
  `docs/architecture/mcp-parameter-dictionary.md`, `docs/architecture/note-structure.md`

- [ ] **Step 1:** Port the prototype branch's guide diff for both guide files: selections, heading
  matching, a misses table, argument faults (with the Q13 codes), and the subsection "Evidence
  coordinates and the hand-off to `read_notes`". Lexical `heading` is recast as a label.
- [ ] **Step 2:** Add dictionary rows for `heading` (heading name; a `read_notes` `paths`-item field)
  and `lines` (a file-relative, 1-based, inclusive span; a `read_notes` `paths`-item field, matching
  `search_notes` evidence).
- [ ] **Step 3:** In `note-structure.md`, add selection resolution, matching, clipping and misses.
  Then `grep -rn "read_notes\|preview" docs/` and fix anything stale.
- [ ] **Step 4:** Run `npm run format`. Commit `docs: selections, misses and the hand-off in the guide`.

### Task 3.9: Ship PR 3/4

- [ ] Run the gates. Open PR `feat(read-notes): heading and line selections (3/4)` with `Refs`
  only. Run the reviewer session, fix its findings and re-review. **Stop. Wait for the user before
  Group 4.**

---

## Group 4 — Structured preview, PR 4/4

### Task 4.1: `preview` carries the outline

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts`
- Test: `test/operations/tools/read-notes.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - **Byte-identical prefix:** for three bodies (short, exactly 500 characters, long with no
    whitespace before 500), the bare-path `preview` `content` and `truncated` equal
    `previewBody(body)` on the reader's `content`.
  - **Outline fields:** the same item carries `lines` (body), `preamble?` and `outline`, and
    `collapsed` only when collapsed.
  - **Headless note:** `outline: []` and `preamble` equal to the body.
  - **Selection preview:** a selection's preview prefix starts at the selection's first line (the
    heading line for a heading read). `truncated` is true when it stops before the selection's
    end.
  - **Determinism:** two identical calls deep-equal.
  - **The ladder:** for one note, the keys of `frontmatter` ⊂ `outline` ⊂ `preview`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. A bare path keeps `previewBody(item.content)`, and a selection uses
  `previewBody(selectionText)`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(read-notes): preview carries the note's outline`.

### Task 4.2: Wording and docs for the preview

**Files:**
- Modify: `src/modules/operations/tools/read-notes.ts`, `docs/guide/reading-and-modifying.md`,
  `docs/guide/routing.md`, `docs/architecture/note-structure.md`
- Test: `test/operations/tools.test.ts`

- [ ] **Step 1:** Assert `/preview/` together with `/everything in `outline`/` in the description.
  Run it. Expected: FAIL.
- [ ] **Step 2:** Port CONTENT's `preview` rung and the "Preview `content` is raw text …" line.
  Port the guide's preview section, and the `routing.md` change ("preview, then the part you
  need"). Then do a final `grep -rn` sweep of `docs/`.
- [ ] **Step 3:** Run `npm test` and `npm run format`. Expected: PASS. Commit
  `docs: the structured preview in the description and guide`.

### Task 4.3: Verify, retrospective, archive

- [ ] **Step 1:** `/opsx:verify` → `verify.md`. Include one manual Haiku probe of the composed
  `read_notes` description against the 253 probe set (`prototype/wording/probe/` on the prototype
  branch), and record the score and any misread. Re-run until nothing blocks.
- [ ] **Step 2:** Write `retrospective.md` per the schema.
- [ ] **Step 3:** Run `npx openspec archive structural-reads -y`, then `npx openspec validate --all`.
  Expected: PASS. Commit.

### Task 4.4: Ship PR 4/4

- [ ] After the retrospective and the archive, run superpowers:finishing-a-development-branch.
  Open PR `feat(read-notes): structured preview (4/4)` whose body closes #239, #152 and #189. Run
  the reviewer session, fix its findings and re-review.
