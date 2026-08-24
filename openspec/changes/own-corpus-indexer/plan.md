# Own Corpus Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the embedding corpus this server owns — extraction at parity with the corpus it replaces, sharded storage inside the vault, and incremental reconcile — as an internal function with no runtime wiring.

**Architecture:** A new `src/lib/obsidian/corpus/` package holds four independent pieces: a chunker (note text → keyed blocks with line spans), an embed-text builder (blocks + path → model inputs, with the size gate), a shard store (JSON-per-note with base64 float32 vectors, atomic writes, plus a manifest), and reconcile (scoped path set vs stored shards → embed / reuse / delete). The indexer depends on the embedding model only through a narrow `EmbedFn` port, so `src/lib/` never imports from `src/modules/` and tests inject a deterministic fake embedder.

**Tech Stack:** TypeScript ESM (Node ≥ 20), vitest, `@xenova/transformers` (`TaylorAI/bge-micro-v2`, 384 dims, 512 max tokens), `write-file-atomic`, `node:crypto` for hashing.

**Spec:** `openspec/changes/own-corpus-indexer/` — `proposal.md` (why), `design.md` (decisions D1–D13), `specs/embed-text-extraction/spec.md`, `specs/own-corpus-index/spec.md`, `specs/vault-scope/spec.md`, and `tasks.md` (the task groups this plan decomposes).

## Global Constraints

- Node floor stays `>= 20`. No dependency that compiles on install (`node-gyp`) and none that ships a platform binary. `write-file-atomic` (ISC, pure JS) is the only new runtime dependency.
- `src/lib/**` MUST NOT import from `src/modules/**`. The indexer declares its own `EmbedFn` port; `EmbeddingService` satisfies it structurally.
- Every import of a local file carries the `.js` extension (ESM + `isolatedModules`).
- `npx tsc --noEmit` is authoritative for type-correctness; a `tsup` build alone is not.
- All three gates must pass before any commit or PR: `npm test`, `npm run lint`, `npm run typecheck`. Add `npx openspec validate --all` before each PR.
- Warnings go to **stderr** only. stdout is the MCP transport and must stay clean.
- Model constants: model key `bge-micro-v2` (id `TaylorAI/bge-micro-v2`), `dims = 384`, `max_tokens = 512`, note-text character budget `Math.floor(512 * 3.7) = 1894`, size gate `min_chars = 200`.
- Extraction strategy identifier for this slice: `sc-parity-v1`. Embed version: `1`.
- Delivery is two PRs. Tasks 1–9 are PR 1 (`Refs #82`); Tasks 10–14 are PR 2 (`Closes #82`). **Stop after Task 9.**
- Commit messages follow Conventional Commits (commitlint runs in CI).

## File Structure

Created:

- `src/lib/obsidian/corpus/types.ts` — every corpus type plus the `EmbedFn` port and the shared constants. No logic.
- `src/lib/obsidian/corpus/chunker.ts` — `chunkNote(content): ChunkedBlock[]`. Pure text → blocks with keys and line spans.
- `src/lib/obsidian/corpus/embed-text.ts` — `buildEmbedInputs(path, content): NoteEmbedInputs`. Applies breadcrumbs, truncation and the size gate.
- `src/lib/obsidian/corpus/vector-codec.ts` — `encodeVector` / `decodeVector` (base64 ↔ `Float32Array`).
- `src/lib/obsidian/corpus/shard-store.ts` — `CorpusStore`: shard read/write/delete/list, manifest read/write/compatibility, the `.gitignore` entry.
- `src/lib/obsidian/corpus/reconcile.ts` — `reconcileCorpus(deps, opts)`: the diff, the embed loop, progress and the summary.
- `src/lib/obsidian/corpus/index.ts` — the package's public surface (re-exports only).
- `test/lib/obsidian/corpus/*.test.ts` — one test file per source file above.
- `docs/adr/0012-own-embedding-corpus.md`, `docs/architecture/own-corpus.md`.

Modified:

- `src/modules/semantic/embedding-service.ts` — cap the tokenizer at the model's real window.
- `package.json` — add `write-file-atomic` (+ `@types/write-file-atomic` if the package ships no types).
- `docs/adr/0006-smart-connections-corpus.md`, `docs/adr/INDEX.md`, `docs/architecture/vault-scope.md`.

Split rationale: the four pieces have separate reasons to change (parity rules, storage format, model plumbing, sync algorithm) and separate test surfaces, so they are separate files and separate tasks. `types.ts` exists so Tasks 2, 3, 5, 6 can be written concurrently against one agreed vocabulary.

---

### Task 1: Corpus vocabulary — types, constants, port

**Files:**
- Create: `src/lib/obsidian/corpus/types.ts`
- Create: `src/lib/obsidian/corpus/index.ts`
- Test: `test/lib/obsidian/corpus/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChunkedBlock`, `EmbedInput`, `NoteEmbedInputs`, `CorpusBlock`, `CorpusShard`, `CorpusManifest`, `EmbedFn`, and the constants `MIN_CHARS`, `MAX_TOKENS`, `EMBED_CHAR_BUDGET`, `MODEL_DIMS`, `SC_PARITY_STRATEGY`, `EMBED_VERSION`. Every later task imports from here.

- [ ] **Step 1: Write the type and constant module**

```typescript
// src/lib/obsidian/corpus/types.ts

/** A block as the chunker produces it: identity + span + its own text. */
export interface ChunkedBlock {
  /** Heading path within the note, e.g. "#Top#Inner". Never includes the note path. */
  key: string;
  /** The last heading segment of `key` ("Inner"), or "" for the root/frontmatter blocks. */
  heading: string;
  /** 1-based inclusive line span within the note. */
  lines: [number, number];
  /** The block's own text, exactly as it appears in the note. */
  text: string;
}

/** One text destined for the embedding model. */
export interface EmbedInput {
  /** Block key for a block input; null for the note-level input. */
  key: string | null;
  text: string;
}

export interface NoteEmbedInputs {
  path: string;
  /** null when the note is below MIN_CHARS. */
  note: string | null;
  blocks: Array<ChunkedBlock & { embedText: string }>;
}

export interface CorpusBlock {
  key: string;
  heading: string;
  lines: [number, number];
  /** base64 of a little-endian Float32Array. */
  embedding: string;
}

export interface CorpusShard {
  path: string;
  content_hash: string;
  mtime: number;
  size: number;
  /** base64 vector, or null for a note below MIN_CHARS. */
  embedding: string | null;
  blocks: CorpusBlock[];
}

export interface CorpusManifest {
  embed_version: number;
  model_key: string;
  dims: number;
  strategy: string;
  created: string;
}

/** The indexer's only view of the embedding model (design D1). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Notes and blocks shorter than this are not embedded. */
export const MIN_CHARS = 200;
export const MAX_TOKENS = 512;
/** Note embed text is cut here — max_tokens x 3.7, the parity formula. */
export const EMBED_CHAR_BUDGET = Math.floor(MAX_TOKENS * 3.7);
export const MODEL_DIMS = 384;
export const SC_PARITY_STRATEGY = 'sc-parity-v1';
export const EMBED_VERSION = 1;
```

- [ ] **Step 2: Write the test that pins the parity constants**

```typescript
// test/lib/obsidian/corpus/types.test.ts
import { describe, expect, it } from 'vitest';

import {
  EMBED_CHAR_BUDGET,
  MAX_TOKENS,
  MIN_CHARS,
  SC_PARITY_STRATEGY,
} from '../../../../src/lib/obsidian/corpus/types.js';

describe('corpus parity constants', () => {
  it('cuts note embed text at max_tokens x 3.7', () => {
    expect(MAX_TOKENS).toBe(512);
    expect(EMBED_CHAR_BUDGET).toBe(1894);
  });

  it('gates embedding at 200 characters', () => {
    expect(MIN_CHARS).toBe(200);
  });

  it('names the extraction strategy', () => {
    expect(SC_PARITY_STRATEGY).toBe('sc-parity-v1');
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/lib/obsidian/corpus/types.test.ts`
Expected: PASS (this task is type-and-constant scaffolding; the cycle starts in Task 2).

- [ ] **Step 4: Add the package barrel**

```typescript
// src/lib/obsidian/corpus/index.ts
export * from './types.js';
```

- [ ] **Step 5: Assert the dependency direction**

Add to `test/lib/obsidian/corpus/types.test.ts`:

