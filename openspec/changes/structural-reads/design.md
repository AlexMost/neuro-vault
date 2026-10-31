## Context

`read_notes` (`src/modules/operations/tools/read-notes.ts`) reads notes straight from disk. Its
three modes are:

- `full`, the whole body with frontmatter stripped;
- `preview`, a 500-char prefix from `preview-body.ts`;
- `frontmatter`, no body.

It has no notion of a note's structure. Two heading parsers exist, and they disagree:

- The **corpus chunker** (`src/lib/obsidian/corpus/chunker.ts`) uses root-level ATX headings only.
  It gives subtree spans, sibling `[n]` disambiguation and one block per heading block. Its output
  is stored verbatim as semantic `blocks[]` evidence, so `blocks[].lines` is chunker output.
- The **lexical parser** (`src/lib/obsidian/lexical/blocks.ts`) takes any mdast heading,
  including setext and headings in lists or blockquotes. It labels lexical matches with the
  rendered text of the nearest preceding heading.

Search evidence reports file-relative lines with frontmatter counted. `read_notes` `content`
is the body after frontmatter. Neither convention is written down anywhere.

The chunker splits with `content.split('\n')`. A file ending in a newline therefore gains a
phantom empty last line, and the last block's span ends one past the real last line.

Every decision below was settled on the wayfinder map (#240), one ticket each. `brainstorm.md`
links each resolution, and the evidence (vault aggregates, Haiku legibility probes) lives there
and on the tickets.

Constraints:

- ADR-0005 (one concept = one parameter name; a rename costs a major version).
- ADR-0015 (the gate owns schema validation; `INVALID_ARGUMENT` is for semantic faults).
- ADR-0003 (the `ToolHandlerError` envelope).
- Model legibility first: every shape is judged by how easily a model reads it.

## Goals / Non-Goals

**Goals:**

- A model can see a note's structure (the outline) without its body, at a bounded size.
- A model can read exactly one heading block or line range, and several from one call.
- A search hit reads back with no translation, through `{ path, lines: row.lines }`.
- The batch default (`preview`) shows the structure, not only a prefix.
- One coordinate pair per block across `search_notes` and `read_notes`.
- Additive contract: every existing call returns what it returns today, plus new fields.

**Non-Goals:**

- Any `search_notes` contract change. Evidence carrying its enclosing heading block's address is
  #255.
- Write-path changes: heading-anchored `edit_note`, and aligning `edit_note` `AMBIGUOUS_MATCH`
  line numbers.
- Obsidian block references (`^id`), `note.md#Heading` inside `paths`, and path-form heading
  addresses.
- A per-call byte budget or auto-degrade, an own-text flag, or a numeric depth.

## Decisions

### D1: The heading model for reads is the chunker's, run at read time

- **Choice:**
  - A pure projection over `chunkNote(content)` keeps heading blocks only: it drops the
    frontmatter block, the `#` preamble and the `#{n}` own-paragraph sub-blocks.
  - It adds heading `level`, which `scanHeadings` computes and discards today.
  - The projection lives beside the chunker (`src/lib/obsidian/corpus/`), so one parser defines a
    heading block for both search and read.
- **Rationale:**
  - Semantic `blocks[].lines` is stored chunker output, so reads and search share spans byte for
    byte.
  - This matches Obsidian's documented "next heading on the same or a higher level".
  - The divergence from the lexical model is 0.5% of notes and shifts no span.
- **Alternatives:**
  - Serve reads from the stored corpus. Rejected: it keeps only ~68% of heading blocks.
  - The lexical model. Rejected: a second coordinate set beside search.

### D2: File-relative, 1-based, inclusive lines everywhere, echoed as `lines`

- **Choice:**
  - Outline entries, selectors and echoed spans count from the file's first line, frontmatter
    included.
  - Returned text stays verbatim, with no line prefixes.
  - Every item that returns body text echoes its span as `lines`. For a whole-note item that is
    the body span `[first body line, last line]`, so frontmatter ends at `lines[0] − 1`.
  - A heading read also echoes the resolved `heading` and `level`.
- **Rationale:** search → read is the main path. Text stays pasteable into `edit_note` `replace`.
- **Alternatives:**
  - Body-relative coordinates. Rejected: frontmatter edits shift search evidence anyway.
  - Both systems plus an offset. Rejected: easy to confuse.
  - Line-numbered text. Rejected: it breaks exact-string edits.

### D3: Fix the phantom trailing line in the chunker and bump `EMBED_VERSION`

- **Choice:**
  - The chunker's line splitting treats a trailing newline as a terminator, so the last span ends
    on the last real line.
  - `EMBED_VERSION` 2 → 3. The identity mismatch rebuilds each vault's corpus once on upgrade.
  - The read path's clip-to-body rule (D8) covers any stale evidence meanwhile.
- **Rationale:**
  - The embedding-model profile switch has already shipped, and nothing else forces a reindex.
  - Without the bump, stored shards keep end + 1 until each note changes, so search and the outline
    would disagree by a line on the same block.
- **Alternatives:**
  - No bump. Rejected: shards self-heal slowly while the mismatch is visible.
  - Leave the chunker unfixed. Rejected: the phantom line would become contract.
  - Migrate only `lines` in the shards. Rejected: extra code to save one rebuild.

### D4: `paths` items carry the selector

- **Choice:**
  - An item is `string | { path, heading?, lines? }`. `{ path }` equals the bare string.
  - One item → one selection → one span. Several pieces of one note are several items.
  - `content` stays one call-level value.
  - The 50-item cap counts reads. De-duplication is exact (path + selector), and results keep
    input order.
  - The coercion layer (`src/lib/input-coercion.ts`) learns two cases: a mixed string/object
    array sent as a JSON string, and numeric strings inside `lines`. Today it unwraps only
    all-string arrays.
- **Rationale:** each search hit maps onto its own item with no recomputation. The name `paths`
  is kept (ADR-0005), because the concept is still "the notes to read".
- **Alternatives:**
  - A call-level selector. Rejected: each hit has its own lines.
  - A shared selector plus overrides. Rejected: it needs a precedence rule.
  - A separate `reads` field. Rejected: a second way to name the target.

### D5: Address a heading block by its heading name

- **Choice:** `heading: "<heading name>"`, the source text plus the sibling `[n]`, the same string
  as semantic `blocks[].heading` and outline entries.
- **Matching:**
  - Exact match first.
  - Otherwise a normalized fallback, accepted only when it picks exactly one block. It ignores
    case, collapses whitespace, strips inline markup, takes wikilink and Markdown link text, and
    drops leading `#`s + space. Level is ignored.
  - No prefix or substring matching, and no emoji stripping.
- **Duplicates:** a cross-parent duplicate is an ambiguous miss.
- **Rationale:** outline → read and search → read are copy-paste. The fallback joins the three
  sources a model gets names from: the outline, lexical evidence and the user's words.
- **Alternatives:**
  - A path form (`A > B`, `A#B`, arrays). Rejected: a grammar for a rare case.
  - The chunker key. Rejected: it encodes level deltas and breaks on `#` in text.
  - Note-wide renumbering. Rejected: it splits from `blocks[].heading`.
  - First match. Rejected: silent wrong block.

### D6: A heading read returns the whole subtree

- **Choice:** the span runs from the heading line to the line before the next heading of the same
  or higher level, which equals the chunker span. Own text is read with `lines`. It is
  contiguous: from the heading line to the first child − 1, readable from the outline.
- **Alternatives:**
  - An `own: true` flag. Rejected: one more combination for a rare need.
  - A numeric `depth`. Rejected: gaps, and it breaks one-item-one-span.

### D7: The outline is a flat list; `preview` gains it in place

- **Outline choice:**
  - `content: 'outline'` returns `outline: [{ heading, level, lines }]` in source order.
  - The item carries `frontmatter`, `lines` (the body span) and `preamble: [s, e]` when that text
    is non-blank.
  - Over 100 entries, the deepest tree level is dropped until the list fits. The shallowest level
    is never cut. A cut parent carries `hidden: n` (headings below it, at all depths), and the
    item carries `collapsed: true`.
- **Preview choice:** `preview` keeps `content` (the 500-char prefix) and `truncated`
  byte-identical, and adds `lines`, `preamble`, `outline` and `collapsed`.
- **The ladder nests:** `frontmatter` ⊂ `outline` ⊂ `preview` ⊂ `full`.
- **Rationale:**
  - The same entry shape as `blocks[]`.
  - Copyable heading names.
  - p95 826 B per outline on the vault, so the cap only bounds repo-scale documents.
- **Alternatives:**
  - A tree. Rejected: +5% bytes, and the model has to walk `children`.
  - A text table of contents. Rejected: the probe dropped backticks from names.
  - A byte budget. Rejected: results then depend on heading length.
  - Per-heading excerpts. Rejected: they vanish under any batch budget.
  - A separate preview mode. Rejected: a fifth value, and the failing default stays.

### D8: `content` applies to the selection; the default is per item

- **Choice:**
  - A bare path's selection is the whole body.
  - Each mode treats a selection as it treats a whole note:
    - `full` → the text + `lines` (+ `heading` / `level`);
    - `outline` → the entries whose heading line lies in the selection (the drill-down);
    - `preview` → the selection's outline + a 500-char prefix from its first line;
    - `frontmatter` → `path` + `frontmatter` only. The selector is still resolved, so a miss is a
      miss.
  - Outline entries keep their true span.
  - `preamble` = the note preamble ∩ the selection.
  - The cap and the collapse count from the selection.
  - A `lines` range is clipped to the body at both ends. It is a miss only when it shares no line
    with the body.
- **Default:**
  - An omitted `content` → a selector item gets `full`.
  - A bare path gets `full` when the call has one item, and `preview` otherwise (all items counted
    after exact de-duplication).
  - An explicit `content` applies to the whole call.
- **Alternatives:**
  - "Any selector → all full". Rejected: whole bodies come back for bare paths.
  - Counting only bare paths. Rejected.
  - Rejecting `frontmatter` + selector. Rejected: it breaks "properties of these hits".

### D9: Misses are per-item errors carrying retry data

- **Choice:**
  - The codes, each with its retry data on the item:

    | Code | Retry data on the item |
    | --- | --- |
    | `HEADING_NOT_FOUND` | body `lines` + full `outline` (+ `collapsed`) |
    | `AMBIGUOUS_MATCH` (reused) | `matches: [{ heading, level, lines }]` |
    | `LINES_OUT_OF_RANGE` | body `lines` |

  - A miss item carries no `frontmatter`.
  - `message` states the cause and the retry.
  - `ReadNotesResultItemError.error.code` widens additively.
  - Misses look the same under every mode.
- **Alternatives:**
  - Empty content plus a flag. Rejected: a model reads it as an empty block.
  - One `SELECTOR_MISS` code plus a `reason`. Rejected.
  - Retry data in `error.details`. Rejected: a different path from success items.

### D10: Call-level argument faults follow ADR-0015

- **Choice:**
  - Schema-expressible faults are `INVALID_PARAMS` at the gate, with `details.issues`. These are
    an empty or blank `heading` (its message names `{ path, lines }`), and a `lines` value that is
    not two integers or has `start < 1` or `start > end`.
  - `heading` and `lines` on the same item is `INVALID_ARGUMENT`, an exactly-one-of fault like
    `name` xor `path`.
  - A note fault (D9) fails only its item.
- **Alternatives:**
  - A union of strict item objects. Rejected: zod reports "Invalid input", which a model cannot
    act on.
  - Everything `INVALID_ARGUMENT`. Rejected: the schema would have to be loose, against ADR-0015.

### D11: Search hand-off is `{ path, lines: row.lines }`; wording is a deliverable

- **Choice:**
  - Every body evidence row reads back through its `lines`. The frontmatter block
    (`---frontmatter---`, embedded when frontmatter is long) lies outside the body, so its
    hand-off is `content: 'frontmatter'` on the path. `search_notes` evidence is left unchanged,
    as that is a non-goal.
  - `heading` is an equal address only on a semantic block whose `heading` is non-empty and not
    `---frontmatter---`. Lexical `heading` is a label.
  - `search_notes` changes by two RESPONSE SHAPE lines: the coordinates + the hand-off, and what
    `blocks[].heading` / `""` and lexical `heading` mean.
  - The `read_notes` description is sectioned: PATHS, LINE COORDINATES, CONTENT, READING THE
    OUTLINE, MISSES, FROM A SEARCH HIT.
  - The text is ported from the throwaway branch `prototype/structured-reads-wording`
    (candidate A), never merged. Each PR adds only its slice's sections.
- **Alternatives:**
  - The lean description B. Rejected: it left the heading-block extent undefined, and in one run
    `content` ended up inside an item.

### D12: Documentation and the ADR

- **New ADR (`docs/adr/0024-…`):** structural reads use the chunker heading model at read time,
  with file-relative 1-based inclusive lines shared with search. It is hard to reverse (a
  contract of two tools), surprising without context (the body is stripped, yet its lines count
  frontmatter), and a real trade-off. It ships with the outline PR.
- **New `docs/architecture/note-structure.md`:** the read-time heading projection, heading names
  and matching, coordinates, selection resolution and collapse. One concept, one file.
- **Updated:**
  - `own-corpus.md` (line spans);
  - `input-coercion.md` (mixed arrays, nested numeric strings);
  - `mcp-parameter-dictionary.md` (`heading`, `lines` as `paths`-item fields; `content` gains
    `outline`);
  - the guide's `reading-and-modifying`, `finding-notes` (+ the stale `blocks[].heading`
    example) and `routing`.
