# Which heading model defines a heading block for reads?

Research for [issue #241](https://github.com/AlexMost/neuro-vault/issues/241), part of the `read_notes` structural-reads map. A planned read feature will return a note's outline and individual _heading blocks_ (a heading plus everything under it, sub-headings included, up to the next heading of the same or a higher level). The repo already parses headings twice, and the two parsers disagree. This note finds out what Obsidian does, how often the disagreement bites on a real vault, and whether the corpus chunker's `lines` are the same `lines` semantic search reports.

Findings are as of 2026-10-30, against `main` at `b2dc267` (v17.4.0). No vault content appears here: vault numbers are aggregate counts, and every example is synthetic.

## TL;DR

- **Recommendation: the corpus chunker's model (root-level ATX headings only) should define a heading block for reads.** It is already the spec'd model ([`embed-text-extraction`](../../openspec/specs/embed-text-extraction/spec.md)), it yields the exact `lines` that semantic `blocks[]` carry, it disambiguates duplicates, and it agrees with what Obsidian itself demonstrably treats as a heading.
- **Obsidian** (community evidence; no official statement): headings inside list items are not in the headings metadata, the Outline pane, or link suggestions; headings inside callouts are reported as not linkable and absent from the Outline. Setext headings: **no source settles it** (evidence weak). Duplicate headings: no official handling; a plain `[[note#Heading]]` goes to a single match, and the stacked `[[note#A#B]]` form is the community-reported way to disambiguate. The one official fact that matters most: `obsidian.d.ts` defines a heading's extent as ending at "the next heading on the same or a higher level", which is exactly the glossary's definition.
- **On the real vault (992 notes)** the two parsers diverge in **5 notes (0.5 %)**, all from **7 headings inside list items**, all of them _extra_ headings the lexical parser sees and the chunker does not. **0 notes** have setext headings, **0** have headings inside blockquotes, and **0** chunker heading-block spans differ from the span the lexical headings would give. Duplicate sibling headings occur in **1 note**.
- **Reuse is exact, with caveats.** Stored `blocks[].lines` are bit-identical to a fresh chunk of the same file (992 of 992 shards). But stored `blocks[]` omit **32 %** of heading blocks (below 200 characters, or fully covered by sub-blocks), so reads must run the chunker on the file, not read the corpus. Also: the chunker's last span ends one line past the real last line when a file ends in a newline (a quirk semantic `blocks[]` already share).
- **What would change:** expose heading `level` (and an outline-friendly projection) from the chunker, filter out its non-heading block kinds, and decide how to present the phantom trailing line. The lexical parser stays as it is; it is a search index and wants the extra headings.

## 1. How Obsidian treats each case

**Evidence strength, up front.** Official sources (the help site and `obsidian.d.ts`) are silent on setext headings, on headings inside containers, and on duplicates. What exists on those is forum posts from users, with no staff statement found in any thread read. Anything below marked _community_ is that grade of evidence. I did not run Obsidian itself to observe the Outline pane or `app.metadataCache`; that would settle the setext question in minutes and is the cheapest follow-up if it matters.

### What the official sources do say

- `HeadingCache` is `{ heading: string; level: number }` plus a `position`, documented with ATX-only examples (`# foo`, `## bar`, `### baz`). It says nothing about nesting containers, setext, or duplicates. ([`obsidian.d.ts`, `HeadingCache`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts))
- `CachedMetadata.sections`: "Sections are root level Markdown blocks, which can be used to divide the document up." `SectionCache.type` includes `'heading'` and `'list'`, `'blockquote'`, `'callout'` as separate root-level types. This is consistent with a heading inside a list or blockquote being part of the list/blockquote section rather than a heading section, but it is an inference from the type union, not a stated rule. ([`obsidian.d.ts`, `CachedMetadata`, `SectionCache`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts))
- `HeadingSubpathResult` (the result of `resolveSubpath(cache, '#foo')`) carries `current: HeadingCache` and a `next` documented as "The next heading on the same or a higher level." That is the official definition of where a heading's content ends, identical to the glossary's heading block. ([`obsidian.d.ts`, `HeadingSubpathResult`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts))
- `stripHeading` normalises headings "for link matching by stripping out special characters and shrinking consecutive spaces", so link matching is on normalised text, not the raw source. ([`obsidian.d.ts`, `stripHeading`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts))
- Linking help: "add a hash (`#`) at the end of the link destination, followed by the heading text", and "You can add multiple hash symbols for each subheading." Silent on duplicates. ([Internal links](https://obsidian.md/help/links))
- Outline help: "lists the headings in the active note." Silent on setext, containers, duplicates. ([Outline](https://obsidian.md/help/plugins/outline))
- Syntax help: "The number of `#` symbols sets the level of the heading (as shown in the Outline)." Silent on setext. ([Basic formatting syntax](https://obsidian.md/help/syntax)) The flavour page names CommonMark as one of the standards Obsidian draws on, nothing more specific. ([Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown))

### (a) Setext headings

**Unknown for the Outline, link resolution and the headings metadata.** No official or community source I could reach states whether a setext heading reaches `HeadingCache`. What the forum does establish is that Obsidian's own setext handling is inconsistent between views: a March 2026 report on 1.12.7 lists underline forms recognised only in the editor, only in reading view, or not at all, with no staff reply ([Setext headings incorrectly recognized](https://forum.obsidian.md/t/setext-headings-incorrectly-recognized-in-both-editor-and-reading-mode/112786)), and a 2022 request notes the underline characters stay visible in Live Preview ([Better support for Setext style Markdown headers](https://forum.obsidian.md/t/live-preview-better-support-for-setext-style-markdown-headers/43553); the thread never mentions the Outline). A parser that treats a setext heading as a block boundary would therefore sometimes disagree with what the user sees in the editor.

### (b) Headings inside list items and blockquotes/callouts

- **List items (community, consistent, no staff).** A reply in one thread: "It's not recognised by Obsidian as a header to be included in the headings metadataCache." Another: they "aren't picked up by Obsidian's index so don't show up in link suggestions, in the Outline, etc." ([Change header color within bullets?](https://forum.obsidian.md/t/change-header-color-within-bullets/83335), June 2024.) The reporter of an older bug says the same of the Outline and file links ([Heading within list not recognized by outline & file link](https://forum.obsidian.md/t/heading-within-list-not-recognized-by-outline-file-link/59841/3), May 2023); a feature request to show them in the Outline drew a reply that it will most likely not happen ([Show headings that are inside bullet lists in Outline view](https://forum.obsidian.md/t/show-headings-that-are-inside-bullet-lists-in-outline-view/59897)). The same threads note the heading still _renders_ as a heading in the editor and reading view.
- **Blockquotes and callouts (community, thinner).** Search results for the forum show repeated requests that headings inside callouts be linkable and appear in the Outline, i.e. they currently do not ([Linking to headers that are inside of callouts](https://forum.obsidian.md/t/linking-to-headers-that-are-inside-of-callouts/62216); I could not fetch this thread body, only its listing). No thread I read separates plain blockquotes from callouts.

### (c) Duplicate headings

- **Plain link, duplicates.** A plain `[[note#Heading]]` resolves to one heading; for same-named headings at different levels, reporters could only reach one of them ([With 2 headings of same name in file can only link to first one](https://forum.obsidian.md/t/with-2-headings-of-same-name-in-file-can-only-link-to-first-one/74574), Jan 2024; [Insert precise heading links when there are duplicate headings](https://forum.obsidian.md/t/insert-precise-heading-links-when-there-are-duplicate-headings-in-a-note/53669), Feb 2023, moved to Feature requests).
- **Stacked path `[[note#A#B]]`.** The community-reported disambiguation is to name the ancestor chain, e.g. `[[#heading c#heading a]]` reaches the last `heading a`, though autocomplete does not offer it (same Jan 2024 thread). The linking help documents the stacked form only as "a hash for each subheading". Two user reports, no official confirmation, and no statement of whether the chain must be direct parents.
- **No numbering scheme exists in Obsidian.** There is no `[2]`-style suffix; the chunker's `Title[2]` is this repo's own invention, and its keys (`#A##B`, with `#` repeated by level difference) are not Obsidian link syntax.
- **Outline pane:** shows every heading, duplicates included, in order (no source contradicts this; none states it).

## 2. How often the two parsers diverge on a real vault

**Method.** A throwaway script outside the repo (never committed) imported the repo's real `chunkNote` and `parseNote` and ran them over every note in the vault scope, mirroring how `lexical-index.ts` derives its line offset (`splitFrontmatter`, then offset from the stripped prefix). The vault was opened read-only. Setext/container/duplicate flags come from a separate `mdast-util-from-markdown` walk with the same container traversal `parseNote` uses (the script asserts its heading list equals `parseNote`'s on every note). Lexical heading blocks were derived with the glossary rule: from the heading line to the line before the next heading of the same or a higher level, else end of file. Only counts are reported.

| Measure                                                                 | Result        |
| ----------------------------------------------------------------------- | ------------- |
| Notes scanned (scope as the server sees it)                             | 992           |
| Notes with at least one heading (either parser)                         | 985           |
| Heading blocks from the chunker / headings from the lexical parser      | 5,053 / 5,060 |
| Notes with setext headings (any depth)                                  | **0**         |
| Notes with headings inside blockquotes or callouts                      | **0**         |
| Notes with headings inside list items                                   | **5** (7 headings) |
| Notes whose heading lists differ at all                                 | **5** (0.5 %) |
| ... of which have neither setext nor container headings                 | 0             |
| Notes whose heading-block spans differ between the parsers              | **5**         |
| Chunker heading blocks whose span has no equal in the lexical spans     | **0**         |
| Notes with duplicate sibling headings (same title, same parent)         | **1**         |
| Notes with the same heading text anywhere, at any depth                 | 2             |
| Notes with empty-text headings, malformed-YAML frontmatter fallback, CRLF | 0 / 0 / 0   |

Reading the numbers:

- **The divergence is entirely headings inside list items, and it is additive.** All seven extra headings are ones the lexical parser counts and the chunker folds into the enclosing block as content. In no case did an extra lexical heading change a chunker block's span (zero chunker spans changed). Three of the seven are level 3 or shallower, so on another vault such a heading could close an enclosing block early.
- **Setext and blockquote headings are absent from this vault**, so the vault gives no evidence about the cost of either choice there. The conclusion for those two cases rests on spec and on Obsidian's behaviour, not on prevalence.
- **Duplicates are rare here** (1 note with sibling duplicates), but the chunker already handles them (`[2]`), and a read keyed by heading text needs some such rule the moment a note has two `## Notes` under different parents.
- **Where the 7 vs 5,053 gap comes from:** 5,060 − 5,053 = 7, exactly the list-item headings, so there is no hidden second source of disagreement (frontmatter offset, empty headings, malformed YAML all contribute 0).

A synthetic note shows the shape of each divergence (line numbers file-relative, frontmatter on lines 1-3):

```
 4  Intro line
 6  # Alpha
 9  Setext Two      <- setext H2 (underline on line 10)
13  - # In list
16  > ## In quote
18  ## Beta
21  # Alpha         <- duplicate
```

Chunker heading blocks: `#Alpha` 6-20, `#Alpha#Beta` 18-20, `#Alpha[2]` 21-23. The setext, list and quote lines are plain content of `#Alpha` (visible only as content of `#{n}` sub-blocks). Lexical headings: Alpha(6), Setext Two(9-10), In list(13), In quote(16), Beta(18), Alpha(21); rule-derived spans would then end `Alpha` at 12, because the list's level-1 heading closes it.

## 3. Would reusing the chunker give the same `lines` semantic `blocks[]` report?

**Trace.** `blocks[].lines` in search results are `BlockMatch.lines`, copied from `IBlockHit.lines` ([`shard-corpus.ts`](../../src/lib/obsidian/corpus/shard-corpus.ts)), which is the stored `CorpusBlock.lines`, written at index time from `buildEmbedInputs(path, rawContent).blocks` ([`reconcile.ts`](../../src/lib/obsidian/corpus/reconcile.ts), `embedNote`). `buildEmbedInputs` is `chunkNote(raw)` filtered ([`embed-text.ts`](../../src/lib/obsidian/corpus/embed-text.ts)), spreading each kept block unchanged, so `lines` is the chunker's `lines` verbatim: 1-based, inclusive, file-relative (frontmatter lines counted). Retrieval only re-keys and sorts them ([`retrieval-policy.ts`](../../src/modules/semantic/retrieval-policy.ts)).

**Verified empirically.** All 992 stored shards had a content hash matching the current file, and for every one the stored `(key, lines)` list was identical to a fresh `buildEmbedInputs` on the file. So for the heading blocks that are stored, `chunkNote` on the same content gives exactly the `lines` search reports.

**Snags.**

1. **Stored blocks are a subset.** `buildEmbedInputs` drops blocks shorter than `MIN_CHARS` (200) and heading blocks whose span is fully covered by kept sub-blocks. Only **3,417 of 5,053 (67.6 %)** heading blocks survive into `blocks[]`. A read that wants the full outline cannot consult the corpus; it must run `chunkNote` on the file at read time. That also keeps reads working with no embedding corpus (lexical-only mode).
2. **Non-heading block kinds share the output.** The chunker also emits the `#---frontmatter---` block (heading text `---frontmatter---`), the `#` preamble block (empty heading), and unkeyed-by-heading `#{n}` own-paragraph sub-blocks (empty heading), emitted only when a heading directly owns more than one paragraph. A read model that means "heading block" must filter to blocks with a non-empty `heading` that are not the frontmatter block. In `blocks[]` on this vault: 111 notes carry a stored frontmatter block, 16 a preamble block, 472 notes have `#{n}` sub-blocks (2,022 in total). Search can legitimately return those; an outline must not list them. Whether reads should address the preamble and frontmatter as pseudo-sections is a design choice for the read feature.
3. **No `level` in the output.** `ChunkedBlock` has key, heading, lines, text, and the level is recoverable only by counting separators in `key`, which is fragile because a heading can contain `#`. An outline needs the level; `scanHeadings` already has it (`HeadingHit.level`) and discards it.
4. **Phantom trailing line.** `content.split('\n')` makes a newline-terminated file one element longer than its real line count, so the last heading block's end is `real_lines + 1`. In this vault 841 of 985 heading-bearing notes have a chunker span ending past the last real line, and 759 stored shards carry such a block. Semantic `blocks[].lines` already show this value, so reuse stays consistent with search; reading by slicing is unaffected (slicing past the end is harmless), but a reader that echoes `lines` back to an agent will show an end line that does not exist. Fixing it in the chunker would change stored `lines`, which is an extraction-version change and a reindex; clamping at read time is the free option.
5. **Heading `title` is raw source text, with a `[n]` suffix on repeats.** That is stable and good for addressing, but it differs from the lexical `raw` (mdast text, markup stripped) and from Obsidian's normalised link text (`stripHeading`). A read addressed by Obsidian-style heading text will need to normalise.
6. **Frontmatter grammar is shared.** The chunker, `set_property`, `edit_note` and the lexical index all use `splitRawFrontmatter` (the lexical path via `splitFrontmatter`), so line offsets agree. The one latent exception is `splitFrontmatter` falling back to the whole raw file as body on malformed YAML, which would let the lexical parser see YAML `# comment` lines as headings; zero notes hit it here.

## Recommendation

**Use the chunker's model for reads: root-level ATX headings only, with the chunker's duplicate disambiguation and its `lines`.**

Why:

1. **One answer for the agent.** A `lines` pair from a search hit and the span of the same heading in an outline will be identical, so an agent can move from `search_notes` to a block read without translating coordinates. The lexical parser would give a second, occasionally different span for the same note.
2. **It matches Obsidian where Obsidian is known.** Headings inside list items are, per community evidence, not headings to Obsidian (not in its headings metadata, Outline or link suggestions); the chunker agrees. Where Obsidian is unknown (setext, quotes) the chunker's conservative choice is also the one that cannot invent a "heading" whose title is a whole sentence (a paragraph above a `---` rule).
3. **It already handles duplicates and uniqueness** (`[n]` suffixes; keys unique within a note), which a read-by-heading needs and the lexical parser does not offer.
4. **The cost of choosing it is small on real data:** the models agree on 99.5 % of notes; the remainder differ by seven list-item headings; no chunker span changes.
5. **It is already specified and tested**, so the read feature inherits the spec instead of creating a third heading definition.

What would need to change (none done here; no source was touched):

- **Surface the level.** Return `level` with each heading block (carry `HeadingHit.level` through, or add an outline-oriented export next to `chunkNote`). Do not derive it from the key.
- **Add a heading-only projection.** A function that returns just heading blocks (non-empty `heading`, not the frontmatter block), so callers do not each re-implement the filter that excludes `#`, `#---frontmatter---` and `#{n}` blocks.
- **Run it on the file at read time**, not from stored shards, because 32 % of heading blocks are not stored.
- **Decide the end-line convention** for the phantom trailing line; clamping to the real line count at read time avoids a reindex. If reads report clamped `lines` while search reports unclamped ones, the two will differ by one on the last block; either accept that and say so, or report both consistently.
- **Document the divergence** from the lexical parser (list-item headings are lexical-only) so the two are not "fixed" to agree: the lexical parser wants more headings, because matching a title inside a list is a search feature, not a structure claim.
- **Leave setext and quote handling as is**, and revisit only if the Obsidian follow-up below shows Obsidian lists them.

## Open questions

- **Setext in Obsidian** (Outline, `[[note#...]]`, `metadataCache.headings`): unresolved. A five-minute check in a scratch vault with `app.metadataCache.getFileCache(file).headings` would settle it, along with list/quote/callout headings and duplicate path resolution. I did not do it: it needs the Obsidian app and a throwaway vault, and the real vault was read-only for this task.
- **Prevalence on other vaults.** Setext and blockquote headings were absent here (0 and 0); a vault with Logseq/Roam imports or heavy callout use would differ.
- **Does `[[A#B]]` require direct parentage?** Unstated by any source reached.

## Sources

- Obsidian API typings, `HeadingCache`, `CachedMetadata`, `SectionCache`, `HeadingSubpathResult`, `resolveSubpath`, `stripHeading`: [obsidianmd/obsidian-api `obsidian.d.ts`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) (read from `master` on 2026-10-30)
- Obsidian help: [Internal links](https://obsidian.md/help/links) · [Outline](https://obsidian.md/help/plugins/outline) · [Basic formatting syntax](https://obsidian.md/help/syntax) · [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown) (the former `help.obsidian.md` paths redirect here)
- Forum, setext: [Setext headings incorrectly recognized](https://forum.obsidian.md/t/setext-headings-incorrectly-recognized-in-both-editor-and-reading-mode/112786) · [Better support for Setext style Markdown headers](https://forum.obsidian.md/t/live-preview-better-support-for-setext-style-markdown-headers/43553)
- Forum, containers: [Change header color within bullets?](https://forum.obsidian.md/t/change-header-color-within-bullets/83335) · [Heading within list not recognized by outline & file link](https://forum.obsidian.md/t/heading-within-list-not-recognized-by-outline-file-link/59841/3) · [Show headings that are inside bullet lists in Outline view](https://forum.obsidian.md/t/show-headings-that-are-inside-bullet-lists-in-outline-view/59897) · [Linking to headers that are inside of callouts](https://forum.obsidian.md/t/linking-to-headers-that-are-inside-of-callouts/62216) (listing only)
- Forum, duplicates: [With 2 headings of same name in file can only link to first one](https://forum.obsidian.md/t/with-2-headings-of-same-name-in-file-can-only-link-to-first-one/74574) · [Insert precise heading links when there are duplicate headings in a note](https://forum.obsidian.md/t/insert-precise-heading-links-when-there-are-duplicate-headings-in-a-note/53669)
- In-repo: [`chunker.ts`](../../src/lib/obsidian/corpus/chunker.ts) · [`embed-text.ts`](../../src/lib/obsidian/corpus/embed-text.ts) · [`reconcile.ts`](../../src/lib/obsidian/corpus/reconcile.ts) · [`shard-corpus.ts`](../../src/lib/obsidian/corpus/shard-corpus.ts) · [`retrieval-policy.ts`](../../src/modules/semantic/retrieval-policy.ts) · [`blocks.ts`](../../src/lib/obsidian/lexical/blocks.ts) · [`lexical-index.ts`](../../src/lib/obsidian/lexical/lexical-index.ts) · [`own-corpus.md`](../architecture/own-corpus.md) · [`embed-text-extraction` spec](../../openspec/specs/embed-text-extraction/spec.md)