```typescript
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

it('never imports from src/modules', () => {
  const dir = path.resolve('src/lib/obsidian/corpus');
  for (const file of readdirSync(dir)) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    expect(source, `${file} must not import from src/modules`).not.toMatch(/modules\//);
  }
});
```

- [ ] **Step 6: Run the gates**

Run: `npx vitest run test/lib/obsidian/corpus/ && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/obsidian/corpus test/lib/obsidian/corpus
git commit -m "feat(corpus): add corpus types, parity constants and embed port"
```

---

### Task 2: Markdown chunker

**Files:**
- Create: `src/lib/obsidian/corpus/chunker.ts`
- Test: `test/lib/obsidian/corpus/chunker.test.ts`

**Interfaces:**
- Consumes: `ChunkedBlock` from Task 1.
- Produces: `chunkNote(content: string): ChunkedBlock[]` — blocks in document order, spans 1-based inclusive, a heading block's span covering its whole section including children.

Key grammar (spec: "A note is chunked into keyed blocks by its headings"):

| Content | Key |
| --- | --- |
| Frontmatter block (fences included in the span) | `#---frontmatter---` |
| Text before the first heading | `#` |
| `# Top` | `#Top` |
| `## Inner` under `# Top` | `#Top#Inner` |
| `### Deep` directly under `# Top` (level skipped) | `#Top##Deep` |
| Content chunk under a heading | `#Top#{1}`, `#Top#{2}`, … |
| A second `# Top` at top level | `#Top[2]` |

The separator between two segments repeats `#` `(childLevel - parentLevel)` times, so a skipped level is visible in the key.

- [ ] **Step 1: Write the failing test for heading split and spans**

```typescript
// test/lib/obsidian/corpus/chunker.test.ts
import { describe, expect, it } from 'vitest';

import { chunkNote } from '../../../../src/lib/obsidian/corpus/chunker.js';

const keys = (content: string) => chunkNote(content).map((b) => b.key);
const byKey = (content: string, key: string) => chunkNote(content).find((b) => b.key === key);

describe('chunkNote', () => {
  it('splits at headings and gives a parent the whole section', () => {
    const content = ['# Top', 'alpha', '## Inner', 'beta'].join('\n');
    expect(keys(content)).toEqual(expect.arrayContaining(['#Top', '#Top#Inner']));
    expect(byKey(content, '#Top')?.lines).toEqual([1, 4]);
    expect(byKey(content, '#Top#Inner')?.lines).toEqual([3, 4]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`
Expected: FAIL — `chunkNote` is not exported from a module that does not exist yet.

- [ ] **Step 3: Implement the heading scan**

```typescript
// src/lib/obsidian/corpus/chunker.ts
import type { ChunkedBlock } from './types.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface OpenSection {
  level: number;
  key: string;
  start: number;
}

export function chunkNote(content: string): ChunkedBlock[] {
  const lines = content.split('\n');
  const blocks: ChunkedBlock[] = [];
  const open: OpenSection[] = [];
  /** (parent key + title) -> occurrences, so a repeat is disambiguated at any level. */
  const headingCounts = new Map<string, number>();
  let inFence = false;

  const close = (section: OpenSection, endLine: number) => {
    blocks.push({
      key: section.key,
      heading: section.key.split('#').filter(Boolean).slice(-1)[0] ?? '',
      lines: [section.start, endLine],
      text: lines.slice(section.start - 1, endLine).join('\n'),
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const level = match[1]!.length;
    let title = match[2]!;
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      close(open.pop()!, i);
    }
    const parent = open[open.length - 1];
    const scopeKey = `${parent ? parent.key : ''}\u0000${title}`;
    const seen = (headingCounts.get(scopeKey) ?? 0) + 1;
    headingCounts.set(scopeKey, seen);
    if (seen > 1) title = `${title}[${seen}]`;
    const separator = '#'.repeat(parent ? level - parent.level : 1);
    open.push({
      level,
      key: `${parent ? parent.key : ''}${separator}${title}`,
      start: i + 1,
    });
  }
  while (open.length > 0) close(open.pop()!, lines.length);

  return blocks.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for code fences and skipped levels**

```typescript
it('ignores headings inside code fences', () => {
  const content = ['# Top', '```', '# not a heading', '```', 'tail'].join('\n');
  expect(keys(content)).toEqual(['#Top']);
  expect(byKey(content, '#Top')?.lines).toEqual([1, 5]);
});

it('encodes a skipped heading level in the separator', () => {
  const content = ['# Top', '### Deep', 'x'].join('\n');
  expect(keys(content)).toContain('#Top##Deep');
});

it('suffixes a repeated top-level heading', () => {
  const content = ['# Top', 'a', '# Top', 'b'].join('\n');
  expect(keys(content)).toEqual(['#Top', '#Top[2]']);
});

it('disambiguates repeated sibling sub-headings too', () => {
  // Block keys are identity in the corpus; a collision silently drops a block.
  const content = ['# Top', '## A', 'x', '## A', 'y'].join('\n');
  const all = keys(content);
  expect(all).toContain('#Top#A');
  expect(all).toContain('#Top#A[2]');
  expect(new Set(all).size).toBe(all.length);
});
```

- [ ] **Step 6: Run, confirm the fence and skip cases pass with the implementation above**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`
Expected: PASS. If the fence test fails, the toggle is running inside a heading branch — the fence check must come before the heading match, as written.

- [ ] **Step 7: Write the failing test for frontmatter and preamble blocks**

```typescript
it('emits frontmatter and preamble blocks', () => {
  const content = ['---', 'type: note', '---', 'intro text', '# Top', 'body'].join('\n');
  expect(keys(content)).toEqual(['#---frontmatter---', '#', '#Top']);
  expect(byKey(content, '#---frontmatter---')?.lines).toEqual([1, 3]);
  expect(byKey(content, '#')?.lines).toEqual([4, 4]);
});

it('emits no preamble block when a heading opens the note', () => {
  expect(keys('# Top\nbody')).toEqual(['#Top']);
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts -t frontmatter`
Expected: FAIL — no frontmatter or preamble block is produced.

- [ ] **Step 9: Implement frontmatter and preamble detection**

Insert before the heading scan, and start the scan after the frontmatter:

```typescript
function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') return i + 1; // 1-based inclusive end
  }
  return 0; // unterminated fence: not frontmatter
}
```

In `chunkNote`, after `const lines = ...`:

```typescript
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd > 0) {
    blocks.push({
      key: '#---frontmatter---',
      heading: '---frontmatter---',
      lines: [1, fmEnd],
      text: lines.slice(0, fmEnd).join('\n'),
    });
  }
  const firstHeading = lines.findIndex((l, idx) => idx >= fmEnd && HEADING_RE.test(l));
  const preambleEnd = firstHeading === -1 ? lines.length : firstHeading;
  if (preambleEnd > fmEnd && lines.slice(fmEnd, preambleEnd).join('').trim() !== '') {
    blocks.push({
      key: '#',
      heading: '',
      lines: [fmEnd + 1, preambleEnd],
      text: lines.slice(fmEnd, preambleEnd).join('\n'),
    });
  }
```

Start the heading loop at `i = fmEnd` so a `---` frontmatter delimiter never toggles the fence flag.

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`
Expected: PASS, all cases.

- [ ] **Step 11: Write the failing test for numbered content chunks**

```typescript
it('numbers content chunks under a heading', () => {
  const content = ['# Top', 'para one', '', 'para two', '## Inner', 'x'].join('\n');
  expect(keys(content)).toEqual(['#Top', '#Top#{1}', '#Top#{2}', '#Top#Inner']);
  expect(byKey(content, '#Top#{1}')?.lines).toEqual([2, 2]);
  expect(byKey(content, '#Top#{2}')?.lines).toEqual([4, 4]);
});
```

- [ ] **Step 12: Run it to verify it fails, then implement**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts -t 'numbers content chunks'`
Expected: FAIL — only heading blocks exist.