- **`GLOSSARY.md`:** *Block*, *Heading block*, *Heading name*, *Own text*, *Selection*. They are
  already drafted in the main checkout.

## Risks / Trade-offs

- [Risk] Upgrading rebuilds every vault's corpus (a full re-embed). → Mitigation: the rebuild is
  automatic and the CHANGELOG states it. Reads clip stale spans meanwhile, so nothing breaks.
- [Risk] A lexical `heading` passed as `{ path, heading }` can silently pick a sibling duplicate
  (12 of 16,368 units on the vault). → Mitigation: the description and the guide teach
  `{ path, lines }` as the hand-off. The guide teaches one check: the heading read echoes `lines`,
  so a hit outside them means "read the outline".
- [Risk] Read-time chunking costs CPU per read. → Mitigation: it is one linear pass per note, the
  same parse the indexer runs. Perf is measured manually in the PR if it is in doubt.
- [Risk] A description advertises behaviour a later PR ships. → Mitigation: each PR adds only its
  slice's description sections, and the phrase tests assert per slice.
- [Risk] The last three wording refinements were never re-probed. → Mitigation: a Haiku probe of the
  composed description in the final PR's verify.
- [Trade-off] Preview items double in size (p95 0.9 → 1.8 KB; a 50-note batch ≈ 87 KB). → Accepted:
  the outline is what makes the batch default useful.
