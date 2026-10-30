// PROTOTYPE runner — `npx tsx prototype/preview/run.ts [vaultDir]`.
// Builds preview.html: four preview candidates on public repo notes plus synthetic edge cases,
// and (optionally) size aggregates over a vault. Only aggregates leave the vault.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  prefixPreview,
  outlinePlusPrefix,
  structured,
  structuredHeadingless,
  markdownSkim,
  sizeOf,
  DEFAULT_C,
} from '../../src/modules/operations/preview.PROTOTYPE.js';
import { flatCapped, structureOf } from '../../src/modules/operations/outline.PROTOTYPE.js';

function log(): string {
  const out = [
    '---',
    'type: project',
    'tags: [log]',
    '---',
    'Intro paragraph before any heading.',
    '',
  ];
  out.push('# Work log', '', 'Append-only. Newest at the bottom.', '');
  for (let m = 1; m <= 12; m++) {
    out.push(`## 2026-${String(m).padStart(2, '0')}`, '');
    for (let d = 1; d <= 30; d++) {
      out.push(
        `### 2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        `- did thing ${d}`,
        '',
      );
      if (d % 10 === 0) out.push('#### Notes', 'a sub note', '');
    }
  }
  return out.join('\n') + '\n';
}

const tableFirst = `---
type: project
status: active
---
**Owner:** someone · **Started:** 2026-03-01 · **Review:** quarterly
**Links:** [[Roadmap]] · [[Budget 2026]] · [[Team]]

| Field | Value |
|---|---|
| Phase | Discovery |
| Risk | Medium |
| Budget | 12k |

## First 30 days

| Week | Goal | Owner | Done |
|---|---|---|---|
| 1 | Interview five customers about onboarding | A | ✅ |
| 2 | Draft the onboarding map | B | ✅ |
| 3 | Prototype the new first-run screen | A | ⏳ |
| 4 | Ship behind a flag | C | |

## Decisions

- Keep the free tier; gate exports instead.
- Onboarding is owned by growth, not core.

## Open questions

Who signs off on the pricing page copy? Legal wants a week.

## Snippets

\`\`\`ts
export const FLAG = 'new-first-run';
export function enabled(user: { id: string }) {
  return hash(user.id) % 100 < 10;
}
\`\`\`

Rollout is 10% by user id hash.
`;

const headingless = `---
type: reflection
---
${Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. Long free-form reflection text with no headings at all, the kind of note a voice memo or a journal entry produces; it rambles a bit and the useful sentence might be anywhere in it.`).join('\n\n')}
`;

const samples = [
  {
    name: '(synthetic) table-first project note',
    why: 'metadata line + table before the first heading, tables and a code fence under headings — the 189 case',
    content: tableFirst,
  },
  {
    name: '(synthetic) heading-less reflection',
    why: '~2.8 KB body, no headings',
    content: headingless,
  },
  {
    name: 'docs/guide/finding-notes.md',
    why: '~460 lines, 20 headings',
    content: readFileSync('docs/guide/finding-notes.md', 'utf8'),
  },
  {
    name: 'CHANGELOG.md',
    why: '~1000 lines, ~175 headings, three levels',
    content: readFileSync('CHANGELOG.md', 'utf8'),
  },
  {
    name: '(synthetic) yearly work log',
    why: '~400 headings; the outline collapses',
    content: log(),
  },
];

const cands = {
  A_prefix: prefixPreview,
  B_outlinePlusPrefix: outlinePlusPrefix,
  C_structured: (t: string) => structuredHeadingless(t),
  C_structured_lastFirst: (t: string) => structured(t, { ...DEFAULT_C, degrade: 'last-first' }),
  C_structured_2KB: (t: string) => structured(t, { ...DEFAULT_C, total: 2048 }),
  D_markdown: markdownSkim,
} as const;

const rendered = samples.map((s) => {
  const st = structureOf(s.content);
  return {
    name: s.name,
    why: s.why,
    lines: st.body[1],
    headings: st.entries.length,
    bodyBytes: Buffer.byteLength(
      s.content
        .split('\n')
        .slice(st.body[0] - 1)
        .join('\n'),
    ),
    variants: Object.fromEntries(
      Object.entries(cands).map(([k, f]) => {
        const v = f(s.content);
        return [k, { json: JSON.stringify(v, null, 1), bytes: sizeOf(v) }];
      }),
    ),
  };
});

// ---- vault aggregates (sizes only) ----
function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (n.endsWith('.md') && !n.endsWith('.excalidraw.md')) acc.push(p);
  }
  return acc;
}
let agg: Record<string, unknown> | null = null;
const vault = process.argv[2];
if (vault) {
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const rows = walk(vault).map((p) => {
    const t = readFileSync(p, 'utf8');
    const st = structureOf(t);
    const c12 = structured(t);
    const c20 = structured(t, { ...DEFAULT_C, total: 2048 });
    const cFree = structured(t, { ...DEFAULT_C, total: 1e9 });
    const a = prefixPreview(t);
    // headings whose line the 500-char prefix reaches
    const reached = st.entries.filter((e) => e.lines[0] <= (a.lines[1] as number)).length;
    return {
      headings: st.entries.length,
      A: sizeOf(a),
      B: sizeOf(outlinePlusPrefix(t)),
      C12: sizeOf(c12),
      C20: sizeOf(c20),
      Cfree: sizeOf(cFree),
      D: sizeOf(markdownSkim(t)),
      outline: sizeOf(flatCapped(st)),
      C12partial: 'excerpts' in c12,
      C20partial: 'excerpts' in c20,
      reachedShare: st.entries.length ? reached / st.entries.length : 1,
    };
  });
  const k = ['A', 'B', 'C12', 'C20', 'Cfree', 'D', 'outline'] as const;
  agg = {
    notes: rows.length,
    bytes: Object.fromEntries(
      k.map((x) => [
        x,
        {
          p50: pct(
            rows.map((r) => r[x]),
            0.5,
          ),
          p95: pct(
            rows.map((r) => r[x]),
            0.95,
          ),
          max: Math.max(...rows.map((r) => r[x])),
          batch50AtP95:
            50 *
            pct(
              rows.map((r) => r[x]),
              0.95,
            ),
        },
      ]),
    ),
    C12_notesWithDroppedExcerpts: rows.filter((r) => r.C12partial).length,
    C20_notesWithDroppedExcerpts: rows.filter((r) => r.C20partial).length,
    multiHeadingNotes: rows.filter((r) => r.headings > 1).length,
    prefixReachesHalfOrLessOfHeadings: rows.filter((r) => r.headings > 1 && r.reachedShare <= 0.5)
      .length,
    prefixReachesAllHeadings: rows.filter((r) => r.headings > 1 && r.reachedShare === 1).length,
  };
}

const data = JSON.stringify({ rendered, agg, defaults: DEFAULT_C });
writeFileSync(
  'prototype/preview/preview.html',
  readFileSync('prototype/preview/shell.html', 'utf8').replace('/*DATA*/null', data),
);
console.log(
  JSON.stringify(
    {
      samples: rendered.map((r) => ({
        name: r.name,
        body: r.bodyBytes,
        bytes: Object.fromEntries(Object.entries(r.variants).map(([k, v]) => [k, v.bytes])),
      })),
      agg,
    },
    null,
    1,
  ),
);
