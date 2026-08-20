## Context

`runFanOut` (`src/lib/fan-out.ts`) is a genuine seam: it owns how a single tool
call spreads across every registered vault and how per-vault failures surface.
It is not the problem. The problem is that each of its five adapters
re-implements the contract *surrounding* it by hand.

Current state — five tools (`list_tags`, `list_properties`, `query_notes`,
`get_vault_overview`, `search_notes`) each carry three kinds of private glue:

1. **The dispatch branch** — `if (input.vault === undefined && registry.isMulti())
   → runFanOut(...)`, else `resolveVault(...)` and the single-vault path.
   Line-for-line identical five times.
2. **The fan-out prose** appended to the tool description — already drifted into
   three variants.
3. **A type contortion** — an `& Record<string, unknown>` alias (or, in
   `search_notes`, an index-signature comment) whose sole purpose is to satisfy
   `IFanOutResult<T extends Record<string, unknown>>`.

The prose drift is not cosmetic. Two of the five descriptions
(`query_notes`, `get_vault_overview`) advertise `skipped_vaults: [...]
(pre-filtered out)`. `runFanOut` hard-codes `skipped_vaults: []`, and the only
helper that ever populated it (`runSemanticFanOut`) was deleted when
`search_notes` became hybrid. Those two descriptions promise semantics no code
path can deliver.

**Constraint — ADR-0010.** Tool descriptions are one of only two channels that
reach an external agent intact (`instructions` is truncated at 2048 characters
and withheld from sub-agents entirely). That makes a wrong description a
behaviour bug, not a documentation nit — and it makes five hand-maintained
copies of one contract a delivery risk rather than mere duplication.

**Constraint — `npm run typecheck` is authoritative.** `isolatedModules` means a
successful `tsup` build does not prove type correctness. Decision D4 below rests
on a hypothesis about the type checker and must be settled by `tsc --noEmit`,
not by inspection.

## Goals / Non-Goals

**Goals:**

- One owner for the multi-vault dispatch contract: the branch, the prose, and
  the type bound.
- Fix the `skipped_vaults` description bug at all five call sites at once.
- Make prose drift structurally unable to recur, enforced by a test rather than
  by review.
- Leverage: a sixth fan-out tool costs one `runForEntry` function plus its
  domain prose.
- Keep the MCP wire contract unchanged apart from the corrected description
  text.

**Non-Goals:**

- Report item 1 (fold `executeRetrieval` into the multi-query pipeline) and
  report item 3 (retire the pre-zod manual validators). Item 1 is already the
  in-flight `unify-retrieval-pipeline` change; report candidate 4 is the
  in-flight `stale-path-filter-adapter` change. Neither is absorbed here.
- Any change to `runFanOut`'s runtime behaviour or the `IFanOutResult` response
  shape. `skipped_vaults` **stays in the response** — only its description
  changes.
- The nine tools that cannot fan out, and `EXPLICIT_VAULT_SUFFIX`.
- Concurrency limits on fan-out (`docs/architecture/fan-out.md` notes unbounded
  parallelism as acceptable today; unrelated to this change).

## Decisions

### D1 — A `buildMultiVaultTool` builder owns the dispatch contract

- **Choice**: a new `src/lib/multi-vault-tool.ts` exporting
  `buildMultiVaultTool(registry, spec)`, where `spec` supplies
  `{ name, title, description, multiVaultNote?, inputShape, runForEntry, single }`.
  The builder merges `vaultParamShape(registry)` into the input schema, appends
  the fan-out prose via `describeMultiVault`, and owns the dispatch branch.
- **Rationale**: passes the deletion test — removing the builder re-scatters all
  three kinds of glue across five tools. Each tool is then reduced to what is
  genuinely its own: a per-vault function and domain prose.
- **Alternative considered**: leave the tools alone and only extract the prose
  into a shared constant. Rejected — it fixes one of three glue kinds and leaves
  the branch and the type bound to drift independently.

### D2 — The single-vault return shape is an explicit function, not a default

Three tools return `{ vault, ...payload }`; `query_notes` and `search_notes`
return the payload as-is because each result item already carries its own
`vault`.

- **Choice**: the builder takes an explicit `single` function, generic over its
  return type, and ships the two implementations as named exports —
  `withVaultName` and `payloadOnly`.
