# Hybrid Search Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lexical (exact-match) leg to `search_notes` so it returns `{ semantic_matches, lexical_matches }` with orthogonal `mode`/`effort` axes — breaking major release.

**Architecture:** A new pure-function lexical stack under `src/lib/obsidian/lexical/` (normalize → markdown-AST block extraction → AND-substring match → six-tier deterministic rank → snippet) fronted by a per-vault `LexicalIndex` with an mtime cache. `search-notes.ts` orchestrates both legs; the lexical leg never touches the Smart Connections corpus loader. See `design.md` (D1–D10) and `specs/hybrid-search/spec.md` in this change directory.

**Tech Stack:** TypeScript strict/ESM (Node ≥ 20), zod, vitest, `mdast-util-from-markdown` (new dependency — block-level AST with line positions).

## Global Constraints

- Gates before EVERY commit: `npm test && npm run lint && npx tsc --noEmit` — all green. `npx tsc --noEmit` is the type-correctness authority, not the tsup build (ADR-0002).
- ESM imports end in `.js` even for TS files (`import ... from './normalize.js'`).
- Tool errors only via `ToolHandlerError('CODE', message, { details })` (ADR-0003).
- Parameter names come from the MCP parameter dictionary; this change ships the breaking rename as a major (ADR-0005).
- The Smart Connections corpus is read-only and must stay untouched by the lexical leg (ADR-0006).
- Tests live under `test/` (not `tests/`); tool-contract tests MUST go through the SDK gate (`reg.spec.inputSchema` / `tool.inputSchema.safeParse`), not handler-direct.
- Conventional Commits; do not add Co-Authored-By trailers naming the executing model.
- Never push to `main`; the change lands as one PR via `gh pr create`.

---

### Task 1: Parser spike + dependency

**Files:**
- Create: `openspec/changes/hybrid-search-notes/spike-notes.md` (throwaway record, 5 lines)
- Modify: `package.json` (dependency)

**Interfaces:**
- Produces: `mdast-util-from-markdown` available as a dependency; confirmed that block nodes carry `position.start.line` / `position.end.line`.

- [ ] **Step 1: Install the parser and types**

```bash
npm install mdast-util-from-markdown
npm install -D @types/mdast
```

- [ ] **Step 2: Spike it against a hard-wrapped paragraph + fence**

Run: `npx tsx -e "
import { fromMarkdown } from 'mdast-util-from-markdown';
const tree = fromMarkdown('# H1\n\nвекторний\nпошук у vault\n\n\`\`\`\n# not a heading\n\`\`\`\n');
for (const n of tree.children) console.log(n.type, n.position?.start.line, n.position?.end.line);
"`
Expected output (types and 1-based line ranges):
```
heading 1 1
paragraph 3 4
code 6 8
```
Record the observed output in `spike-notes.md` with the sentence "mdast-util-from-markdown confirmed: block nodes + line positions; markdown-it fallback not needed." Update `design.md` §Open Questions: parser question resolved to `mdast-util-from-markdown`.

- [ ] **Step 3: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add package.json package-lock.json openspec/changes/hybrid-search-notes/
git commit -m "chore(deps): add mdast-util-from-markdown for lexical leg"
```

---

### Task 2: `normalize.ts` — normalization with offset map

**Files:**
- Create: `src/lib/obsidian/lexical/normalize.ts`
- Test: `test/lib/obsidian/lexical/normalize.test.ts`

**Interfaces:**
- Produces:
  - `normalizeWithMap(raw: string): { norm: string; map: number[] }` — `map[i]` = index in `raw` of the char that produced `norm[i]`.
  - `normalizeText(raw: string): string`
  - `tokenizeQuery(query: string): string[]` — normalized whitespace-split tokens, punctuation kept.

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/lexical/normalize.test.ts
import { describe, expect, it } from 'vitest';

import {
  normalizeText,
  normalizeWithMap,
  tokenizeQuery,
} from '../../../../src/lib/obsidian/lexical/normalize.js';

describe('normalizeText', () => {
  it('lowercases Latin and Cyrillic', () => {
    expect(normalizeText('ПОШУК MCP')).toBe('пошук mcp');
  });

  it('strips combining marks via NFKD (accent-insensitive)', () => {
    expect(normalizeText('résumé')).toBe('resume');
  });

  it('folds й→и and ї→і (deliberate recall bias)', () => {
    expect(normalizeText('йога її')).toBe('иога іі');
  });

  it('does NOT merge і and и', () => {
    expect(normalizeText('і')).not.toBe(normalizeText('и'));
  });

  it('unifies apostrophe variants to U+0027', () => {
    for (const s of ["об'єкт", 'обʼєкт', 'об’єкт', 'об‘єкт']) {
      expect(normalizeText(s)).toBe("об'єкт");
    }
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  a\t\tb \n c  ')).toBe('a b c');
  });
});

describe('normalizeWithMap', () => {
  it('maps normalized indices back to raw indices', () => {
    const raw = 'Об’єкт X';
    const { norm, map } = normalizeWithMap(raw);
    expect(norm).toBe("об'єкт x");
    // norm[0] 'о' came from raw[0] 'О'
    expect(map[0]).toBe(0);
    // norm index of 'x' maps to raw index of 'X'
    expect(raw[map[norm.indexOf('x')]!]).toBe('X');
  });
});

describe('tokenizeQuery', () => {
  it('splits on whitespace, keeps punctuation inside tokens', () => {
    expect(tokenizeQuery('  Tolerant-Arguments  spec ')).toEqual(['tolerant-arguments', 'spec']);
  });

  it('returns [] for blank input', () => {
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/lexical/normalize.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/obsidian/lexical/normalize.js`.

- [ ] **Step 3: Implement**

```ts
// src/lib/obsidian/lexical/normalize.ts
const APOSTROPHE_VARIANTS = /[‘’ʼ]/;
const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/u;

export interface NormalizedText {
  norm: string;
  /** map[i] = index in the raw string of the character that produced norm[i]. */
  map: number[];
}

/**
 * lowercase → NFKD → strip combining marks → apostrophe unification →
 * whitespace collapse (+ trim). Keeps an offset map so a match position in
 * the normalized text can be projected back onto the raw text for snippets.
 */
export function normalizeWithMap(raw: string): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // swallows leading whitespace
  let rawIndex = 0;

  for (const ch of raw) {
    const decomposed = ch.toLowerCase().normalize('NFKD');
    for (const piece of decomposed) {
      if (COMBINING_MARK.test(piece)) continue;
      if (WHITESPACE.test(piece)) {
        if (!lastWasSpace) {
          out.push(' ');
          map.push(rawIndex);
          lastWasSpace = true;
        }
        continue;
      }
      out.push(APOSTROPHE_VARIANTS.test(piece) ? "'" : piece);
      map.push(rawIndex);
      lastWasSpace = false;
    }
    rawIndex += ch.length;
  }

  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  return { norm: out.join(''), map };
}

export function normalizeText(raw: string): string {
  return normalizeWithMap(raw).norm;
}

export function tokenizeQuery(query: string): string[] {
  const norm = normalizeText(query);
  return norm.length === 0 ? [] : norm.split(' ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/lexical/normalize.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/lib/obsidian/lexical/normalize.ts test/lib/obsidian/lexical/normalize.test.ts
git commit -m "feat(lexical): normalization with offset map (case/NFKD/apostrophes/whitespace)"
```

---

### Task 3: `blocks.ts` — AST block extraction

