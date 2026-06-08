<!--
Raw capture of the brainstorming for this change.

The creative exploration was already done outside this session and recorded in the
vault task note `Tasks/neuro-vault/Preview-режим тіла для read_notes` (itself distilled
from the W17→W24 tool-usage reports under `Inbox/neuro-vault-usage/`). The one design
fork left open — the parameter shape — was resolved live with the user via a single
question. This file captures that completed brainstorming as a decision log; it does not
re-run the brainstorming skill, because doing so would re-litigate decisions the user has
already made.
-->

# Brainstorm — Preview mode for `read_notes` bodies

## Background

`read_notes` is the heaviest knowledge tool in `neuro-vault-mcp` — ~12–15 KB per call,
peak ~33 KB — and has held that spot for six consecutive weekly usage reports. The cost
concentrates on one path: `search_notes` / `query_notes` → `read_notes`. On that path the
agent pulls the **full** bodies of every candidate note (typically ~5), even though the
only thing it needs to triage candidates is the title + frontmatter + a short snippet.
Full bodies are genuinely needed for the 1–2 notes that actually make it into the answer
or get edited — not for all five.

This recommendation surfaced in W17, W21, W23, and W24, escalating LOW → MED, but never
shipped. A `fields` parameter (`'frontmatter' | 'content'`) already exists, but it is an
all-or-nothing toggle on the body and the agent almost never reaches for it (W24: 1 call
out of 15). Conclusion from the analysis: the parameter alone does not solve the problem —
what is missing is (a) a _cheap_ body mode and (b) a prompt-level rule that makes it the
default on the triage hop.

## Decision chain

### Q1 — What is the unit of savings?

**Decision:** Cut the body payload on the _triage_ hop only, not everywhere. Keep full
bodies trivially available for the final read/edit. The waste is specifically "full bodies
of notes that were only being skimmed and then discarded."

### Q2 — What shape should the body control take?

This was the open fork. `read_notes` already exposes `fields: ['frontmatter','content']`,
and `content` is simultaneously (a) a member of that array and (b) the name of the output
field. A new top-level `content: 'full'|'preview'|'none'` parameter therefore overlaps the
existing knob and risks a confusing two-knobs-for-one-concept surface.

Three options were weighed:

- **A. Extend `fields`** with a `'preview'` member (`['frontmatter','preview']`). One knob,
  zero new contract surface, fully backward compatible — but diverges from the task's
  literal `content:` parameter name.
- **B. Add `content:` enum, keep `fields`.** Honors the task verbatim but leaves two
  overlapping body knobs that need precedence rules.
- **C. Make `content:` enum the sole body knob and retire `fields`.** Cleanest surface,
  matches the task's wording exactly, but is a breaking change (major version) and drops
  the rarely-used "body without frontmatter" shape.

**Decision: Option C.** The user confirmed backward compatibility is **not required**, which
removes C's only real downside. So: `content: 'full' | 'preview' | 'frontmatter'` becomes the
one body knob, `fields` is removed, frontmatter is always returned. (The value is named
`'frontmatter'`, not `'none'` — self-describing, since frontmatter is always returned.)

### Q2a — What is the default mode?

Reopened after the first pass. Three candidates: static `full` (no regression, but savings hinge
on the agent opting into `preview` — which W24 says it won't, 1/15), static `preview` (guaranteed
savings, but silently truncates single-note read→edit/cite — a footgun), or a **count-based
default**.

**Decision: count-based default.** When `content` is omitted, derive the mode from the number of
distinct requested paths: **one → `full`, two or more → `preview`**; an explicit `content` always
overrides. A single explicit path is a "give me this note" read (cite/edit) → stays full, no
regression — which answers the original task's worry about breaking standalone reads. Multiple
paths is the triage signature → defaults to preview, so the saving happens _without the agent
opting in_. Distinct-path count (post-dedup) is used, so repeating one path still reads full.

### Q3 — What does `preview` actually return?

**Decision:** frontmatter + a deterministic, bounded slice of the body — roughly the first
~500 characters, cut on a word/line boundary, with a truncation marker and a `truncated`
flag so the agent knows more body exists. Match-aware snippets (centering the slice on a
search hit) are deliberately deferred — `read_notes` is stateless and path-only; it never
sees the originating query, and snippet-around-match is the separate W23 `search_notes`
idea, explicitly out of scope here.

### Q4 — How does `preview` become the _default_ on triage, given the param alone didn't work?

**Decision:** Primarily through the count-based default (Q2a) — multi-note reads are preview
out of the box, so the saving does not depend on the agent opting in (the lesson of W17–W24).
The behavioral guidance then plays a supporting role: ship it through the channels the
_consuming_ agent actually reads — the `read_notes` tool description and `docs/guide/routing.md`
(which already carries the canonical `search_notes → read_notes` example) — to make the
truncation legible and tell the agent to re-read `content: 'full'` before citing/editing. The
task named "AGENTS.md"; we read that as "agent-facing guidance" and place it where it reaches
the model.

### Q5 — How do we know it worked?

**Decision:** The next weekly usage report should show `read_notes` average payload falling
from ~14 KB toward ~6–8 KB at a comparable session count. If it doesn't move, the rule isn't
reaching the agent (the same "ToolSearch tax" failure mode) — that's a signal to relocate the
guidance, not a guess.

## Agreed approach

1. **Tool surface:** Replace `read_notes`' `fields` parameter with
   `content: 'full' | 'preview' | 'frontmatter'`. Frontmatter is always returned. Default is
   count-based: one distinct path → `full`, two or more → `preview`; explicit `content` overrides.
   - `full` → full body.
   - `preview` → frontmatter + bounded body slice + `truncated` flag.
   - `frontmatter` → frontmatter only (replaces `fields: ['frontmatter']`).
     Breaking change → major version bump (10.x → 11.0.0). `fields` is removed; if passed, it is
     silently ignored (non-strict schema).
2. **Truncation:** a small pure helper that takes the full body and returns
   `{ content, truncated }`, capped near 500 chars on a boundary, marker appended when cut.
   Computed in the `read_notes` handler; the underlying reader is untouched (still `fields`-based
   internally, used by `query_notes` and the wikilink graph).
3. **Guidance:** triage-preview rule in the `read_notes` description and `docs/guide/routing.md`;
   refresh `README.md` and `docs/guide/vault-operations.md`.
4. **Verification:** `npm test`, `npm run lint`, `npx tsc --noEmit` all green; new tests cover
   the preview helper and all three `content` modes; weekly-payload metric tracked post-merge.

## Out of scope

- Globally defaulting `read_notes` to frontmatter-only — that breaks standalone reads for
  citation/editing. The saving is taken on triage only.
- Snippet/match-aware semantics in `search_notes` (the larger W23 idea) — separate task.
