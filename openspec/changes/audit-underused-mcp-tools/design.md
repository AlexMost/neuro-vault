## Context

`neuro-vault-mcp` exposes 16 tools across two modules: `operations/` (12: note body, structured
query, frontmatter properties, tags, overview) and `semantic/` (4: search, similar, duplicates,
stats). The weekly tool-usage reports (`Inbox/neuro-vault-usage/`) track which tools the consuming
agent actually calls. W23 and W24 agreed on six low-signal tools: `find_duplicates`,
`get_note_links`, `list_properties`, `remove_property` (zero calls, both weeks) and `get_stats`,
`read_property` (rare, pointwise).

The cost of a rarely-used tool is real but bounded: it enlarges the schema set ToolSearch scans and
keeps surfacing in `unusedTools`. The hazard is over-correcting — deleting a tool that is unused yet
**unique**, losing a capability with no replacement. So the task's governing rule is *remove only
what is genuinely covered*; keep the unique ones (with a "when to reach for it" nudge so they stop
reading as dead).

Constraints that shaped the audit and the change:
- **Breaking-contract discipline (ADR-0005 spirit):** a tool vanishing from the surface is a breaking
  change → major version bump, surfaced explicitly.
- **Module separation:** `operations/` works without the embedding corpus; `semantic/` requires it.
  A capability that depends on the corpus cannot move into an operations tool.
- **Frozen history:** `docs/superpowers/specs/` + `plans/` are the pre-OpenSpec record — never edited.
  Only *live* docs (guides, architecture, README, AGENTS) and the parameter dictionary are updated.
- **Verification before verdict:** every remove/merge verdict must show, on a real example, that the
  covering tool returns the same result — or, where it doesn't, say so plainly.

Stakeholders: the consuming AI agent (pays the surface cost, loses the dropped affordances) and the
maintainer (owns the contract and the version bump).

## Goals / Non-Goals

**Goals:**
- A defensible verdict for each of the six candidates, with the live verification attached.
- Shrink the tool surface by removing the tools the audit (and the user) cleared for removal.
- Preserve every *unique* capability; make the kept-but-rare tools legibly intentional via `AGENTS.md`.
- Leave the contract and docs internally consistent: no live doc or dictionary row points at a removed
  tool; tool counts are corrected.

**Non-Goals:**
- Backward compatibility for the removed tools (a major bump is accepted).
- Changing any *kept* tool's behaviour — including `get_vault_overview` (the top-30 property cap stays;
  the user chose to remove `list_properties` outright rather than lift the cap).
- Re-specifying `get_similar_notes`, `search_notes`, `query_notes`, etc. — in scope only as overlap
  hypotheses, all of which the audit rejected.
- The sibling MCP cleanups (`read_notes` preview, `query_notes` argument tolerance) — separate changes.

## Decisions

Verdicts are grouped: removals first (each with the coverage evidence the DoD requires), then keeps.

### D1: Remove `read_property` — covered by `read_notes` with no data loss
- **Choice:** Delete the tool. Route "read a single frontmatter value" to
  `read_notes(fields: ['frontmatter'])` (or `query_notes`, which already returns frontmatter).
- **Evidence (live):** `read_property({ path: <task note>, key: 'status' })` → `{ value: "todo" }`.
  `read_notes` and `query_notes` on the same note both return `frontmatter.status === "todo"` inside
  the full frontmatter object — same value, no loss. The only sliver `read_property` adds is ergonomic:
  a value-only return and a `name` (wikilink) lookup. The parameter dictionary already steers callers to
  resolve `name → path` first, so the `name` affordance is marginal.
- **Alternatives considered:** *Keep + nudge* (it is documented and ergonomic) and *keep as-is* — both
  rejected by the user in favour of the leaner surface, consistent with the task author's pre-verdict.
- **Doc dependency:** `docs/guide/routing.md` currently *recommends* `read_property` (rule of thumb +
  the "status of Quarterly review" example). These must be re-routed, not just deleted.

### D2: Remove `list_properties` — covered by `get_vault_overview` (top-30); tail surrendered
- **Choice:** Delete the tool. `get_vault_overview` already returns the same `properties`
  (`{ name, type, count }`) list. Leave `get_vault_overview` unchanged (top-30 cap intact).
