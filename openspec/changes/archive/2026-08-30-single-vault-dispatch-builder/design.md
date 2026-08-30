# Design — single-vault-dispatch-builder

## Context

`src/lib/multi-vault-tool.ts` owns the dispatch contract for the five fan-out tools. The nine single-vault tools — seven operations (`read_notes`, `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`, `get_note_links`) and two semantic (`get_similar_notes`, `find_duplicates`) — hand-roll their half: spread `vaultParamShape(registry)`, concatenate `describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX)`, call `resolveVault` / `resolveSemanticVault` with their own name literal restated. Verified state (2026-08-30): 27 repetitions; suffix-order broken in `create-note.ts:56-57` (prose after suffix) and structurally fragile in `get-note-links.ts:39-41` (suffix inside a `.join('\n')` element); `buildMultiVaultTool` carries a `spec.description.includes('\n')` separator heuristic (`multi-vault-tool.ts:80-83`) because description composition has two owners; `VAULT_REQUIRED` behaviour tested for only 3 of 9 tools.

Constraints: ADR-0005 (parameter names frozen), ADR-0003 (error codes stable), ADR-0010 (descriptions are a delivery channel), ADR-0015 (the registration gate owns schema validation; tests route through it). None of the nine tools uses `annotations` or `outputSchema`.

## Goals / Non-Goals

**Goals:**

- One exported `buildSingleVaultTool(registry, spec)` owns the `vault` param contribution, the suffix-last description composition, and the resolver call for all nine tools.
- The suffix-last invariant becomes structural (builder-appended), not conventional.
- The separator heuristic in `buildMultiVaultTool` is deleted.
- `VAULT_REQUIRED` (and semantic-readiness routing) behaviour is proven once at the builder level, through the registration gate.
- The import boundary (`src/modules/**` never imports `lib/vault-param.js` / `lib/resolve-vault.js`) is CI-enforced via lint.

**Non-Goals:**

- No tool-contract change: parameter names, dispatch prose wording, error codes stay as today.
- No change to the five fan-out tools' spec interface or behaviour beyond the separator normalization.
- No conversion of existing tests (e.g. `multi-vault-tool.test.ts`) to the gate helpers.
- No `annotations` / `outputSchema` / post-suffix note support in the new builder (nothing needs it).

## Decisions

### D1: One builder over a discriminated spec union, not two builders or bare overloads

- **Choice**: `buildSingleVaultTool(registry, spec)` where `spec` is `ISingleVaultToolSpec<TInput, TOutput> | ISemanticVaultToolSpec<TInput, TOutput>`, discriminated on `semantic`. The non-semantic variant types `runForEntry(entry: IVaultEntry, input: TInput)`; the `semantic: true` variant types `runForEntry(entry: IVaultEntry & { backend: SemanticBackend }, input: TInput)` and routes resolution through `resolveSemanticVault` (which owns the readiness gate: `SEMANTIC_INDEX_BUILDING` / `SEMANTIC_DISABLED` / `SEMANTIC_INDEX_NOT_FOUND`).
- **Why**: preserves the typed `entry.backend` narrowing the two semantic tools rely on today, with one exported function and one place the name literal is consumed.
- **Alternatives**: two builders (splits the "one owner" this change buys); untyped flag + cast in handlers (loses the narrowing `resolveSemanticVault` exists to provide).

Spec shape mirrors `IMultiVaultToolSpec` minus the fan-out members: `name: ToolName`, `title`, `description` (domain prose only), `inputShape: z.ZodRawShape & { vault?: never }` (same compile-level guard against a spec smuggling its own `vault`), `runForEntry`. No `single`/`multiVaultNote` analogs — there is no fan-out shape choice and nothing may follow the suffix.

### D2: The dispatch block is always its own final paragraph, in both builders

