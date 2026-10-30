# PROTOTYPE — outline result shape for `read_notes` (issue 246)

Throwaway, never merged. Answers: what does `content: 'outline'` return?

- `src/modules/operations/outline.PROTOTYPE.ts` — pure functions: the chunker's heading blocks
  plus `level`, and five candidate shapes (flat, flat + own, tree, text TOC, tuples), a 2 KB byte
  budget and the chosen 100-entry depth-collapse cap.
- `prototype/outline/run.ts` — `npx tsx prototype/outline/run.ts [vaultDir]` renders
  `outline.html` from `shell.html`: every shape on long public repo notes plus a synthetic
  400-heading log, and size aggregates over a vault (numbers only, no paths or titles).
- `outline.html` — the rendered demo; open it by double-click.

Verdict: see the resolution comment on issue 246.