- [Trade-off] The `read_notes` description grows ~0.85 → ~4.6 KB. → Accepted: the probe showed that
  the lean variant leaves models guessing.
- [Trade-off] Repeated items of one note under `frontmatter` return identical frontmatter. → Accepted
  to keep the result flat.

## Migration Plan

Four PRs to `main`, each releasable on its own. PRs 1–3 carry `Refs` for #239, #152 and #189 and no
closing keyword. PR 4 closes all three.

1. **Foundation (no tool contract change):**
   - the chunker span fix and its tests;
   - `EMBED_VERSION` 3;
   - the read-time heading projection with `level`;
   - the change artifacts, the glossary terms and the `embed-text-extraction` delta;
   - the stale `finding-notes` example fix.

   **Pause for review before the contract changes.**
2. **Outline mode for bare paths:**
   - `content: 'outline'`, the collapse;
   - the `lines` echo on `full`;
   - the description sections LINE COORDINATES and READING THE OUTLINE, plus the outline part of
     CONTENT;
   - the parameter dictionary, `note-structure.md` and the ADR.
3. **Selection reads:**
   - object items + coercion;
   - `heading` / `lines`, the misses, the per-item default, the drill-down;
   - the description sections PATHS, MISSES and FROM A SEARCH HIT;
   - the `search_notes` lines;
   - the guide's `reading-and-modifying` and `finding-notes`;
   - the round-trip tests.
4. **Structured preview:**
   - the preview fields + the span echo;
   - the guide's `routing`;
   - verify (with the Haiku probe) → retrospective → archive.

Every PR passes `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`,
commitlint and `openspec validate --all`. Every PR is reviewed by a separate reviewer session:
Critical and Important findings are fixed before merge, Minor ones are fixed or declined with a
reason, and the reviewer re-checks after the fixes.

**Rollback:** revert the PR. Reverting PR 1 after release puts `EMBED_VERSION` back to 2 and
triggers one more rebuild. Every contract change is additive, so a revert removes fields without
breaking a caller that ignores them.

## Open Questions

- **Obsidian's handling of setext and callout headings, and whether `[[A#B]]` needs a direct
  parent.** A scratch-vault check of `metadataCache` would settle it. It does not block: the vault
  has 0 such headings, and no span depends on it. The owner is the vault owner, if a mismatch is
  reported.
