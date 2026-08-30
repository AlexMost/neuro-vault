<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — single-vault-dispatch-builder

Source: [GitHub issue #111](https://github.com/AlexMost/neuro-vault/issues/111). The issue arrived
fully specified (scope, invariants, acceptance criteria), so this session ran as a grounding pass:
verify every claim against the source, then resolve the forks the issue left open. Classification:
architectural-through-opsx — it reshapes the tool-construction seam nine tools sit on, matching the
sibling precedent `multi-vault-dispatch-builder` (now `openspec/specs/multi-vault-dispatch/`).

## Background — verified against source (2026-08-30)

Every factual claim in the issue checks out:

- **The 27 repetitions are real.** Nine tools hand-roll the triple. Seven operations tools
  (`read_notes`, `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`,
  `get_note_links`) call `resolveVault`; two semantic tools (`get_similar_notes`,
  `find_duplicates`) call `resolveSemanticVault`. Each spreads `...vaultParamShape(registry)`,
  concatenates `describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX)`, and restates its own `name:`
  literal inside the resolver call in the same file.
- **Both suffix-order violations confirmed.** `create-note.ts:56-57` appends the overwrite warning
  *after* the dispatch suffix. `get-note-links.ts:39-41` concatenates the suffix onto the last
  element of a `.join('\n')` array — textually last today, but nothing stops a sixth element
  landing after it.
- **The separator heuristic** sits at `multi-vault-tool.ts:80-83`
  (`spec.description.includes('\n')`), pinned by an exact-string test in
  `test/lib/multi-vault-tool.test.ts`. It exists only because description composition has two
  owners.
- **Test gap confirmed.** `VAULT_REQUIRED` behaviour tests exist for `create_note`,
  `get_similar_notes`, `find_duplicates` only. The other six get a description-regex assertion
  (`test/operations/tools.test.ts` ~L153-168) — prose, not behaviour.
- **No tool in the nine uses `annotations` or `outputSchema`** — the new spec interface can mirror
  `IMultiVaultToolSpec` minus the fan-out members, with nothing extra.
- **`resolveSemanticVault`** (`resolve-vault.ts:28`) narrows the entry to
  `IVaultEntry & { backend: SemanticBackend }` and owns the readiness gate
  (`SEMANTIC_INDEX_BUILDING` / `SEMANTIC_DISABLED` / `SEMANTIC_INDEX_NOT_FOUND`). The builder's
  `semantic` flag must preserve that narrowing at the type level.

## Decision chain

### Q1 — Routing: direct PR or opsx change?

The issue said "decide at pickup". The user invoked `/opsx:propose` → opsx change, matching the
sibling precedent. The routing table's letter says "internal consolidation → direct PR", but this
change extends a capability contract that already lives in `openspec/specs/multi-vault-dispatch/`
— the spec delta alone justifies the opsx route.

### Q2 — One builder with a `semantic` flag, or two builders?

**Decided: one exported `buildSingleVaultTool` over a discriminated spec union.** The issue asks
for `semantic: true` routing to `resolveSemanticVault`. The typing fork was open: overloads, two
builders, or a discriminated union. A discriminated union of two spec interfaces —
`semantic?: false` giving `runForEntry(entry: IVaultEntry, …)`, `semantic: true` giving
`runForEntry(entry: IVaultEntry & { backend: SemanticBackend }, …)` — keeps one exported function,
one name literal, and lets the semantic tools keep their typed `entry.backend` access without
casts. Two builders would split the "one owner" the issue is buying; bare overloads hide the
discriminant from the reader.

### Q3 — What replaces the separator heuristic?

**Decided: the dispatch block always lands as its own paragraph (`\n\n` + block, no leading
space), in both builders.** The heuristic can't just be deleted from `buildMultiVaultTool` without
an answer for single-paragraph vs multi-line descriptions. Options weighed:

1. Always own-paragraph (chosen) — uniform, zero sniffing, and the block reads as the distinct
   contract statement it is. The *words* of every description stay byte-identical; only the
   joining whitespace changes for the four single-paragraph fan-out tools (space → blank line).
   That does not touch the issue's invariants (parameter names, dispatch prose, error codes).
2. Keep concatenation-with-leading-space and forbid multi-line domain descriptions — dead on
   arrival; `search_notes`, `read_notes`, `get_note_links` are legitimately multi-line.
3. Move the heuristic into `describeMultiVault` — keeps the sniff, fails the acceptance criterion
   that the branch is gone.

Consequence: `describeMultiVault` drops its leading-space wrapping (the builders own placement),
and the exact-string assertions in `test/lib/multi-vault-tool.test.ts` are updated to the
paragraph form.

### Q4 — How is "no tool file imports the helpers directly" enforced?

**Decided: ESLint `no-restricted-imports` scoped to `src/modules/**`,** banning
`lib/vault-param.js` and `lib/resolve-vault.js` module paths there. `npm run lint` runs in CI on
every push and PR, so the invariant gets a CI-enforced gate rather than a one-time checklist row.
A repo-scan test was the alternative; lint is the idiomatic home for an import-boundary rule and
this repo already carries a type-aware-linting capability. The helpers stay exported (the two
builders in `src/lib/` and the lib-level tests still consume them) — "internal to the builders"
is enforced at the module boundary, not by unexporting.

### Q5 — Where does the builder live, and what happens to `vault-param.ts`?

**Decided: new `src/lib/single-vault-tool.ts` beside `multi-vault-tool.ts`.** `vault-param.ts`
stays as a file (both builders import it; `vault-param.test.ts` and `fan-out-prose.test.ts` keep
importing the suffix constants), but after this change its production consumers are exactly the
two builders.

### Q6 — Builder-level `VAULT_REQUIRED` coverage: how does it route?

**Decided: `test/lib/single-vault-tool.test.ts` goes through the registration gate** —
`registerTool(buildSingleVaultTool(…))` + `callTool` / `expectToolError` from `test/_gate.ts`,
per ADR-0015 and the repo convention. Covers: `VAULT_REQUIRED` when `vault` is omitted in
multi-vault mode, named-vault targeting, single-vault fallthrough, unknown vault failure,
`vault` advertised in multi / absent in single mode, suffix-last placement, and `semantic: true`
routing through the readiness gate (one non-ready backend case proves the routing). Converting
the existing `multi-vault-tool.test.ts` to the gate is out of scope.

### Q7 — `create_note`'s post-suffix sentence?

**Decided: the overwrite warning moves *before* the suffix,** becoming the tail of the domain
description (leading space adjusted). Its words are unchanged; only its position moves, which is
exactly the suffix-last fix the issue prescribes. No `multiVaultNote`-style post-suffix hook for
the single-vault builder — the fan-out builder needed one, nothing here does (YAGNI).

### Q8 — Delivery shape?

**Decided: one PR.** The builder with zero call sites is dead code, the nine migrations are
mechanical and only reviewable against the builder, and the lint boundary can only turn on once
all nine have migrated. Splitting would manufacture an unreviewable foundation PR.

## Out of scope (re-confirmed from the issue)

- No tool-contract change: parameter names (ADR-0005), dispatch prose wording, error codes.
- The five fan-out tools and `buildMultiVaultTool`'s spec interface untouched, except deleting the
  separator sniff (and the paragraph normalization that replaces it).
- No conversion of existing tests to the gate beyond the new builder test.

## Acceptance (from the issue, unchanged)

- `npm test`, `npm run lint`, `npm run typecheck` pass.
- All nine single-vault tools built through `buildSingleVaultTool`; no tool file imports
  `vaultParamShape` / `describeMultiVault` / `resolveVault` directly.
- Dispatch suffix last in every description, including `create_note` and `get_note_links`.
- The `spec.description.includes('\n')` branch in `buildMultiVaultTool` is gone.
- `VAULT_REQUIRED` behaviour covered once at the builder level, holding for all nine tools.
