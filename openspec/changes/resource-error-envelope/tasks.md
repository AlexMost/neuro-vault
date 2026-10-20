# Tasks — resource-error-envelope

One PR, `Closes #214`. The groups are sequential: 2 describes what 1 builds, and 3 is last.

## 1. The mapping (sequential)

- [ ] 1.1 `src/lib/resource-registry.ts`: the handler wrapper maps a `ToolHandlerError` to a `ResourceReadError` (code `-32603`, same message, `data: { code, details? }`, original as `cause`) and rethrows anything else (design D1–D4). Tests in `test/lib/resource-registry.test.ts`, through a real `McpServer` and SDK `Client` over `InMemoryTransport`: an error with details, one without, the cause absent from the client's error, and a plain `Error` with no `data`.
- [ ] 1.2 The overview resource on the wire: a test in `test/operations/resources/vault-overview.test.ts` that reads `vault://overview` through `registerResource` and a real server and client while the graph read fails, and gets `data: { code: 'DEPENDENCY_ERROR', details: { vault, operation: 'vault://overview' } }`.

## 2. ADR and docs (sequential, needs 1)

- [ ] 2.1 `docs/adr/0023-resource-errors-carry-the-error-code.md` (design D5), and ADR-0003's row in `docs/adr/INDEX.md`.
- [ ] 2.2 `docs/architecture/mcp-server-shape.md` (resource errors), `docs/architecture/wikilink-graph.md` and `docs/guide/reading-and-modifying.md` (the resource is no longer message-only).

## 3. Gates, verify, archive (sequential, last)

- [ ] 3.1 Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`, `npx commitlint --from origin/main --to HEAD`.
- [ ] 3.2 verify → retrospective → archive (`openspec archive resource-error-envelope`) → PR with `Closes #214`.
