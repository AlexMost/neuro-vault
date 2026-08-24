# Restore list_properties Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development
> to implement this plan task-by-task.
>
> NOTE: the `superpowers:writing-plans` skill was unavailable in this
> session; per user opt-in this plan was written manually. The
> implementation itself was completed in the working tree ahead of this
> formalization — completed steps are checked and kept for the record;
> only Task 4's release steps remain.

**Goal:** Re-expose the `list_properties` MCP tool so consumers get the complete, untruncated frontmatter-property inventory that `get_vault_overview` (top-30) cannot provide.

**Architecture:** Near-verbatim revert of the v10 tool wrapper over the still-living `provider.listProperties()`, mirroring `list_tags` (shared `vault` param, `runFanOut` multi-vault fan-out, `{ vault, results: [{name, count}] }`). The orientation-vs-audit split is encoded in the tool descriptions and server instructions.

**Tech Stack:** TypeScript (strict, ESM), zod input schemas, vitest, MCP over stdio.

---

## Task 1: Tool restoration

- [x] **Step 1:** Restore `src/modules/operations/tools/list-properties.ts` from `907b70d^`, updating the description to promise the complete inventory, contrast with `get_vault_overview` truncation, and name the consistency-audit use case
- [x] **Step 2:** Add `'list_properties'` to `TOOL_NAMES` in `src/lib/tool-names.ts`, after `'list_tags'`
- [x] **Step 3:** Import and register `buildListPropertiesTool` in `src/modules/operations/tools/index.ts`, after `list_tags`
- [x] **Step 4:** Re-add `ListPropertiesToolInput` and `listProperties` to `src/modules/operations/types.ts`

## Task 2: Tests

- [x] **Step 1:** `test/operations/tools.test.ts` — registration array 10 → 11 names; new description test (`/ALL frontmatter properties/`, `/complete inventory/i`, `/get_vault_overview/`, `/count/i`)
- [x] **Step 2:** `test/server-modules.test.ts` — add `list_properties` to both registered-name arrays, flip absence assertions to presence, retitle "thirteen tools (3 semantic + 10 operations)" → "fourteen tools (3 semantic + 11 operations)"
- [x] **Step 3:** `test/operations/operations-module.test.ts` — `result.tools.length` 10 → 11

## Task 3: Descriptions, instructions, docs

- [x] **Step 1:** `src/modules/operations/tools/get-vault-overview.ts` — "(top entries only — use `list_properties` for the full inventory)"
- [x] **Step 2:** `src/server.ts` — probe-step fallback list, Frontmatter properties section paragraph, orientation hint, multi-vault fan-out list
- [x] **Step 3:** `README.md` — multi-vault fan-out tool list
- [x] **Step 4:** `docs/guide/reading-and-modifying.md` — new `### list_properties` section, `get_vault_overview` cross-reference, fan-out failure note

## Task 4: Verify and release

- [x] **Step 1:** Gates: `npx tsc --noEmit` clean; `npm run lint` clean; `npx vitest run` — 748/748 green (count did not drop)
- [ ] **Step 2:** Commit `feat(tools): restore list_properties` (include this change's OpenSpec artifacts), open PR to `main`
- [ ] **Step 3:** After merge: `npm run release` on `main` → 12.1.0; archive this change (`/opsx:archive`); notify the downstream consumer