- **Evidence (live):** `list_properties` → 36 keys; `get_vault_overview.properties` → the identical
  list **capped at 30**, dropping the tail (`blocked_by` ×1, `excalidraw-plugin` ×1, and four `count: 0`
  keys). So it is *not* a strict subset — overview covers every key with `count ≥ 1` that matters, but
  full enumeration of the rare/zero-count tail is given up. The user accepted that (the tail is mostly
  dead keys).
- **Alternatives considered:** *Remove + lift the 30-cap on `get_vault_overview`* (zero capability loss,
  one fewer tool) and *keep + nudge* — both presented; the user chose **remove outright**.
- **Internal dependency (do not break):** `computeVaultOverview` calls `provider.listProperties()`
  (`src/lib/obsidian/vault-overview.ts`). The provider method **stays**; only the tool wrapper goes.

### D3: Remove `get_stats` — a deliberate surface cut, NOT deduplication
- **Choice:** Delete the tool, on the user's explicit decision, with the consequence recorded.
- **Evidence (live):** `get_stats` → `{ totalNotes: 704, totalBlocks: 16595, embeddingDimension: 384,
  modelKey: "bge-micro-v2" }`. `get_vault_overview` → `total_notes: 574` (a disk scan). **No other tool
  reports block count, embedding dimension, model, or the corpus note count**, and the 704↔574 gap is a
  genuine staleness signal (orphaned embeddings in the Smart Connections cache). The audit verdict on the
  evidence was therefore **keep**.
- **Why removed anyway:** the user was shown this and chose to drop it to minimise the surface, accepting
  that embedding-corpus health is no longer observable via MCP (it can be inspected outside the server).
  This is documented honestly so a future reader does not mistake it for a covered duplicate.
- **Why it cannot be merged instead:** `get_stats` lives in `semantic/` because its fields only exist
  when the embedding corpus is loaded; folding them into the operations-module `get_vault_overview` would
  couple operations to the corpus and break the module separation. So the realistic options were keep or
  remove — not merge.
- **Doc consequence:** `docs/guide/configuration.md` tells users to "check that `get_stats` shows a
  non-zero `totalNotes`" when search returns nothing. That troubleshooting step must be re-worded to a
  still-available check (e.g. confirm `search_notes` returns results / the corpus path is configured).

### D4: Keep `get_note_links` — sole source of wikilink edge lists
- **Choice:** Keep. Add an `AGENTS.md` nudge: reach for it to traverse the link graph around a note
  (who links in, what it links out to, including unresolved targets).
- **Evidence (live):** for the task note, `incoming: [Daily/2026-06-08]`, five `outgoing` targets with
  `resolved`/path. `query_notes` returns only `backlink_count: 1` (a count, no list); `get_similar_notes`
  ranks/merges neighbours and never exposes the raw adjacency or unresolved links. Unique → keep.

### D5: Keep `find_duplicates` — vault-wide all-pairs dedup, not single-source similarity
- **Choice:** Keep. `AGENTS.md` nudge: reach for it for a corpus-wide near-duplicate sweep (vault hygiene).
- **Evidence (live):** at threshold 0.9 it returned **1,169 pairs** (e.g. `Daily/2026-04-18` ≈
  `Daily/2026-04-19` @ 0.9986). `get_similar_notes` is single-source (neighbours of one given note);
  reconstructing the sweep would take N calls plus manual pair dedup. Different operation → keep.

### D6: Keep `remove_property` — sole frontmatter-key deletion path
- **Choice:** Keep. `AGENTS.md` nudge: the only way to *delete* a frontmatter key.
- **Evidence (by contract; not executed, to avoid mutating the vault):** `set_property` only
  sets/overwrites a key; `edit_note` preserves frontmatter byte-for-byte in both its modes. Neither can
  delete a key — `remove_property` is the inverse of `set_property` and has no substitute. Unique → keep.

