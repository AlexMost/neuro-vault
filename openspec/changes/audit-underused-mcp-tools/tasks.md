# Tasks — audit-underused-mcp-tools

Parallel-safe vs sequential (read by the apply phase's subagent-driven-development):

- **Group 1 (remove the three tools)** — the per-tool file deletes are independent of each other,
  but they all edit two shared files (`tool-names.ts`, and one `tools/index.ts` per module) — do the
  shared-file edits as the single tasks 1.4/1.5, not in parallel.
- **Group 2 (server instructions string)** — single file (`src/server.ts`); depends on nothing,
  parallel-safe with Groups 4–5.
- **Group 3 (tests)** — depends on Groups 1–2.
- **Group 4 (docs + parameter dictionary)** — independent of code; parallel-safe with Groups 1–3, 5.
- **Group 5 (AGENTS.md keep-nudges)** — independent; parallel-safe with everything.
- **Group 6 (quality gates + release)** — sequential, last; depends on all.

## 1. Remove the three tools + registrations + dead code

- [x] 1.1 Delete `src/modules/operations/tools/read-property.ts`. Then grep `readProperty` across `src/`: if `provider.readProperty` / the `ReadProperty*` types in `src/modules/operations/{types.ts,obsidian-cli-provider.ts}` and `src/lib/obsidian/vault-provider.ts` have **no remaining caller**, remove them too; if anything else still calls `readProperty`, keep the provider method and remove only the tool.
- [x] 1.2 Delete `src/modules/operations/tools/list-properties.ts`. **Keep** `provider.listProperties()` (in `vault-provider.ts` / `obsidian-cli-provider.ts`) — `src/lib/obsidian/vault-overview.ts` calls it. Do **not** change `get-vault-overview.ts` or `vault-overview.ts`.
- [x] 1.3 Delete `src/modules/semantic/tools/get-stats.ts`. Remove the now-dead `ToolStats` type and `readEmbeddingDimension` from `src/modules/semantic/types.ts` (and wherever `ToolStats` is referenced). **Keep** `modelKey` — `find_duplicates` still uses it.
- [x] 1.4 In `src/lib/tool-names.ts`: remove `'read_property'`, `'list_properties'`, and `'get_stats'` from `TOOL_NAMES` (the `ToolName` union narrows automatically — `tsc --noEmit` will then flag every stale reference).
- [x] 1.5 Remove the three tools from their module barrels: `read_property` + `list_properties` from `src/modules/operations/tools/index.ts`, and `get_stats` from `src/modules/semantic/tools/index.ts` (drop the `build*Tool` imports and their entries in the constructed tool arrays). Confirm `src/server.ts` registers tools via these barrels (no direct `build*Tool` calls to remove there).

## 2. Server external-agent instructions string (`src/server.ts`)

- [x] 2.1 Scrub the instructions-template string in `src/server.ts` of the removed tools: drop `list_properties` from the "fall back to … or exploratory `query_notes`" line (~58) and the `get_vault_overview` orientation line (~137); in the properties paragraph (~82) drop `read_property` from the `set_property, read_property, remove_property` list and delete the "Use `list_properties` to see what property names are in use" sentence; reword the "replaces N `read_property` calls" note (~86) to describe `read_notes({ fields: ['frontmatter'] })` on its own; remove `list_properties` from the multi-vault fan-out list (~148). Leave `set_property`/`remove_property`/`list_tags`/`get_vault_overview` intact.

## 3. Tests (delete removed-tool suites; fix shared references)

- [x] 3.1 Delete `test/operations/tools/read-property.test.ts`, `test/operations/tools/list-properties.test.ts`, and `test/semantic/tools/get-stats.test.ts`.
- [x] 3.2 Update shared/server tests that reference the removed tools: `test/server-modules.test.ts`, `test/server-instructions.test.ts` (assertions on the instructions string from Group 2), `test/operations/tools.test.ts`, `test/operations/tools/_helpers.ts`, `test/operations/operations-module.test.ts`, `test/operations/obsidian-cli-provider.test.ts`, and `test/lib/obsidian/vault-overview.test.ts` — remove expectations for the three tool names while keeping the `provider.listProperties` coverage that backs `get_vault_overview`. Add/adjust an assertion that the registered tool set no longer contains `read_property` / `list_properties` / `get_stats` (covers the spec's "not registered" scenarios).
- [x] 3.3 Grep `read_property|list_properties|get_stats` across `test/` and confirm no stale reference remains.

## 4. Live docs + parameter dictionary (frozen `docs/superpowers/` untouched)

- [x] 4.1 `docs/guide/routing.md`: remove `read_property` from the structural-tools rule of thumb (~7); re-route the "What's the status of Quarterly review?" example (~18) away from `read_property` to `read_notes({ paths: ["…"], fields: ["frontmatter"] })` (resolve title→path first, consistent with the existing "Q1 OKRs" example) or `query_notes`.
- [x] 4.2 `docs/guide/vault-operations.md`: delete the `### read_property` (~215) and `### list_properties` (~243) sections; drop `list_properties` from the fan-out tools list (~9); reword the "replaces N `read_property` calls" line (~38) and the "`list_tags + list_properties + exploratory query_notes` ritual" line (~259).
- [x] 4.3 `docs/guide/semantic-search.md`: remove the `## get_stats` section (~239); drop `read_property` from the structural-tools line (~250).
- [x] 4.4 `docs/guide/README.md` (~8) and `README.md` (~166): drop `get_stats` from the Semantic Search tool list. `README.md` (~145): drop `list_properties` from the fan-out tools list.
- [x] 4.5 `docs/guide/configuration.md` (~32): re-word the "check that `get_stats` shows a non-zero `totalNotes`" troubleshooting tip to a still-available check (e.g. confirm `search_notes` returns results / the Smart Connections corpus path is configured).
- [x] 4.6 `docs/guide/installation.md` (~87): drop `list_properties` from the "probe the vault structure (`list_tags`, `list_properties`, exploratory `query_notes`)" line.
- [x] 4.7 `docs/architecture/module-structure.md` (~10): update tool counts (operations 12 → 10, semantic 4 → 3) and remove `read_property` + `list_properties` from the frontmatter-properties group.
- [x] 4.8 `docs/architecture/mcp-parameter-dictionary.md`: remove `read_property` from the "Used by" lists for the `path` (~11), `name` (~15), and `key` (~16) concepts and from the `.md` auto-append rule (~24).
- [x] 4.9 `docs/architecture/note-path-resolution.md` (~11): remove `read_property` from the list of tools using `normalizeNotePath`.
- [x] 4.10 `docs/architecture/query.md` (~64–65): update the forward-looking note that references `read_property` / `list_properties` migrating onto the scan pipeline (those tools no longer exist).
- [x] 4.11 Final grep `read_property|list_properties|get_stats` across `docs/guide/`, `docs/architecture/`, `README.md`, `AGENTS.md` — confirm zero remaining live references (matches the spec acceptance).

## 5. AGENTS.md keep-nudges for the three retained tools

- [x] 5.1 Add a short "when to reach for it" note to `AGENTS.md` for the kept-but-rare tools: `get_note_links` (traverse the wikilink graph around a note — incoming/outgoing edges, incl. unresolved targets), `find_duplicates` (vault-wide all-pairs near-duplicate sweep for hygiene), `remove_property` (the only way to _delete_ a frontmatter key). Keep it terse and in the cheat-sheet style.

## 6. Quality gates + release

- [ ] 6.1 Run `npm test`, `npm run lint`, `npx tsc --noEmit` — all green. The vitest count drops by exactly the three deleted suites (intentional, per the baseline spec); `tsc --noEmit` confirms no stale `ToolName`/registration/type references survive.
- [ ] 6.2 Confirm the breaking change is captured for a major release: a `BREAKING CHANGE:` footer listing the three removed tools and their replacement (or accepted loss), so `npm run release` on `main` cuts **11.0.0**.
