Tracked by: #231

## Why

The lexical leg matches a query token anywhere inside a unit's text, so short acronyms hit
inside longer words, other-language text, identifiers and URLs, and inside the encoded
payloads of Excalidraw drawings. On the extended eval every lexical hit on a control query
is spurious: `lexical` quick returns notes for 5 of 17 controls, and production `fused`
quick for 6 of 17 even after the semantic floors of #230. A word-boundary rule removes most
of that noise without costing answerable entries, and with the semantic floor in place it is
now the largest source of junk left in the fused list.

## What Changes

**Lexical token matching**
- From: a token (and the phrase) matches as a substring anywhere in a unit.
- To: a token (and the phrase) matches only where it starts at a word boundary; its end is
  free, so a stem still matches its inflected forms. A token whose first character is not a
  letter or digit needs no boundary.
- Reason: drops matches inside longer words while keeping Ukrainian inflections.
- Impact: non-breaking in shape; fewer lexical matches. A token that only occurred inside a
  longer word (or after `_` inside an identifier) no longer matches.

**Excalidraw drawing payloads**
- From: `compressed-json` code blocks are body units of the lexical leg.
- To: they are not lexical units; the drawing's `Text Elements` stay searchable.
- Reason: the payload is encoded drawing data, not text anyone searches.
- Impact: non-breaking; drawings match only on their text, title and headings.

**Advertised semantics**
- The `search_notes` description, `docs/architecture/lexical-search.md`, the guides and the
  GLOSSARY *Lexical leg* entry describe word-prefix matching instead of substring matching.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hybrid-search`: "Matching is normalized substring AND" becomes word-prefix AND matching;
  "Lexical leg matches title, headings, and body blocks" excludes Excalidraw
  `compressed-json` blocks.

## Impact

- Code: `src/lib/obsidian/lexical/match.ts`, `src/lib/obsidian/lexical/blocks.ts`, the
  `search_notes` description in `src/modules/semantic/tools/search-notes.ts`.
- Behaviour: every lexical reader (daemon, in-process, standalone) and the eval's lexical and
  fused pipelines, since they share `parseNote` and `matchUnit`. No input or output shape
  changes, no new parameter, no error code.
- Docs: `docs/architecture/lexical-search.md`, `docs/guide/finding-notes.md`,
  `docs/guide/routing.md`, `GLOSSARY.md`.