### D7: Removal mechanics — registration, names, tests, dead code
- **Choice:** For each removed tool, delete (a) the tool file, (b) its entry in `src/lib/tool-names.ts`
  `TOOL_NAMES`, (c) its entry in the module's `tools/index.ts`, (d) its registration in `src/server.ts`,
  and (e) its test file plus its references in shared/server tests. Then prune code that becomes dead:
  `ToolStats` + `readEmbeddingDimension` (only `get_stats` used them); and `provider.readProperty` **iff**
  no other caller remains (verify by grep). **Preserve** `provider.listProperties()` (D2) and `modelKey`
  (still consumed by `find_duplicates`).
- **Rationale:** `tool-names.ts` is the canonical surface list and `ToolName` is a derived union type;
  removing a name there makes `tsc --noEmit` flag every stale reference — a built-in completeness check.
- **Tests are deleted, not skipped:** per the baseline spec, the suite count may drop, but only
  intentionally; the removed tools' suites are the intended drop and the change notes it.

### D8: Version bump — breaking, 10.1.0 → 11.0.0
- **Choice:** Treat the removals as a breaking contract change; the release (Conventional Commits →
  `npm run release` on `main`) carries a `BREAKING CHANGE:` footer so it cuts a major.
- **Rationale:** a tool disappearing from the MCP surface breaks any client/config that calls it — the
  same bar ADR-0005 sets for renaming a shared parameter.

### D9: No new ADR
- **Choice:** No `docs/adr/` entry. This is an application of existing decisions (surface hygiene under
  the ADR-0005 breaking-change discipline + the module-separation invariant), not a new architectural
  decision. (Flagged in Open Questions for confirmation.)

## Risks / Trade-offs

- [Risk] A client still calls a removed tool after upgrade → it receives a tool-not-found error.
  **Mitigation:** the major version bump signals the break; the removed tools were called in zero/near-zero
  buckets, so real impact is minimal.
- [Risk] Losing `get_stats` removes the only in-MCP way to spot embedding-corpus staleness (the 704↔574
  drift). **Mitigation:** accepted by the user as a deliberate cut; corpus health remains inspectable
  outside the server, and `find_duplicates` still exposes one corpus-hygiene angle. Recorded in D3.
- [Risk] A stale reference to a removed tool lingers in a doc or test and ships inconsistent.
  **Mitigation:** `tsc --noEmit` catches code/type references via the `ToolName` union; a final grep for
  each removed name across `src/`, `test/`, and live docs is a task-list gate.
- [Trade-off] `list_properties` removal surrenders full-tail property enumeration (D2). **Accepted:** the
  tail is rare/`count: 0` noise; overview's top-30 covers what matters; lifting the cap was offered and
  declined.
- [Trade-off] Keeping three unused tools leaves three rarely-needed schemas in the surface. **Accepted:**
  each is the *sole* path to its capability; the `AGENTS.md` nudge makes the intent explicit so they are
  not re-audited as dead next cycle.

## Migration Plan

1. Commit the change folder, then implement on a worktree branch off `origin/main`.
2. Remove the three tools + dead code; delete their tests; scrub live docs and the parameter dictionary;
   add the three keep-nudges to `AGENTS.md` (D7, D4–D6).
3. Quality gates green: `npm test` (count drops only by the removed suites), `npm run lint`,
   `npx tsc --noEmit` (authoritative — confirms no stale `ToolName`/registration references).
4. PR to `main`; merge; `npm run release` on `main` → **11.0.0** with a `BREAKING CHANGE:` footer listing
   the three removed tools and their replacements (or accepted loss).
5. **Rollback:** revert the PR — pure surface/doc change, no data or schema migration.
6. **Acceptance:** the three gates pass; no live doc or dictionary row references a removed tool; the next
   weekly usage report no longer lists the removed tools under `unusedTools`.

## Open Questions

- Confirm **no** `docs/adr/` entry is wanted (D9 treats this as an application of existing ADRs).
  Default: no new ADR.
- `provider.readProperty` removal is conditional on no remaining caller — confirm during apply via grep
  (D7). If something else uses it, keep the method and remove only the tool.
- Exact replacement wording for the `routing.md` "status of X" example and the `configuration.md`
  corpus-check tip — settle during apply; not contract-critical.
