## Context

`read_notes` reads one or more notes from disk in a single MCP round-trip. Today it exposes
`fields: ('frontmatter' | 'content')[]` (default both) and projects each item to the requested
fields. The handler calls `entry.reader.readNotes({ paths, fields })`; the reader returns full
frontmatter + content, and the handler slices.

Six consecutive weekly usage reports (W17→W24, `Inbox/neuro-vault-usage/`) flag `read_notes` as
the heaviest knowledge tool: ~12–15 KB/call, peak ~33 KB. The cost is structural, not incidental
— on the `search_notes`/`query_notes` → `read_notes` path the agent reads the **full** body of
every candidate (~5) to triage them, then keeps only 1–2. The `fields` toggle could mitigate this
but is effectively unused (W24: 1/15 calls), because it is all-or-nothing and there is no rule
telling the agent to reach for it.

Constraints that shaped the design:

- **Parameter dictionary (ADR-0005):** one concept = one parameter name; renames/removals are
  breaking and cost a major version, and must be surfaced explicitly.
- **The reader is shared:** `VaultReader.readNotes({ fields })` is also called by `query_notes`
  (`src/lib/obsidian/query/query-notes.ts`) and the wikilink graph. Its `fields` mechanism must
  stay intact — only the `read_notes` _tool surface_ changes.
- **No regression on the common path:** standalone single-note reads (for citation/editing) must
  keep returning full bodies by default.

Stakeholders: the consuming AI agent (primary — pays the context cost), and contributors who
maintain the tool contract.

## Goals / Non-Goals

**Goals:**

- Make the cheap body mode the _default on the triage hop_ — without the agent having to opt in —
  while keeping single-note reads full.
- Make `preview` deterministic and bounded so it is testable and predictable.
- Signal incompleteness unmistakably (a `truncated` flag + marker) so the agent re-reads `full`
  before citing/editing.
- Reduce `read_notes` average payload from ~14 KB toward ~6–8 KB (next weekly report).

**Non-Goals:**

- Backward compatibility with `fields` (confirmed not required).
- Match-aware / snippet-around-hit previews — `read_notes` is stateless and never sees the
  originating query; this is the separate W23 `search_notes` idea.
- Truncating single-note reads by default (the read→edit / read→cite path stays `full`).
- Touching the shared `VaultReader.readNotes` contract.

## Decisions

### D1: Replace `fields` with `content: 'full' | 'preview' | 'frontmatter'`

- **Choice:** Remove the `fields` array from the `read_notes` tool surface; add a single
  `content` enum with values `'full'`, `'preview'`, `'frontmatter'`. Frontmatter is always
  returned. `'frontmatter'` replaces `fields: ['frontmatter']`; the "body without frontmatter"
  shape (`fields: ['content']`) is dropped.
- **Rationale:** The task asked for a `content:` enum; keeping `fields` alongside it would leave
  two overlapping body knobs (and `content` already named both a `fields` member and the output
  field). With backward compatibility waived, one knob is the cleanest surface. `'frontmatter'`
  is self-describing where the earlier `'none'` was misleading (frontmatter is still returned).
- **Alternatives considered:**
  - _Extend `fields` with a `'preview'` member_ — one knob, fully backward compatible, but
    diverges from the task's parameter name and keeps an array where an enum is clearer.
  - _Add `content:` and keep `fields`_ — honors the task but needs precedence rules between two
    body knobs; rejected as confusing.
  - _Value name `'none'`_ — rejected; misleading, since frontmatter is always returned.
- **Contract impact:** breaking → major version **10.1.0 → 11.0.0**. `fields` is removed; because
  the input schema is non-strict (`z.object` without `.strict()`), a stray `fields` key is
  silently ignored rather than erroring. Surfaced per ADR-0005.

### D1a: The default body mode is derived from the distinct-path count

