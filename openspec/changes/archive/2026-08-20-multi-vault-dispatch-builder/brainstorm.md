<!-- Raw capture of superpowers:brainstorming output. -->

# Brainstorm — multi-vault dispatch builder

## Background

Source: architecture review `architecture-review-20260820-124639`, item 2 —
"The multi-vault dispatch seam — stop copy-pasting the fan-out glue"
(rated **Strong**, independently verified: drift quoted verbatim, all five
dispatch branches confirmed).

`runFanOut` (`src/lib/fan-out.ts`) is a real seam and stays. The problem is the
*surrounding* contract: each of its five adapters re-implements the same three
things by hand.

**Five tools carrying the glue:**

- `src/modules/operations/tools/list-tags.ts`
- `src/modules/operations/tools/list-properties.ts`
- `src/modules/operations/tools/query-notes.ts`
- `src/modules/operations/tools/get-vault-overview.ts`
- `src/modules/semantic/tools/search-notes.ts`

**Glue kind 1 — the dispatch branch.** Line-for-line identical in all five:

```ts
if (input.vault === undefined && registry.isMulti()) {
  return await runFanOut(registry, (entry) => runForEntry(entry, input));
}
const entry = resolveVault(input, registry, { tool: '<name>' });
// ... single-vault path
```

**Glue kind 2 — the fan-out prose, already drifted into three variants:**

- `list_tags` / `list_properties` — `results_by_vault` + `failed_vaults`, no
  `skipped_vaults`.
- `query_notes` / `get_vault_overview` — same, **plus** "`skipped_vaults: [...]`
  (pre-filtered out)".
- `search_notes` — its own prose variant entirely, plus an inline hand-rolled
  copy of the `Registered vaults: "a", "b".` listing that `describeMultiVault`
  already produces.

The `skipped_vaults` mention is not merely drift, it is **wrong**: `runFanOut`
hard-codes `skipped_vaults: []` and the only helper that ever populated it
(`runSemanticFanOut`) was deleted when `search_notes` went hybrid. Two of five
tool descriptions advertise a field no code path can fill.

**Glue kind 3 — the type contortion.** Four near-identical aliases whose only
job is to satisfy `IFanOutResult<T extends Record<string, unknown>>`:

```ts
type FanOutPayload = { results: TagEntry[] } & Record<string, unknown>;       // list-tags
type FanOutPayload = { results: PropertyEntry[] } & Record<string, unknown>;  // list-properties
type QueryNotesResultRecord = QueryNotesResultWithVault & Record<string, unknown>;
type VaultOverviewRecord = VaultOverview & Record<string, unknown>;
```

plus an index-signature comment carrying the same burden in `search-notes.ts:81`.

**Deletion test.** Deleting a shared wrapper would re-scatter all three kinds of
glue across 5 tools → it passes. The seam earns its keep.

## Decision chain

### Q1 — Which way does the unified `skipped_vaults` prose go?

Two defensible answers: drop the mention (describe only what is true today), or
document all three fields (model learns the full shape up front; a future
pre-filtering tool needs no description change).

**Decided: drop the mention.** The field stays in the *response shape* for
contract stability (`docs/architecture/fan-out.md` reserves it as the designated
slot for a future pre-filtering tool), but descriptions stop advertising a field
that is always `[]`. ADR-0010 is the tiebreaker: descriptions are the expensive
channel, sent on every `tools/list` — say each thing once, and only what is
true. A description that promises `skipped_vaults` semantics no code delivers is
a behaviour bug, not a wording preference.

### Q2 — Does `search_notes` belong in this change, or does report item 1 own it?

Report item 1 is already an in-flight change, `unify-retrieval-pipeline`, and it
also rewrites `search-notes.ts`. Collision risk checked against that change's own
Impact section rather than by inspection alone: it touches "the `isMulti` branch
at the call site … four `let`s and the `isMultiNode` guard" — all inside
`runSearchForEntry` and the node-shape code **above** line 480. The fan-out glue
lives in `buildSearchNotesTool` (lines 486-588). Disjoint regions of one file.

**Decided: all five tools.** `search_notes` is the worst offender — the only one
that bypasses `describeMultiVault` entirely and hand-rolls its vault-name
listing. Excluding it would leave the most-drifted copy alive and leave the
leverage claim ("a sixth tool costs one function") unproven.

### Q3 — How does the builder handle the single-vault shape variation?

Not all five tools shape the single-vault return the same way:

| tool                 | single-vault return         | why                              |
| -------------------- | --------------------------- | -------------------------------- |
| `list_tags`          | `{ vault, ...payload }`     | payload has no vault of its own  |
| `list_properties`    | `{ vault, ...payload }`     | same                             |
| `get_vault_overview` | `{ vault, ...payload }`     | same                             |
| `query_notes`        | payload as-is               | each result item carries `vault` |
| `search_notes`       | payload as-is               | each match carries `vault`       |

Options weighed:

- **(a) optional `shapeSingle` with `{ vault, ...payload }` as the default** —
  reads as if prefixing were the norm and the other two were exceptions. The
  magic default hides a real contract difference.
