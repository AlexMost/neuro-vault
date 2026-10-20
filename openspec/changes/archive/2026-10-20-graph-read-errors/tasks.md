# Tasks — graph-read-errors

One PR, `Closes #212`. Groups 1 and 2 are parallel-safe with each other
(`src/lib/tool-graph.ts` vs. `src/modules/semantic/graph/`). Group 3 needs 1. Its tasks touch
disjoint files, so they are parallel-safe with each other. Group 4 is last.

## 1. The mapping helper (parallel-safe with 2)

- [x] 1.1 `src/lib/tool-graph.ts` `graphForTool(entry, operation, warn?)` (design D1). Unit tests in `test/lib/tool-graph.test.ts`: each of the three reads delegates its arguments and answer; a `GraphReadError` from each read becomes `DEPENDENCY_ERROR` / `Graph read failed` / `details: { vault, operation }` with the error as `cause`, and `warn` gets one line naming the operation, vault and cause message; a non-`GraphReadError` rejection is rethrown as itself with no `warn`.

## 2. The `--no-semantic` graph (parallel-safe with 1)

- [x] 2.1 `src/modules/semantic/graph/standalone-reader.ts` `createStandaloneGraphReader(graph)` (design D2), exported from `graph/index.ts`, used by `createLexicalOnlyVaultFactories().graphFactory`. Tests: reads answer as `createGraphReader` does; a rejecting `ensureFresh()` rejects each read with a `GraphReadError` whose `cause` is the original error; a `GraphReadError` passes through as itself.

## 3. The consumers (needs 1; tasks parallel-safe with each other)

- [x] 3.1 `search_notes`: stamp backlinks through `graphForTool(entry, 'search_notes', warn)`. Gate tests: single-vault failure → `DEPENDENCY_ERROR` with details and the cause on `warn` only; a two-vault fan-out lists the failing vault in `failed_vaults` with that code, message and details while the other vault answers.
- [x] 3.2 `get_note_links`: `graphForTool(entry, 'get_note_links')`. Gate test: single-vault failure → `DEPENDENCY_ERROR`, cause on stderr (`console.error` spy), not in the message.
- [x] 3.3 `get_vault_overview` and the overview resource: `graphForTool(entry, 'get_vault_overview')` and `graphForTool(entry, uri)`. Tests: the tool, single vault and a fan-out `failed_vaults` entry; the resource handler rejects with `DEPENDENCY_ERROR` and `operation` equal to its URI.
- [x] 3.4 `query_notes`: `graphForTool(entry, 'query_notes')`. Gate tests: single vault and a fan-out `failed_vaults` entry.
- [x] 3.5 `read_daily`: `graphForTool(entry, 'read_daily')`. Gate test: single-vault failure → `DEPENDENCY_ERROR`.
- [x] 3.6 `get_similar_notes`: the forward-link resolver is `graphForTool(entry, 'get_similar_notes')`. Gate test: a failing `resolve` → `DEPENDENCY_ERROR`. An ENOENT on the note still → `NOT_FOUND`.

## 4. Docs, verify, archive (sequential, last)

- [x] 4.1 Docs: `docs/architecture/wikilink-graph.md` (an Errors paragraph: the view and the standalone reader throw `GraphReadError`, and `graphForTool` maps it; consumer table and `--no-semantic` wiring), `docs/architecture/vault-registry.md` (`graph` failures), `docs/guide/finding-notes.md` and `docs/guide/reading-and-modifying.md` (what a client sees). `IRegisteredVault.graph` doc comment points to `graphForTool`.
- [x] 4.2 Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`, `npx commitlint --from origin/main --to HEAD`.
- [x] 4.3 verify → retrospective → archive (`openspec archive graph-read-errors`) → PR with `Closes #212`.