- **Choice:** When `content` is omitted, the effective mode is computed from the number of
  **distinct** requested paths (after the handler's existing de-duplication): exactly one →
  `'full'`; two or more → `'preview'`. An explicit `content` value always overrides this. Because
  the default depends on input, the Zod schema keeps `content` optional with no static default;
  the handler resolves `effectiveContent = input.content ?? (dedupedPaths.length === 1 ? 'full' :
'preview')`.
- **Rationale:** This aligns the default with intent and resolves the original task's worry that a
  blanket default change "breaks standalone reads for citation/editing." A single explicit path is
  a "give me this note" read (likely to cite or edit) → it stays `full`, no regression. Multiple
  paths is the triage signature (`search`/`query` hands the agent ~5 candidates) → it defaults to
  `preview`, capturing the savings _without depending on the agent opting in_ — which the W24 data
  (the `fields` knob used 1/15) says it won't.
- **Alternatives considered:**
  - _Static default `full`_ — no regression, but the savings hinge on guidance reaching the agent;
    that is exactly the failure mode that kept W17–W24 from shipping.
  - _Static default `preview`_ — guarantees savings but silently truncates single-note read→edit /
    read→cite reads; rejected as a correctness footgun.
- **Trade-off:** the default is mildly "magic" (behaviour keyed on argument shape). Accepted: it is
  one sentence to document, and it puts the cheap mode exactly where the waste is. Distinct-path
  count (not raw count) is used so repeating one path still reads `full`.

### D2: `preview` = frontmatter + a bounded, boundary-cut body slice + `truncated` flag

- **Choice:** A pure helper `previewBody(body: string): { content: string; truncated: boolean }`.
  If `body.length <= PREVIEW_CHAR_CAP` (≈500), return the body unchanged with `truncated: false`.
  Otherwise cut at the last whitespace/newline at or before the cap (hard-cut if none), append a
  single-character marker (`…`), and return `truncated: true`. Preview items carry an extra
  `truncated` boolean on the result item.
- **Rationale:** Deterministic and boundary-respecting → predictable for the agent and trivially
  unit-testable (failing test → impl → refactor). The `truncated` flag tells the agent "more body
  exists, re-read with `content: 'full'` if you need it." ~500 chars matches the "~300–500 chars"
  target from the usage analysis and is enough to triage.
- **Alternatives considered:**
  - _Heading-aware slicing_ (first heading section) — nicer in theory but fiddly and
    format-dependent; the char cap already captures the lead. Left as a possible future refinement.
  - _No `truncated` flag_ — cheaper output but the agent can't distinguish a short note from a cut
    one; rejected.

### D3: Truncation lives in the handler; the reader is untouched

- **Choice:** Resolve the effective mode (D1a) first, then compute preview in the `read_notes`
  handler's projection step. Map the effective mode to the reader call: `'frontmatter'` →
  `reader.readNotes({ fields: ['frontmatter'] })` (skip the body read); `'full'`/`'preview'` →
  `reader.readNotes({ fields: ['frontmatter','content'] })`, then truncate in the handler for
  `'preview'`.
- **Rationale:** Keeps the breaking change localized to one tool. The shared `VaultReader` (and its
  `query_notes` / wikilink-graph callers) keep their `fields` contract. The handler already owns
  projection, so this is the natural seam.
- **Alternatives considered:** push preview into the reader — rejected; it would leak a
  tool-specific concern into shared infrastructure and ripple to unrelated callers.

### D4: Triage-preview guidance ships where the consuming agent reads it

- **Choice:** Put the rule in the `read_notes` tool description and in `docs/guide/routing.md`
  (which already carries the canonical `search_notes → read_notes` example), plus refresh
  `README.md` and `docs/guide/vault-operations.md`. The task named "AGENTS.md"; we interpret that
  as "agent-facing guidance" and place it in the channels the model actually consumes (this repo's
  `AGENTS.md` is contributor-facing).
- **Rationale:** The prior analysis showed the parameter alone never shifted behaviour; the rule has
  to reach the model. The tool description is the most reliable channel; the routing guide is the
  conceptual home for the search→read path.
- **Rule text (intent):** "Multi-note reads (the `search_notes`/`query_notes` → `read_notes` triage
  hop) default to `content: 'preview'` — bodies are truncated and carry `truncated: true`. Re-read a
  note with `content: 'full'` before you cite or edit it. Single-note reads default to `full`."
