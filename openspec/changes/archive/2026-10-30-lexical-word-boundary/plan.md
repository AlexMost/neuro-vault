# Lexical word boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the lexical leg matches a token (and the phrase) only where it starts at a word
boundary, and drops Excalidraw `compressed-json` payloads from its units, so spurious matches
on control queries go away without costing answerable entries.

**Architecture:** two leaf changes inside `src/lib/obsidian/lexical/`. `matchUnit` (`match.ts`)
replaces each `indexOf` with a scan for the first occurrence at a boundary (design D1–D3);
`parseNote` (`blocks.ts`) skips `compressed-json` code nodes (D4). Every reader, the per-token
diagnostic and the eval inherit both through the shared functions.

**Tech Stack:** TypeScript ESM, vitest.

**Spec:** `specs/hybrid-search/spec.md` (RENAMED + MODIFIED) and `design.md` in this change.

**Execution:** native. This session implements every task, then one fresh whole-branch reviewer
checks the branch. The tasks are two small leaf functions plus their pins and docs.

## Global Constraints

- Word character: `\p{L}`, `\p{N}`, `_`, `'` (the unified apostrophe). Boundary: index 0, or the
  preceding code point is not a word character (D2).
- A phrase or token whose first character is not `\p{L}` or `\p{N}` matches at any occurrence
  (D3).
- The token's end is free. Density, tiers, caps, snippets and the response shape are unchanged.
- Only `code` nodes with `lang === 'compressed-json'` are skipped; a `json` fence stays a unit.
- `search_notes` description stays within `DESCRIPTION_BUDGET` (3800,
  `test/semantic/tools/search-notes.test.ts`); do not raise the budget.
- No private vault content in any file, commit or PR: aggregate numbers only.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass before each commit.
  Commit bodies have lines of 100 characters or fewer and one `Co-Authored-By` trailer.

## Review Focus

1. A unit where the token first occurs inside a word and later at a word start must match, with
   `firstIndex` at the later occurrence, so the snippet shows the real match (Task 1).
2. A non-BMP letter before the token must count as a letter: reading one UTF-16 unit back sees a
   lone surrogate, which is not `\p{L}` (Task 1).
3. A token led by `'` or `_` (not a letter or digit) needs no boundary, by the rule as written
   (Task 1, the D3 test with `'`).
4. An existing test that relied on in-word substring matching must be rewritten to the new rule,
   not deleted (Task 3: run the whole suite and read every failure).
5. A drawing note's `Text Elements` paragraph and headings must still match after the payload is
   dropped (Task 2).

---

### Task 1: Word-prefix matching

**Files:**
- Modify: `src/lib/obsidian/lexical/match.ts`
- Create: `test/lib/obsidian/lexical/match.test.ts`

**Interfaces:**
- Produces: `matchUnit(normUnit, normQuery, tokens): UnitHit | null` — signature unchanged.
  Module-private `indexAtBoundary(unit: string, needle: string): number` (−1 when none).

- [ ] **Step 1: Write the failing tests** — `describe('matchUnit word-prefix rule')`:
  - `matchUnit('пошуком у vault', 'пошук', ['пошук'])` → non-null, `firstIndex` 0.
  - `matchUnit('rapid growth', 'api', ['api'])` → null.
  - `matchUnit('tolerant_arguments', 'arguments', ['arguments'])` → null.
  - `matchUnit("об'єкт", 'єкт', ['єкт'])` → null.
  - `matchUnit('tolerant-arguments', 'tolerant arguments', ['tolerant', 'arguments'])` →
    `phrase: false`, non-null.
  - `matchUnit('rapid api', 'api', ['api'])` → `phrase: true`, `firstIndex` 6.
  - `matchUnit('xvector search, vector search', 'vector search', ['vector', 'search'])` →
    `phrase: true`, `firstIndex` 16.
  - `matchUnit('𝐀api', 'api', ['api'])` (U+1D400, a letter) → null.
  - `matchUnit('v2/api/notes', '/api', ['/api'])` → non-null; `matchUnit('x.env', '.env',
    ['.env'])` → non-null; `matchUnit("rock'n'roll", "'n", ["'n"])` → non-null.
  - AND still requires every token: `matchUnit('vector db', 'vector search', ['vector',
    'search'])` → null.
- [ ] **Step 2: Run** `npx vitest run test/lib/obsidian/lexical/match.test.ts` — the in-word
  cases FAIL.
