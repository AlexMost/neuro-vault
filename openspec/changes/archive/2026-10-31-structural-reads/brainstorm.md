<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm — structural-reads

Tracked by #239. Also closes #152 and #189. Decided on the wayfinder map
[Map: structural reads in read_notes](https://github.com/AlexMost/neuro-vault/issues/240), one
ticket per decision; each Q below links its resolution, which holds the facts and probes behind it.

## Background

`read_notes` returns a note's frontmatter and its body as a whole (`full`), as a 500-char prefix
(`preview`), or not at all (`frontmatter`). A model that needs one part of a large note reads all
of it. The batch default (`preview`) often shows none of what matters: of 805 vault notes with
two or more headings, the prefix reaches the first half of the headings or less on 452. The three
source issues ask for:

- reading a single heading block (#152);
- a preview that shows the note's structure (#189);
- an outline mode with heading-block and line-range selection (#239).

The change adds that structure to the read path, for `read_notes` only. The target ladder is
frontmatter → outline → structured preview → selection → full body.

Two heading parsers exist, and they disagree:

- the corpus chunker (`src/lib/obsidian/corpus/chunker.ts`) uses root-level ATX headings only, with
  subtree spans and sibling `[n]` keys;
- the lexical parser (`src/lib/obsidian/lexical/blocks.ts`) takes any mdast heading.

Semantic `blocks[]` evidence is stored chunker output verbatim. Its `lines` are file-relative
(frontmatter counted), while `read_notes` `content` is the body with frontmatter stripped.

## Decision log

**Q1: which heading model defines a heading block for reads?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/241#issuecomment-6528635796))

- **Model:** the corpus chunker's, run on the file at read time. That means root-level ATX headings
  only, the subtree span, and `Title[2]` sibling disambiguation. A read and a semantic hit then share
  coordinates with no translation.
- **Why not reuse the corpus:** it keeps only ~68% of heading blocks (short or covered ones are
  dropped), so it cannot serve reads.
- **What the read path needs:** a heading-only projection (frontmatter, `#` preamble and `#{n}`
  own-paragraph sub-blocks dropped) and the heading `level`, which `scanHeadings` computes and
  throws away today.
- **The lexical parser stays as it is.** Search wants its extra headings.
- **Divergence on a ~1k-note vault:** 0 setext headings and 0 in blockquotes. 5 notes (0.5%) have
  headings inside list items, and those shift no chunker span.
- Rejected: the lexical model, which gives a second set of coordinates beside search.

**Q2: which line coordinates?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/242#issuecomment-6533378743))

- **Convention:** file-relative, 1-based, inclusive, frontmatter counted. It holds everywhere:
  outline spans, the `lines` selector and every echoed span.
- **Returned text stays verbatim**, so it can be pasted into `edit_note` `replace`.
- **Every item that returns body text echoes its span in one field.**
- **A range that overlaps frontmatter is clipped** to the body start.
- **The phantom trailing line is fixed at the source.** Today a trailing `\n` makes the last span end
  one past the real last line. The fix goes into the chunker's line splitting, which corpus and
  read share, so the two cannot drift (see Q12).
- Rejected: body-relative coordinates (they buy stability nowhere it matters, because frontmatter
  edits shift search evidence too). Also rejected: both systems plus an offset (easy to confuse).

**Q3: what shape does the selector take across several paths?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/243#issuecomment-6533574657))

- **The item:** a `paths` item is `string | { path, heading?, lines? }`. There is no call-level
  selector.
- **One item → one selection → one span.** Several pieces of one note are read by repeating the path.
- **At most one selector per item.** `heading` together with `lines` is call-level `INVALID_ARGUMENT`
  (an exactly-one-of fault, ADR-0015; see Q13).
- **`content` stays one call-level value.**
- **The 50-item cap counts reads.** De-duplication is exact (same path and same selector), and results
  keep input order.
- **`{ path }` with no selector equals the bare string.**
- **The input gate learns the new shape:**
  - a mixed string/object `paths` array sent as a JSON string;
  - numeric strings inside `lines`.

  Today's coercion (`src/lib/input-coercion.ts`) unwraps only all-string arrays.
- Rejected:
  - a shared selector (each search hit has its own lines);
  - a shared selector plus overrides (a precedence rule);
  - a separate `reads` field (a second way to name the target).

**Q4: how deep does a heading-block read go?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/244#issuecomment-6533670299))

- **The whole subtree only.** The span starts at the heading line and equals the chunker span.
- **Own text is read with `lines`.** It is always contiguous: the heading line up to the first child
  heading − 1.
- Rejected: an `own: true` flag (one more combination for a rare need). Also rejected: a numeric
  `depth` (it leaves gaps and breaks one-item-one-span).

**Q5: how is a heading block addressed?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/245#issuecomment-6533804135))

- **The selector:** `heading: "<heading name>"`. It is the source text plus the sibling `[n]`, the
  same string semantic `blocks[].heading` and the outline carry.
- **Match exact first.** Then try one normalized fallback, accepted only when it picks exactly one
  block. It ignores case and whitespace, inline markup, wikilink and Markdown link text, and a
  leading `#`s + space. Level is ignored. There is no prefix matching and no emoji stripping.
- **Duplicates:** a cross-parent duplicate is an ambiguous miss and is read with `lines`.
- **An empty or blank `heading` fails the whole call** at the gate as `INVALID_PARAMS` (see Q13).
- Rejected:
  - a path form (`A > B`, arrays, `A#B`), because it adds a grammar for a rare case;
  - the chunker's internal key (it encodes level deltas, and a `#` in a heading breaks it);
  - note-wide renumbering (it splits from `blocks[].heading`);
  - first-match (it picks a block silently).

**Q6: what does the outline look like?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/246#issuecomment-6534004055))

- **Entries:** `content: 'outline'` returns a flat list in source order, `{ heading, level, lines }`
  each, with no body text.
- **The item carries:**
  - `frontmatter` (parsed);
  - `lines` = the body span (so frontmatter ends at `lines[0] − 1`);
  - `preamble: [s, e]` only when that text is non-blank.
- **The span field is `lines` everywhere.** A heading read also echoes `heading` (resolved) and
  `level`.
- **Over 100 entries the deepest tree level collapses.** A cut parent carries `hidden: n` and the item
  carries `collapsed: true`. The shallowest level is never cut.
- **Size on the vault:** p95 826 B, max 1.65 KB, no note collapses.
- Rejected:
  - a tree (5% more bytes, and the model has to walk `children`);
  - a text table of contents (the probe dropped backticks from heading names);
  - `chars` / `own` fields;
  - a byte budget (results then depend on heading-text length).

**Q7: what becomes of the preview?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/247#issuecomment-6534386434))

- **`preview` changes in place, additively.** Today's `content` prefix and `truncated` stay
  byte-identical, plus the outline fields `lines`, `preamble`, `outline` and `collapsed`.
- **The ladder nests:** `frontmatter` ⊂ `outline` ⊂ `preview` ⊂ `full`.
- **No new knob.** The outline's collapse is the only thing that degrades.
- **Cost:** p95 per item goes from 0.9 to 1.8 KB, and a 50-note batch at p95 is ≈ 87 KB (accepted).
- Rejected:
  - a separate mode (a fifth value, and the failing prefix stays the default);
  - per-heading excerpts (45% of notes drop some under a 1.2 KB budget, plus three extra rules);
  - a markdown skim (spans parsed out of text).

**Q8: what does a miss return?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/248#issuecomment-6534512272))

- **A miss is a per-item error**, `error: { code, message }`, counted in `errors`. It never comes back
  as empty content.
- **The codes:**

  | Code | Cause |
  | --- | --- |
  | `HEADING_NOT_FOUND` | no heading block with that name |
  | `AMBIGUOUS_MATCH` | reused; one name matches several heading blocks |
  | `LINES_OUT_OF_RANGE` | the range shares no line with the body |

- **Retry data sits on the item:**
  - not-found → body `lines` + the full `outline`;
  - ambiguous → `matches: [{ heading, level, lines }]`;
  - range miss → body `lines`.

  A miss item carries no `frontmatter`.
- **`lines` is clipped to the body at both ends.** A range is a miss only with no overlap, which
  subsumes the transitional end-one-past clamp.
- **Malformed ranges fail the whole call at the gate** (`INVALID_PARAMS`, see Q13): `start < 1`,
  `start > end`, non-integers, or not exactly two numbers.
- **The error-code union widens additively.**
- Rejected: one `SELECTOR_MISS` code plus a `reason`. Also rejected: retry data in `error.details`
  (a different path from successful items).

**Q9: how do selector items behave under each content mode, and what is the default?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/251#issuecomment-6534621003))

- **One rule:** `content` applies to each item's *selection* as it would to a whole note.
  - `full` → the text + `lines` (+ `heading` / `level`).
  - `outline` → the entries whose heading line is inside the selection (drill-down into a collapsed
    entry).
  - `preview` → the selection's outline + a 500-char prefix from its first line.
  - `frontmatter` → `path` + `frontmatter` only. The selector is still resolved, so a miss is a miss.
- **The default is derived per item:**
  - a selector item → `full`;
  - a bare path → `full` when the call has one item, `preview` otherwise (all items counted after
    exact dedupe).

  An explicit `content` is call-wide.
- **Selection details:**
  - Outline entries keep their true span.
  - `preamble` = the note preamble ∩ the selection.
  - The cap and the collapse count relative to the selection.
- Rejected:
  - a call-level "any selector → everything full";
  - counting only bare paths;
  - `frontmatter` + selector as `INVALID_ARGUMENT`.

**Q10: how does a search hit reach a read?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/252#issuecomment-6541092595))

- **The hand-off is `{ path, lines: row.lines }`** for every evidence row, semantic or lexical.
- **When `heading` is an equal address:**
  - on a semantic block, only when its `heading` is non-empty (~45% of corpus blocks carry `heading: ""`);
  - a lexical `heading` is a label, not an address.
- **No `search_notes` contract change.**
- **The silent sibling mismatch is accepted** (12 of 16,368 lexical units), with a guide check.
- **No `within` echo on line reads.**
- Ruled out of scope: evidence carrying its enclosing heading block's address (#255).

**Q11: what wording does the model see?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/253#issuecomment-6541200837))

- **Everything model-facing lives in a sectioned `read_notes` description** (~4.6 KB, against ~0.85 KB
  today; accepted). The sections are PATHS, LINE COORDINATES, CONTENT, READING THE OUTLINE, MISSES
  and FROM A SEARCH HIT.
- **`search_notes` gains two RESPONSE SHAPE lines:** the coordinates plus the `{ path, lines }`
  hand-off, and what `blocks[].heading` / `""` and lexical `heading` mean.
- **Guide rewrites** in `docs/guide/reading-and-modifying.md`, `finding-notes.md` (plus a fix to its
  stale `blocks[].heading` example) and `routing.md`.
- **Source:** candidate "A" and the guide drafts live on the throwaway branch
  `prototype/structured-reads-wording`. Port the text, never merge the branch.
- **Probe:** Haiku, 3 runs × 17 questions, 51/51. The last three small clarifications were not
  re-probed (see Acceptance).
- Rejected: the lean candidate "B", which left the heading-block extent undefined, and in one run
  `content` ended up inside an item.

**Q12: how does the change ship?**
([resolution](https://github.com/AlexMost/neuro-vault/issues/254#issuecomment-6541273170))

- **Four PRs, each releasable on its own; see Delivery.** The embedding-model profile switch has
  already shipped, and nothing else on the tracker forces a reindex. This change therefore bumps
  `EMBED_VERSION` (2 → 3) itself.
- **Why the bump:** without it, stored shards keep the phantom end + 1 until each note changes. Search
  evidence and the outline would then disagree by a line on the same block. Reads would still work
  (they clip), but the one-coordinate-pair-per-block property would break.
- **Phantom line scope:** only the chunker has the bug. The lexical parser takes lines from mdast
  positions.
- Rejected:
  - three PRs (no clean pause before the contract changes);
  - no bump;
  - leaving the chunker unfixed (the phantom line becomes contract);
  - a `lines`-only shard migration (extra code to save one rebuild).

**Q13: which error code does a call-level argument fault carry?** (settled during propose,
2026-10-31, against [ADR-0015](../../../docs/adr/0015-input-gate-owns-schema-validation.md))

- **The tickets said "call-level `INVALID_ARGUMENT`" loosely.** What was decided is that these faults
  fail the whole call, not one item. ADR-0015 fixes which code: what a zod schema can express is
  rejected at the gate as `INVALID_PARAMS` with `details.issues`.
- **`INVALID_PARAMS`:** an empty or whitespace-only `heading`, a `lines` value that is not exactly two
  integers, `start < 1`, `start > end`. The empty-`heading` issue message names `{ path, lines }` as
  the fix.
- **`INVALID_ARGUMENT`:** `heading` and `lines` on the same item. This is an exactly-one-of fault
  across fields, the same class as `name` xor `path`.
- Rejected: everything as `INVALID_PARAMS` through a union of strict item objects (zod reports a
  union mismatch as a bare "Invalid input", which a model cannot act on). Also rejected:
  everything as `INVALID_ARGUMENT` (it needs a deliberately loose schema, against ADR-0015).

## Touchpoints (for design/plan)

- **Corpus:** `src/lib/obsidian/corpus/chunker.ts` (line splitting; a read-time heading projection
  exposing `level`) and `src/lib/obsidian/corpus/types.ts` (`EMBED_VERSION`).
- **Tool:** `src/modules/operations/tools/read-notes.ts` (input shape, per-item default, selection,
  outline, misses, description), `src/modules/operations/types.ts` (result and error-code types),
  `src/modules/operations/preview-body.ts`.
- **Gate:** `src/lib/input-coercion.ts`, for mixed `paths` arrays and numeric strings in `lines`.
- **`search_notes`:** `src/modules/semantic/tools/search-notes.ts`, the two description lines only.
- **Specs:**
  - `read-notes-content-modes` (outline mode, preview fields, selections, misses, default);
  - `embed-text-extraction` (the line span ends on the last real line).
- **Docs:** `docs/guide/{reading-and-modifying,finding-notes,routing}.md`,
  `docs/architecture/mcp-parameter-dictionary.md`, and a sweep of the rest of `docs/`.
- **ADR:** one, "Structural reads use the chunker heading model at read time, with file-relative
  1-based inclusive lines shared with search". It ships in 2/4.
- **`GLOSSARY.md`:** *Block*, *Heading block*, *Heading name*, *Own text* and *Selection*. These are
  already written and uncommitted in the main checkout, and they get committed in 1/4.

## Delivery

Each PR updates the description, the guide and the spec deltas for its own slice only, so a
description never advertises unshipped behaviour. PRs 1–3 carry `Refs` for 239, 152 and 189, with
no closing keyword anywhere in their bodies (a squash merge would close early). 4/4 closes all three.

1. **(1/4) Foundation — no tool contract change.**
   - The phantom-line fix.
   - The `EMBED_VERSION` bump (the corpus rebuilds once on upgrade; the CHANGELOG says so).
   - The read-time heading projection, with unit tests.
   - The opsx change artifacts, the glossary terms and the `embed-text-extraction` delta.
   - The stale `finding-notes.md` example fix.

   **Pause after this PR.**
2. **(2/4) Outline mode for bare paths.**
   - `content: 'outline'`, with collapse (`hidden`, `collapsed`).
   - The `lines` echo on `full` items.
   - The description sections LINE COORDINATES, READING THE OUTLINE and the outline part of CONTENT.
   - The parameter dictionary and the ADR.

   Outline goes before selections because a `HEADING_NOT_FOUND` miss carries `outline` as retry
   data.
3. **(3/4) Selection reads.**
   - Object items, `heading` / `lines`, gate coercion.
   - The three misses, the per-item default, drill-down.
   - The description sections PATHS, MISSES and FROM A SEARCH HIT, and the two `search_notes` lines.
     Those lines are true only once `lines` reads exist.
   - The guide's `reading-and-modifying` and `finding-notes`.
   - The round-trip tests.
4. **(4/4) Structured preview.**
   - The additive preview fields and the span echo.
   - The guide's `routing`.
   - Then verify → retrospective → archive → PR.

## Acceptance

**Every PR:**
- **Gates:** `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`,
  commitlint on every commit, `openspec validate --all`.
- **Review by a separate reviewer session.** A fresh session with no author context gets the PR diff,
  this change and the repo standards.
  - Every Critical and Important finding is fixed in the same PR before merge.
  - Each Minor is fixed or explicitly declined with a reason in the PR.
  - The reviewer re-checks after the fixes.

**Tests:**
- **Gate.** Tool tests go only through `registerTool` + `callTool` / `expectToolError`
  (`test/_gate.ts`), never handler-direct.
  - Coercion: a mixed `paths` array sent as a JSON string; numeric strings inside `lines`.
  - Call-level `INVALID_PARAMS` for an empty or blank `heading` (its `message` names
    `{ path, lines }`) and for each malformed range.
  - Call-level `INVALID_ARGUMENT` for `heading` + `lines` together.
- **Chunker.** A file ending in `\n` gives a last span on the last real line, and other spans and keys
  are unchanged.
- **Results.**
  - Each miss code comes with its retry data.
  - The per-item default follows the count rule.
  - Collapse kicks in above 100 entries.
  - Drill-down with `outline` + `heading` works.
  - The existing `preview` fields are byte-identical to today's.
- **Round trip.**
  - On a note with a preamble, own-paragraph sub-blocks and a heading block, each semantic block's
    `lines`, read as `{ path, lines }`, returns exactly that block's text.
  - The non-empty-`heading` block read via `{ path, heading }` returns the same text and `lines`.
  - A lexical body match's `lines` returns the matched unit (frontmatter offset included).
- **Description phrases** on `spec.description`, following `test/operations/tools.test.ts`. Each PR
  asserts its own slice's phrases.
  - "file-relative", "1-based" and "inclusive" in both descriptions.
  - `content` as one call-level value.
  - The `hidden` unit.
  - The three miss codes.
  - The `{ path, lines }` hand-off.

**Docs:**
- Sweep all of `docs/`, not only `docs/guide`.
- `mcp-parameter-dictionary.md`.
- Both spec deltas.

**Once, in 4/4 verify:** a manual Haiku probe of the composed `read_notes` description, recorded in
`verify.md`.

**No CI step needed.** Every property is observable by source-level tests, and the description's
size is accepted without a gate.

## Open, non-blocking

- **Obsidian's own heading model** (from Q1). A scratch-vault check of `metadataCache` would settle
  how Obsidian treats setext and callout headings, and whether `[[A#B]]` needs a direct parent.
  - Impact: none on this change. The vault has 0 such headings, and no chunker span depends on it.
  - Owner: the vault owner, if a mismatch is ever reported.

## Out of scope

- Search evidence carrying its enclosing heading block's address — #255.
- Aligning `edit_note` `AMBIGUOUS_MATCH` line numbers (body-relative today) with these coordinates.
- Heading-anchored writes in `edit_note`.
- Obsidian block references (`^block-id`).
- `note.md#Heading` addressing inside `paths`.
- A per-call byte budget or auto-degrade.
- An own-text flag or a numeric depth on the heading selector.
- Path-form heading addressing, and prefix or emoji-insensitive matching.
