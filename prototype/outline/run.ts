// PROTOTYPE runner — `npx tsx prototype/outline/run.ts [vaultDir]`.
// Builds outline.html: every candidate shape on a few long public notes plus a synthetic log,
// and (optionally) size aggregates over a vault. Only aggregates leave the vault.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  structureOf,
  flat,
  flatOwn,
  tree,
  text,
  tuples,
  flatBudgeted,
  flatCapped,
} from '../../src/modules/operations/outline.PROTOTYPE.js';

const shapes = { flat, flatOwn, tree, text, tuples } as const;
const BUDGET = 2048;

function synthetic(): string {
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
        '- did a thing',
        '',
      );
      if (d % 10 === 0) out.push('#### Notes', 'a sub note', '');
    }
  }
  out.push('## Notes', 'cross-parent duplicate of the daily "Notes"', '');
  return out.join('\n') + '\n';
}

const samples: { name: string; why: string; content: string }[] = [
  {
    name: 'docs/guide/finding-notes.md',
    why: '~460 lines, 20 headings — the "500-line note" of the budget',
    content: readFileSync('docs/guide/finding-notes.md', 'utf8'),
  },
  {
    name: 'openspec/specs/hybrid-search/spec.md',
    why: '~550 lines, heading-dense (requirements + scenarios)',
    content: readFileSync('openspec/specs/hybrid-search/spec.md', 'utf8'),
  },
  {
    name: 'CHANGELOG.md',
    why: '~1000 lines, ~170 headings, three levels',
    content: readFileSync('CHANGELOG.md', 'utf8'),
  },
  {
    name: '(synthetic) yearly work log',
    why: 'frontmatter + preamble, ~400 headings, sibling + cross-parent duplicate "Notes"',
    content: synthetic(),
  },
];

const rendered = samples.map((s) => {
  const st = structureOf(s.content);
  const variants = Object.fromEntries(
    Object.entries(shapes).map(([k, f]) => {
      const v = f(st);
      return [k, { json: JSON.stringify(v), bytes: JSON.stringify(v).length }];
    }),
  );
  const b = flatBudgeted(st, BUDGET);
  variants.budgeted = { json: JSON.stringify(b), bytes: JSON.stringify(b).length };
  const c = flatCapped(st);
  variants.capped = { json: JSON.stringify(c), bytes: JSON.stringify(c).length };
  return {
    name: s.name,
    why: s.why,
    lines: st.body[1],
    entries: st.entries.length,
    bodyBytes: s.content.length,
    variants,
  };
});

// ---- vault aggregates (sizes only) ----
function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (n.endsWith('.md')) acc.push(p);
  }
  return acc;
}
let agg: Record<string, unknown> | null = null;
const vault = process.argv[2];
if (vault) {
  const rows = walk(vault).map((p) => {
    const st = structureOf(readFileSync(p, 'utf8'));
    return {
      lines: st.body[1],
      entries: st.entries.length,
      flat: JSON.stringify(flat(st)).length,
      text: JSON.stringify(text(st)).length,
      collapsed: 'collapsed' in flatBudgeted(st, BUDGET),
      maxDepth: Math.max(0, ...st.entries.map((e) => e.depth)),
      ownDiffers: st.entries.filter((e) => e.own[1] !== e.lines[1]).length,
    };
  });
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const long = rows.filter((r) => r.lines >= 400);
  agg = {
    notes: rows.length,
    entriesP50: pct(
      rows.map((r) => r.entries),
      0.5,
    ),
    entriesP95: pct(
      rows.map((r) => r.entries),
      0.95,
    ),
    entriesMax: Math.max(...rows.map((r) => r.entries)),
    notesOver100Headings: rows.filter((r) => r.entries > 100).length,
    flatBytesP95: pct(
      rows.map((r) => r.flat),
      0.95,
    ),
    flatBytesMax: Math.max(...rows.map((r) => r.flat)),
    notesFlatOver2KB: rows.filter((r) => r.flat > BUDGET).length,
    notesTextOver2KB: rows.filter((r) => r.text > BUDGET).length,
    notesCollapsedAt2KB: rows.filter((r) => r.collapsed).length,
    notes400PlusLines: long.length,
    notes400PlusLinesFlatOver2KB: long.filter((r) => r.flat > BUDGET).length,
    maxTreeDepth: Math.max(...rows.map((r) => r.maxDepth)),
    entriesWithOwnTextShorterThanSubtree: rows.reduce((n, r) => n + r.ownDiffers, 0),
    entriesTotal: rows.reduce((n, r) => n + r.entries, 0),
  };
}

const data = JSON.stringify({ rendered, agg, budget: BUDGET });
const html = readFileSync('prototype/outline/shell.html', 'utf8').replace('/*DATA*/null', data);
writeFileSync('prototype/outline/outline.html', html);
console.log(
  JSON.stringify(
    {
      samples: rendered.map((r) => ({
        name: r.name,
        lines: r.lines,
        entries: r.entries,
        bytes: Object.fromEntries(Object.entries(r.variants).map(([k, v]) => [k, v.bytes])),
      })),
      agg,
    },
    null,
    1,
  ),
);
