Delivery is four PRs, one per group (see design.md §Migration Plan). Each PR is releasable on its
own and is reviewed by a separate reviewer session before merge. Stop at each PR boundary and wait
for the user before starting the next group. Inside a group, tasks are **sequential** unless marked
**parallel-safe**: every task's commit must pass `npm run typecheck`, so a type change and its
call sites are one task.

## 1. Foundation — PR 1/4 (no tool contract change)

- [x] 1.1 Chunker line splitting: a trailing newline terminates the last line. Test: `# A\ntext\n`
      gives `#A` span `[1, 2]` and text `# A\ntext`. The same note without a final newline gives
      the same span. Existing chunker spans and keys are otherwise unchanged
      (`embed-text-extraction` delta).
- [x] 1.2 Bump `EMBED_VERSION` 2 → 3. Test: a manifest recorded under version 2 no longer matches
      the active identity, so the corpus rebuilds. Add a CHANGELOG-facing note to the PR body: the
      corpus rebuilds once on upgrade.
- [x] 1.3 Read-time heading projection beside the chunker: heading blocks only (frontmatter, `#`
      preamble and `#{n}` sub-blocks dropped), each `{ heading, level, lines }` in source order,
      plus the note's body span and preamble span. Tests: levels, sibling `[n]`, headings in a list
      item / blockquote / fence produce no entry, a headless note, spans equal to `chunkNote`'s.
- [x] 1.4 Docs and model in the PR: `docs/architecture/own-corpus.md` (line spans and the rebuild),
      the stale `blocks[].heading` example in `docs/guide/finding-notes.md`, and the pending
      `GLOSSARY.md` terms (*Block*, *Heading block*, *Heading name*, *Own text*, *Selection*)
      committed as they stand. Commit the change artifacts.
- [x] 1.5 Gates (`npm test`, `npm run lint`, `npm run typecheck`, `npm run format`,
      `npm run build`, `openspec validate --all`, `npx commitlint --from origin/main --to HEAD`).
      Then open PR "(1/4)" with `Refs #239`, `Refs #152`, `Refs #189` and no closing keyword. Then
      run the reviewer session, fix its findings and re-review. **Stop for the user.**

## 2. Outline mode — PR 2/4

- [x] 2.1 Types: `ContentMode` gains `'outline'`; the success item gains optional `lines`,
      `preamble`, `outline` and `collapsed`; the outline entry type is `{ heading, level, lines,
      hidden? }`. Land the input enum, the handler branch and the `lines` echo on `full` items in
      the same task. Tests through `test/_gate.ts`: an outline item carries `frontmatter`, body
      `lines`, `preamble` only when non-blank and `outline`, and no `content`; a `full` item echoes
      the body `lines`; an invalid `content` names the four values.
- [x] 2.2 Depth collapse at 100 entries: the deepest level is dropped repeatedly, the shallowest is
      never cut, `hidden` sits on the deepest kept entries (headings at all depths) and the item
      carries `collapsed: true`. A pure function with unit tests: the 12 × 10 case, 150 top-level
      headings, no collapse at ≤ 100.
- [x] 2.3 Description sections LINE COORDINATES, READING THE OUTLINE and the outline part of
      CONTENT, ported from `prototype/structured-reads-wording` (candidate A), trimmed to what has
      shipped. Phrase tests on `spec.description`: "file-relative", "1-based", "inclusive"; the
      `hidden` unit.
- [x] 2.4 Docs (**parallel-safe** with 2.3): a new `docs/architecture/note-structure.md`; the
      `mcp-parameter-dictionary.md` `content` values; the outline in
      `docs/guide/reading-and-modifying.md`; the ADR (`docs/adr/0024-…`: the chunker heading model
      at read time, file-relative 1-based inclusive lines shared with search) and its `INDEX.md`
      row; a sweep of the rest of `docs/`.
- [x] 2.5 Gates, PR "(2/4)" with `Refs` only, reviewer session, fixes, re-review. **Stop for the user.**

## 3. Selection reads — PR 3/4

