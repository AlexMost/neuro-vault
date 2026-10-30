# Brainstorm — lexical-word-boundary

Tracked by #231. Epic #234. Decided on wayfinder map #216:
[Lexical matching noise](https://github.com/AlexMost/neuro-vault/issues/228#issuecomment-6509479525),
on the evidence of the miss analysis (#221). Cites #190 point 1.

## Background

The lexical leg matches a query token anywhere inside a unit's normalized text. The extended eval
(#220) shows every lexical hit on a control query is spurious: `lexical` quick returns notes for
5 of 17 controls (1.12 notes on average), and production `fused` quick, on top of the new
semantic floor (#230), for 6 of 17 (1.29). The miss analysis traced them to two causes:

- Short acronyms match inside longer words, other-language text, identifiers and URLs.
- They also match inside Excalidraw drawing payloads (`compressed-json` code blocks), which the
  leg indexes as body text. In deep, 8 of 329 lexically surfaced notes are payload matches.

Simulated against a re-implementation of the lexical ranker (same normalisation, AST units,
tiers, density and backlink tie-break; it reproduces today's baseline exactly), with semantic
seeds at the #230 floors:

| rule | lexical quick hit@3 / recall | lexical quick ctl any / mean | fused quick ctl any / mean | fused deep recall |
|---|---|---|---|---|
| substring (today) | 0.714 / 0.560 | 5 / 1.12 | 6 / 1.29 | 0.841 |
| token starts at a word boundary | 0.714 / 0.565 | 1 / 0.12 | 3 / 0.47 | 0.845 |
| whole word | 0.698 / 0.536 | 0 / 0 | 2 / 0.35 | 0.812 |
| boundary, substring for tokens ≥ 5 | same as boundary | | | |
| boundary + no drawing payloads + no URLs | 0.714 / 0.565 | 1 / 0.06 | 3 / 0.41 | 0.850 |

Fused quick hit@3 stays at 0.937 under the boundary rule.

Real usage (480 mined `search_notes` calls, replayed against the current vault): the boundary
rule removes 15% of lexical matches and keeps 556 of the 561 notes (99.1%) that agents went on
to read after the lexical leg matched them. Of the 5 it loses, one was noise, one is a query
that starts with punctuation, and the rest are parts of compound words.

## Decision log

**Q1: which boundary rule?** A query token must start at a word boundary; its end is free. A
stem still matches its inflected forms (`пошук` → `пошуком`), and a token no longer matches
inside a longer word. The rule applies to the phrase match and to every token of the AND match.
- Rejected: whole word. It loses inflections: hit@3 0.698, fused deep recall 0.812.
- Rejected: substring kept for tokens of 5+ characters. It measures the same as the plain
  boundary rule, so the extra case buys nothing.

**Q2: what is a word character?** A letter (`\p{L}`), a digit (`\p{N}`), `_` or the unified
apostrophe `'`. That is the simulated rule, so the measured numbers carry over. A boundary is
the start of the unit, or a preceding character that is not a word character: whitespace,
hyphen, slash, dot, bracket, `#`, other punctuation.
- `'` is a word character because the Ukrainian apostrophe sits inside a word (`об'єкт`): `єкт`
  must not match there.
- `_` is a word character, as in `\w`. A token after `_` inside an identifier
  (`tolerant_arguments`) therefore no longer matches on its own; the whole identifier and its
  first part still do. Hyphenated forms (`tolerant-arguments`) keep matching token by token,
  since `-` is a boundary. Treating `_` as a boundary is the one alternative that departs from
  the measured rule; it is noted here and left out.

**Q3: what about tokens that start with a non-word character?** A token whose first character
is not a letter or digit needs no boundary: that character is its own boundary. `/api`, `#tag`
and `.env` match wherever they occur, as today. The simulation did not model this exception;
it only adds matches (the real-usage replay lost one such query).

**Q4: which non-prose units leave the lexical leg?** Excalidraw `compressed-json` code blocks
(the encoded drawing data). They are dropped at unit extraction, so nothing ranks, counts or
snippets them. The drawing's `Text Elements` section stays searchable: it is the drawing's
own text.
- Rejected: stripping URLs. People search by domain, and stripping them adds almost nothing
  (ctl mean 0.12 → 0.06 together with the payload exclusion).
- Out of scope: other code or base64 blocks. No evidence names them.

**Q5: what does it cost answerable entries?** Nothing measurable: lexical quick hit@3 stays at
0.714 and recall rises 0.560 → 0.565 (spurious notes no longer take pool slots); fused quick
hit@3 stays at 0.937.

**Q6: opsx or direct PR?** opsx. It changes the documented matching semantics: the
`search_notes` description promises substring matching, and the `hybrid-search` spec
requirement "Matching is normalized substring AND" pins it, with the scenario "inflected
forms match by substring".

## Touchpoints (for design/plan)

- `src/lib/obsidian/lexical/match.ts` — `matchUnit` finds the first occurrence that starts at
  a boundary, for the phrase and for each token. `firstIndex` is that occurrence, so snippets
  centre on the boundary match. The per-token diagnostic in `rank.ts` calls `matchUnit` and
  inherits the rule.
- `src/lib/obsidian/lexical/blocks.ts` — `parseNote` skips `code` nodes whose `lang` is
  `compressed-json`.
- `src/modules/semantic/tools/search-notes.ts` — the `LEXICAL MATCHING:` description line says
  word-prefix instead of substring, within the description budget.
- `openspec/specs/hybrid-search/spec.md` — MODIFIED "Matching is normalized substring AND" and
  "Lexical leg matches title, headings, and body blocks".
- Docs: `docs/architecture/lexical-search.md` (normalize chain note, §5, "does not do"),
  `docs/guide/finding-notes.md`, `docs/guide/routing.md`, `GLOSSARY.md` *Lexical leg*.
- The parity oracle (`test/lib/obsidian/lexical/_legacy-lexical-index.ts`) uses the live
  `parseNote` and `rankNotes`, so it follows the new rule without change.

## Acceptance

- `lexical` quick: controls returning anything 5 → about 1, mean notes 1.12 → about 0.12.
- Production `fused` quick: controls 6 → about 3, mean 1.29 → about 0.47 (about 0.41 with the
  payload exclusion).
- Guard: `lexical` hit@3 / recall@10 stay at or above 0.714 / 0.557; fused hit@3 does not drop.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass.

## Out of scope

- Stripping URLs; excluding other code or base64 blocks.
- The semantic corpus: whether drawing payloads reach the embedding text is a separate question.
- The lexical pool size (#233).