**Files:**
- Create: `src/lib/obsidian/lexical/blocks.ts`
- Test: `test/lib/obsidian/lexical/blocks.test.ts`

**Interfaces:**
- Consumes: `normalizeWithMap` from `./normalize.js`.
- Produces:
  ```ts
  interface NoteUnit {
    kind: 'heading' | 'body';
    raw: string;                 // plain text content of the block
    norm: string;
    map: number[];
    lines: [number, number];     // 1-based, relative to the FULL note file
    heading?: string;            // enclosing section heading (body units only)
  }
  interface ParsedNote {
    title: { raw: string; norm: string; map: number[] };  // filename sans .md
    units: NoteUnit[];
  }
  parseNote(opts: { path: string; body: string; lineOffset: number }): ParsedNote
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/lexical/blocks.test.ts
import { describe, expect, it } from 'vitest';

import { parseNote } from '../../../../src/lib/obsidian/lexical/blocks.js';

describe('parseNote', () => {
  it('derives the title from the filename without .md', () => {
    const parsed = parseNote({ path: 'Tasks/Пошук.md', body: '', lineOffset: 0 });
    expect(parsed.title.raw).toBe('Пошук');
    expect(parsed.title.norm).toBe('пошук');
  });

  it('extracts headings and body blocks with line ranges', () => {
    const body = '# Розділ\n\nПерший абзац.\n\nДругий абзац.\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toEqual([
      expect.objectContaining({ kind: 'heading', raw: 'Розділ', lines: [1, 1] }),
      expect.objectContaining({ kind: 'body', raw: 'Перший абзац.', lines: [3, 3], heading: 'Розділ' }),
      expect.objectContaining({ kind: 'body', raw: 'Другий абзац.', lines: [5, 5], heading: 'Розділ' }),
    ]);
  });

  it('keeps a hard-wrapped paragraph as ONE unit (phrase across linewrap)', () => {
    const body = 'векторний\nпошук у vault\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]!.norm).toContain('векторнии пошук'); // й→и per normalize
    expect(parsed.units[0]!.lines).toEqual([1, 2]);
  });

  it('treats fenced code as body, never heading', () => {
    const body = '```\n# не заголовок\n```\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]!.kind).toBe('body');
    expect(parsed.units[0]!.raw).toContain('# не заголовок');
  });

  it('collects list items and blockquote paragraphs as body units', () => {
    const body = '- перший пункт\n- другий пункт\n\n> цитата тут\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    const texts = parsed.units.map((u) => u.raw);
    expect(texts).toEqual(['перший пункт', 'другий пункт', 'цитата тут']);
  });

  it('shifts line numbers by lineOffset (frontmatter)', () => {
    const parsed = parseNote({ path: 'n.md', body: 'абзац\n', lineOffset: 4 });
    expect(parsed.units[0]!.lines).toEqual([5, 5]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/lexical/blocks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/obsidian/lexical/blocks.ts
import path from 'node:path';

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Heading, Nodes, Parent, RootContent } from 'mdast';

import { normalizeWithMap } from './normalize.js';

export interface NoteUnit {
  kind: 'heading' | 'body';
  raw: string;
  norm: string;
  map: number[];
  lines: [number, number];
  heading?: string;
}

export interface ParsedNote {
  title: { raw: string; norm: string; map: number[] };
  units: NoteUnit[];
}

function nodeText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) {
    return (node as Parent).children.map((c) => nodeText(c as Nodes)).join('');
  }
  return '';
}

function linesOf(node: Nodes, lineOffset: number): [number, number] {
  const start = (node.position?.start.line ?? 1) + lineOffset;
  const end = (node.position?.end.line ?? start) + lineOffset;
  return [start, end];
}

/** Leaf block types that become body units. Containers below are recursed into. */
const CONTAINER_TYPES = new Set(['list', 'listItem', 'blockquote']);

export function parseNote(opts: { path: string; body: string; lineOffset: number }): ParsedNote {
  const titleRaw = path.basename(opts.path, '.md');
  const titleNorm = normalizeWithMap(titleRaw);

  const units: NoteUnit[] = [];
  let currentHeading: string | undefined;

  const visit = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const raw = nodeText(node as Heading).trim();
        if (raw.length > 0) {
          const { norm, map } = normalizeWithMap(raw);
          units.push({ kind: 'heading', raw, norm, map, lines: linesOf(node, opts.lineOffset) });
        }
        currentHeading = raw.length > 0 ? raw : currentHeading;
        continue;
      }
      if (CONTAINER_TYPES.has(node.type) && 'children' in node) {
        visit((node as Parent).children as RootContent[]);
        continue;
      }
      if (node.type === 'paragraph' || node.type === 'code' || node.type === 'table') {
        const raw = nodeText(node).trim();
        if (raw.length === 0) continue;
        const { norm, map } = normalizeWithMap(raw);
        units.push({
          kind: 'body',
          raw,
          norm,
          map,
          lines: linesOf(node, opts.lineOffset),
          heading: currentHeading,
        });
      }
    }
  };

  visit(fromMarkdown(opts.body).children);

  return { title: { raw: titleRaw, ...titleNorm }, units };
}
```

Note: a `listItem` wraps its text in a `paragraph`, so recursion into containers yields one body unit per list item, matching the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/lexical/blocks.test.ts`
Expected: PASS. If the list-item expectation fails on ordering, print `parsed.units` and fix the container recursion (list → listItem → paragraph), not the test.