- **Rationale**: the output type infers from `single`, so the builder needs no
  function overloads; shipping the two implementations by name removes the
  duplication that an explicit-lambda-per-tool approach would cost. Each call
  site then reads as a declaration of which contract that tool follows.
- **Alternatives considered**:
  - Optional `shapeSingle` defaulting to `{ vault, ...payload }` — reads as if
    prefixing were the norm and the other two were exceptions, hiding a real
    contract difference behind a magic default.
  - A `'prefix-vault' | 'as-is'` flag — self-documenting, but the two variants
    have different output types, forcing overloads on the builder.

### D3 — The unified prose drops the `skipped_vaults` mention

- **Choice**: a `FAN_OUT_SUFFIX` constant in `src/lib/vault-param.ts` describing
  `results_by_vault` and `failed_vaults` only. The field itself remains in the
  response shape.
- **Rationale**: ADR-0010 — descriptions are the expensive channel, sent on
  every `tools/list`; say each thing once and only what is true. Documenting a
  field that is permanently `[]` spends the budget on a promise no code keeps.
  `docs/architecture/fan-out.md` already explains why the *field* stays
  (contract stability plus a reserved slot for a future pre-filtering tool) —
  that rationale justifies the shape, not the advertisement.
- **Placement rationale**: `vault-param.ts` already owns `EXPLICIT_VAULT_SUFFIX`,
  the suffix for the nine tools that *cannot* fan out. Putting `FAN_OUT_SUFFIX`
  beside it means one file states both halves of the multi-vault contract —
  5 tools ↔ 9 tools.
- **Alternative considered**: document all three fields everywhere, so a future
  pre-filtering tool needs no description change. Rejected — it pays a
  per-`tools/list` cost now for a tool that does not exist, and keeps a false
  statement live in the meantime.

### D4 — Relax `IFanOutResult`'s constraint to `T extends object`, verified empirically

- **Choice**: attempt relaxing `IFanOutResult<T extends Record<string, unknown>>`
  and `runFanOut`'s generic to `T extends object`, then delete the four
  `& Record<string, unknown>` aliases and the `search-notes.ts` index-signature
  workaround.
- **Rationale**: the constraint is load-bearing for exactly one expression —
  the `{ vault, ...outcome.value }` spread inside `runFanOut`. TypeScript has
  supported generic object spread since 3.2 and requires only `T extends object`,
  which interfaces satisfy and `Record<string, unknown>` does not. If it holds,
  the aliases disappear rather than relocating.
- **This is a hypothesis, not an established fact.** It must be settled by
  `npm run typecheck`, which is authoritative here.
- **Fallback if it does not typecheck clean**: keep the existing constraint; the
  builder declares it once in its own generic and the aliases move behind the
  builder instead of vanishing. The change is worth doing either way — only the
  line-count win is contingent on D4.

### D5 — `search_notes` keeps its parameter line and its domain sentence

- **Choice**: `search_notes` retains the `- vault: target a specific vault by
  name when multiple are registered.` line inside its mid-description
  `PARAMETERS:` block (and the `registry.isMulti()` reference that gates it).
  Its domain-specific sentence — "A vault without a semantic index still
  contributes lexically-sourced matches; none are skipped." — passes through the
  builder's optional `multiVaultNote`. Its hand-rolled `Registered vaults: ...`
  block is deleted.
- **Rationale**: `search_notes`'s description is an array joined by `\n` with
  position-dependent sections; a generic builder can append a tail but cannot
  place text mid-description. The retained line is a *parameter listing*, not
  the fan-out contract, so it is not the duplication being removed. The
  `Registered vaults:` block, by contrast, is a hand-rolled copy of what
  `describeMultiVault` already emits — pure duplication, deleted.
- **Stated explicitly so the residue is not mistaken for an oversight.**

### D6 — No new ADR, and ADR-0010 is left as written

- **Choice**: propose no new ADR, and make no edit to
  `docs/adr/0010-context-delivery-channels.md`. Its Consequences section states
  "`search_notes` composes its multi-vault text inline instead of going through
  it" — a clause this change makes false as a statement about current code.
  The current-state claim is carried by `docs/architecture/fan-out.md` instead.