- [ ] **Step 3: Implement** `indexAtBoundary`: if `needle`'s first code point is not
  `\p{L}`/`\p{N}`, return `unit.indexOf(needle)`; otherwise loop `indexOf(needle, from)`, accept
  `i === 0` or a preceding code point (step back two units when `unit[i-1]` is a low surrogate)
  not matching `/[\p{L}\p{N}_']/u`, else `from = i + 1`. `matchUnit` uses it for the phrase and
  each token; everything else stays.
- [ ] **Step 4: Run** the file — PASS — then `npx vitest run test/lib/obsidian/lexical`.
- [ ] **Step 5: Commit** `feat(lexical): match tokens at a word boundary`.

### Task 2: Drawing payloads

**Files:**
- Modify: `src/lib/obsidian/lexical/blocks.ts`
- Modify: `test/lib/obsidian/lexical/blocks.test.ts`

- [ ] **Step 1: Write the failing test** `'drops an Excalidraw compressed-json payload, keeps its
  text elements'`: body
  `'# Excalidraw Data\n\n## Text Elements\nвекторний пошук ^abc\n\n%%\n## Drawing\n```compressed-json\nN4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA\n```\n%%\n'`
  → no unit's `raw` contains `N4KAk`; a body unit's `raw` contains `векторний пошук`. Second
  test: a ```` ```json ```` fence stays a body unit.
- [ ] **Step 2: Run** — FAIL on the payload assertion.
- [ ] **Step 3: Implement**: in `visit`, `continue` for `node.type === 'code' && node.lang ===
  'compressed-json'` before the body-unit branch, with a one-line comment naming Excalidraw.
- [ ] **Step 4: Run** `npx vitest run test/lib/obsidian/lexical` — PASS.
- [ ] **Step 5: Commit** `feat(lexical): drop Excalidraw drawing payloads from lexical units`.

### Task 3: Behaviour pins, description and docs

**Files:**
- Modify: `test/lib/obsidian/lexical/rank.test.ts`
- Modify: `src/modules/semantic/tools/search-notes.ts` (the `LEXICAL MATCHING:` line)
- Modify: `test/semantic/tools/search-notes-description.test.ts`
- Modify: `docs/architecture/lexical-search.md`, `docs/guide/finding-notes.md`,
  `docs/guide/routing.md`, `GLOSSARY.md`

- [ ] **Step 1: rank tests**: rename "inflected forms match by substring" to "…by word prefix";
  add `'an in-word occurrence is no candidate'` (note body `rapid growth`, query `api` →
  `notes` empty, `perQueryCounts.api` 0); `'per-token counts follow the boundary rule'` (notes
  `a.md` "rapid api", `b.md` "rapid", query `api zzz` → `perQueryTokenCounts['api zzz'].api`
  1); `'a drawing payload is neither matched nor counted'` (payload holding `n4kak`, query
  `n4kak` → no notes, count 0).
- [ ] **Step 2: Description**: the line becomes `'LEXICAL MATCHING: accent- and
  case-insensitive, at the start of a word (its end is free); a multiword query needs ALL tokens
  (AND), and a contiguous phrase ranks higher.'` Pin it in the description test; run
  `npx vitest run test/semantic/tools` — the budget test must still pass (shorten the line, not
  the budget, if it fails).
- [ ] **Step 3: Docs**: replace the substring claims with the word-prefix rule (D1–D3) and the
  payload skip (D4) in every place `tasks.md` 3.3 lists, then `grep -rn -i substring docs
  GLOSSARY.md` and fix any remaining lexical-leg claim. Keep the `tolerant_arguments` trade-off
  visible in `lexical-search.md`.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run typecheck && npm run format`; read
  every failure, rewrite a test that relied on in-word matching to the new rule.
- [ ] **Step 5: Commit** `docs(lexical): describe word-prefix matching`
  (with the description and test changes).

### Task 4: Measure, verify, close

- [ ] **Step 1:** production eval on the same vault sha, before (main) and after (branch):
  `npm run eval -- --vault <vault> --run production --pipeline <lexical|fused> --effort
  <quick|deep>`. Check the guard: lexical hit@3 / R@10 ≥ 0.714 / 0.557; fused hit@3 not
  dropping.
- [ ] **Step 2:** whole-branch review by one fresh reviewer; fix what it confirms.
- [ ] **Step 3:** verify.md, retrospective.md, `npx openspec archive lexical-word-boundary -y`,
  PR with `Closes #231` and aggregate numbers only.
