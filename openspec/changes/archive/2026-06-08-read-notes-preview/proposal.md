## Why

`read_notes` is the server's heaviest knowledge tool — ~12–15 KB per call, peak ~33 KB —
six weekly reports running. The cost concentrates on the `search/query → read_notes` triage
path, where the agent pulls **full** bodies of ~5 candidate notes just to skim and discard
most of them; full bodies are only needed for the 1–2 notes that reach the answer. The
existing `fields` toggle is all-or-nothing and effectively unused (W24: 1/15 calls). A cheap
body mode plus a rule that makes it the triage default is the lever this needs. Doing it now
collapses the single biggest recurring context cost without touching the common read path.

## What Changes

**`read_notes` body control**

- From: `fields: ('frontmatter' | 'content')[]` — an all-or-nothing toggle on the body.
- To: `content: 'full' | 'preview' | 'frontmatter'`; frontmatter always returned. `preview`
  returns a bounded body slice (~500 chars, cut on a boundary) plus a `truncated` flag;
  `frontmatter` returns frontmatter only.
- Default: derived from the distinct-path count — **one path → `full`, two or more → `preview`**;
  an explicit `content` always overrides.
- Reason: put the cheap body mode where the waste is (the multi-note triage hop) _by default_,
  without depending on the agent opting in, while single-note reads stay full for citation/editing.
- Impact: **Breaking** (major version 10.x → 11.0.0). The `fields` parameter is removed and the
  default output for multi-note reads changes from full to preview; the rarely-used "body without
  frontmatter" shape goes away. Backward compatibility was confirmed not required. Single-note
  reads do not regress (still `full`).

**Triage-preview guidance**

- From: no guidance on body cost across the `search/query → read_notes` hop.
- To: the `read_notes` description and `docs/guide/routing.md` explain that multi-note reads default
  to `preview` (truncated, `truncated: true`) and instruct the agent to re-read a note with
  `content: 'full'` before citing or editing it.
- Reason: the default does the saving automatically; the guidance makes the truncation legible and
  tells the agent when to force `full`.
- Impact: non-breaking; behavioural guidance, not enforcement.

## Capabilities

### New Capabilities

- `read-notes-content-modes`: `read_notes` returns note bodies at a caller-selected
  granularity (`full` / `preview` / `frontmatter`) with frontmatter always present, a
  distinct-path-count default (one → full, many → preview), deterministic bounded preview
  truncation, and a `truncated` signal.

### Modified Capabilities

<!-- None. The existing `baseline` capability is unaffected; this introduces a new capability. -->

## Impact

- **Code:** `src/modules/operations/tools/read-notes.ts` (input schema, description, handler
  projection), `src/modules/operations/tool-helpers.ts` (`validateReadNotesInput`), and
  `src/modules/operations/types.ts` (`ReadNotesToolInput`, `ReadNotesResultItemSuccess`). A new
  pure preview-truncation helper. The underlying `VaultReader` (`fields`-based, used by
  `query_notes` and the wikilink graph) is **unchanged**.
- **Tests:** `test/operations/tools/read-notes.test.ts` rewritten for `content`; new helper
  tests; any other call-sites referencing the removed `fields` param updated.
- **Docs:** `README.md`, `docs/guide/vault-operations.md`, `docs/guide/routing.md`; a note in
  `docs/architecture/mcp-parameter-dictionary.md` that `content` is a `read_notes`-local body
  selector (not a shared dictionary concept).
- **Contract / release:** breaking → major version 11.0.0.
- **Metric:** next weekly usage report — `read_notes` average payload ~14 KB → ~6–8 KB at a
  comparable session count.