- [x] 3.1 Input gate: `paths` items `string | { path, heading?, lines? }`. Coercion in
      `src/lib/input-coercion.ts` for a stringified mixed array and numeric strings in `lines`.
      Schema constraints: `heading` non-blank (the message names `{ path, lines }`); `lines`
      exactly two integers with `1 ≤ start ≤ end`. Tests through `test/_gate.ts`: both coercions,
      each `INVALID_PARAMS` case, `content` inside an item rejected. Update
      `docs/architecture/input-coercion.md`.
- [x] 3.2 Item model and default: exact de-duplication over (path, selector), input order, the
      50-item cap counting reads, `heading` + `lines` on one item → call-level `INVALID_ARGUMENT`,
      and the per-item default (selector → `full`; bare path → `full` for one item, `preview`
      otherwise, all items counted). Tests through `test/_gate.ts`.
- [x] 3.3 `lines` selections: clipped to the body at both ends with the clipped span echoed,
      `LINES_OUT_OF_RANGE` with body `lines` on no overlap. Widen the error-code union in the same
      task. Tests: frontmatter overlap, past the end, wholly inside frontmatter, `[n, n]`.
- [x] 3.4 `heading` selections: exact match, then a unique normalized fallback (case, whitespace,
      inline markup, wikilink / Markdown link text, leading `#`s); level ignored; no prefix match.
      Each read echoes `heading` / `level` / `lines`. `HEADING_NOT_FOUND` carries body `lines` +
      the collapsed `outline`; `AMBIGUOUS_MATCH` carries `matches`. Miss items carry no
      `frontmatter`. Tests for each, plus `Notes[2]`.
- [x] 3.5 `content` over a selection: `outline` drill-down (entries keep their true span, collapse
      counted from the selection), `frontmatter` still resolves the selector (a miss stays a miss),
      `preamble` = the note preamble ∩ the selection. Tests through `test/_gate.ts`.
- [x] 3.6 Round-trip tests: every semantic block of a note with frontmatter, a preamble,
      own-paragraph sub-blocks and a heading block reads back exactly through `{ path, lines }`;
      the non-empty-`heading` block reads the same through `{ path, heading }`; a lexical body
      match's `lines` returns its unit; an unclosed-fence lexical unit clips, not misses; the
      `---frontmatter---` block hands off as `content: 'frontmatter'` (D11).
- [x] 3.7 Wording: the description sections PATHS, MISSES and FROM A SEARCH HIT, and one
      `search_notes` RESPONSE SHAPE line (hybrid-search delta). Phrase tests: `content` as one call-level value; the
      three miss codes; the `{ path, lines }` hand-off; "file-relative", "1-based" and "inclusive"
      in `search_notes`.
- [x] 3.8 Docs (**parallel-safe** with 3.7): `docs/guide/reading-and-modifying.md` (selections,
      matching, misses, argument faults); `finding-notes.md` (the "Evidence coordinates and the
      hand-off to `read_notes`" subsection, lexical `heading` as a label); `heading` / `lines` rows
      in `mcp-parameter-dictionary.md`; `note-structure.md`; a sweep of the rest of `docs/`.
- [x] 3.9 Gates, PR "(3/4)" with `Refs` only, reviewer session, fixes, re-review. **Stop for the user.**

## 4. Structured preview — PR 4/4

- [x] 4.1 `preview` gains `lines`, `preamble`, `outline` and `collapsed` for the selection; the
      prefix starts at the selection's first line. Tests through `test/_gate.ts`: `content` and
      `truncated` byte-identical to today on bare paths (pinned against the pre-change
      `previewBody` output), outline fields present, a headless note gets `outline: []`,
      determinism.
- [x] 4.2 Wording and docs: the preview part of CONTENT; the `read-notes-content-modes` wording in
      `docs/guide/reading-and-modifying.md`; `docs/guide/routing.md` ("preview, then the part you
      need"); a final sweep of `docs/`.
- [x] 4.3 Gates. Verify (`verify.md`), including one manual Haiku probe of the composed
      `read_notes` description (the 253 probe set) with its result recorded. Then the
      retrospective, then archive (`openspec archive structural-reads`).
- [x] 4.4 After the retrospective and the archive: finishing-a-development-branch. Open PR "(4/4)"
      whose body closes #239, #152 and #189. Run the reviewer session, fix its findings and
      re-review.