- [ ] **Step 5: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/lib/obsidian/lexical/blocks.ts test/lib/obsidian/lexical/blocks.test.ts
git commit -m "feat(lexical): markdown AST block extraction with line positions"
```

---

### Task 4: `match.ts` + `rank.ts` — tiers, density, staged evaluation

**Files:**
- Create: `src/lib/obsidian/lexical/match.ts`
- Create: `src/lib/obsidian/lexical/rank.ts`
- Test: `test/lib/obsidian/lexical/rank.test.ts`

**Interfaces:**
- Consumes: `ParsedNote`, `NoteUnit` from `./blocks.js`; `tokenizeQuery`, `normalizeText` from `./normalize.js`.
- Produces:
  ```ts
  // match.ts
  interface UnitHit { phrase: boolean; density: number; firstIndex: number; matchLen: number }
  matchUnit(normUnit: string, normQuery: string, tokens: string[]): UnitHit | null

  // rank.ts
  interface LexicalMatch { matched_in: 'title' | 'heading' | 'body'; snippet: string; lines?: [number, number]; heading?: string }
  interface RankedNote { path: string; matches: LexicalMatch[]; matchedQueries: string[] }
  rankNotes(opts: {
    notes: Map<string, ParsedNote>;        // path → parsed
    queries: string[];                     // original query strings
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): { notes: RankedNote[]; truncated: boolean }
  ```
- Note: `rank.ts` calls `makeSnippet` from `./snippet.js` (Task 5). Implement Task 5 first if executing out of order; otherwise stub `makeSnippet` is NOT allowed — Tasks 4 and 5 are ordered 5-before-4 in commits below (write snippet first inside this task's steps).

- [ ] **Step 1: Write `snippet.ts` failing test + implementation FIRST (small, needed by rank)**

```ts
// test/lib/obsidian/lexical/snippet.test.ts
import { describe, expect, it } from 'vitest';

import { makeSnippet } from '../../../../src/lib/obsidian/lexical/snippet.js';
import { normalizeWithMap } from '../../../../src/lib/obsidian/lexical/normalize.js';

describe('makeSnippet', () => {
  it('returns the whole text when it fits the window', () => {
    const raw = 'короткий рядок';
    const { norm, map } = normalizeWithMap(raw);
    expect(makeSnippet(raw, map, norm.indexOf('рядок'), 'рядок'.length)).toBe('короткий рядок');
  });

  it('windows long text around the match with ellipses', () => {
    const raw = `${'а'.repeat(300)} пошук ${'б'.repeat(300)}`;
    const { norm, map } = normalizeWithMap(raw);
    const snippet = makeSnippet(raw, map, norm.indexOf('пошук'), 'пошук'.length);
    expect(snippet).toContain('пошук');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect([...snippet].length).toBeLessThanOrEqual(160);
  });

  it('does not split surrogate pairs / emoji at window edges', () => {
    const raw = `${'🐍'.repeat(120)} пошук ${'🐍'.repeat(120)}`;
    const { norm, map } = normalizeWithMap(raw);
    const snippet = makeSnippet(raw, map, norm.indexOf('пошук'), 'пошук'.length);
    // well-formed: re-encoding round-trips only when no lone surrogates exist
    expect(snippet).toBe(Buffer.from(snippet, 'utf8').toString('utf8'));
  });
});
```

```ts
// src/lib/obsidian/lexical/snippet.ts
const WINDOW = 150;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * ~150-char grapheme-safe window around the first match, projected from
 * normalized-match coordinates back onto the raw text via the offset map.
 */
export function makeSnippet(
  raw: string,
  map: number[],
  normStart: number,
  normLen: number,
  window = WINDOW,
): string {
  if (raw.length <= window) return raw;

  const rawStart = map[Math.min(normStart, map.length - 1)] ?? 0;
  const rawEnd = map[Math.min(normStart + Math.max(normLen - 1, 0), map.length - 1)] ?? rawStart;

  const graphemes = [...segmenter.segment(raw)]; // { segment, index }
  const startG = graphemes.findIndex((g) => g.index + g.segment.length > rawStart);
  const endG = graphemes.findIndex((g) => g.index + g.segment.length > rawEnd);
  const matchSpan = Math.max(endG - startG + 1, 1);
  const pad = Math.max(Math.floor((window - matchSpan) / 2), 0);

  const from = Math.max(startG - pad, 0);
  const to = Math.min(endG + pad, graphemes.length - 1);
  const slice = graphemes.slice(from, to + 1).map((g) => g.segment).join('');

  return `${from > 0 ? '…' : ''}${slice.trim()}${to < graphemes.length - 1 ? '…' : ''}`;
}
```

Run: `npx vitest run test/lib/obsidian/lexical/snippet.test.ts` — expect FAIL first (module missing), then PASS after writing the implementation.

- [ ] **Step 2: Write `match.ts` (no separate test file — covered via rank tests)**

```ts
// src/lib/obsidian/lexical/match.ts
export interface UnitHit {
  phrase: boolean;
  density: number;    // matched chars / unit length, capped at 1
  firstIndex: number; // index of first match in the NORMALIZED unit
  matchLen: number;   // normalized length of the phrase (or first token) matched
}

export function matchUnit(normUnit: string, normQuery: string, tokens: string[]): UnitHit | null {
  if (tokens.length === 0 || normUnit.length === 0) return null;

  const phraseIdx = normUnit.indexOf(normQuery);
  if (phraseIdx >= 0) {
    return {
      phrase: true,
      density: Math.min(normQuery.length / normUnit.length, 1),
      firstIndex: phraseIdx,
      matchLen: normQuery.length,
    };
  }

  let firstIndex = Number.MAX_SAFE_INTEGER;
  let firstLen = 0;
  let total = 0;
  for (const token of tokens) {
    const idx = normUnit.indexOf(token);
    if (idx < 0) return null; // AND semantics
    total += token.length;
    if (idx < firstIndex) {
      firstIndex = idx;
      firstLen = token.length;
    }
  }
  return {
    phrase: false,
    density: Math.min(total / normUnit.length, 1),
    firstIndex,
    matchLen: firstLen,
  };
}
```

- [ ] **Step 3: Write the failing rank tests**

```ts
// test/lib/obsidian/lexical/rank.test.ts
import { describe, expect, it } from 'vitest';

import { parseNote } from '../../../../src/lib/obsidian/lexical/blocks.js';
import { rankNotes } from '../../../../src/lib/obsidian/lexical/rank.js';

function notes(entries: Array<[string, string]>) {
  return new Map(entries.map(([p, body]) => [p, parseNote({ path: p, body, lineOffset: 0 })]));
}

const noBacklinks = () => 0;

describe('rankNotes', () => {
  it('title match outranks heading match outranks body match', () => {
    const map = notes([
      ['c-body.md', 'десь тут пошук у тексті\n'],
      ['a-пошук.md', ''],
      ['b-head.md', '# пошук\n'],
    ]);
    // rename a-пошук.md so its TITLE matches:
    map.set('Пошук.md', parseNote({ path: 'Пошук.md', body: '', lineOffset: 0 }));
    map.delete('a-пошук.md');
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['Пошук.md', 'b-head.md', 'c-body.md']);
    expect(ranked[0]!.matches[0]!.matched_in).toBe('title');
    expect(ranked[1]!.matches[0]!.matched_in).toBe('heading');
    expect(ranked[2]!.matches[0]!.matched_in).toBe('body');
  });

  it('density breaks ties within a tier', () => {
    const map = notes([
      ['Довгі роздуми про пошук сенсу.md', ''],
      ['Пошук.md', ''],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['Пошук.md', 'Довгі роздуми про пошук сенсу.md']);
  });

  it('phrase beats AND-tokens in the same unit kind', () => {
    const map = notes([
      ['tokens.md', '# пошук векторний та інше\n'],
      ['phrase.md', '# векторний пошук\n'],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['векторний пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['phrase.md', 'tokens.md']);
  });

  it('groups all evidence of one note under matches[] with per-note cap', () => {
    const body = ['# пошук', '', 'пошук раз.', '', 'пошук два.', '', 'пошук три.', '', 'пошук чотири.', ''].join('\n');
    const map = notes([['Пошук.md', body]]);
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.matches).toHaveLength(3); // capped, best tiers first
    expect(ranked[0]!.matches[0]!.matched_in).toBe('title');
  });

  it('body match carries section heading and lines', () => {
    const map = notes([['n.md', '# Рішення\n\nтут пошук живе.\n']]);
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    const body = ranked[0]!.matches.find((m) => m.matched_in === 'body')!;
    expect(body.heading).toBe('Рішення');
    expect(body.lines).toEqual([3, 3]);
  });

  it('global cap truncates and reports truncated', () => {
    const map = notes([
      ['a пошук.md', ''],
      ['b пошук.md', ''],
      ['c пошук.md', ''],
    ]);
    const res = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 2, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(res.notes).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('multi-query merges with matchedQueries annotation', () => {
    const map = notes([
      ['Vector search.md', ''],
      ['Векторний пошук.md', ''],
    ]);
    const { notes: ranked } = rankNotes({
      notes: map,
      queries: ['vector search', 'векторний пошук'],
      noteCap: 10, perNoteCap: 3, getBacklinkCount: noBacklinks,
    });
    expect(ranked).toHaveLength(2);
    for (const n of ranked) expect(n.matchedQueries).toHaveLength(1);
  });

  it('is deterministic: backlink desc then path asc as final tie-breaks', () => {
    const map = notes([
      ['b пошук тут.md', ''],
      ['a пошук тут.md', ''],
    ]);
    const backlinks = (p: string) => (p.startsWith('b') ? 5 : 0);
    const { notes: ranked } = rankNotes({
      notes: map, queries: ['пошук'], noteCap: 10, perNoteCap: 3, getBacklinkCount: backlinks,
    });
    expect(ranked.map((n) => n.path)).toEqual(['b пошук тут.md', 'a пошук тут.md']);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/lexical/rank.test.ts`
Expected: FAIL — `rank.js` not found.

- [ ] **Step 5: Implement `rank.ts`**

```ts
// src/lib/obsidian/lexical/rank.ts
import type { ParsedNote } from './blocks.js';
import { matchUnit, type UnitHit } from './match.js';
import { normalizeText, tokenizeQuery } from './normalize.js';
import { makeSnippet } from './snippet.js';

export interface LexicalMatch {
  matched_in: 'title' | 'heading' | 'body';
  snippet: string;
  lines?: [number, number];
  heading?: string;
}

export interface RankedNote {
  path: string;
  matches: LexicalMatch[];
  matchedQueries: string[];
}

interface Candidate {
  path: string;
  tier: number;       // 0..5 — best across the note's matches
  density: number;    // of the best match
  matches: Array<{ tier: number; density: number; match: LexicalMatch }>;
  matchedQueries: Set<string>;
}

// tier = kindBase + (phrase ? 0 : 1); kindBase: title 0, heading 2, body 4
function tierOf(kind: 'title' | 'heading' | 'body', hit: UnitHit): number {
  const base = kind === 'title' ? 0 : kind === 'heading' ? 2 : 4;
  return base + (hit.phrase ? 0 : 1);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.tier - b.tier ||
    b.density - a.density ||
    0 // backlink/path applied by caller-provided comparator below
  );
}

export function rankNotes(opts: {
  notes: Map<string, ParsedNote>;
  queries: string[];
  noteCap: number;
  perNoteCap: number;
  getBacklinkCount: (path: string) => number;
}): { notes: RankedNote[]; truncated: boolean } {
  const prepared = opts.queries.map((q) => ({
    original: q,
    norm: normalizeText(q),
    tokens: tokenizeQuery(q),
  }));

  const byPath = new Map<string, Candidate>();

  for (const [notePath, parsed] of opts.notes) {
    for (const q of prepared) {
      if (q.tokens.length === 0) continue;

      const record = (kind: 'title' | 'heading' | 'body', hit: UnitHit, match: LexicalMatch) => {
        const tier = tierOf(kind, hit);
        let cand = byPath.get(notePath);
        if (!cand) {
          cand = { path: notePath, tier, density: hit.density, matches: [], matchedQueries: new Set() };
          byPath.set(notePath, cand);
        }
        if (tier < cand.tier || (tier === cand.tier && hit.density > cand.density)) {
          cand.tier = tier;
          cand.density = hit.density;
        }
        cand.matchedQueries.add(q.original);
        // avoid duplicate evidence rows across queries for the same location
        const key = `${match.matched_in}:${match.lines?.[0] ?? -1}`;
        if (!cand.matches.some((m) => `${m.match.matched_in}:${m.match.lines?.[0] ?? -1}` === key)) {
          cand.matches.push({ tier, density: hit.density, match });
        }
      };

      const titleHit = matchUnit(parsed.title.norm, q.norm, q.tokens);
      if (titleHit) {
        record('title', titleHit, {
          matched_in: 'title',
          snippet: makeSnippet(parsed.title.raw, parsed.title.map, titleHit.firstIndex, titleHit.matchLen),
        });
      }

      for (const unit of parsed.units) {
        const hit = matchUnit(unit.norm, q.norm, q.tokens);
        if (!hit) continue;
        record(unit.kind, hit, {
          matched_in: unit.kind,
          snippet: makeSnippet(unit.raw, unit.map, hit.firstIndex, hit.matchLen),
          lines: unit.lines,
          ...(unit.kind === 'body' && unit.heading !== undefined ? { heading: unit.heading } : {}),
        });
      }
    }
  }

  const candidates = [...byPath.values()].sort(
    (a, b) =>
      compareCandidates(a, b) ||
      opts.getBacklinkCount(b.path) - opts.getBacklinkCount(a.path) ||
      a.path.localeCompare(b.path),
  );

  const truncated = candidates.length > opts.noteCap;
  const selected = candidates.slice(0, opts.noteCap).map((c) => ({
    path: c.path,
    matches: c.matches
      .sort((a, b) => a.tier - b.tier || b.density - a.density)
      .slice(0, opts.perNoteCap)
      .map((m) => m.match),
    matchedQueries: [...c.matchedQueries],
  }));

  return { notes: selected, truncated };
}
```

Lazy-cascade note (design D8): this full evaluation IS the reference semantics. The `LexicalIndex` (Task 6) may skip parsing bodies when titles alone fill the cap ONLY if it preserves output equality; if that optimization is added, add an equivalence test comparing it against `rankNotes` full evaluation on the same fixture. Do not add it speculatively in this task.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/lexical/rank.test.ts test/lib/obsidian/lexical/snippet.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/lib/obsidian/lexical/ test/lib/obsidian/lexical/
git commit -m "feat(lexical): tiered deterministic ranking with density and snippets"
```

---

### Task 5: `lexical-index.ts` — per-vault index with mtime cache

**Files:**
- Create: `src/lib/obsidian/lexical/lexical-index.ts`
- Create: `src/lib/obsidian/lexical/index.ts` (barrel: re-export `LexicalIndex`, `rankNotes`, types)
- Test: `test/lib/obsidian/lexical/lexical-index.test.ts`

**Interfaces:**
- Consumes: `VaultReader` (`scan`, `readNotes`) from `../vault-reader.js`; `parseNote`, `rankNotes`.
- Produces:
  ```ts
  class LexicalIndex {
    constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: (absPath: string) => Promise<{ mtimeMs: number }> })
    search(opts: {
      queries: string[];
      allowed?: Set<string>;          // pre-filter from listMatchingPaths
      noteCap: number;
      perNoteCap: number;
      getBacklinkCount: (path: string) => number;
    }): Promise<{ notes: RankedNote[]; truncated: boolean }>
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/obsidian/lexical/lexical-index.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../../../src/lib/obsidian/vault-reader.js';
import { LexicalIndex } from '../../../../src/lib/obsidian/lexical/lexical-index.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-index-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const full = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

function makeIndex() {
  return new LexicalIndex({ vaultRoot, reader: new FsVaultReader({ vaultRoot }) });
}

const searchOpts = { noteCap: 10, perNoteCap: 3, getBacklinkCount: () => 0 };

describe('LexicalIndex', () => {
  it('finds matches across title, heading, and body', async () => {
    await write('Пошук.md', '');
    await write('other.md', '# пошук\n\nтіло без збігу.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['Пошук.md', 'other.md']);
  });

  it('skips frontmatter (body matching starts after it) but keeps line numbers file-relative', async () => {
    await write('fm.md', '---\ntype: task\n---\n\nтут пошук.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.matches[0]!.lines).toEqual([5, 5]);
  });

  it('does not match frontmatter content', async () => {
    await write('fm-only.md', '---\ntitle: пошук\n---\n\nінший текст.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(0);
  });

  it('sees edits on the next call (mtime cache invalidation)', async () => {
    await write('n.md', 'старий текст.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['гібридний'], ...searchOpts })).notes).toHaveLength(0);
    // ensure a distinct mtime even on coarse filesystems
    await new Promise((r) => setTimeout(r, 20));
    await write('n.md', 'тут гібридний тест.\n');
    const { notes } = await idx.search({ queries: ['гібридний'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['n.md']);
  });

  it('drops deleted notes', async () => {
    await write('gone.md', 'пошук тут.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(1);
    await fs.rm(path.join(vaultRoot, 'gone.md'));
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(0);
  });

  it('respects the allowed pre-filter set', async () => {
    await write('Tasks/a.md', 'пошук в tasks.\n');
    await write('Archive/b.md', 'пошук в archive.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({
      queries: ['пошук'],
      allowed: new Set(['Tasks/a.md']),
      ...searchOpts,
    });
    expect(notes.map((n) => n.path)).toEqual(['Tasks/a.md']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/obsidian/lexical/lexical-index.test.ts`
Expected: FAIL — `lexical-index.js` not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/obsidian/lexical/lexical-index.ts
import { stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import type { VaultReader } from '../vault-reader.js';
import { parseNote, type ParsedNote } from './blocks.js';
import { rankNotes, type RankedNote } from './rank.js';

type StatFn = (absPath: string) => Promise<{ mtimeMs: number }>;

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedNote;
}

export class LexicalIndex {
  private readonly vaultRoot: string;
  private readonly reader: VaultReader;
  private readonly stat: StatFn;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: { vaultRoot: string; reader: VaultReader; stat?: StatFn }) {
    this.vaultRoot = opts.vaultRoot;
    this.reader = opts.reader;
    this.stat = opts.stat ?? ((p) => fsStat(p));
  }

  async search(opts: {
    queries: string[];
    allowed?: Set<string>;
    noteCap: number;
    perNoteCap: number;
    getBacklinkCount: (path: string) => number;
  }): Promise<{ notes: RankedNote[]; truncated: boolean }> {
    const paths = await this.reader.scan();
    const scoped = opts.allowed ? paths.filter((p) => opts.allowed!.has(p)) : paths;

    await this.refresh(scoped);

    const notes = new Map<string, ParsedNote>();
    for (const p of scoped) {
      const entry = this.cache.get(p);
      if (entry) notes.set(p, entry.parsed);
    }

    return rankNotes({
      notes,
      queries: opts.queries,
      noteCap: opts.noteCap,
      perNoteCap: opts.perNoteCap,
      getBacklinkCount: opts.getBacklinkCount,
    });
  }

  private async refresh(paths: string[]): Promise<void> {
    const stats = await Promise.all(
      paths.map(async (p) => {
        try {
          return [p, (await this.stat(path.join(this.vaultRoot, p))).mtimeMs] as const;
        } catch {
          return [p, null] as const; // vanished between scan and stat
        }
      }),
    );

    const live = new Set(paths);
    for (const cached of this.cache.keys()) {
      if (!live.has(cached)) this.cache.delete(cached);
    }

    const stale = stats.filter(([p, mtime]) => {
      if (mtime === null) {
        this.cache.delete(p);
        return false;
      }
      return this.cache.get(p)?.mtimeMs !== mtime;
    });
    if (stale.length === 0) return;

    const mtimeByPath = new Map(stale.map(([p, m]) => [p, m as number]));
    const items = await this.reader.readNotes({
      paths: stale.map(([p]) => p),
      fields: ['content'],
    });
    for (const item of items) {
      if ('error' in item) {
        this.cache.delete(item.path);
        continue;
      }
      // reader strips frontmatter from content; recover the line offset so
      // unit line numbers stay file-relative. Raw file = frontmatter + content.
      const lineOffset = await this.frontmatterLineOffset(item.path, item.content);
      this.cache.set(item.path, {
        mtimeMs: mtimeByPath.get(item.path)!,
        parsed: parseNote({ path: item.path, body: item.content, lineOffset }),
      });
    }
  }

  private async frontmatterLineOffset(relPath: string, body: string): Promise<number> {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path.join(this.vaultRoot, relPath), 'utf8');
    const prefixLength = raw.length - body.length;
    if (prefixLength <= 0) return 0;
    return raw.slice(0, prefixLength).split('\n').length - 1;
  }
}
```

Implementation note: if the double read (readNotes + readFile for the offset) is unpleasant, read the raw file once with `readFile` and call the existing `splitFrontmatter` from `../frontmatter.js` directly instead of `reader.readNotes` — same behavior, one read. Prefer that refactor if lint flags the dynamic import; keep the tests as the contract.

```ts
// src/lib/obsidian/lexical/index.ts
export { LexicalIndex } from './lexical-index.js';
export { rankNotes, type LexicalMatch, type RankedNote } from './rank.js';
export { normalizeText, tokenizeQuery } from './normalize.js';
export { parseNote, type ParsedNote, type NoteUnit } from './blocks.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/lexical/`
Expected: PASS (all four lexical test files).

- [ ] **Step 5: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/lib/obsidian/lexical/ test/lib/obsidian/lexical/
git commit -m "feat(lexical): LexicalIndex with mtime cache over vault reader"
```

---

### Task 6: `search_notes` input axes + response rename (breaking)

**Files:**
- Modify: `src/modules/semantic/types.ts` (add `SearchChannelMode`, `SearchEffort`; keep `SearchMode` for retrieval-policy internals)
- Modify: `src/modules/semantic/tools/search-notes.ts` (schema, types, orchestration signature)
- Modify: `test/semantic/tools/search-notes.test.ts`, `test/semantic/tools/search-notes-filter.test.ts` (rename sweep)
- Test: `test/semantic/tools/search-notes-hybrid.test.ts` (new — axes via SDK gate)

**Interfaces:**
- Produces:
  ```ts
  // types.ts additions
  export type SearchChannelMode = 'hybrid' | 'lexical';
  export type SearchEffort = 'quick' | 'deep';

  // search-notes.ts
  interface SearchNotesInput {
    vault?: string;
    query: string | string[];
    mode?: SearchChannelMode;    // default 'hybrid'
    effort?: SearchEffort;       // default 'quick'
    limit?: number;
    threshold?: number;
    filter?: NoteFilter-shape;
  }
  export interface LexicalNoteResult {
    path: string; backlink_count: number; vault: string;
    matched_queries?: string[];
    matches: LexicalMatch[];
  }
  export type SearchNotesOutput =
    | { semantic_matches: EnrichedNoteNode<NoteResultNode>[]; lexical_matches: LexicalNoteResult[] }
    | { semantic_matches: EnrichedNoteNode<MultiNoteResultNode>[]; lexical_matches: LexicalNoteResult[]; truncated: boolean };
  ```
- Consumes: `LexicalIndex`, `LexicalMatch` from `../../../lib/obsidian/lexical/index.js` (wired in Task 7 — in THIS task the lexical leg returns `[]` so the rename+axes land compilable and tested).

- [ ] **Step 1: Write the failing SDK-gate tests for the axes**

```ts
// test/semantic/tools/search-notes-hybrid.test.ts
import { describe, expect, it, vi } from 'vitest';

import { buildSearchNotesTool } from '../../../src/modules/semantic/tools/search-notes.js';
import { makeSearchDeps } from './_helpers.js';

function makeMockEngine() {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

describe('search_notes input axes (SDK gate)', () => {
  async function makeTool() {
    const { deps, cleanup } = await makeSearchDeps({
      sources: new Map(),
      embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
      searchEngine: makeMockEngine(),
      modelKey: 'k',
    });
    return { tool: buildSearchNotesTool(deps), cleanup };
  }

  it('rejects old mode values quick/deep', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      for (const bad of ['quick', 'deep']) {
        const parsed = tool.inputSchema.safeParse({ query: 'x', mode: bad });
        expect(parsed.success).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });

  it('accepts the new axes and defaults', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      expect(tool.inputSchema.safeParse({ query: 'x' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', mode: 'hybrid', effort: 'deep' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', mode: 'lexical', effort: 'quick' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ query: 'x', effort: 'exhaustive' }).success).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('response carries semantic_matches and lexical_matches, no results key', async () => {
    const { tool, cleanup } = await makeTool();
    try {
      const out = await tool.handler({ query: 'x' });
      expect(out).toHaveProperty('semantic_matches');
      expect(out).toHaveProperty('lexical_matches');
      expect(out).not.toHaveProperty('results');
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
Expected: FAIL — `mode: 'quick'` currently passes, response has `results`.

- [ ] **Step 3: Implement the axes + rename in `search-notes.ts`**

Schema block (replace the current `mode` line):

```ts
    mode: z.enum(['hybrid', 'lexical']).optional(),
    effort: z.enum(['quick', 'deep']).optional(),
```

In `runSearchForEntry`: replace `const mode = input.mode ?? 'quick';` with

```ts
  const channel = input.mode ?? 'hybrid';
  const effort = input.effort ?? 'quick';
```

and pass `mode: effort` into `executeRetrieval` / `executeMultiRetrieval` (retrieval-policy keeps its internal `quick|deep` vocabulary — do NOT rename inside retrieval-policy).

Rename every `results:` key in this file's return values to `semantic_matches:` and add `lexical_matches: []` (placeholder until Task 7), including the empty-filter early return:

```ts
    if (allowed.size === 0) {
      const isMulti = Array.isArray(input.query);
      return isMulti
        ? ({ semantic_matches: [], lexical_matches: [], truncated: false } as SearchNotesOutput)
        : ({ semantic_matches: [], lexical_matches: [] } as SearchNotesOutput);
    }
```

Update `SearchNotesOutput` and add `LexicalNoteResult` exactly as in **Interfaces** above (import `LexicalMatch` type from `../../../lib/obsidian/lexical/index.js`).

- [ ] **Step 4: Sweep the existing tests**

In `test/semantic/tools/search-notes.test.ts` and `search-notes-filter.test.ts`, mechanically replace `result.results` → `result.semantic_matches` and every `mode: 'quick'` / `mode: 'deep'` handler input with `effort: 'quick'` / `effort: 'deep'`. Do NOT weaken any assertion — the semantic tree content must stay byte-identical under the new key.

- [ ] **Step 5: Run the full suite, fix fallout, commit**

Run: `npx vitest run test/semantic/`
Expected: PASS. Then:

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/modules/semantic/ test/semantic/
git commit -m "feat(search)!: mode/effort axes and semantic_matches rename in search_notes"
```

---

### Task 7: Lexical leg orchestration (hybrid + lexical-only + cold corpus)

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts`
- Modify: `src/modules/semantic/index.ts` (only if the module wires tool deps — pass nothing new; `LexicalIndex` instances live in the tool builder)
- Test: extend `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**
- Consumes: `LexicalIndex` from `../../../lib/obsidian/lexical/index.js`; `IVaultEntry.reader`, `.path`, `.graph`, `.listMatchingPaths`; `resolveVault` from `../../../lib/resolve-vault.js` (plain, NOT `resolveSemanticVault`); `runFanOut` from `../../../lib/fan-out.js`.
- Produces: fully populated `lexical_matches`; caps: global `limit ?? (effort === 'deep' ? 10 : 5)` in lexical mode, `effort === 'deep' ? 10 : 5` in hybrid; per-note cap `3`.

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/tools/search-notes-hybrid.test.ts` (imports: add `fs`/`os`/`path`, `makeTestRegistry`, `makeFakeGraph`):

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeTestRegistry, makeFakeGraph, makeFakeCorpusIndex } from './_helpers.js';

async function makeLexicalVault(files: Record<string, string>, opts: { semantic: boolean } = { semantic: true }) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(vaultRoot, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      smartEnvPath: path.join(vaultRoot, '.smart-env'),
      reader: new FsVaultReader({ vaultRoot }),
      corpus: opts.semantic ? makeFakeCorpusIndex(new Map()) : undefined,
      graph: makeFakeGraph(),
      listMatchingPaths: async () => new Set(Object.keys(files)),
      semanticAvailable: opts.semantic,
    },
  ]);
  const deps = {
    registry,
    embeddingProvider: { initialize: vi.fn(), embed: vi.fn().mockResolvedValue([1, 0]) },
    searchEngine: makeMockEngine(),
    modelKey: 'k',
  };
  return { deps, cleanup: () => fs.rm(vaultRoot, { recursive: true, force: true }) };
}

describe('lexical leg orchestration', () => {
  it('hybrid returns lexical matches alongside (empty) semantic ones', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = await tool.handler({ query: 'пошук' });
      expect(out.lexical_matches).toHaveLength(1);
      expect(out.lexical_matches[0]).toMatchObject({
        path: 'Пошук.md',
        vault: 'v',
        backlink_count: 0,
        matches: [{ matched_in: 'title', snippet: 'Пошук' }],
      });
      expect(out.lexical_matches[0]).not.toHaveProperty('similarity');
    } finally {
      await cleanup();
    }
  });

  it('mode lexical works with NO corpus and does not touch the loader', async () => {
    const { deps, cleanup } = await makeLexicalVault(
      { 'n.md': "# Рішення\n\nоб'єкт тут.\n" },
      { semantic: false },
    );
    try {
      const tool = buildSearchNotesTool(deps);
      // apostrophe variant in the query (U+2019) must still match (U+0027 in file)
      const out = await tool.handler({ query: 'об’єкт', mode: 'lexical' });
      expect(out.semantic_matches).toEqual([]);
      expect(out.lexical_matches[0]!.matches[0]).toMatchObject({
        matched_in: 'body',
        heading: 'Рішення',
        lines: [3, 3],
      });
    } finally {
      await cleanup();
    }
  });

  it('hybrid on a cold corpus still returns lexical matches instead of throwing', async () => {
    const { deps, cleanup } = await makeLexicalVault({ 'Пошук.md': '' }, { semantic: false });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = await tool.handler({ query: 'пошук' });
      expect(out.semantic_matches).toEqual([]);
      expect(out.lexical_matches).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('filter binds the lexical leg through listMatchingPaths', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Tasks/a пошук.md': '',
      'Archive/b пошук.md': '',
    });
    // narrow the allowed set to Tasks/ only
    deps.registry.list()[0]!.listMatchingPaths = async () => new Set(['Tasks/a пошук.md']);
    try {
      const tool = buildSearchNotesTool(deps);
      const out = await tool.handler({ query: 'пошук', filter: { path_prefix: 'Tasks/' } });
      expect(out.lexical_matches.map((n: { path: string }) => n.path)).toEqual(['Tasks/a пошук.md']);
    } finally {
      await cleanup();
    }
  });

  it('limit steers the lexical list in lexical mode', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'a пошук.md': '', 'b пошук.md': '', 'c пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = await tool.handler({ query: 'пошук', mode: 'lexical', limit: 2 });
      expect(out.lexical_matches).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
Expected: FAIL — `lexical_matches` is `[]` everywhere; cold-corpus hybrid currently throws from `resolveSemanticVault`.

- [ ] **Step 3: Implement orchestration**

In `buildSearchNotesTool`:

```ts
  // Per-vault lexical indexes, created lazily; the Map lives for the tool's lifetime.
  const lexicalIndexes = new Map<string, LexicalIndex>();
  const lexicalFor = (entry: IVaultEntry): LexicalIndex => {
    let idx = lexicalIndexes.get(entry.name);
    if (!idx) {
      idx = new LexicalIndex({ vaultRoot: entry.path, reader: entry.reader });
      lexicalIndexes.set(entry.name, idx);
    }
    return idx;
  };
```

Handler resolution: replace `resolveSemanticVault` with plain `resolveVault` (both modes — the semantic leg is now conditional), and for fan-out use `runFanOut(registry, ...)` over ALL entries in both modes (a vault without a corpus contributes `semantic_matches: []` + its lexical matches).

`runSearchForEntry` becomes: compute `allowed` (existing filter block, unchanged) → run legs:

```ts
  const queries = Array.isArray(input.query)
    ? normalizeQueryArray(input.query)
    : [normalizeQuery(input.query)];
  const isMulti = Array.isArray(input.query);

  const lexCap =
    channel === 'lexical'
      ? (limit ?? (effort === 'deep' ? 10 : 5))
      : effort === 'deep' ? 10 : 5;

  await entry.graph.ensureFresh();
  const lexical = await lexicalFor(entry).search({
    queries,
    allowed,                       // Set<string> | undefined from the filter block
    noteCap: lexCap,
    perNoteCap: 3,
    getBacklinkCount: (p) => entry.graph.getBacklinkCount(p),
  });
  const lexical_matches: LexicalNoteResult[] = lexical.notes.map((n) => ({
    path: n.path,
    backlink_count: entry.graph.getBacklinkCount(n.path),
    vault: entry.name,
    ...(isMulti ? { matched_queries: n.matchedQueries } : {}),
    matches: n.matches,
  }));

  if (channel === 'lexical' || !entry.semanticAvailable || entry.corpus === undefined) {
    return isMulti
      ? { semantic_matches: [], lexical_matches, truncated: lexical.truncated }
      : { semantic_matches: [], lexical_matches };
  }
  // …existing semantic path, unchanged except: attach lexical_matches to the
  // returned object and keep the semantic `truncated` for multi-query.
```

Semantic-leg errors on an *available* corpus still throw `DEPENDENCY_ERROR` (unchanged) — the "cold corpus" case is handled by availability, not by swallowing errors.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/semantic/`
Expected: PASS (hybrid file + swept legacy files).

- [ ] **Step 5: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/modules/semantic/ test/semantic/
git commit -m "feat(search): lexical leg orchestration — hybrid, lexical-only, cold corpus"
```

---

### Task 8: Multi-query merge + multi-vault fan-out for the hybrid shape

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (only if Step 1 exposes gaps — multi-query lexical is already wired in Task 7)
- Test: extend `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**
- Consumes: `runFanOut` envelope (`results_by_vault`, `skipped_vaults`) from `src/lib/fan-out.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('multi-query and fan-out', () => {
  it('multi-query annotates lexical items with matched_queries', async () => {
    const { deps, cleanup } = await makeLexicalVault({
      'Vector search.md': '',
      'Векторний пошук.md': '',
    });
    try {
      const tool = buildSearchNotesTool(deps);
      const out = await tool.handler({ query: ['vector search', 'векторний пошук'] });
      expect(out.lexical_matches).toHaveLength(2);
      for (const item of out.lexical_matches) {
        expect(item.matched_queries).toHaveLength(1);
      }
      expect(out).toHaveProperty('truncated');
    } finally {
      await cleanup();
    }
  });

  it('multi-vault fan-out wraps the hybrid shape per vault', async () => {
    // build TWO lexical vaults and register both under one registry
    const a = await makeLexicalVault({ 'пошук a.md': '' });
    const b = await makeLexicalVault({ 'пошук b.md': '' }, { semantic: false });
    const registry = makeTestRegistry([...a.deps.registry.list(), ...b.deps.registry.list()]);
    // rename second entry to avoid the name collision
    registry.list()[1]!.name = 'w';
    try {
      const tool = buildSearchNotesTool({ ...a.deps, registry });
      const out = await tool.handler({ query: 'пошук' });
      expect(out).toHaveProperty('results_by_vault');
      for (const vaultResult of out.results_by_vault) {
        expect(vaultResult.result).toHaveProperty('semantic_matches');
        expect(vaultResult.result).toHaveProperty('lexical_matches');
      }
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
```

Adjust the fan-out assertions to the ACTUAL `IFanOutResult` field names in `src/lib/fan-out.ts` (read it first — the envelope key may be `results_by_vault: [{ vault, ...result }]` rather than `{ vault, result }`). The assertion intent is fixed: every per-vault payload carries both legs.

- [ ] **Step 2: Run, implement any gaps, re-run**

Run: `npx vitest run test/semantic/tools/search-notes-hybrid.test.ts`
If the fan-out test fails because the handler still routes through `runSemanticFanOut`, switch to `runFanOut` (Task 7 Step 3 specified this) and re-run.
Expected: PASS.

- [ ] **Step 3: Gates + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/modules/semantic/ test/semantic/
git commit -m "feat(search): multi-query and multi-vault parity for the lexical leg"
```

---

### Task 9: Tool description + parameter dictionary

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts` (`SEARCH_NOTES_DESCRIPTION`)
- Modify: `docs/architecture/mcp-parameter-dictionary.md`
- Test: `test/server-instructions.test.ts` (only if it asserts on the description — check first)

- [ ] **Step 1: Rewrite `SEARCH_NOTES_DESCRIPTION`**

Replace the description array wholesale with (keep the `registry.isMulti()` conditional blocks in their current positions):

```ts
  const SEARCH_NOTES_DESCRIPTION = [
    'Hybrid search over notes: a semantic leg (embedding similarity — fuzzy recall, topic exploration, cross-language) and a lexical leg (exact text matches over note titles, headings, and body — names, codes, terms). Returns both in one response. Pass short keyword queries (1-4 words), not sentences.',
    '',
    'AXES:',
    '- mode: "hybrid" (default) runs both legs; "lexical" runs ONLY exact text matching — works even when no embedding corpus exists.',
    '- effort: "quick" (default) — compact lookup (up to 3 semantic notes, ~5 lexical); "deep" — exploration (up to 8 semantic notes + related[], ~10 lexical).',
    '',
    'PARAMETERS:',
    '- query (required): string, or array of 1-8 strings for synonyms/translations — merged into one ranked list per leg; each result carries `matched_queries`.',
    '- mode: "hybrid" | "lexical" (default "hybrid").',
    '- effort: "quick" | "deep" (default "quick").',
    '- limit: in hybrid mode caps `semantic_matches`; in lexical mode caps `lexical_matches`.',
    '- threshold: min similarity 0-1 — SEMANTIC LEG ONLY. Default 0.5 (quick) / 0.35 (deep).',
    ...(registry.isMulti()
      ? ['- vault: target a specific vault by name when multiple are registered.']
      : []),
    '',
    'RESPONSE SHAPE:',
    '- `semantic_matches[]` — the semantic tree: `path`, `similarity`, `backlink_count`, `vault`, `blocks[]` (heading, lines, similarity), `related[]` (deep only, `expansion_similarity`). Empty in lexical mode or when no corpus exists.',
    '- `lexical_matches[]` — grouped per note: `path`, `backlink_count`, `vault`, and `matches[]` (max ~3) of `{ matched_in: "title"|"heading"|"body", snippet, lines?, heading? }`. `heading` on a body match names its enclosing section. No numeric score — order and matched_in carry the ranking (title > heading > body; exact phrase > all-tokens).',
    '- `truncated` — top-level, only when `query` is an array.',
    '',
    'LEXICAL MATCHING: case-, accent-, and apostrophe-variant-insensitive substring; multiword query = ALL tokens must appear (AND), contiguous phrase ranks higher. A note in BOTH legs is a strong relevance signal.',
    '',
    'INVARIANTS:',
    "- `similarity`/`expansion_similarity` appear ONLY on semantic nodes; lexical items never carry scores.",
    '- `blocks[]` and `related[]` are always present on semantic results (possibly empty); `matches[]` is always non-empty on lexical items.',
    '- Empty `lexical_matches` means literally no exact match — unlike the semantic leg, it does not degrade to weak matches.',
    '',
    'EXAMPLES:',
    '- "where did I write about X?" → search_notes({query: "X"}).',
    '- exact name/code/term → search_notes({query: "PARAM_DICT", mode: "lexical"}).',
    '- "what do I know about Y?" → search_notes({query: "Y", effort: "deep"}).',
    '- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).',
    '',
    'PRE-FILTER (filter parameter) — applies to BOTH legs identically:',
    '  Shape: { path_prefix?, exclude_path_prefix?, tags?, frontmatter? }. At least one field required.',
    '  - path_prefix / exclude_path_prefix: scope to / drop folder subtrees (string or array).',
    '  - tags: notes with ANY of these tags (no leading "#").',
    '  - frontmatter: sift filter on frontmatter keys, same operator allow-list as query_notes.',
  ].join('\n');
```

(Then re-append the existing multi-vault conditional tail block unchanged.)

- [ ] **Step 2: Update the parameter dictionary**

In `docs/architecture/mcp-parameter-dictionary.md`: change the `mode` row to "which search legs run — `hybrid` | `lexical` (search_notes)" and add an `effort` row: "result volume / exploration depth — `quick` | `deep` (search_notes)". Add a line to the change-log section of that doc noting the breaking redefinition in this major.

- [ ] **Step 3: Full suite + commit**

```bash
npm test && npm run lint && npx tsc --noEmit
git add src/modules/semantic/tools/search-notes.ts docs/architecture/mcp-parameter-dictionary.md
git commit -m "docs(search): hybrid tool description and parameter dictionary"
```

---

### Task 10: Guide restructure by intent + architecture page + CHANGELOG

**Files:**
- Create: `docs/guide/finding-notes.md` (content moved from `semantic-search.md` + new lexical/hybrid sections + `query_notes`/`get_note_links`/`find_duplicates` moved from `vault-operations.md`)
- Create: `docs/guide/reading-and-modifying.md` (rest of `vault-operations.md`)
- Delete: `docs/guide/semantic-search.md`, `docs/guide/vault-operations.md`
- Modify: `docs/guide/routing.md`, `docs/guide/README.md`
- Create: `docs/architecture/lexical-search.md`
- Modify: `docs/architecture/README.md` (index the new page)

- [ ] **Step 1: Move guide content along the intent axis**

`finding-notes.md` sections: "One search entry point" (hybrid `search_notes`: axes table from design.md, intersection-signal guidance, lexical grouping shape) → "Structured queries" (`query_notes`) → "Similarity & graph" (`get_similar_notes`, `find_duplicates`, `get_note_links`). Move prose; do not rewrite content that still holds. `reading-and-modifying.md`: `read_notes`, `read_daily`, `create_note`, `edit_note`, `set_property`, `remove_property`, `list_tags`.

- [ ] **Step 2: Rewrite `routing.md` framing**

New routing table: "fuzzy or unknown wording → `search_notes` (hybrid default)"; "exact term/name/code, or no embedding corpus → `search_notes` mode lexical"; "you know the structural key (frontmatter/tag/folder) → `query_notes`"; "one known note → `read_notes`". Remove the "structural vs semantic" dichotomy paragraphs.

- [ ] **Step 3: Write `docs/architecture/lexical-search.md`**

One page, current-state (ADR-0008 style): pipeline diagram (scan → mtime cache → mdast blocks → normalize → AND-substring → 6 tiers → density → caps → snippet), the normalize chain incl. apostrophe unification, why no search index (link `openspec/changes/hybrid-search-notes/design.md` D5), freshness model shared with `query_notes`.

- [ ] **Step 4: Update `docs/guide/README.md` map + CHANGELOG**

Guide README lists the two new pages instead of the two old ones. CHANGELOG: rely on `npm run release` generation, but stage the breaking notes by using `feat(search)!:` commits (already done) — verify `git log --oneline main..HEAD | grep '!'` shows the breaking commits.

- [ ] **Step 5: Link check + gates + commit**

Run: `grep -rn "semantic-search.md\|vault-operations.md" docs/ README.md src/ && echo "STALE LINKS" || echo "clean"`
Expected: `clean` (fix any hits first).

```bash
npm test && npm run lint && npx tsc --noEmit
git add docs/
git commit -m "docs(guide): restructure by intent — finding vs reading-and-modifying"
```

---

### Task 11: End-to-end sanity + spec self-check

**Files:**
- Test: `test/semantic/tools/search-notes-e2e.test.ts` (new)

- [ ] **Step 1: Write the e2e fixture test (real reader, real parser, fake embeddings)**

```ts
// test/semantic/tools/search-notes-e2e.test.ts
// One vault fixture exercising, in a single file: intersection (a note that
// hits BOTH legs), Ukrainian apostrophe + case query, filter binding both
// legs, and lexical-only on a corpus-less vault. Reuse makeLexicalVault from
// search-notes-hybrid.test.ts (export it from that file or a shared helper).
```

Concrete cases (write them fully, one `it` each, using the helpers from Task 7):
1. Vault with `Retrieval eval harness.md` (title hit) + a corpus stub whose `findNeighbors` returns that same path → assert the path appears in BOTH `semantic_matches` and `lexical_matches`.
2. Query `ОБ'ЄКТ` (upper, U+2019) over a body containing `об'єкт` (U+0027) → lexical body hit.
3. `filter: { path_prefix: 'Tasks/' }` excludes an `Archive/` note from both legs.
4. `{ mode: 'lexical' }` on a `semanticAvailable: false` vault → full lexical result, `semantic_matches: []`.

- [ ] **Step 2: Run the whole world**

```bash
npm test && npm run lint && npx tsc --noEmit && npm run build
```
Expected: all green, build succeeds.

- [ ] **Step 3: Spec self-check**

Walk `openspec/changes/hybrid-search-notes/specs/hybrid-search/spec.md` scenario by scenario; for each, name the test that covers it (add a one-line mapping table to `verify.md` groundwork if helpful). Any uncovered scenario → add the missing test NOW.

- [ ] **Step 4: Commit + PR**

```bash
git add test/
git commit -m "test(search): end-to-end hybrid sanity fixture"
git push -u origin HEAD
gh pr create --title "feat(search)!: hybrid search_notes — lexical leg, mode/effort axes" --body "OpenSpec change: hybrid-search-notes (see openspec/changes/hybrid-search-notes/). Breaking: results→semantic_matches, mode→mode+effort. Major release after merge."
```

Do NOT run `npm run release` from the branch — release happens on `main` after the PR merges.
