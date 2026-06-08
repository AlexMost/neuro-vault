# Trim Underused MCP Tools — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Tests are vitest; prefer DI over module-level mocks. Run `npm test`,
> `npm run lint`, and `npx tsc --noEmit` at each commit point — `tsc --noEmit` is authoritative
> (isolatedModules).
>
> Plan authored directly from tasks.md + design.md (the writing-plans skill's decomposition,
> applied manually) — the work is mechanical removal + doc scrub, the code seams are known, and the
> `ToolName` union makes the compiler the completeness check.
>
> **TDD shape for a removal:** the "RED" signal is the compiler. Remove a name from
> `TOOL_NAMES` → `tsc --noEmit` lights up every stale reference → clean until green. For the spec's
> "tool is not registered" scenarios, write the assertion first (it passes once the tool is gone).

**Goal:** Remove the three audited-as-removable tools (`read_property`, `list_properties`,
`get_stats`) from the MCP surface, keep the three unique ones (`get_note_links`, `find_duplicates`,
`remove_property`) with `AGENTS.md` nudges, and leave code, tests, and live docs internally
consistent — a breaking change shipping as **11.0.0**.

**Architecture:** Tools are registered through each module's `tools/index.ts` barrel and enumerated
in `src/lib/tool-names.ts` (`TOOL_NAMES` → derived `ToolName` union). Removing a tool = delete its
file, drop it from the barrel + `TOOL_NAMES`, prune code that only it used, and scrub the
agent-facing instructions string in `src/server.ts` plus the live docs. `get_vault_overview` and
`provider.listProperties()` are deliberately untouched.

**Tech Stack:** TypeScript (ESM, strict), Zod input schemas, vitest, tsup build.

---

## Task 1: Remove `read_property`

- [ ] **Step 1:** Delete `src/modules/operations/tools/read-property.ts`.
- [ ] **Step 2:** Remove `'read_property'` from `TOOL_NAMES` in `src/lib/tool-names.ts`.
- [ ] **Step 3:** Remove the `read_property` import + array entry from `src/modules/operations/tools/index.ts`.
- [ ] **Step 4:** `grep -rn "readProperty" src/` — if `provider.readProperty` has no remaining caller, remove it from `src/lib/obsidian/vault-provider.ts`, `src/modules/operations/obsidian-cli-provider.ts`, and the `ReadProperty*` shapes in `src/modules/operations/types.ts`. If a caller remains, keep the method and stop here.
- [ ] **Step 5:** `npx tsc --noEmit` → fix any references it surfaces (expect test-only refs, handled in Task 5).
- [ ] **Commit:** `feat(operations)!: remove read_property tool (covered by read_notes frontmatter)`

## Task 2: Remove `list_properties`

- [ ] **Step 1:** Delete `src/modules/operations/tools/list-properties.ts`.
- [ ] **Step 2:** Remove `'list_properties'` from `TOOL_NAMES`.
- [ ] **Step 3:** Remove the `list_properties` import + array entry from `src/modules/operations/tools/index.ts`.
- [ ] **Step 4:** Confirm `provider.listProperties()` is **still present** and that `src/lib/obsidian/vault-overview.ts` still calls it (do not touch `get-vault-overview.ts` / `vault-overview.ts`).
- [ ] **Step 5:** `npx tsc --noEmit` → green except test refs.
- [ ] **Commit:** `feat(operations)!: remove list_properties tool (covered by get_vault_overview)`

## Task 3: Remove `get_stats`

- [ ] **Step 1:** Delete `src/modules/semantic/tools/get-stats.ts`.
- [ ] **Step 2:** Remove `'get_stats'` from `TOOL_NAMES`.
- [ ] **Step 3:** Remove the `get_stats` import + array entry from `src/modules/semantic/tools/index.ts`.
- [ ] **Step 4:** Remove the now-dead `ToolStats` type and `readEmbeddingDimension` from `src/modules/semantic/types.ts` (and any reference). Verify `modelKey` is still wired to `find_duplicates` and left intact.
- [ ] **Step 5:** `npx tsc --noEmit` → green except test refs.
- [ ] **Commit:** `feat(semantic)!: remove get_stats tool (corpus diagnostics retired from MCP surface)`

## Task 4: Scrub the server instructions string

- [ ] **Step 1:** In `src/server.ts`, edit the external-agent instructions template: drop `list_properties` from the "fall back to … exploratory `query_notes`" line and the orientation line; in the properties paragraph drop `read_property` from the `set_property, read_property, remove_property` list and delete the "Use `list_properties` to see …" sentence; reword the "replaces N `read_property` calls" note to stand on `read_notes({ fields: ['frontmatter'] })`; remove `list_properties` from the multi-vault fan-out list. Keep `set_property`, `remove_property`, `list_tags`, `get_vault_overview`.
- [ ] **Step 2:** `npx tsc --noEmit` → green (string edits only).
- [ ] **Commit:** `docs(server): drop removed tools from agent instructions string`