- **(b) a `'prefix-vault' | 'as-is'` flag** — self-documenting, but the two
  variants have different output types, so the builder needs function
  overloads.
- **(c) an explicit `single` function, generic over its return type** — no
  overloads (the output type infers), no hidden default. Cost: three tools would
  each write the same `(entry, p) => ({ vault: entry.name, ...p })` lambda.

**Decided: (c), with the two implementations shipped as named exports** —
`withVaultName` and `payloadOnly`. That kills (c)'s duplication cost while
keeping its typing. Each call site reads as a declaration of which contract the
tool follows.

### Q4 — Can the builder absorb the type contortion, or only relocate it?

Investigated the root cause rather than accepting it. `IFanOutResult<T extends
Record<string, unknown>>`'s constraint exists for exactly one expression inside
`runFanOut` — the spread `{ vault, ...outcome.value }`. Interfaces (`VaultOverview`,
`QueryNotesResultWithVault`) have no index signature and so fail
`Record<string, unknown>`, which is why every call site launders its payload
through an `& Record<string, unknown>` alias.

But TypeScript has supported generic object spread since 3.2, and it needs only
`T extends object`. Relaxing the constraint one word plausibly deletes all four
aliases *and* the `search-notes.ts:81` index-signature workaround.

**Decided: attempt the relaxation, verify empirically, keep a fallback.** This
is a hypothesis about the type checker, not an established fact —
`npm run typecheck` is authoritative (`isolatedModules` means a `tsup` build
alone proves nothing). If `T extends object` does not typecheck clean, the
builder still declares the constraint once in its own generic, and the aliases
move behind the builder instead of disappearing. The change is worth doing
either way; only the line-count win is contingent.

### Q5 — Where does the unified prose live?

`vault-param.ts` already owns `EXPLICIT_VAULT_SUFFIX` — the shared suffix for
the nine tools that *cannot* fan out. The fan-out suffix is its exact mirror.

**Decided: `FAN_OUT_SUFFIX` beside it in `vault-param.ts`.** The symmetry is the
point: one file states both halves of the multi-vault contract, 5 tools ↔ 9
tools. The builder concatenates it via the existing `describeMultiVault`, which
already prefixes the registered vault names.

### Q6 — What does `search_notes` keep?

Its description is an array joined by `\n`, not a single string, and it has a
mid-description `PARAMETERS:` section containing:

```
- vault: target a specific vault by name when multiple are registered.
```

That line is position-dependent and is a *parameter listing*, not the fan-out
contract. A generic builder cannot place text mid-description.

**Decided:** `search_notes` keeps that one line and keeps its
`registry.isMulti()` reference for it. The builder appends only the tail. The
domain-specific sentence — "A vault without a semantic index still contributes
lexically-sourced matches; none are skipped." — passes through the optional
`multiVaultNote` field. The hand-rolled `Registered vaults: ...` block is
deleted outright, since `describeMultiVault` emits exactly that.

Accepted residue, stated so it is not mistaken for an oversight.

## Design trade-offs

**What gets better**

- Locality: the fan-out contract (branch + prose + type bound) has one owner.
- The `skipped_vaults` description bug is fixed at all call sites at once.
- Drift cannot recur — a test asserts all five descriptions carry byte-identical
  fan-out prose. This is the load-bearing test; without it the change buys
  tidiness, not a guarantee.
- Leverage: a sixth fan-out tool costs `runForEntry` + domain prose.
- Dispatch semantics tested once, in one place, instead of five partial copies.

**What it costs**

- One more indirection between a tool and its handler. Mitigated by the builder
  being small and single-purpose.
- Five tool files change at once — a wide, shallow diff.

**Not in conflict with ADR-0010 — this change fulfils it.** ADR-0010 makes tool
descriptions a *delivery channel*, which is precisely why drifted prose counts
as a behaviour bug rather than cosmetic debt: a contract delivered through five
hand-maintained copies has no owner. One caveat: ADR-0010's Consequences section
states "`search_notes` composes its multi-vault text inline instead of going
through it". This change makes that clause false as a statement about current
code. Initially decided to correct it in place; **reversed after checking
ADR-0008 and `docs/adr/INDEX.md`** — the ADR layer is the durable point-in-time
WHY record, `docs/architecture/` is the living current-state layer, and the only
sanctioned edit to a standing ADR is a Status change for supersession. The ADR
stays as written; `docs/architecture/fan-out.md` carries the current state.

## Out of scope

- Report item 1 (fold `executeRetrieval` into the multi-query pipeline) — already
  the in-flight `unify-retrieval-pipeline` change.
- Report item 3 (retire the pre-zod manual validators).
- Report candidate 4 (the stale-path existence filter) — already the in-flight
  `stale-path-filter-adapter` change.
- Any change to `runFanOut`'s runtime behaviour, the `IFanOutResult` response
  shape, or the MCP wire contract beyond the description text.
- The nine non-fan-out tools and `EXPLICIT_VAULT_SUFFIX`.