- **Note:** the count-based default (D1a) already makes triage cheap without the agent opting in; the
  guidance exists to (a) make the truncation legible and (b) tell the agent to force `full` before
  acting on a previewed note.

### D5: No new ADR; update the parameter-dictionary doc

- **Choice:** Do not open a new `docs/adr/` entry. Add a one-line note to
  `docs/architecture/mcp-parameter-dictionary.md` recording that `content` is a `read_notes`-local
  body-granularity selector (not a shared cross-tool concept), and that removing `fields` is the
  breaking change this dictionary's rules anticipate.
- **Rationale:** This is an _application_ of ADR-0005 (the dictionary), not a new architectural
  decision. Per the design rule, an ADR is proposed only for load-bearing new decisions; this is a
  parameter change governed by an existing ADR. (Flagged for user confirmation in Open Questions.)

## Risks / Trade-offs

- [Risk] The agent edits or cites a note from a `preview` body without re-reading `full`, acting on
  truncated content → **Mitigation:** `truncated: true` + the visible marker make incompleteness
  machine- and human-legible; the tool description and routing guide mandate a `full` re-read before
  citing/editing. This is the main hazard introduced by defaulting batch reads to preview.
- [Risk] The count-based default surprises a caller who passes multiple paths expecting full bodies →
  **Mitigation:** documented in one sentence in the description; `content: 'full'` forces full for a
  batch. The weekly-payload metric confirms the default is doing its job.
- [Risk] Truncating mid-structure (e.g., inside a code fence or table) yields odd-looking preview
  text → **Mitigation:** acceptable for triage; boundary-cut + marker keeps it readable, and the
  `truncated` flag signals incompleteness. Heading/structure-aware slicing is a noted future refinement.
- [Trade-off] Dropping `fields: ['content']` (body without frontmatter) removes a capability.
  → **Accepted:** frontmatter is tiny, the shape was rarely used, and always returning it simplifies
  the contract.
- [Trade-off] The default is keyed on argument shape (distinct-path count) — mild "magic".
  → **Accepted:** it aligns the default with intent (single = cite/edit → full; batch = triage →
  preview) and is the only option that guarantees the saving without risking single-note reads.
- [Trade-off] A major version bump for a single-tool change. → **Accepted:** removing a public
  parameter and changing default output is breaking; the user waived backward compatibility.

## Migration Plan

1. Land the change behind a normal PR to `main`; merge.
2. `npm run release` on `main` → major bump to **11.0.0** (Conventional Commits; the breaking change
   is recorded with a `!`/`BREAKING CHANGE:` footer).
3. Consumers passing `fields` see it silently ignored and get the count-based default (single-path
   reads stay `full`; multi-path reads become `preview`) — no error, no crash; they adopt `content`
   at their own pace.
4. **Rollback:** revert the PR; no data/schema migration is involved (pure tool-surface change).
5. **Acceptance:** `npm test` + `npm run lint` + `npx tsc --noEmit` all green pre-merge; weekly
   `read_notes` payload tracked post-merge as the behavioural acceptance signal.

## Open Questions

- Confirm with the user that **no** `docs/adr/` entry is wanted (D5 treats this as an application of
  ADR-0005, not a new decision). Default: no new ADR.
- Exact `PREVIEW_CHAR_CAP` value (currently ~500) — tune during apply if 300 vs 500 reads better in
  practice; not contract-critical.
- Marker character (`…` vs `[…]` / `\n…`) — cosmetic; settle during apply.
