## Context

`<vaultPath>/.neuro-vault/for-external-agents.md` is the vault owner's channel
for describing *their* vault to an external agent — note-type vocabulary,
project-scoping convention, folder semantics. Nothing else can carry it: tool
descriptions describe the server, not the vault.

Today it is composed into the MCP `instructions` string by
`buildServerInstructions` (`src/server.ts:140`) as the **last** layer, behind
`STATIC_SERVER_INSTRUCTIONS` (measured: **10,803 characters**), the overview
hint, and the multi-vault section. Claude Code truncates `instructions` at
**exactly 2048 characters** (characters, not bytes — verified by an external
report with two ruler servers, one emitting 3-byte characters, both cut at the
same character index). The surviving slice ends mid-sentence inside `## Role`.
The vault block begins past ~11k and is therefore unreachable at any file size.

Two further constraints from the same report:

- **Sub-agents receive no `instructions` at all** — not truncated, absent
  (verified on `general-purpose` and `Explore` against a control).
- The only channels that arrive intact everywhere are **tool descriptions** and
  **tool responses**.

Both are Claude Code behaviors we do not control. Cursor and Windsurf are
untested and may cap differently or not at all.

Relevant current state: `get_vault_overview` and the `vault://overview`
resource are two thin adapters over one `computeVaultOverview`
(`src/lib/obsidian/vault-overview.ts`); in multi-vault mode the tool fans out
via `runFanOut` and the resource is registered once per vault at
`vault://<vault-name>/overview`. `readExternalAgentInstructions`
(`src/server.ts:31`) is currently private to the startup path.

## Goals / Non-Goals

**Goals:**

- A typical vault conventions block survives the 2048-character truncation
  intact, together with a usable preamble.
- A delivery channel that is not size-capped and that reaches sub-agents.
- Conventions edits take effect without restarting the MCP server.
- One reader for the file, shared by both channels — no second definition of
  "where conventions live" or "what counts as empty".
- `docs/` states the new promise, including the model-facing guide layer.

**Non-Goals:**

- Fixing or working around the 2048 cap itself, or the missing sub-agent
  instructions — client behavior; at most an upstream issue.
- Verifying Cursor / Windsurf. The design does not depend on `instructions`,
  so it cannot degrade further there.