Implement: after closing a section, split the text it owns *directly* (lines from its start+1 up to its first child's start, or its end) into blank-line-separated chunks; emit each as `<sectionKey>#{n}` with `n` counting from 1 within that section. Skip chunks that are only whitespace. Apply the same to the `#` preamble block's owner only if it has a heading — the preamble itself is never sub-chunked.

- [ ] **Step 13: Run the tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/corpus/chunker.test.ts`
Expected: PASS.

- [ ] **Step 14: Add the golden fixture test**

Create `test/lib/obsidian/corpus/fixtures/sample-note.md` with frontmatter, a preamble paragraph, `# Top`, two paragraphs, `## Inner`, and a fenced code block containing a `#` line. Then:

```typescript
it('matches the golden chunking of the sample note', () => {
  const content = readFileSync(
    new URL('./fixtures/sample-note.md', import.meta.url),
    'utf8',
  );
  expect(chunkNote(content).map((b) => ({ key: b.key, lines: b.lines }))).toMatchInlineSnapshot();
});
```

Run once, let vitest fill the snapshot, then read it and confirm every key and span by hand against the table above before committing.

- [ ] **Step 15: Run the gates**

Run: `npx vitest run test/lib/obsidian/corpus && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 16: Commit**

```bash
git add src/lib/obsidian/corpus/chunker.ts test/lib/obsidian/corpus
git commit -m "feat(corpus): chunk notes into keyed blocks with line spans"
```

---

### Task 3: Embed text and the size gate

**Files:**
- Create: `src/lib/obsidian/corpus/embed-text.ts`
- Test: `test/lib/obsidian/corpus/embed-text.test.ts`

**Interfaces:**
- Consumes: `chunkNote` (Task 2), `EMBED_CHAR_BUDGET`, `MIN_CHARS`, `NoteEmbedInputs` (Task 1).
- Produces: `buildEmbedInputs(notePath: string, content: string): NoteEmbedInputs` and `pathBreadcrumbs(notePath: string): string`.

Formulas (spec: "Embed text is derived by two fixed formulas"):

- `pathBreadcrumbs("Folder/Note.md")` → `"Folder > Note"` (`/` → ` > `, trailing `.md` dropped).
- Block embed text: take `<notePath><blockKey>`, replace `/` with ` > `, split on `#`, **drop the last segment**, join with ` > `, drop `.md`; then `+ "\n" + block.text`.
- Note embed text: `pathBreadcrumbs + ":\n" + content`, then `.slice(0, EMBED_CHAR_BUDGET)`.

- [ ] **Step 1: Write the failing test for both formulas**

```typescript
// test/lib/obsidian/corpus/embed-text.test.ts
import { describe, expect, it } from 'vitest';

import { buildEmbedInputs } from '../../../../src/lib/obsidian/corpus/embed-text.js';
import { EMBED_CHAR_BUDGET } from '../../../../src/lib/obsidian/corpus/types.js';

const long = (n: number) => 'x'.repeat(n);

describe('buildEmbedInputs', () => {
  it('builds block embed text from breadcrumbs without the block own heading', () => {
    const content = ['# Top', long(250), '## Inner', long(250)].join('\n');
    const { blocks } = buildEmbedInputs('Folder/Note.md', content);
    const inner = blocks.find((b) => b.key === '#Top#Inner');
    expect(inner?.embedText.split('\n')[0]).toBe('Folder > Note > Top');
    expect(inner?.embedText).toContain('## Inner');
  });

  it('builds note embed text from path breadcrumbs and truncates by characters', () => {
    const { note } = buildEmbedInputs('Folder/Note.md', long(5000));
    expect(note?.startsWith('Folder > Note:\n')).toBe(true);
    expect(note).toHaveLength(EMBED_CHAR_BUDGET);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/embed-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```typescript
// src/lib/obsidian/corpus/embed-text.ts
import { chunkNote } from './chunker.js';
import { EMBED_CHAR_BUDGET, MIN_CHARS, type NoteEmbedInputs } from './types.js';

export function pathBreadcrumbs(notePath: string): string {
  return notePath.split('/').join(' > ').replace(/\.md$/, '');
}

function blockBreadcrumbs(notePath: string, blockKey: string): string {
  return `${notePath}${blockKey}`
    .split('/')
    .join(' > ')
    .split('#')
    .slice(0, -1)
    .join(' > ')
    .replace(/\.md/g, '');
}

export function buildEmbedInputs(notePath: string, content: string): NoteEmbedInputs {
  const blocks = chunkNote(content).map((block) => ({
    ...block,
    embedText: `${blockBreadcrumbs(notePath, block.key)}\n${block.text}`,
  }));
  const note =
    content.length >= MIN_CHARS
      ? `${pathBreadcrumbs(notePath)}:\n${content}`.slice(0, EMBED_CHAR_BUDGET)
      : null;
  return { path: notePath, note, blocks };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/embed-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the size gate and coverage rule**

```typescript
it('drops the note-level input below the gate but keeps qualifying blocks', () => {
  const content = ['# Top', long(250)].join('\n');
  const { note, blocks } = buildEmbedInputs('N.md', content.slice(0, 150));
  expect(note).toBeNull();
  expect(buildEmbedInputs('N.md', content).blocks.map((b) => b.key)).toContain('#Top');
});

it('drops blocks below the gate', () => {
  const { blocks } = buildEmbedInputs('N.md', ['# Top', 'short'].join('\n'));
  expect(blocks).toHaveLength(0);
});

it('skips a parent block fully covered by embedded sub-blocks', () => {
  const content = ['# Top', '## A', long(250), '## B', long(250)].join('\n');
  const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
  expect(keys).toEqual(['#Top#A', '#Top#B']);
});

it('keeps a parent that holds text of its own', () => {
  const content = ['# Top', long(250), '## A', long(250)].join('\n');
  const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
  expect(keys).toContain('#Top');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/embed-text.test.ts -t gate`
Expected: FAIL — every chunked block is currently returned.

- [ ] **Step 7: Implement the gate**

In `buildEmbedInputs`, after chunking and before mapping: keep only blocks whose `text.length >= MIN_CHARS`; then drop any remaining block whose line span is fully covered by the union of the spans of the *other kept* blocks that are strictly nested inside it (the parent's own heading line counts as its own text only if non-blank content sits outside every child span). Implement as an explicit line-coverage set so the rule is readable:

```typescript
function isFullyCovered(block: ChunkedBlock, others: ChunkedBlock[]): boolean {
  const children = others.filter(
    (o) => o !== block && o.lines[0] >= block.lines[0] && o.lines[1] <= block.lines[1],
  );
  if (children.length === 0) return false;
  const covered = new Set<number>();
  for (const child of children) {
    for (let l = child.lines[0]; l <= child.lines[1]; l += 1) covered.add(l);
  }
  for (let l = block.lines[0]; l <= block.lines[1]; l += 1) {
    if (covered.has(l)) continue;
    const line = block.text.split('\n')[l - block.lines[0]] ?? '';
    if (line.trim() !== '' && !/^#{1,6}\s/.test(line)) return false;
  }
  return true;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/corpus/embed-text.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the determinism and path-dependence tests**

```typescript
it('is deterministic', () => {
  const content = ['# Top', long(250)].join('\n');
  expect(buildEmbedInputs('A/N.md', content)).toEqual(buildEmbedInputs('A/N.md', content));
});

it('changes every embed text when the path changes', () => {
  const content = ['# Top', long(250)].join('\n');
  const before = buildEmbedInputs('A/N.md', content);
  const after = buildEmbedInputs('B/N.md', content);
  expect(after.note).not.toBe(before.note);
  expect(after.blocks[0]?.embedText).not.toBe(before.blocks[0]?.embedText);
});
```

- [ ] **Step 10: Run the gates**

Run: `npx vitest run test/lib/obsidian/corpus && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/lib/obsidian/corpus/embed-text.ts test/lib/obsidian/corpus/embed-text.test.ts
git commit -m "feat(corpus): build embed inputs at parity with the replaced corpus"
```

---

### Task 4: Cap the tokenizer in the embedding service

**Files:**
- Modify: `src/modules/semantic/embedding-service.ts`
- Test: `test/semantic/embedding-service.test.ts` (extend the existing file; create it if absent)

**Interfaces:**
- Consumes: nothing from earlier tasks (parallel-safe with Tasks 2, 3, 5–8).
- Produces: no new export. `EmbeddingService.embed` becomes safe for inputs longer than the model window — the precondition every later embedding call relies on.

**Why this exists:** the cached `tokenizer_config.json` for `TaylorAI/bge-micro-v2` declares `model_max_length = 1e15`, so the pipeline's internal `truncation: true` is a no-op and any input over 512 tokens throws from ONNX (`Attempting to broadcast an axis... 512 by N`). Query text never reached that length; note and block text does (design D3).

- [ ] **Step 1: Write the failing test**

```typescript
// test/semantic/embedding-service.test.ts
import { describe, expect, it, vi } from 'vitest';

import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';

function fakePipeline() {
  const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
  return Object.assign(pipe, { tokenizer: { model_max_length: 1e15 } });
}

describe('EmbeddingService tokenizer cap', () => {
  it('caps the tokenizer at the model window after initialization', async () => {
    const pipe = fakePipeline();
    const service = new EmbeddingService({ pipelineFactory: async () => pipe as never });
    await service.embed('hello');
    expect(pipe.tokenizer.model_max_length).toBe(512);
  });

  it('does not throw when the pipeline exposes no tokenizer', async () => {
    const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    const service = new EmbeddingService({ pipelineFactory: async () => pipe as never });
    await expect(service.embed('hello')).resolves.toHaveLength(384);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/semantic/embedding-service.test.ts`
Expected: FAIL — `model_max_length` is still `1e15`.

- [ ] **Step 3: Implement the cap**

In `src/modules/semantic/embedding-service.ts`, add the constant and apply it where the pipeline is cached:

```typescript
const MODEL_MAX_TOKENS = 512;

type CappableTokenizer = { model_max_length?: number };

function capTokenizer(embeddingPipeline: unknown): void {
  const tokenizer = (embeddingPipeline as { tokenizer?: CappableTokenizer } | null)?.tokenizer;
  if (tokenizer && typeof tokenizer.model_max_length === 'number') {
    // The shipped tokenizer config declares an effectively unbounded length,
    // which disables the pipeline's own truncation and makes any input over
    // the real window throw inside ONNX.
    tokenizer.model_max_length = MODEL_MAX_TOKENS;
  }
}
```

and inside `getPipeline`'s `.then`:

```typescript
        .then((embeddingPipeline) => {
          capTokenizer(embeddingPipeline);
          this.pipeline = embeddingPipeline;
        })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/semantic/embedding-service.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Run the whole suite — this file is shared with the query path**

Run: `npm test`
Expected: PASS. Any existing embedding-service test that asserts the pipeline object is untouched needs updating, not the cap.

- [ ] **Step 6: Commit**

```bash
git add src/modules/semantic/embedding-service.ts test/semantic/embedding-service.test.ts
git commit -m "fix(semantic): cap tokenizer at the model window so long inputs truncate"
```

---

### Task 5: Vector codec

**Files:**
- Create: `src/lib/obsidian/corpus/vector-codec.ts`
- Test: `test/lib/obsidian/corpus/vector-codec.test.ts`

**Interfaces:**
- Consumes: `MODEL_DIMS` (Task 1).
- Produces: `encodeVector(values: number[]): string`, `decodeVector(encoded: string): number[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/obsidian/corpus/vector-codec.test.ts
import { describe, expect, it } from 'vitest';

import { decodeVector, encodeVector } from '../../../../src/lib/obsidian/corpus/vector-codec.js';

describe('vector codec', () => {
  it('round-trips a vector bit-exactly', () => {
    const values = Array.from({ length: 384 }, (_, i) => Math.fround(Math.sin(i) / 3));
    expect(decodeVector(encodeVector(values))).toEqual(values);
  });

  it('round-trips correctly when many vectors are encoded in sequence', () => {
    // Small Buffers come from a shared pool: decoding via a bare `.buffer`
    // would read a neighbouring vector's bytes.
    const vectors = Array.from({ length: 50 }, (_, n) =>
      Array.from({ length: 384 }, (_, i) => Math.fround((n + 1) * 0.001 * i)),
    );
    const encoded = vectors.map(encodeVector);
    encoded.forEach((e, n) => expect(decodeVector(e)).toEqual(vectors[n]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/vector-codec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the codec**

```typescript
// src/lib/obsidian/corpus/vector-codec.ts
import os from 'node:os';

if (os.endianness() !== 'LE') {
  throw new Error('neuro-vault corpus: little-endian host required for the vector format');
}

export function encodeVector(values: number[]): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length % 4 !== 0) {
    throw new Error('neuro-vault corpus: vector payload is not a whole number of float32 values');
  }
  // byteOffset/length are mandatory — Buffer allocates small buffers from a pool.
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/vector-codec.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the malformed-payload test**

```typescript
it('rejects a payload that is not whole float32 values', () => {
  expect(() => decodeVector(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/float32/);
});
```

- [ ] **Step 6: Run the gates and commit**

Run: `npx vitest run test/lib/obsidian/corpus && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/vector-codec.ts test/lib/obsidian/corpus/vector-codec.test.ts
git commit -m "feat(corpus): add base64 float32 vector codec"
```

---

### Task 6: Shard store — read, write, list, tolerate corruption

**Files:**
- Create: `src/lib/obsidian/corpus/shard-store.ts`
- Test: `test/lib/obsidian/corpus/shard-store.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `CorpusShard`, `CorpusManifest` (Task 1); `encodeVector`/`decodeVector` (Task 5, used by callers, not by the store).
- Produces:

```typescript
export interface CorpusStoreDeps {
  writeFile?: (p: string, data: string) => Promise<void>;   // defaults to write-file-atomic
  readFile?: (p: string) => Promise<string>;
  readdir?: (p: string) => Promise<string[]>;
  unlink?: (p: string) => Promise<void>;
  mkdir?: (p: string) => Promise<void>;
  warn?: (message: string) => void;                          // defaults to console.error
  dims?: number;                                             // defaults to MODEL_DIMS (384)
}

export class CorpusStore {
  constructor(vaultRoot: string, deps?: CorpusStoreDeps);
  static shardFileName(notePath: string): string;
  readShard(notePath: string): Promise<CorpusShard | null>;
  writeShard(shard: CorpusShard): Promise<void>;
  deleteShard(notePath: string): Promise<void>;
  listShards(): Promise<Map<string, CorpusShard>>;
}
```

Layout: `<vaultRoot>/.neuro-vault/corpus/manifest.json` and `<vaultRoot>/.neuro-vault/corpus/notes/<sha256(notePath) sliced to 32 hex>.json`.

- [ ] **Step 1: Add the dependency**

```bash
npm install write-file-atomic
```

Then check whether types ship with it: `ls node_modules/write-file-atomic/*.d.ts`. If absent, `npm install -D @types/write-file-atomic`. Record in the PR body: ISC licence, pure JS, no install-time build.

- [ ] **Step 2: Write the failing round-trip test**

```typescript
// test/lib/obsidian/corpus/shard-store.test.ts
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import type { CorpusShard } from '../../../../src/lib/obsidian/corpus/types.js';

const shard = (p: string): CorpusShard => ({
  path: p,
  content_hash: 'abc123',
  mtime: 1000,
  size: 42,
  embedding: 'AAAA',
  blocks: [{ key: '#Top', heading: 'Top', lines: [1, 2], embedding: 'BBBB' }],
});

async function tempVault() {
  return mkdtemp(path.join(tmpdir(), 'nv-corpus-'));
}

describe('CorpusStore', () => {
  it('round-trips a shard', async () => {
    const store = new CorpusStore(await tempVault());
    await store.writeShard(shard('Folder/Note.md'));
    expect(await store.readShard('Folder/Note.md')).toEqual(shard('Folder/Note.md'));
  });

  it('gives colliding-slug paths distinct files', () => {
    expect(CorpusStore.shardFileName('A/b.md')).not.toBe(CorpusStore.shardFileName('A_b.md'));
  });

  it('keeps each vault corpus under its own root', async () => {
    const first = new CorpusStore(await tempVault());
    const second = new CorpusStore(await tempVault());
    await first.writeShard(shard('N.md'));
    expect(await second.readShard('N.md')).toBeNull();
    expect(await second.listShards()).toEqual(new Map());
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the store**

```typescript
// src/lib/obsidian/corpus/shard-store.ts
import { createHash } from 'node:crypto';
import { mkdir as fsMkdir, readdir as fsReaddir, readFile as fsReadFile, unlink as fsUnlink } from 'node:fs/promises';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import type { CorpusShard } from './types.js';

export const CORPUS_DIR = '.neuro-vault/corpus';

export class CorpusStore {
  private readonly root: string;    // <vaultRoot>/.neuro-vault/corpus
  private readonly notesDir: string;
  // deps assigned from the constructor argument, each with the node default

  static shardFileName(notePath: string): string {
    return `${createHash('sha256').update(notePath).digest('hex').slice(0, 32)}.json`;
  }

  async writeShard(shard: CorpusShard): Promise<void> {
    await this.mkdir(this.notesDir);
    await this.writeFile(
      path.join(this.notesDir, CorpusStore.shardFileName(shard.path)),
      `${JSON.stringify(shard)}\n`,
    );
  }

  async readShard(notePath: string): Promise<CorpusShard | null> {
    const file = path.join(this.notesDir, CorpusStore.shardFileName(notePath));
    return this.readShardFile(file, notePath);
  }
  // readShardFile: read, JSON.parse, validate, and check that shard.path
  // hashes back to the file it was found in; any failure returns null.
}
```

`writeFile` default: `(p, data) => writeFileAtomic(p, data)`. `mkdir` default: `(p) => fsMkdir(p, { recursive: true }).then(() => undefined)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for corruption tolerance**

```typescript
it('reads a malformed shard as absent', async () => {
  const root = await tempVault();
  const store = new CorpusStore(root);
  const file = path.join(root, '.neuro-vault/corpus/notes', CorpusStore.shardFileName('N.md'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{ not json');
  expect(await store.readShard('N.md')).toBeNull();
});

it('reads a shard whose path does not match its filename as absent', async () => {
  const root = await tempVault();
  const store = new CorpusStore(root);
  const file = path.join(root, '.neuro-vault/corpus/notes', CorpusStore.shardFileName('N.md'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(shard('Other.md')));
  expect(await store.readShard('N.md')).toBeNull();
});

it('reads a shard whose vector has the wrong dimension as absent', async () => {
  const root = await tempVault();
  const store = new CorpusStore(root);
  const wrongSize = Buffer.alloc(4 * 8).toString('base64'); // 8 floats, not 384
  await store.writeShard({ ...shard('N.md'), embedding: wrongSize });
  expect(await store.readShard('N.md')).toBeNull();
});

it('skips unreadable shards when listing', async () => {
  const root = await tempVault();
  const store = new CorpusStore(root);
  await store.writeShard(shard('Good.md'));
  const bad = path.join(root, '.neuro-vault/corpus/notes', 'deadbeef.json');
  await writeFile(bad, 'nope');
  const listed = await store.listShards();
  expect([...listed.keys()]).toEqual(['Good.md']);
});

it('lists an empty map when the corpus directory does not exist', async () => {
  expect(await new CorpusStore(await tempVault()).listShards()).toEqual(new Map());
});
```

- [ ] **Step 7: Run them, implement validation and listing, run again**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: FAIL, then PASS after `readShardFile` validates (`typeof shard.path === 'string'`, `Array.isArray(shard.blocks)`, hash-matches-filename, and every present vector's decoded byte length equal to `dims * 4` — check the length, do not decode into floats) and `listShards` catches `ENOENT` from `readdir` by returning an empty map.

The dimension check is the local form of the guarantee the replaced loader gets by throwing on mixed dimensions across the corpus (parity checklist item 8): a wrong-dimension vector must never reach a similarity computation, and re-embedding one note is a cheaper repair than failing the process.

Note the fixture shards in this file use short placeholder vectors, so give `shard()` a `dims`-sized value — `Buffer.alloc(384 * 4).toString('base64')` — or construct the store with `{ dims: 1 }` in the tests that do not exercise this rule.

- [ ] **Step 8: Write the failing test for atomic writes**

```typescript
it('writes through the atomic writer, never a partial file', async () => {
  const calls: string[] = [];
  const store = new CorpusStore(await tempVault(), {
    writeFile: async (p) => { calls.push(p); },
    mkdir: async () => {},
  });
  await store.writeShard(shard('N.md'));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(CorpusStore.shardFileName('N.md'));
});
```

Assert the injected writer is used; the temp+rename guarantee itself belongs to `write-file-atomic` and is not re-tested here.

- [ ] **Step 9: Write the delete test**

```typescript
it('deletes a shard and tolerates a missing one', async () => {
  const store = new CorpusStore(await tempVault());
  await store.writeShard(shard('N.md'));
  await store.deleteShard('N.md');
  expect(await store.readShard('N.md')).toBeNull();
  await expect(store.deleteShard('N.md')).resolves.toBeUndefined();
});
```

- [ ] **Step 10: Run the gates and commit**

Run: `npx vitest run test/lib/obsidian/corpus && npm run lint && npm run typecheck`

```bash
git add package.json package-lock.json src/lib/obsidian/corpus/shard-store.ts test/lib/obsidian/corpus/shard-store.test.ts
git commit -m "feat(corpus): store one atomic self-describing shard per note"
```

---

### Task 7: Manifest and the rebuild gate

**Files:**
- Modify: `src/lib/obsidian/corpus/shard-store.ts`
- Test: `test/lib/obsidian/corpus/shard-store.test.ts`

**Interfaces:**
- Consumes: `CorpusManifest`, `EMBED_VERSION`, `MODEL_DIMS`, `SC_PARITY_STRATEGY` (Task 1).
- Produces, on `CorpusStore`:

```typescript
  readManifest(): Promise<CorpusManifest | null>;
  writeManifest(manifest: CorpusManifest): Promise<void>;
  clearShards(): Promise<void>;
  /** Compare, rebuild if needed, write only on change. Called first by reconcile. */
  ensureManifest(expected: Omit<CorpusManifest, 'created'>): Promise<{ rebuilt: boolean }>;
```

plus a free function `isManifestCompatible(stored: CorpusManifest | null, expected: Omit<CorpusManifest, 'created'>, hasShards: boolean): boolean`.

- [ ] **Step 1: Write the failing compatibility tests**

```typescript
import { isManifestCompatible } from '../../../../src/lib/obsidian/corpus/shard-store.js';

const expected = { embed_version: 1, model_key: 'bge-micro-v2', dims: 384, strategy: 'sc-parity-v1' };
const stored = { ...expected, created: '2026-08-24T00:00:00.000Z' };

describe('isManifestCompatible', () => {
  it('accepts an identical manifest', () => {
    expect(isManifestCompatible(stored, expected, true)).toBe(true);
  });

  it.each(['embed_version', 'model_key', 'dims', 'strategy'] as const)(
    'rejects a manifest differing in %s',
    (field) => {
      const changed = { ...stored, [field]: field === 'dims' || field === 'embed_version' ? 999 : 'other' };
      expect(isManifestCompatible(changed, expected, true)).toBe(false);
    },
  );

  it('rejects a missing manifest when shards exist', () => {
    expect(isManifestCompatible(null, expected, true)).toBe(false);
  });

  it('accepts a missing manifest on an empty corpus', () => {
    expect(isManifestCompatible(null, expected, false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, implement, run again**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts -t Manifest`
Expected: FAIL, then PASS.

- [ ] **Step 3: Write the failing test for write-only-on-change**

```typescript
it('writes the manifest only when its values change', async () => {
  const writes: string[] = [];
  const store = new CorpusStore(await tempVault(), {
    writeFile: async (p) => { writes.push(p); },
    mkdir: async () => {},
    readFile: async () => JSON.stringify(stored),
  });
  await store.ensureManifest(expected);
  expect(writes).toHaveLength(0);
});
```

- [ ] **Step 4: Implement `ensureManifest(expected)`**

Reads the stored manifest; if `isManifestCompatible(stored, expected, hasShards)` it returns `{ rebuilt: false }`; otherwise it calls `clearShards()`, writes a fresh manifest with `created: new Date().toISOString()`, and returns `{ rebuilt: true }`.

- [ ] **Step 5: Write the failing test for the rebuild path**

```typescript
it('clears every shard when the manifest is incompatible', async () => {
  const root = await tempVault();
  const store = new CorpusStore(root);
  await store.writeShard(shard('N.md'));
  await store.writeManifest({ ...stored, model_key: 'other-model' });
  const result = await store.ensureManifest(expected);
  expect(result.rebuilt).toBe(true);
  expect(await store.listShards()).toEqual(new Map());
  expect((await store.readManifest())?.model_key).toBe('bge-micro-v2');
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the gates and commit**

Run: `npx vitest run test/lib/obsidian/corpus && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/shard-store.ts test/lib/obsidian/corpus/shard-store.test.ts
git commit -m "feat(corpus): gate the corpus on a manifest and rebuild on mismatch"
```

---

### Task 8: Keep the corpus out of the vault's git history

**Files:**
- Modify: `src/lib/obsidian/corpus/shard-store.ts`
- Test: `test/lib/obsidian/corpus/shard-store.test.ts`

**Interfaces:**
- Produces: `ensureCorpusGitignored(vaultRoot: string, deps?: { readFile?; writeFile?; warn? }): Promise<void>`, exported from `shard-store.ts` and called once per index run.

- [ ] **Step 1: Write the failing tests**

```typescript
import { ensureCorpusGitignored } from '../../../../src/lib/obsidian/corpus/shard-store.js';

describe('ensureCorpusGitignored', () => {
  it('appends one entry, preserving existing lines', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), '.smart-env/\nnode_modules\n');
    await ensureCorpusGitignored(root);
    const after = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(after).toContain('.smart-env/');
    expect(after).toContain('node_modules');
    expect(after.match(/\.neuro-vault\/corpus\//g)).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), 'x\n');
    await ensureCorpusGitignored(root);
    await ensureCorpusGitignored(root);
    const after = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(after.match(/\.neuro-vault\/corpus\//g)).toHaveLength(1);
  });

  it('does not create a gitignore that does not exist', async () => {
    const root = await tempVault();
    await ensureCorpusGitignored(root);
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('warns on stderr and never throws when the file cannot be written', async () => {
    const warn = vi.fn();
    await expect(
      ensureCorpusGitignored(await tempVault(), {
        readFile: async () => 'x\n',
        writeFile: async () => { throw new Error('EACCES'); },
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a gitignore that already covers the corpus untouched', async () => {
    const root = await tempVault();
    await writeFile(path.join(root, '.gitignore'), '.neuro-vault/corpus/\n');
    await ensureCorpusGitignored(root);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe('.neuro-vault/corpus/\n');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts -t gitignore`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

Read `<vaultRoot>/.gitignore`; on `ENOENT` return silently. If any line, trimmed, equals `.neuro-vault/corpus/`, `.neuro-vault/corpus`, `/.neuro-vault/corpus/`, `.neuro-vault/` or `.neuro-vault`, return. Otherwise append `.neuro-vault/corpus/\n` (prefixing a newline when the file does not end in one) through the atomic writer. Wrap everything after the ENOENT check in a `try/catch` that calls `warn` with a message naming the vault root and returns normally.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/corpus/shard-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/shard-store.ts test/lib/obsidian/corpus/shard-store.test.ts
git commit -m "feat(corpus): keep the corpus out of the vault's git history"
```

---

### Task 9: PR 1 — extraction and storage

**Files:** none (delivery task).

- [ ] **Step 1: Run every gate and capture the output**

```bash
npm test && npm run lint && npm run typecheck && npx openspec validate --all
```

- [ ] **Step 2: Confirm the slice is still inert**

```bash
git diff --stat main -- src/server.ts src/cli.ts src/lib/vault-registry.ts
```

Expected: empty. Nothing is wired; the only file touched outside `src/lib/obsidian/corpus/` is `src/modules/semantic/embedding-service.ts` (Task 4).

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin feat/own-corpus-indexer-extraction
gh pr create --base main --title "feat(corpus): embed-text extraction and shard storage" --body "$(cat <<'BODY'
Slice #2 of the own-embedding-pipeline queue, part 1 of 2: extraction and storage.

Refs #82

- Chunker, embed-text builder and size gate at parity with the corpus being replaced
- Shard store: one atomic self-describing JSON shard per note, base64 float32 vectors, manifest with a rebuild gate
- Tokenizer cap so inputs over the model window truncate instead of crashing ONNX
- New dependency: write-file-atomic (ISC, pure JS, no install-time build, Node floor unchanged)

Nothing is wired: no registry, server, watcher or CLI change, and Smart Connections still serves every semantic tool. Reconcile and docs land in part 2.

Gates: npm test, npm run lint, npm run typecheck, openspec validate --all — all green.
BODY
)"
```

- [ ] **Step 4: Stop**

Do not start Task 10 until PR 1 is merged. This is the pause the change's delivery plan requires.

---

### Task 10: Reconcile core

**Files:**
- Create: `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts`

**Interfaces:**
- Consumes: `CorpusStore` + `ensureCorpusGitignored` (Tasks 6–8), `buildEmbedInputs` (Task 3), `encodeVector` (Task 5), `EmbedFn` and the constants (Task 1).
- Produces:

```typescript
export interface ReconcileDeps {
  vaultRoot: string;
  /** Scope-filtered, vault-relative `.md` paths. Production: FsVaultReader.scan(). */
  scan: () => Promise<string[]>;
  readNote: (relPath: string) => Promise<{ content: string; mtime: number; size: number }>;
  embed: EmbedFn;
  store: CorpusStore;
  warn?: (message: string) => void;
}

export interface ReconcileOptions {
  onProgress?: (progress: { indexed: number; total: number }) => void;
}

export interface ReconcileSummary {
  total: number;
  embedded: number;
  reused: number;
  renamed: number;
  deleted: number;
  failed: number;
}

export function contentHash(content: string): string;           // sha256 hex
export function reconcileCorpus(
  deps: ReconcileDeps,
  opts?: ReconcileOptions,
): Promise<ReconcileSummary>;
```

Algorithm, in order:

1. `ensureManifest(expected)`; if it rebuilt, treat the shard map as empty.
2. `paths = await scan()` (already scope-filtered — reconcile applies no exclusion rule of its own), `shards = await store.listShards()`.
3. For each path in sorted order:
   - shard exists and `shard.mtime === stat.mtime` and `shard.size === stat.size` → **reused**, no read;
   - else read the note; `contentHash(content) === shard?.content_hash` → rewrite the shard with the new mtime/size, reuse the vectors → **reused**;
   - else embed (below) → **embedded**, or **renamed** when the hash matched a shard whose path is not in `paths` (Task 11).
4. Every shard whose path is not in `paths` → `deleteShard` → **deleted**.
5. `ensureCorpusGitignored(vaultRoot)` once, at the end.

Embedding one note: `buildEmbedInputs(path, content)` → embed `note` if non-null, embed each block's `embedText`, encode each vector, write one shard.

- [ ] **Step 1: Write the test helper**

```typescript
// test/lib/obsidian/corpus/reconcile.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { reconcileCorpus } from '../../../../src/lib/obsidian/corpus/reconcile.js';
import { MODEL_DIMS } from '../../../../src/lib/obsidian/corpus/types.js';

/** Deterministic fake embedder: the vector is a checkable function of its input text. */
function fakeEmbed() {
  const fn = vi.fn(async (text: string) => {
    const vector = new Array<number>(MODEL_DIMS).fill(0);
    for (let i = 0; i < text.length; i += 1) {
      vector[i % MODEL_DIMS] = Math.fround((vector[i % MODEL_DIMS] ?? 0) + text.charCodeAt(i) / 1000);
    }
    return vector;
  });
  return fn;
}

/** In-memory vault: path -> { content, mtime, size }. */
function fakeVault(files: Record<string, string>) {
  const state = new Map(
    Object.entries(files).map(([p, content]) => [p, { content, mtime: 1, size: content.length }]),
  );
  return {
    state,
    scan: async () => [...state.keys()].sort(),
    readNote: async (p: string) => {
      const entry = state.get(p);
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entry;
    },
    edit(p: string, content: string) {
      state.set(p, { content, mtime: 2, size: content.length });
    },
    touch(p: string) {
      const entry = state.get(p)!;
      state.set(p, { ...entry, mtime: entry.mtime + 1 });
    },
    move(from: string, to: string) {
      const entry = state.get(from)!;
      state.delete(from);
      state.set(to, entry);
    },
  };
}

const body = (marker: string) => `# ${marker}\n${'x'.repeat(300)}\n`;

async function harness(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-'));
  const vault = fakeVault(files);
  const embed = fakeEmbed();
  const store = new CorpusStore(root);
  const run = () =>
    reconcileCorpus({ vaultRoot: root, scan: vault.scan, readNote: vault.readNote, embed, store });
  return { root, vault, embed, store, run };
}
```

- [ ] **Step 2: Write the failing first-run test**

```typescript
describe('reconcileCorpus', () => {
  it('embeds every in-scope note on the first run', async () => {
    const { run, store } = await harness({ 'A.md': body('A'), 'Dir/B.md': body('B') });
    const summary = await run();
    expect(summary).toMatchObject({ total: 2, embedded: 2, reused: 0, deleted: 0, failed: 0 });
    expect([...(await store.listShards()).keys()]).toEqual(['A.md', 'Dir/B.md']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the first-run path**

Write `contentHash` (`createHash('sha256').update(content).digest('hex')`), the embed-one-note helper, and the loop for the "no shard" case only. Wire `ensureManifest` at the start and `ensureCorpusGitignored` at the end.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing incremental tests**

```typescript
it('embeds nothing on a second run over an untouched vault', async () => {
  const { run, embed } = await harness({ 'A.md': body('A') });
  await run();
  embed.mockClear();
  expect(await run()).toMatchObject({ total: 1, embedded: 0, reused: 1, deleted: 0 });
  expect(embed).not.toHaveBeenCalled();
});

it('does not re-embed a touched but unmodified note', async () => {
  const { run, embed, vault } = await harness({ 'A.md': body('A') });
  await run();
  vault.touch('A.md');
  embed.mockClear();
  expect(await run()).toMatchObject({ reused: 1, embedded: 0 });
  expect(embed).not.toHaveBeenCalled();
});

it('re-embeds an edited note', async () => {
  const { run, embed, vault, store } = await harness({ 'A.md': body('A') });
  await run();
  const before = (await store.readShard('A.md'))!.embedding;
  vault.edit('A.md', body('A EDITED'));
  embed.mockClear();
  expect(await run()).toMatchObject({ embedded: 1, reused: 0 });
  expect((await store.readShard('A.md'))!.embedding).not.toBe(before);
});

it('records a note below the size gate without a note-level vector', async () => {
  const { run, store } = await harness({ 'Short.md': '# S\ntiny\n' });
  await run();
  const shard = (await store.readShard('Short.md'))!;
  expect(shard.embedding).toBeNull();
  expect(shard.blocks).toEqual([]);
  expect(shard.content_hash).toEqual(expect.any(String));
});

it('deletes the shard of a removed note', async () => {
  const { run, vault, store } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
  await run();
  vault.state.delete('B.md');
  expect(await run()).toMatchObject({ deleted: 1, total: 1 });
  expect([...(await store.listShards()).keys()]).toEqual(['A.md']);
});

it('drops a note that left scope and picks up one that entered it', async () => {
  const { run, vault, store } = await harness({ 'A.md': body('A') });
  await run();
  vault.state.delete('A.md');
  vault.state.set('C.md', { content: body('C'), mtime: 1, size: body('C').length });
  await run();
  expect([...(await store.listShards()).keys()]).toEqual(['C.md']);
});
```

- [ ] **Step 7: Run them to verify they fail, implement, run again**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts`
Expected: FAIL on the incremental cases, then PASS once the mtime/size pre-check, hash comparison, metadata-only rewrite and orphan deletion are implemented.

- [ ] **Step 8: Write the failing manifest-rebuild test**

```typescript
it('rebuilds everything when the manifest is incompatible', async () => {
  const { run, store, embed, root } = await harness({ 'A.md': body('A') });
  await run();
  await store.writeManifest({
    embed_version: 1, model_key: 'other', dims: 384,
    strategy: 'sc-parity-v1', created: '2026-01-01T00:00:00.000Z',
  });
  embed.mockClear();
  expect(await run()).toMatchObject({ embedded: 1, reused: 0 });
  expect(embed).toHaveBeenCalled();
});
```

- [ ] **Step 9: Run it, confirm it passes with the `ensureManifest` wiring from Step 4**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts -t rebuild`
Expected: PASS. If it fails, the shard map is being read before `ensureManifest` clears it — re-read `listShards` after the rebuild.

- [ ] **Step 10: Run the gates and commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/reconcile.ts test/lib/obsidian/corpus/reconcile.test.ts
git commit -m "feat(corpus): reconcile the corpus against the vault incrementally"
```

---

### Task 11: Rename handling and the reproducibility invariant

**Files:**
- Modify: `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts`

**Interfaces:**
- Consumes: everything from Task 10. Adds no new export; `ReconcileSummary.renamed` starts being non-zero.

**Why a rename re-embeds** (design D9): both embed-text formulas carry path breadcrumbs, so a vector is a function of (path, content, strategy). Reusing vectors across a rename would leave the old path inside them until the note's text next changed, and an incrementally maintained corpus would then differ from a from-scratch index of the same vault.

- [ ] **Step 1: Write the failing rename test**

```typescript
it('re-embeds a renamed note and removes its old shard', async () => {
  const { run, vault, store, embed } = await harness({ 'A.md': body('A') });
  await run();
  const before = (await store.readShard('A.md'))!;
  vault.move('A.md', 'Dir/A.md');
  embed.mockClear();

  const summary = await run();

  expect(summary).toMatchObject({ renamed: 1, deleted: 0, embedded: 0 });
  expect(await store.readShard('A.md')).toBeNull();
  const after = (await store.readShard('Dir/A.md'))!;
  expect(after.content_hash).toBe(before.content_hash);
  expect(after.embedding).not.toBe(before.embedding);
  expect(embed).toHaveBeenCalled();
});

it('gives two notes with identical content two distinct vectors', async () => {
  const shared = body('SAME');
  const { run, store } = await harness({ 'A.md': shared, 'Dir/A.md': shared });
  await run();
  const a = (await store.readShard('A.md'))!;
  const b = (await store.readShard('Dir/A.md'))!;
  expect(a.content_hash).toBe(b.content_hash);
  expect(a.embedding).not.toBe(b.embedding);
});
```

- [ ] **Step 2: Run them to verify the rename case fails**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts -t rename`
Expected: FAIL — the move is currently counted as one `embedded` plus one `deleted`, and `renamed` is 0.

- [ ] **Step 3: Implement rename detection**

Before the per-path loop, build `orphanByHash: Map<string, string[]>` from every shard whose path is **not** in the scanned set, keyed by `content_hash`. In the "no shard at this path" branch, after hashing the content: if `orphanByHash` holds that hash, shift one entry off, `deleteShard(oldPath)`, remove it from the orphan set so step 4 does not delete it again, embed the note under its new path, and count it as `renamed` rather than `embedded`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing invariant test**

```typescript
it('reaches the same corpus incrementally as from scratch', async () => {
  const files = { 'A.md': body('A'), 'Dir/B.md': body('B'), 'C.md': body('C') };
  const incremental = await harness(files);
  await incremental.run();
  incremental.vault.edit('A.md', body('A v2'));
  await incremental.run();
  incremental.vault.move('Dir/B.md', 'Moved/B.md');
  await incremental.run();
  incremental.vault.state.delete('C.md');
  incremental.vault.state.set('D.md', { content: body('D'), mtime: 1, size: body('D').length });
  await incremental.run();

  const scratch = await harness({
    'A.md': body('A v2'),
    'Moved/B.md': body('B'),
    'D.md': body('D'),
  });
  await scratch.run();

  const normalize = async (h: Awaited<ReturnType<typeof harness>>) =>
    [...(await h.store.listShards()).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, shard]) => [p, { ...shard, mtime: 0, size: 0 }]);

  expect(await normalize(incremental)).toEqual(await normalize(scratch));
});
```

`mtime`/`size` are normalized away because they legitimately differ between the two histories; every vector, hash, key and span must match exactly.

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts -t 'same corpus'`
Expected: PASS. A failure here is a real defect, not a flaky test — it means some path reuses a vector computed under a different path.

- [ ] **Step 7: Run the gates and commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/reconcile.ts test/lib/obsidian/corpus/reconcile.test.ts
git commit -m "feat(corpus): re-embed renamed notes so incremental equals from-scratch"
```

---

### Task 12: Progress, summary and failure containment

**Files:**
- Modify: `src/lib/obsidian/corpus/reconcile.ts`
- Test: `test/lib/obsidian/corpus/reconcile.test.ts`

**Interfaces:**
- Consumes: Task 10's `ReconcileOptions` and `ReconcileSummary`.
- Produces: the progress callback contract that slice #3 (CLI progress) and slice #5 (`semantic_status: { state: "indexing", indexed, total }`) consume unchanged.

- [ ] **Step 1: Write the failing progress test**

```typescript
it('reports progress in notes against the in-scope total', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-progress-'));
  const vault = fakeVault({ 'A.md': body('A'), 'B.md': body('B'), 'C.md': body('C') });
  const seen: Array<{ indexed: number; total: number }> = [];
  await reconcileCorpus(
    { vaultRoot: root, scan: vault.scan, readNote: vault.readNote, embed: fakeEmbed(), store: new CorpusStore(root) },
    { onProgress: (p) => seen.push({ ...p }) },
  );
  expect(seen.at(-1)).toEqual({ indexed: 3, total: 3 });
  expect(seen.map((p) => p.indexed)).toEqual([1, 2, 3]);
  expect(seen.every((p) => p.total === 3)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails, implement, run again**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts -t progress`
Expected: FAIL — `onProgress` is never called. Then PASS after calling it once per processed note, counting every outcome (embedded, reused, renamed, failed) alike.

- [ ] **Step 3: Write the failing failure-containment tests**

```typescript
it('records a failing note and keeps going', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-fail-'));
  const vault = fakeVault({ 'A.md': body('A'), 'Bad.md': body('Bad'), 'C.md': body('C') });
  const embed = vi.fn(async (text: string) => {
    if (text.includes('Bad')) throw new Error('model exploded');
    return new Array<number>(MODEL_DIMS).fill(0.1);
  });
  const store = new CorpusStore(root);
  const warn = vi.fn();

  const summary = await reconcileCorpus({
    vaultRoot: root, scan: vault.scan, readNote: vault.readNote, embed, store, warn,
  });

  expect(summary).toMatchObject({ total: 3, embedded: 2, failed: 1 });
  expect([...(await store.listShards()).keys()]).toEqual(['A.md', 'C.md']);
  expect(warn).toHaveBeenCalledTimes(1);
});

it('leaves the previous shard intact when a re-embed fails', async () => {
  const { run, store, vault, root } = await harness({ 'A.md': body('A') });
  await run();
  const before = (await store.readShard('A.md'))!;
  vault.edit('A.md', body('A v2'));

  const summary = await reconcileCorpus({
    vaultRoot: root,
    scan: vault.scan,
    readNote: vault.readNote,
    embed: vi.fn(async () => { throw new Error('nope'); }),
    store,
    warn: vi.fn(),
  });

  expect(summary).toMatchObject({ total: 1, failed: 1, embedded: 0 });
  expect(await store.readShard('A.md')).toEqual(before);
});
```

- [ ] **Step 4: Run them to verify they fail, implement, run again**

Run: `npx vitest run test/lib/obsidian/corpus/reconcile.test.ts -t fail`
Expected: FAIL (the run currently rejects), then PASS once each note's work is wrapped in `try/catch` that increments `failed`, calls `warn` with the note path, and continues without writing a shard.

- [ ] **Step 5: Verify against the real vault, outside the suite**

Write a throwaway script in the scratchpad (not in the repo — the CLI is slice #3) that builds an `FsVaultReader` with `loadVaultScope`, a real `EmbeddingService`, and a `CorpusStore` over a **copy** of a vault, then runs `reconcileCorpus` twice.

Run it and record in the PR body: note count, vector count, wall-clock of run 1, and run 2's summary (which must be all-reused, zero embedded).

- [ ] **Step 6: Run the gates and commit**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add src/lib/obsidian/corpus/reconcile.ts test/lib/obsidian/corpus/reconcile.test.ts
git commit -m "feat(corpus): report indexing progress and contain per-note failure"
```

---

### Task 13: Documentation

**Files:**
- Create: `docs/adr/0012-own-embedding-corpus.md`, `docs/architecture/own-corpus.md`
- Modify: `docs/adr/0006-smart-connections-corpus.md`, `docs/adr/INDEX.md`, `docs/architecture/vault-scope.md`

- [ ] **Step 1: Write ADR-0012**

Follow `docs/adr/0000-template.md`. Status `Accepted`, dated the day it is written. Context: the ADR-0006 premise (a plugin's corpus is free) against what changed — the model is already loaded for queries, indexing measures ~1.5–3.3 min cold and ~90 ms per changed note, and the inherited corpus is stale and unreconcilable with the lexical leg's membership. Decision: the server builds and owns an embedding corpus under `<vault>/.neuro-vault/corpus/`, superseding ADR-0006's "the server never writes embeddings". Consequences: a new write path inside the vault, a `write-file-atomic` dependency, corpus freshness becomes ours to maintain, and the `embed_version` + rebuild mechanism becomes the migration lever. Alternatives: the plugin's AJSON format, LanceDB, hnswlib-node, sqlite in both forms — each with the one fact that disqualified it (design D4).

- [ ] **Step 2: Mark ADR-0006 superseded in part**

Add under its Status line:

```markdown
- **Superseded in part by**: [ADR-0012](0012-own-embedding-corpus.md) — the
  "server never writes embeddings" decision is reversed; the read-only
  consumption record stands as history.
```

Add the ADR-0012 row to `docs/adr/INDEX.md` in the existing table's format.

- [ ] **Step 3: Write `docs/architecture/own-corpus.md`**

One concept, one file — a reader must understand the own corpus from this file alone. Sections: what it is (the four pieces and where they live); the extraction rules with the key-grammar table from Task 2 and both formulas from Task 3; the named divergences from the corpus being replaced (design D2); the on-disk layout with the shard and manifest schemas; atomic writes and the "a corrupt shard is a missing shard" recovery rule; the reconcile algorithm as a numbered list; the `vector = f(path, content, strategy)` invariant and why a rename re-embeds; measured numbers (40.4 vectors/s, ~1.5–3.3 min cold, ~90 ms per note, 68 ms cold load of 2 500 shards); and a Boundaries section naming what this slice deliberately does not do (no watcher, no promotion, no CLI, no serving).

- [ ] **Step 4: Update `docs/architecture/vault-scope.md`**

Replace the "**Not governed yet — the semantic leg**" paragraph and the "**From the next slice on:**" forward reference: the own corpus now takes membership from the same scope, and what remains ungoverned is only what still reads the Smart Connections corpus (slice #5 closes that). Keep the accepted `Untitled.md` membership diff — it is still true.

- [ ] **Step 5: Sweep the rest of the docs**

```bash
grep -rniE "smart.connections|embeddings come|never writes embeddings|zero infrastructure" docs README.md
```

For each hit, decide: still true (a tool still serves from the SC corpus in this slice — leave it), or now wrong (fix it). Do **not** rewrite the README's "zero infrastructure" claim here — that belongs to slice #5, which introduces the watcher that makes it false. Note in the PR body which hits were left for slice #5.

- [ ] **Step 6: Verify links resolve**

```bash
grep -oE '\]\([^)#]+\.md' docs/architecture/own-corpus.md docs/adr/0012-own-embedding-corpus.md | cut -d'(' -f2 | while read -r f; do test -e "docs/$(dirname "")/$f" || echo "check: $f"; done
```

Simpler and sufficient: open each new file and click through every relative link once.

- [ ] **Step 7: Commit**

```bash
git add docs
git commit -m "docs(corpus): record the own-corpus decision and mechanism"
```

---

### Task 14: PR 2 — reconcile and docs

**Files:** none (delivery task).

- [ ] **Step 1: Run every gate**

```bash
npm test && npm run lint && npm run typecheck && npx openspec validate --all
```

- [ ] **Step 2: Confirm the slice stayed internal**

```bash
git diff --stat main -- src/server.ts src/cli.ts src/lib/vault-registry.ts src/modules/semantic/tools
```

Expected: empty. No MCP contract change, no wiring, no watcher, no CLI; Smart Connections still serves every semantic tool.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --title "feat(corpus): incremental reconcile and the own-corpus decision record" --body "$(cat <<'BODY'
Slice #2 of the own-embedding-pipeline queue, part 2 of 2: reconcile and docs.

Closes #82

- Incremental reconcile: mtime/size pre-check, content hash as truth, orphan deletion
- A rename re-embeds — vectors are a function of (path, content, strategy), since both parity embed-text formulas carry path breadcrumbs. This corrects an upstream decision that assumed path-independent vectors; see design.md D9.
- Progress callback and run summary, per-note failure contained
- ADR-0012 superseding ADR-0006's "server never writes embeddings"; docs/architecture/own-corpus.md; vault-scope doc updated

Still internal: no tool contract change, no wiring, no watcher, no CLI.

Gates: npm test, npm run lint, npm run typecheck, openspec validate --all — all green.
Real-vault check: <note count> notes, <vector count> vectors, <wall-clock> first run; second run all-reused, zero embedded.
BODY
)"
```

- [ ] **Step 4: Verify and archive**

After the PR merges, run `/opsx:verify` and then `/opsx:archive`. Release from `main` only.
