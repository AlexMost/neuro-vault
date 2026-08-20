<!--
Raw capture of superpowers:brainstorming output.
Conducted verbally in-chat over an external field report (2026-08-20), then
re-verified against source before promotion. Source task: vault note
"Tasks/neuro-vault/for-external-agents крізь ліміт 2048 — реордер instructions
і канал через overview".
Three remaining open questions were closed by explicit user decisions at
promotion time (Q4-Q6 below).
-->

# Brainstorm — vault-conventions-delivery

## Background

`.neuro-vault/for-external-agents.md` is the vault owner's channel for telling
an external agent how *this particular* vault is organised — the note-type
vocabulary, the project-scoping convention, folder semantics. It is the one
piece of information the client cannot derive from anywhere else: tool
descriptions describe the *server*, the vault file describes the *vault*.

The feature does not work at all in Claude Code. The client injects MCP
`instructions` into the system prompt but truncates them at exactly 2048
characters, and the vault-specific block is appended **last** — so it never
physically arrives.

## Diagnosis (external report, Claude Code 2.1.236 + local reproduction)

- The cap is **exactly 2048 characters, not bytes**. The reporter measured with
  two "ruler" servers, one emitting 3-byte characters; both cut at the same
  character index, different byte offsets.
- `buildServerInstructions` (`src/server.ts:140`) composes, in order:
  `STATIC_SERVER_INSTRUCTIONS` → `GET_VAULT_OVERVIEW_HINT` → multi-vault
  section → per-vault blocks. Only the first survives, and only partly.
- **Sub-agents receive no instructions at all** — not truncated, none
  (reporter verified on `general-purpose` and `Explore` with a control: the
  tool is visible, the instructions section is absent). The only channels that
  arrive intact everywhere are **tool descriptions** and **tool responses**.

### Code verification (2026-08-20, this session)

- `STATIC_SERVER_INSTRUCTIONS` measures **10,803 characters** — 5.3× the cap.
  The 2048-character slice ends mid-sentence inside `## Role`, at "…they exist
  so frontmatter and". Fifteen headings; fourteen never render.
- Vault blocks start past ~11k. Dead at any vault-file size, confirming the
  report's core claim rather than merely a "large file" problem.
- The preamble substantially **duplicates the tool descriptions**: the
  `query_notes` section restates the operator list, result shape, and `limit`
  semantics already in that tool's own `description`; the multi-vault section
  restates what `describeMultiVault` (`src/lib/vault-param.ts:31`) already
  appends to all 12 multi-vault-aware tool descriptions.

## Decision chain

**Q1 — Fight the truncation, or route around it?**
Both. The 2048 cap and the missing sub-agent instructions are Claude Code
behavior, not ours; we cannot fix them, and other clients (Cursor, Windsurf)
may cap differently or not at all. So: repair the main channel cheaply
*and* add a channel with no cap.

**Q2 — How to repair the instructions channel? → B: reorder + diet.**
Vault-specific blocks move **first** (the only information the client cannot
obtain elsewhere), followed by a condensed preamble of ~600–800 characters
carrying only what tool descriptions do *not* say: the "second brain" role, the
operations-vs-semantic routing heuristic, and the project-scope discovery
order. Sections that restate tool descriptions, and the multi-vault section,
are removed. A typical ~1200-character vault block plus a ~700-character
preamble fits inside 2048 with room to spare.

Rejected: keeping the preamble first and merely trimming it — the ordering is
the actual defect; a diet alone still puts the vault block behind a variable
amount of prose, so the fix would silently regress the next time the preamble
grows.

**Q3 — What is the uncapped channel? → C: `get_vault_overview`.**
A new response field carrying the raw contents of `for-external-agents.md`,
plus one sentence in the tool's `description` ("the response carries the vault
owner's conventions — follow them"). Descriptions arrive complete everywhere,
including sub-agents, and this tool is already positioned as "call once at the
start of a session". Bonus: instructions are composed once at server startup,
while a tool response reads the file at call time — editing conventions is
picked up without restarting the MCP server.

Rejected: a `vault://guide` resource mirroring `vault://overview` — Claude Code
does not auto-fetch resources, so it would carry the same "never arrives"
defect in a new place.

B is the belt, C the suspenders: B repairs the main path for cheap, C is
uncapped and the only one that reaches sub-agents.

**Q4 — Field name? → `conventions`.**
Matches the existing `## Vault-specific conventions` heading in the
instructions and the docs. `agent_instructions` was rejected as colliding with
MCP `instructions`, the very channel being repaired here.

**Q5 — Does `vault://overview` carry the field too? → yes, automatically.**
The field is added at the `computeVaultOverview` level, so the resource
(a thin adapter over the same compute, `src/modules/operations/resources/vault-overview.ts`)
inherits it and the two surfaces keep one shape — the "one compute, two
surfaces" symmetry the tool was built with.

**Q6 — Cap the field's size? → soft cap plus a flag.**
The response has no 2048 problem, but an unbounded field would let one oversized
vault file inflate every session start. Bounded slice plus a `truncated` boolean
is already this codebase's idiom (`previewBody`, `src/modules/operations/preview-body.ts`),
so reuse the shape at a much larger cap rather than inventing a new one.
Truncation must stay visible, never silent.

## Design trade-offs

- **Losing preamble content.** The diet deletes real guidance (per-tool usage
  notes, the `search_notes` query-writing recipe). This is acceptable *only*
  because that content already lives in the tool descriptions, which arrive in
  full. Anything cut must be checked against a description first — if it is not
  there, it moves there rather than being deleted.
- **Contract change.** A new field in `get_vault_overview` output is a tool
  contract change → opsx change, not a direct PR (`.claude/rules/opsx-routing.md`).
- **Doc drift.** The feature's promise changes from "injected into instructions"
  to "every agent that calls the overview sees them", so `docs/` must be swept
  whole, including the model-facing guide layer, not just architecture files.

## Out of scope

- The 2048 cap itself and the absent sub-agent instructions — Claude Code
  behavior; at most an upstream issue.
- Cursor / Windsurf verification — untested; the design does not rely on
  instructions, so it degrades no worse there.
- Missing GitHub Releases for tags v4–v15.1 (same report's postscript) —
  a tooling fix, tracked separately as a direct PR.
