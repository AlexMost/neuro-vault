# PROTOTYPE — structured preview for `read_notes` (issue 247)

Throwaway, never merged. Answers: what does a structured preview look like, what bounds it, and
does it replace today's `preview`?

- `src/modules/operations/preview.PROTOTYPE.ts` — pure functions, four candidates: A today's
  500-char prefix (+ `lines`), B outline + prefix, C structured array with per-heading
  excerpts under a per-note budget, D a markdown skim with inlined spans. Builds on
  `outline.PROTOTYPE.ts` from the `prototype/outline-shape` branch (246).
- `prototype/preview/run.ts` — `npx tsx prototype/preview/run.ts [vaultDir]` renders
  `preview.html` from `shell.html`: every candidate on public repo notes plus synthetic
  table-first, heading-less and 400-heading notes, and size aggregates over a vault (numbers
  only, no paths or titles).
- `preview.html` — the rendered demo; open it by double-click.

Verdict: B, in place — `preview` keeps `content` / `truncated` unchanged and gains the outline
fields (`lines` = body span, `preamble`, `outline`, `collapsed`). Details: the resolution
comment on issue 247.