- **Rationale**: this change *fulfils* ADR-0010 rather than revising or
  superseding it — no core invariant changes, no new runtime dependency, and the
  approach was not a close call, so no new ADR is owed either. On editing the
  existing one: ADR-0008 makes `docs/architecture/` the living, current-state
  layer and `docs/adr/` the durable WHY layer, and `docs/adr/INDEX.md` sanctions
  exactly one kind of edit to a standing ADR — a **Status** change recording
  supersession. This is not a supersession. An ADR's Consequences section
  describes the state at the time the decision was taken (2026-08-20); that
  remains an accurate historical record even once the code moves on, and
  rewriting it would convert the rationale layer into a second, redundant
  living-state layer.
- **Alternative considered**: correct the clause in place, on the reasoning that
  it describes implementation state rather than the decision itself. Rejected —
  the split ADR-0008 draws puts current-state claims in
  `docs/architecture/fan-out.md`, which this change already updates. Correcting
  the ADR would duplicate that claim in two layers with different update rules.
- **Note on a sibling claim**: the in-flight `stale-path-filter-adapter` change
  justifies the same conclusion as "ADRs are immutable (ADR-0008)". ADR-0008
  does not say that — it establishes the living-vs-durable layer split, and the
  Status-change carve-out lives in `docs/adr/INDEX.md`. Same outcome, different
  warrant; recorded here so the reasoning is not inherited unverified.

## Risks / Trade-offs

- **[Risk] `T extends object` does not typecheck clean** (D4) → Mitigation: the
  fallback in D4 — keep the constraint, declare it once inside the builder. The
  task is written with both outcomes as acceptable, so this cannot block the
  change.
- **[Risk] Five tool files change at once — a wide, shallow diff that could
  regress a tool's description or single-vault shape silently** → Mitigation:
  per-tool description assertions already exist (`test/operations/tools.test.ts`)
  and stay green; add explicit single-vault-shape assertions per tool, and
  assert the fan-out prose is byte-identical across all five.
- **[Risk] The drift-prevention claim is unenforced without a test — the change
  would then buy tidiness, not a guarantee** → Mitigation: the
  identical-prose test is the load-bearing deliverable, not an optional extra.
  Without it, the acceptance criteria are not met.
- **[Risk] Description text is a model-facing contract; shortening
  `query_notes` / `get_vault_overview` changes what an agent reads** →
  Mitigation: the removed sentence described a field that is always `[]`, so no
  behaviour an agent could rely on is lost. Verified against `runFanOut`, which
  hard-codes the empty array.
- **[Trade-off] One more indirection between a tool and its handler** →
  Accepted: the builder is small and single-purpose, and the alternative is five
  copies of a contract with no owner.
- **[Trade-off] Touching `search-notes.ts` while the in-flight
  `unify-retrieval-pipeline` change (report item 1) also rewrites it** →
  Accepted, and verified against that change's own stated impact rather than by
  inspection alone: it touches "the `isMulti` branch at the call site … four
  `let`s and the `isMultiNode` guard", all inside `runSearchForEntry` and the
  node-shape code above line 480. This change touches `buildSearchNotesTool`
  (lines 486-588). The two edit disjoint regions of the same file; expect a
  textual merge, not a semantic conflict, and land whichever is ready first.

## Migration Plan

N/A for deployment — no endpoint, schema, or data migration. In-process
refactor of an already-shipped surface.

Sequencing and rollback:

1. Land `src/lib/multi-vault-tool.ts` plus `FAN_OUT_SUFFIX` with unit tests
   before touching any tool, so the builder is proven against a fake registry
   first.
2. Migrate the four operations tools, then `search_notes` last — it has the most
   description surface and the most special-casing.
3. Attempt D4's constraint relaxation only after all five compile against the
   builder, so a typecheck failure is unambiguously attributable to D4.
4. Update `docs/architecture/fan-out.md` — the only doc that must state the
   new current state. No ADR is written or edited.

Rollback is a plain revert — no persisted state and no wire-contract change to
undo. Acceptance: `npm test && npm run lint && npm run typecheck` green, five
tools registered with byte-identical fan-out prose, and no `skipped_vaults`
mention in any tool description.

## Open Questions

None blocking. D4's typecheck outcome is unresolved by design and is settled
during implementation; both branches are specified and neither blocks the
change.