## Task 5: Tests — delete removed suites, fix shared refs, assert absence

- [ ] **Step 1:** Write/adjust the absence assertions first: in `test/server-modules.test.ts` (or the closest registry test) assert the registered tool set does **not** include `read_property`, `list_properties`, `get_stats`, and **does** include `get_note_links`, `find_duplicates`, `remove_property` (covers the spec scenarios).
- [ ] **Step 2:** Delete `test/operations/tools/read-property.test.ts`, `test/operations/tools/list-properties.test.ts`, `test/semantic/tools/get-stats.test.ts`.
- [ ] **Step 3:** Fix shared references: `test/server-instructions.test.ts` (instructions-string assertions from Task 4), `test/operations/tools.test.ts`, `test/operations/tools/_helpers.ts`, `test/operations/operations-module.test.ts`, `test/operations/obsidian-cli-provider.test.ts`, and `test/lib/obsidian/vault-overview.test.ts` — drop expectations for the removed tool names; keep the `provider.listProperties` coverage that backs `get_vault_overview`.
- [ ] **Step 4:** `grep -rn "read_property\|list_properties\|get_stats" test/` → confirm clean. Run `npx vitest run` → green; note the count dropped by exactly the three deleted suites.
- [ ] **Commit:** `test: drop removed-tool suites and assert trimmed surface`

## Task 6: Live docs + parameter dictionary

- [ ] **Step 1:** `docs/guide/routing.md` — remove `read_property` from the rule of thumb; re-route the "status of Quarterly review?" example to `read_notes({ paths: ["…"], fields: ["frontmatter"] })` (title→path first) or `query_notes`.
- [ ] **Step 2:** `docs/guide/vault-operations.md` — delete the `### read_property` and `### list_properties` sections; drop `list_properties` from the fan-out list; reword the "replaces N read_property calls" and "list_tags + list_properties + … ritual" lines.
- [ ] **Step 3:** `docs/guide/semantic-search.md` — remove the `## get_stats` section; drop `read_property` from the structural-tools line.
- [ ] **Step 4:** `docs/guide/README.md` + `README.md` — drop `get_stats` from the Semantic Search list; drop `list_properties` from `README.md`'s fan-out list.
- [ ] **Step 5:** `docs/guide/configuration.md` — reword the `get_stats` troubleshooting tip to a still-available check (`search_notes` returns results / corpus path configured).
- [ ] **Step 6:** `docs/guide/installation.md` — drop `list_properties` from the vault-probe line.
- [ ] **Step 7:** `docs/architecture/module-structure.md` — update counts (operations 12 → 10, semantic 4 → 3) and the frontmatter-properties group.
- [ ] **Step 8:** `docs/architecture/mcp-parameter-dictionary.md` — remove `read_property` from the `path`/`name`/`key` "Used by" lists and the `.md` auto-append rule.
- [ ] **Step 9:** `docs/architecture/note-path-resolution.md` — remove `read_property` from the `normalizeNotePath` tool list. `docs/architecture/query.md` — update the forward-looking `read_property`/`list_properties` migration note.
- [ ] **Step 10:** `grep -rn "read_property\|list_properties\|get_stats" docs/guide docs/architecture README.md AGENTS.md` → zero live references. (`docs/superpowers/` is frozen — skip.)
- [ ] **Commit:** `docs: remove the three retired tools from guides, architecture, and dictionary`

## Task 7: AGENTS.md keep-nudges

- [ ] **Step 1:** Add a terse "when to reach for it" note in `AGENTS.md` for `get_note_links` (wikilink edge traversal, incl. unresolved targets), `find_duplicates` (vault-wide all-pairs near-duplicate sweep), and `remove_property` (sole frontmatter-key deletion), in the cheat-sheet style.
- [ ] **Commit:** `docs(agents): note when to reach for the kept low-use tools`

## Task 8: Final quality gates + release

- [ ] **Step 1:** `npm test` (full suite — count down only by the three deleted suites), `npm run lint`, `npx tsc --noEmit` → all green.
- [ ] **Step 2:** Ensure a `BREAKING CHANGE:` footer is present on a removal commit, listing the three removed tools and their replacement/accepted-loss, so `npm run release` on `main` cuts **10.1.0 → 11.0.0**.
- [ ] **Step 3:** Open the PR to `main` (`gh pr create`). Acceptance signal: next weekly usage report no longer lists the removed tools under `unusedTools`.