- **Choice**: both builders append `'\n\n' + block` where the block no longer carries `describeMultiVault`'s leading space (the builders own placement; the helper returns the bare block). The heuristic branch is deleted.
- **Why**: the heuristic existed only to serve two description layouts; a uniform paragraph makes suffix-last verifiable byte-wise and reads as the distinct contract statement it is. Description *words* stay identical; only joining whitespace changes for the four single-paragraph fan-out tools.
- **Alternatives**: forbid multi-line domain descriptions (dead on arrival — `search_notes`, `read_notes`, `get_note_links` are legitimately multi-line); move the heuristic into `describeMultiVault` (keeps the sniff, fails acceptance).

### D3: Import boundary enforced by ESLint, not a repo-scan test

- **Choice**: `no-restricted-imports` override scoped to `src/modules/**` banning module paths resolving to `lib/vault-param.js` and `lib/resolve-vault.js`. Helpers stay exported — `src/lib/` builders and lib-level tests keep consuming them.
- **Why**: `npm run lint` runs in CI on every push and PR, making the boundary a standing gate rather than a one-time checklist row. Lint is the idiomatic home for import-boundary rules in a repo that already carries type-aware linting.
- **Alternative**: a test that greps `src/modules/**` (works, but duplicates what lint natively does and lives far from the boundary it guards).

### D4: `create_note`'s overwrite warning moves before the suffix

- **Choice**: the sentence keeps its words, loses its leading space, and becomes the tail of the domain description. `get_note_links` passes its joined array (without the suffix element) as the domain description.
- **Why**: this is exactly the suffix-last fix the issue prescribes; adding a post-suffix hook to the new builder would re-open the hole being closed.

### D5: Builder-level behaviour tests route through the registration gate

- **Choice**: `test/lib/single-vault-tool.test.ts` exercises `registerTool(buildSingleVaultTool(…))` via `callTool` / `expectToolError` (`test/_gate.ts`), covering: `VAULT_REQUIRED` on omitted `vault` in multi-vault mode (code + `registered_vaults` details), named-vault targeting, single-vault fallthrough, unknown-vault failure, `vault` advertised in multi / absent in single mode, suffix as the description's final paragraph, and `semantic: true` routing (one non-ready backend case proves the readiness gate engages).
- **Why**: ADR-0015 — handler-direct tests bypass coercion, `.strict()`, and advertisement.

### D6: Spec home is the existing `multi-vault-dispatch` capability

- **Choice**: MODIFIED-capability delta extending `openspec/specs/multi-vault-dispatch/` with the explicit-vault class; no new capability.
- **Why**: fan-out and explicit-vault are the two dispatch classes of one contract; the capability's existing requirements (shared suffix constants, vault-name enumeration) already straddle both.

## Risks / Trade-offs

- **[Risk] Exact-string description tests break on the whitespace normalization** → Mitigation: the plan updates `test/lib/multi-vault-tool.test.ts`'s exact-string assertions deliberately; regex-based assertions (`tools.test.ts`, `fan-out-prose.test.ts`) are separator-agnostic (`toMatch`/`toContain`) and must keep passing untouched — an untouched failing regex test signals a wording regression, not collateral.
- **[Risk] The nine migrations silently change description words** → Mitigation: builder test pins composition; per-tool description regex tests already pin key phrases; verify step diffs `tools/list` descriptions word-wise (whitespace-insensitive) against `main`.
- **[Trade-off] Whitespace-only description change reaches MCP clients** → accepted: prose bytes unchanged, and ADR-0010 concerns wording, not paragraph joins.
- **[Trade-off] `vault-param.ts` survives as a file with exactly two production consumers** → accepted: unexporting would break lib tests for no boundary gain; the lint rule carries the invariant.

## Migration Plan

Single PR on a feature branch via worktree; `npm test && npm run lint && npm run typecheck` green at every task boundary. Internal refactor — no deployment, config, or data migration. Rollback = revert the PR. Order inside the PR: builder + gate-routed tests first (new code, nothing consumes it yet), then the nine tool migrations, then heuristic deletion + `describeMultiVault` cleanup + test updates, then the lint boundary (only satisfiable once all nine are migrated), then docs sweep (`docs/architecture/fan-out.md`, full `docs/` grep for the three helper names).

## Open Questions

None — all forks resolved in brainstorm Q1–Q8.
