<!--
Dependency shape (see plan.md for the PR boundaries):

  1 ──┬── 2 ── 3 ──┐
      └── 4 ───────┴── 5 ── 6

Group 1 is the foundation — nothing else starts until it lands.
Groups 2→3 (the overview channel) and group 4 (the instructions channel) are
**parallel-safe** with respect to each other: disjoint files, no shared state.
Groups 5 and 6 are sequential tails.
-->

## 1. Shared conventions reader and per-vault seam

Sequential foundation. Both channels must agree by construction on the path, the trim, and what
"absent" means (design D6).

- [ ] 1.1 Failing test: a reader module resolves `<vaultPath>/.neuro-vault/for-external-agents.md`, returns its trimmed content, and returns `null` for missing, empty, whitespace-only, and unreadable files (permission error, and path-is-a-directory).
- [ ] 1.2 Create `src/lib/obsidian/vault-conventions.ts` exporting the reader plus `CONVENTIONS_PATH`; make the file read injectable the way `FsVaultReader` injects `readFile`, so tests need no temp directory.
- [ ] 1.3 Delete `readExternalAgentInstructions` and `EXTERNAL_AGENT_INSTRUCTIONS_PATH` from `src/server.ts`; point `buildServerInstructions` at the new module. Behavior must be unchanged at this step — the existing `test/server-instructions.test.ts` stays green as the regression guard.
- [ ] 1.4 Failing test: a registry entry exposes `readConventions()` that resolves against that entry's own vault path, and two entries in a multi-vault registry read different files.
- [ ] 1.5 Add `readConventions` to `IVaultEntry` and a matching factory to `IVaultEntryDeps` + `buildDefaultVaultEntryDeps`, wired from `entry.path`; switch `buildServerInstructions` to call `entry.readConventions()`.
- [ ] 1.6 Add the character cap constant and the bounded-slice helper (mirror `previewBody`'s shape at the larger cap, design D8); test the boundary cases — exactly at the cap, one over, far over.

## 2. Conventions on the overview computation

Depends on group 1. Parallel-safe with group 4.

- [ ] 2.1 Failing test: `computeVaultOverview` returns `conventions` matching a stubbed reader's content, and omits the key entirely when the stub returns `null`.
- [ ] 2.2 Extend `VaultOverview` with optional `conventions` / `conventions_truncated` and take `readConventions` as a dep in `ComputeVaultOverviewDeps`; keep the function free of direct `fs` access.
- [ ] 2.3 Failing test: an over-cap file yields a slice no longer than the cap plus `conventions_truncated: true`; an under-cap file yields the whole content and no flag key.
- [ ] 2.4 Failing test: a rejecting `readConventions` leaves the structural snapshot intact and omits the key — the overview never fails on the optional file.
- [ ] 2.5 Failing test: two successive computes across a changed file return the old then the new content — the read happens per call, nothing is cached (design D7).

## 3. Both overview surfaces

Depends on group 2. Tasks 3.1–3.2 and 3.3 touch different files and may run in parallel.

- [ ] 3.1 Failing test through the SDK gate (`reg.spec.inputSchema` + handler, per this repo's MCP test convention): single-vault `get_vault_overview` carries `conventions`; wire `entry.readConventions` into `runOverviewForEntry`.
- [ ] 3.2 Failing test: in fan-out, each `results_by_vault` entry carries its own vault's conventions; a vault with no file omits the key and does **not** appear in `failed_vaults`.
- [ ] 3.3 Failing test: `vault://overview` (and each `vault://<name>/overview` in multi-vault) carries the same field as the tool; wire the resource handler.
- [ ] 3.4 Add the description sentence to `get_vault_overview` — the response carries the vault owner's conventions and they are to be followed — and assert it on the advertised description, not just in source (design D9).

## 4. Instructions reorder and diet

Depends on group 1 only. Parallel-safe with groups 2–3 — disjoint files.

- [ ] 4.1 Failing test: for a registry whose vault has a ~1,200-character conventions file, the first 2048 characters of `buildServerInstructions` output contain that content **in full** and the whole preamble. This is the change's load-bearing assertion and the regression guard for future preamble growth.
- [ ] 4.2 Failing test: the conventions block starts at a lower offset than any server-authored section, and a vault with no file yields the preamble alone with no stray heading.
- [ ] 4.3 Reorder `buildServerInstructions`: per-vault blocks first, then preamble. Drop the `## Multi-vault mode` section.
- [ ] 4.4 Audit before deleting — for each per-tool section in `STATIC_SERVER_INSTRUCTIONS`, confirm the content is already in that tool's `description`. Record the audit result in the task notes; anything without a home moves into the description in 4.5 rather than being deleted.
- [ ] 4.5 Move any orphaned guidance found in 4.4 into the relevant tool description (the `search_notes` query-writing recipe is the likeliest candidate), with a test on the advertised description for each move.
- [ ] 4.6 Rewrite `STATIC_SERVER_INSTRUCTIONS` to ~600–800 characters: second-brain role, operations-vs-semantic routing, project-scope discovery order. Fold the `get_vault_overview` orientation hint in rather than keeping it a separate layer.

## 5. Documentation and decision record

Depends on groups 2–4 — write once behavior is final. 5.1–5.4 are parallel-safe with each other.

- [ ] 5.1 Create `docs/architecture/vault-conventions.md` owning the whole concept: file location, both channels, ordering, the 2048 budget, per-call freshness, the cap and its flag, multi-vault behavior.
- [ ] 5.2 Reduce `docs/architecture/mcp-server-shape.md`'s instructions layering (items 1–4) to the new order plus a pointer to 5.1 — the current text describes the broken order and is now actively wrong.
- [ ] 5.3 Write `docs/adr/0010-context-delivery-channels.md` and add it to `docs/adr/INDEX.md`: tool descriptions and tool responses are the channels that arrive intact; `instructions` is best-effort (design D11).
- [ ] 5.4 Sweep **all** of `docs/` — including the model-facing `docs/guide/` layer, which architecture-scoped greps have missed before — for the old promise ("injected into instructions") and for any advice about keeping `for-external-agents.md` short. Restate as: every agent that calls the overview sees them; the instructions copy is best-effort and budgeted around 2048.
- [ ] 5.5 Update `README.md` where it describes `.neuro-vault/for-external-agents.md`.

## 6. Gates

- [ ] 6.1 `npm test`, `npm run lint`, `npm run typecheck` all green; test count must not silently drop (baseline spec).
- [ ] 6.2 Manual check against the real vault: call `get_vault_overview`, confirm `conventions` matches the file; edit the file, call again without restarting, confirm the change is visible.
- [ ] 6.3 `npx openspec validate vault-conventions-delivery` clean.
