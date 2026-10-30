## Context

The lexical leg of `search_notes` (`src/lib/obsidian/lexical/`) extracts units from a note's
markdown AST (`parseNote`, `blocks.ts`), normalizes them, and matches each query with
`matchUnit` (`match.ts`): the whole normalized query as a contiguous substring is a phrase
match, otherwise every whitespace token must occur somewhere in the unit (AND). Both checks
are plain `indexOf`. The substring rule was chosen in the original hybrid-search design for
recall over Ukrainian inflections, and is pinned by the `hybrid-search` spec and promised by
the `search_notes` description.

The extended eval (#220) and its miss analysis (#221) show the price: every lexical hit on a
control query is spurious. Short tokens match inside longer words, identifiers and URLs, and
inside Excalidraw `compressed-json` payloads, which `parseNote` takes as body units because
they are fenced code. The decision (#228) was simulated against a re-implementation of the
ranker that reproduces today's baseline; its numbers are in `brainstorm.md`.

Every lexical reader shares `parseNote` and `matchUnit`: the daemon's and the in-process
`lexical` service, the standalone reader (`--no-semantic`) and the eval's lexical and fused
pipelines. So does the per-token diagnostic (`lexical_tokens` in `query_stats`), which calls
`matchUnit` per token. The parity oracle in the tests uses the live `parseNote`/`rankNotes`,
so it follows the rule without change.

## Goals / Non-Goals

**Goals:**

- A query token, and the phrase, matches only where it starts at a word boundary; its end
  stays free, so stems still match inflected forms.
- Excalidraw drawing payloads leave the lexical leg.
- The advertised matching semantics (tool description, spec, architecture doc, guides,
  glossary) say word-prefix, not substring.
- On the production eval: `lexical` quick controls 5 → about 1 of 17, production `fused`
  quick 6 → about 3, with answerable hit@3 and recall@10 not dropping.

**Non-Goals:**

- Whole-word matching, stemming or any language-aware tokenizer.
- Stripping URLs, or excluding other code or base64 blocks.
- Changing tiers, density, caps, snippets or the response shape.
- The semantic corpus's handling of drawing payloads.
- The lexical pool size (#233).

## Decisions

### D1: Word-prefix matching for phrase and tokens

- **Choice:** `matchUnit` accepts an occurrence of the phrase, or of a token, only when it
  starts at a word boundary. It scans occurrences left to right (`indexOf` from the previous
  hit + 1) and takes the first that qualifies; `firstIndex` is that occurrence, so the snippet
  centres on the match that counted. Density keeps its formula (matched lengths ÷ unit
  length): the matched lengths do not change.
- **Rationale:** it drops matches inside longer words and keeps Ukrainian inflection
  (`пошук` → `пошуком`, `пошуку`). Simulated: lexical quick controls 5 → 1, hit@3 0.714 held,
  recall 0.560 → 0.565; the real-usage replay keeps 99.1% of the notes agents read.
- **Alternatives considered:** whole word (loses inflections: hit@3 0.698, fused deep recall
  0.812); substring kept for tokens of 5+ characters (measures the same as the plain rule).

### D2: What a boundary is

- **Choice:** a word character is a letter (`\p{L}`), a digit (`\p{N}`), `_` or the unified
  apostrophe `'`. An occurrence starts at a boundary when it is at index 0 or the code point
  before it is not a word character. The check reads the preceding code point, not the
  preceding UTF-16 unit, so a letter outside the BMP counts as a letter.
- **Rationale:** it is the definition the #228 simulation measured, so its numbers carry over.
  `'` is intra-word in Ukrainian (`об'єкт`). `_` follows `\w`.
- **Alternatives considered:** `_` as a boundary, so `tolerant arguments` keeps matching
  `tolerant_arguments` token by token. It departs from the measured rule and re-admits
  matches inside identifiers; left out. Hyphenated forms keep matching, since `-` is a
  boundary.

### D3: Tokens that start with a non-word character need no boundary

- **Choice:** when the phrase or a token begins with a character that is not a letter or a
  digit, any occurrence qualifies.
- **Rationale:** the leading character is its own boundary: `/api`, `#tag`, `.env` keep
  matching wherever they occur. This only adds matches over the simulated rule; the
  real-usage replay lost one such query without it.
- **Alternatives considered:** apply the boundary to every token alike; it loses
  punctuation-led queries for no noise gain.

### D4: Excalidraw payloads are not lexical units

- **Choice:** `parseNote` skips `code` nodes whose `lang` is `compressed-json`, in any note.
  The node produces no unit, so nothing ranks, counts or snippets it, and the per-token
  diagnostic does not see it either.
- **Rationale:** the block is the Excalidraw plugin's encoded drawing; nobody searches it, and
  it carries arbitrary letter runs. The drawing's own text sits in its `Text Elements`
  section, which stays a body unit. The language tag is specific to the plugin, so the check
  needs no path test.
- **Alternatives considered:** drop everything under the `Drawing` heading of a
  `.excalidraw.md` file (the simulation's proxy; it couples the rule to a file-name and
  heading convention); strip URLs too (people search by domain; almost no gain).

### D5: No new parameter, no opt-out

- **Choice:** the rule replaces substring matching; no `match: "substring"` switch.
- **Rationale:** the eval and the usage replay show no answerable cost, and a switch would add
  a tool-contract concept with no observed demand. `mode: "hybrid"` still recovers a note
  whose term only occurs inside a compound word, through the semantic leg.

No ADR is proposed: the change replaces one matching rule inside the lexical leg, recorded in
the `hybrid-search` spec and `docs/architecture/lexical-search.md`.

## Risks / Trade-offs

- [Risk] A token that only occurs inside a compound word or after `_` no longer matches →
  Mitigation: the hybrid default still reaches it semantically; the phrase or the compound's
  first part still matches lexically; the replay measured the loss at 5 of 561 read notes.
- [Risk] The boundary scan re-runs `indexOf` past rejected occurrences, so a token frequent
  inside words costs more scans per unit → Mitigation: each scan is linear in the unit and
  the number of rejected occurrences is bounded by the unit length; the vault is ~1k notes.
- [Risk] A stale shared daemon serves the old rule after the upgrade → Mitigation: the daemon
  key covers the CLI build, so a new build gets a new daemon (`shared-daemon.md`).
- [Trade-off] `tolerant_arguments` stops matching the query `tolerant arguments` → accepted
  to keep the measured rule; tests pin it so the choice stays visible.

## Migration Plan

N/A — no stored state changes. The lexical cache is in memory and rebuilt by the new build's
daemon; there is no persisted index to migrate. Rollback is reverting the change.

Acceptance: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass; the
production eval moves `lexical` quick and `fused` quick controls as stated in Goals, with
`lexical` hit@3 / recall@10 at or above 0.714 / 0.557 and fused hit@3 not dropping.

## Open Questions

None blocking. Whether `_` should become a boundary is answerable from usage later; it is
recorded under D2.
