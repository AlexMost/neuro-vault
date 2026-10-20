# Verification Report

**Change**: `resource-error-envelope`
**Verified at**: `2026-10-20 10:10`
**Verifier**: Claude Opus 5.5, the session that wrote the change. It ran the gates and the
scenario mapping itself. A fresh review subagent read the whole diff against the SDK source. It
found no Critical or Important issues and 2 Minor wording issues, both fixed in `8fa2749` (§4).

Scope: branch `claude/resource-error-envelope`, one PR, `Closes #214`.

### Gates

| Gate | Result |
| --- | --- |
| `npm test` | 2871 passed, 4 skipped (base 2867 passed; +4 tests) |
| `npm run lint` (`eslint .`) | clean |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm run format` | clean |
| `npm run build` | success |
| `npx commitlint --from origin/main --to HEAD` | clean |

## 1. Structural Validation (`openspec validate --all --json`)

- [x] Every item is `"valid": true`: 27 of 27 (1 change, 26 specs).

## 2. Task Completion (`tasks.md`)

- [x] All tasks 1.1–3.2 are ticked. 3.2 (verify → retrospective → archive → PR) is this
  close-out.

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
| --- | --- | --- |
| `tool-response-envelope` | ✗ needs sync | ADDED "A resource read error carries the error code and details"; `openspec archive` syncs it |
| `shared-wikilink-graph` | ✗ needs sync | MODIFIED "A failed graph read is a dependency error"; `openspec archive` syncs it |

## 4. Design / Specs Coherence Spot Check

| Sample | design | specs | Gap |
| --- | --- | --- | --- |
| D2 `data` shape | `{ code }` plus `details` when present | tool-response-envelope: both scenarios | none |
| D3 JSON-RPC code | `-32603` for every `ToolHandlerError` | tool-response-envelope requirement | none |
| D4 message unprefixed | the server sends the bare message | scenarios name the JSON-RPC error message | fixed in `8fa2749` (scenarios said "the client's message", which the SDK client prefixes) |
| Non-`ToolHandlerError` | rethrown unchanged | requirement | fixed in `8fa2749` (said every other error reaches the client with no `data`; true only of a plain `Error`) |

Scenario → test mapping:

| Scenario | Test |
| --- | --- |
| handler error with details | `test/lib/resource-registry.test.ts` › a ToolHandlerError with details reaches the client as data, without its cause |
| handler error without details | › a ToolHandlerError without details has no details key |
| the cause stays off the wire | › …with details… (asserts `daemon did not answer` absent) |
| plain Error | › a plain Error reaches the client with its message and no data |
| overview resource reports the code | `test/operations/resources/vault-overview.test.ts` › vault://overview reports DEPENDENCY_ERROR and details to an SDK client |

All five go through a real `McpServer` and SDK `Client` over `InMemoryTransport`
(`test/_resource-wire.ts`). The reviewer confirmed that the three `data` assertions fail without
the `src` change, since a `ToolHandlerError` has no `data`.

**Drift warnings** (non-blocking): none left.

## 5. Implementation Signal

- [x] No unstaged files in the worktree.
- [ ] Pushed: at PR time.

**Commit range**: `413d6e0..HEAD`

## 6. Front-Door Routing Leak Detector

- [x] No files under `docs/superpowers/specs/`.

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

plan.md has no `[~]` rows.

## Overall Decision

- [x] ✅ PASS — ready for archive and the PR
- [ ] ⚠️ PASS WITH WARNINGS
- [ ] ❌ FAIL

**Next**: retrospective, `openspec archive resource-error-envelope -y`, PR with `Closes #214`.