- Any change to the semantic module, the fan-out contract, or error codes.
- Missing GitHub Releases for tags v4–v15.1 (same report's postscript) —
  separate tooling fix, direct PR.

## Decisions

### D1: Repair the instructions channel *and* add an uncapped one

- **Choice:** ship both — reorder plus diet the `instructions` (belt), and add
  a `conventions` field to the `get_vault_overview` response (suspenders).
- **Rationale:** the reorder is cheap and fixes the main path for every client
  including ones with no cap; only the response channel is uncapped and reaches
  sub-agents. Either alone leaves a real population unserved.
- **Alternatives considered:** *instructions only* — leaves sub-agents with
  nothing and stays hostage to the next preamble growth. *Response only* —
  abandons the channel for clients that render `instructions` fully, for no
  saving, since the reorder is a few lines.

### D2: Vault blocks first, preamble second

- **Choice:** `buildServerInstructions` emits per-vault conventions blocks
  first, then a condensed preamble.
- **Rationale:** ordering *is* the defect. The vault block is the only content
  the client cannot obtain from tool descriptions, so it must occupy the part
  of the string that always survives.
- **Alternative considered:** keep the preamble first and merely shrink it —
  rejected: it leaves the vault block behind a variable amount of prose, so the
  fix silently regresses the next time the preamble grows.

### D3: Preamble diet to ~600–800 characters, scoped by "is it already in a description?"

- **Choice:** keep only the "second brain" role, the operations-vs-semantic
  routing heuristic, and the project-scope discovery order. Delete the per-tool
  sections and the `## Multi-vault mode` section.
- **Rationale:** those sections restate content that already arrives in full —
  the `query_notes` section repeats that tool's operator list, result shape and
  `limit` semantics; the multi-vault section repeats what `describeMultiVault`
  (`src/lib/vault-param.ts:31`) already appends to every multi-vault-aware
  description. Duplication that never renders costs the vault block its space.
- **Guard:** deletion is only legitimate where a tool description already
  carries the content. Anything cut without such a home **moves into the
  relevant description** instead — descriptions are the channel that works.
- **Alternative considered:** a hard character budget enforced in code
  (throw at startup if the preamble exceeds N) — rejected as over-engineering
  for a constant; a test asserting the 2048 budget covers it.

### D4: `conventions` (and `conventions_truncated`) on the overview payload

- **Choice:** field name `conventions`; truncation flag `conventions_truncated`.
- **Rationale:** `conventions` matches the existing `## Vault-specific
  conventions` heading in the instructions and the docs, so one word names the
  thing across all surfaces. These are **response fields, not parameters**, so
  the MCP parameter dictionary (ADR-0005) does not bind them — but the same
  one-concept-one-name discipline is what picks the name.
- **Alternatives considered:** `agent_instructions` — collides with MCP
  `instructions`, the channel being repaired here. `vault_conventions` —
  redundant beside the `vault: "<name>"` key already present on every
  fan-out entry.

### D5: Field added at the compute layer, not per-adapter

- **Choice:** `computeVaultOverview` produces `conventions`; the tool and the
  resource inherit it.
- **Rationale:** preserves the "one compute, two surfaces" symmetry the tool
  was built with, and keeps a single shape to document. In multi-vault mode
  each `results_by_vault` entry and each per-vault resource carries its own,
  with no extra wiring, because both already iterate entries.
- **Alternative considered:** add it in the tool handler only — cheaper by one
  parameter, but forks the two surfaces' shapes and needs a doc caveat.

### D6: One shared reader, injected per vault entry

- **Choice:** move `readExternalAgentInstructions` out of `src/server.ts` into
  a shared `src/lib/obsidian/` module (working name `vault-conventions.ts`),
  and expose it on `IVaultEntry` as `readConventions(): Promise<string | null>`,
  built by a factory in `IVaultEntryDeps` like every other per-entry
  dependency. `computeVaultOverview` takes it as a dep; `buildServerInstructions`
  calls the same one.
- **Rationale:** both channels then agree by construction on the path, the
  trim, and what "absent" means. Injection keeps `computeVaultOverview` free of
  direct `fs` access, matching its existing all-injected deps and letting tests
  stub the file without touching disk.
- **Alternative considered:** pass `vaultPath: string` into
  `computeVaultOverview` and read there — fewer moving parts, but puts `fs` in
  a function whose whole design is injected I/O, and every test would need a
  real temp directory.

### D7: Read at call time; no caching

- **Choice:** the file is read on each overview call.
- **Rationale:** this is the feature's second selling point — editing
  conventions is picked up without an MCP restart, which the startup-composed
  `instructions` can never offer. `get_vault_overview` is a once-per-session
  call, so the cost is one small read against a compute that already scans the
  vault.
- **Alternative considered:** cache with an mtime check — measurable
  complexity for no measurable gain at this call frequency.

### D8: Soft size cap with a visible flag

- **Choice:** bounded slice at a cap constant (proposed **8,000 characters**)
  plus `conventions_truncated: true` when it bites; the flag is absent
  otherwise, as is `conventions` itself when the file is missing or empty.
- **Rationale:** the response has no 2048 problem, but an unbounded field lets
  one oversized file inflate every session start. Bounded-slice-plus-flag is
  already this codebase's idiom (`previewBody`,
  `src/modules/operations/preview-body.ts`, cap 500) — reuse the shape at a
  much larger cap rather than invent a second one. 8,000 leaves headroom over a
  real conventions file (measured: 6,755 characters — see the cap note below), and
  when it happens it is visible rather than silent.
