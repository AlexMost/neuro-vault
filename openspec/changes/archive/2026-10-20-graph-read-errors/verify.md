# Verification Report

**Change**: `graph-read-errors`
**Verified at**: `2026-10-20 09:50`
**Verifier**: Claude Opus 5.5, the session that wrote the change. It ran the gates and the
scenario mapping itself. A fresh review subagent read the whole diff. It found 1 Important
issue (the resource's wire shape, fixed in the spec and docs, see §4) and 3 Minor ones: one is
fixed, and two are kept on purpose (§4).

Scope: branch `claude/graph-read-errors`, one PR, `Closes #212`.

### Gates

| Gate | Result |
| --- | --- |
| `npm test` | 2867 passed, 4 skipped (base 2841 passed; +26 tests) |
| `npm run lint` (`eslint .`) | clean |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm run format` | clean |
| `npm run build` | success |
| `npx commitlint --from origin/main --to HEAD` | clean |

The eval was not run. The change touches no ranking code: `runRetrievalPipeline`, the lexical
leg and fusion are unchanged, and the eval harness does not go through the tool handlers it
edits.

## 1. Structural Validation

`npx openspec validate graph-read-errors`: valid.

## 2. Task Completion

All tasks 1.1–4.2 are ticked. 4.3 (verify → retrospective → archive → PR) is this close-out.

## 3. Delta Spec Sync State

There is one ADDED requirement in `shared-wikilink-graph`, "A failed graph read is a
dependency error". `openspec archive` syncs it.

## 4. Design / Specs Coherence Spot Check

| Scenario | Test |
| --- | --- |
| A single-vault call fails with DEPENDENCY_ERROR | `get-note-links.test.ts` "a failed graph read is DEPENDENCY_ERROR…" (envelope `toEqual`, stderr line exact) |
| A fan-out lists the vault in failed_vaults | `search-notes.test.ts` "graph read failure › in a multi-vault fan-out…"; the same shape in `get-vault-overview.test.ts` and `query-notes.test.ts` |
| Every tool maps the failure | `get-vault-overview`, `query-notes`, `read-daily`, `get-similar-notes` tests (single vault) |
| The overview resource hides the cause | `resources/vault-overview.test.ts` "…a failed graph read" (both URIs; the stderr line carries the URI) |
| A failed no-semantic build is a graph read failure | `semantic/graph/standalone-reader.test.ts`; `lexical-only-factories.test.ts` "a failed build reads as a GraphReadError" |
| Other errors pass through | `lib/tool-graph.test.ts` "rethrows any other error…"; `get-similar-notes.test.ts` "a query note missing on disk is still NOT_FOUND" |

Mutation check: with the `instanceof GraphReadError` mapping in `graphForTool` disabled, all 11
new consumer tests failed.

Review findings:
- **Important, fixed in spec and docs.** A resource read has no tool envelope. The MCP SDK
  answers a thrown `ToolHandlerError` as JSON-RPC `InternalError` with the message only. The
  spec, design (D4), proposal and docs now say that a resource client sees
  `Graph read failed`, and that the code and URI reach only stderr. A structured resource
  error is a separate change.
- **Minor, fixed.** `search_notes`' warn assertion is now `toHaveBeenCalledExactlyOnceWith`.
- **Minor, kept.** The fan-out test renames a vault after the registry is built. It mirrors
  the lexical failure test beside it.
- **Minor, kept.** Under `--no-semantic` the stderr line reads "…: graph read failed: <reason>".
  It mirrors the standalone lexical reader's "lexical search failed: <reason>".

## 5. Implementation Signal

`graphForTool` (`src/lib/tool-graph.ts`) has seven call sites, one per consumer. The reviewer's
grep found no remaining direct `entry.graph` read outside the daemon and vault-entry code.

## 6. Front-Door Routing Leak Detector

Routed to opsx because an error code on the wire is tool contract
(`.claude/rules/opsx-routing.md`). It is tracked by #212.

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

None deferred. A real daemon timeout is simulated by a `GraphReadError` at the reader seam.
The view's own mapping of timeouts and dropped connections to `GraphReadError` is already
covered by `test/semantic/graph/view.test.ts`.

## Overall Decision

**PASS.**