- **Alternative considered:** no cap at all (the source task's lean) —
  rejected on the user's call at promotion time; unbounded owner-authored text
  on a hot path is the same class of problem this change exists to fix.

### D9: Description sentence is part of the contract

- **Choice:** add one sentence to `get_vault_overview`'s description saying the
  response carries the vault owner's conventions and that they are to be
  followed.
- **Rationale:** the field is inert if the model does not know it is
  authoritative rather than decorative, and the description is the only channel
  guaranteed to reach every agent, sub-agents included. This is why D1's
  "suspenders" actually holds.

### D10: Documentation

- **Choice:** a new `docs/architecture/vault-conventions.md` owning the whole
  concept (file location, both channels, ordering, budget, freshness,
  truncation), with `docs/architecture/mcp-server-shape.md`'s instructions
  layering reduced to a pointer, plus a sweep of the model-facing guide layer.
- **Rationale:** ADR-0008 — a reader must understand one concept by reading one
  file. Today the concept is split across `mcp-server-shape.md` §3–4 and
  whatever the guide says; after this change the promise itself is different
  ("every agent that calls the overview sees them"), so a stale sentence is an
  active lie. Architecture-scoped greps have previously missed the guide layer,
  so the sweep is explicitly whole-`docs/`.

### D11: Record the delivery-channel principle as an ADR

- **Choice:** write `docs/adr/0010-context-delivery-channels.md` in this change
  — *tool descriptions and tool responses are the only channels that reach an
  external agent intact; context that must arrive belongs there, and MCP
  `instructions` is best-effort.*
- **Rationale:** the principle outlives this change and will govern the next
  context-delivery work (the `Startup baseline context skill` task hits the same
  wall). Per ADR-0008's split, `docs/adr/` owns WHY and is immutable, while
  design.md is scoped to one change and stops being read once archived.
- **Alternative considered:** leave it in design.md plus the architecture doc —
  rejected: the architecture file records *how this vault's conventions travel*,
  not *why we stopped trusting `instructions`*, and the next task would have to
  rediscover the reasoning from an archived change.

## Risks / Trade-offs

- **[Risk] The diet deletes guidance that has no home in a tool description.**
  → Mitigation: D3's guard — each deleted section is checked against the
  relevant description before removal, and moves there if absent. The
  `search_notes` query-writing recipe is the most likely case to need moving,
  not deleting.
- **[Risk] The 2048 budget silently regresses as the preamble grows again.**
  → Mitigation: a test asserts that a representative ~1,200-character vault
  block appears *complete* within the first 2048 characters of the composed
  output — the regression fails CI rather than shipping.
- **[Risk] A per-call file read on a fan-out multiplies by vault count.**
  → Mitigation: reads are small, parallel with the existing per-vault compute,
  and bounded by `runFanOut`'s existing concurrency; the overview already scans
  every note per vault, which dominates.
- **[Risk] Unreadable / permission-denied conventions file breaks the overview.**
  → Mitigation: the shared reader keeps today's swallow-and-return-`null`
  behavior. The overview must never fail because of an optional file.
- **[Trade-off] `conventions` inflates every overview response by up to 8 KB.**
  → Accepted: that is the payload's whole purpose, it is a once-per-session
  call, and the cap plus flag bounds the worst case visibly.
- **[Trade-off] `IVaultEntry` grows a member for a single feature.**
  → Accepted: it is the seam that makes both channels share one reader (D6),
  and it matches how every other per-entry capability is wired.
- **[Trade-off] Two channels now carry the same text; a client with no cap
  sees it twice.** → Accepted: duplication in a working channel is cheap;
  absence in the only channel that reaches sub-agents is not.

## Migration Plan

Additive and non-breaking; no deployment steps beyond the normal release.

- **Order:** shared reader + `IVaultEntry` seam (D6) → compute-layer field and
  cap (D5, D8) → tool description sentence (D9) → instructions reorder and diet
  (D2, D3) → docs sweep (D10). The reader must land first; the instructions
  work is last because it is the only step that deletes prose and therefore the
  one most worth reviewing against finished behavior.
- **Compatibility:** clients that ignore unknown response fields are
  unaffected; `conventions` is absent when no file exists, so today's payload
  is byte-identical for vaults without the feature. `instructions` is advisory
  text with no contract, so reordering it breaks nothing.
- **Acceptance:** the first 2048 characters of composed instructions contain a
  representative vault block in full plus the complete preamble;
  `get_vault_overview` returns `conventions` matching the file, per vault in
  fan-out, absent when the file is missing or empty, flagged when trimmed;
  an edit between two calls is visible with no restart; `npm test`,
  `npm run lint`, `npm run typecheck` green.
- **Rollback:** revert the commit. No persisted state, no migration, no
  config flag to unwind.

## Open Questions

- **Cap value — RESOLVED at implementation, 2026-08-20.** The "roughly 6×
  headroom" estimate above was wrong. Measured against the vault actually in
  use, `for-external-agents.md` is **6,755 characters — 84% of the cap**, not a
  sixth of it. Raising the cap to 16,000 was offered and **declined**: the cap
  stays at 8,000 and now functions as deliberate back-pressure toward compact
  conventions rather than as slack. Two consequences follow. First, this file is
  one section away from truncating, so the `conventions_truncated` flag is a
  live signal, not a theoretical one — the visible-truncation requirement is
  load-bearing. Second, the docs should tell vault owners the budget is ~8,000
  characters and that exceeding it trims rather than fails.
- **Preamble final wording.** The ~600–800-character target is a budget, not a
  draft; the exact text lands during apply, and D3's guard decides what moves
  into descriptions rather than being deleted.
