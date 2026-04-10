# Neuro Vault MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public npm package that exposes an MCP server over stdio for semantic search in an Obsidian vault powered by Smart Connections `.ajson` data.

**Architecture:** A single published package exposes one CLI entrypoint, `neuro-vault-mcp`, which requires `--vault /absolute/path/to/vault`. Startup flow is: parse config, validate vault path, load Smart Connections note data into memory, initialize query embedding with Smart Connections' default `bge-micro-v2` model through `@xenova/transformers`, and register MCP tools that delegate to focused modules. The codebase stays modular so loader, search, embedding, and MCP boundaries remain independently testable.

**Tech Stack:** TypeScript, Node.js 20 LTS, npm, `@modelcontextprotocol/sdk`, `@xenova/transformers`, Vitest, tsup, ESLint, Prettier

---

## File Structure

- Modify: `package.json`
- Create: `README.md`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `src/config.ts`
- Create: `src/types.ts`
- Create: `src/smart-connections-loader.ts`
- Create: `src/embedding-service.ts`
- Create: `src/search-engine.ts`
- Create: `src/tool-handlers.ts`
- Create: `src/server.ts`
- Create: `test/config.test.ts`
- Create: `test/search-engine.test.ts`
- Create: `test/smart-connections-loader.test.ts`
- Create: `test/embedding-service.test.ts`
- Create: `test/tool-handlers.test.ts`
- Create: `test/server-smoke.test.ts`
- Create: `test/fixtures/vault/.smart-env/multi/note-a.ajson`
- Create: `test/fixtures/vault/.smart-env/multi/note-b.ajson`
- Create: `test/fixtures/vault/.smart-env/multi/note-c.ajson`

### Task 1: Scaffold the package and developer tooling

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`

- [ ] **Step 1: Write the failing tooling expectations**

Document the expected package shape inside `package.json` tests-by-inspection comments in the plan before editing:

```json
{
  "type": "module",
  "bin": {
    "neuro-vault-mcp": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "lint": "eslint .",
    "format": "prettier --check .",
    "format:write": "prettier --write .",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Run install command and verify the repo is not ready yet**

Run: `npm test`
Expected: fail because no tests or build/test tooling exist yet

- [ ] **Step 3: Write the minimal package/tooling implementation**

Apply these decisions:

- set package name to `neuro-vault-mcp`
- switch package type to `module`
- add `exports` and `bin`
- add `files: ["dist", "README.md"]`
- add runtime dependencies for MCP SDK and transformers
- add dev dependencies for TypeScript, `@types/node`, tsup, Vitest, ESLint, Prettier, and tsx
- configure Node 20+ in `engines`

Starter `tsconfig.json` shape:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "tsup.config.ts"]
}
```

- [ ] **Step 4: Verify the tooling boots**

Run:
- `npm install`
- `npm run lint`
- `npm run test`

Expected:
- install succeeds
- lint succeeds or reports only missing source files that will be created next
- test runner starts successfully even if current test suite is incomplete

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts eslint.config.js .prettierrc.json .gitignore
git commit -m "chore: scaffold neuro vault mcp package tooling"
```

### Task 2: Define shared types and CLI config parsing

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing config tests**

Add tests for:

- missing `--vault` throws a user-facing error
- non-absolute vault path throws
- valid absolute path returns normalized config
- default model key is `bge-micro-v2`

Example assertion shape:

```ts
expect(() => parseConfig(["node", "cli.js"])).toThrow("--vault")
expect(parseConfig(["node", "cli.js", "--vault", "/tmp/vault"]).vaultPath).toBe("/tmp/vault")
```

- [ ] **Step 2: Run config tests to verify failure**

Run: `npm test -- test/config.test.ts`
Expected: fail because `src/config.ts` and `src/types.ts` do not exist

- [ ] **Step 3: Write minimal implementation**

Define shared types for:

- `SmartBlock`
- `SmartSource`
- `SearchResult`
- `DuplicatePair`
- `ServerConfig`
- `EmbeddingProvider`

Implement `parseConfig(argv)` with:

- required `--vault`
- absolute path validation
- derived `smartEnvPath = <vault>/.smart-env/multi`
- `modelKey = "bge-micro-v2"`

- [ ] **Step 4: Run tests to verify pass**

Run:
- `npm test -- test/config.test.ts`
- `npm run lint`

Expected: all green

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: add typed config parsing"
```

### Task 3: Load and normalize Smart Connections data

**Files:**
- Create: `src/smart-connections-loader.ts`
- Test: `test/smart-connections-loader.test.ts`
- Create: `test/fixtures/vault/.smart-env/multi/note-a.ajson`
- Create: `test/fixtures/vault/.smart-env/multi/note-b.ajson`
- Create: `test/fixtures/vault/.smart-env/multi/note-c.ajson`

- [ ] **Step 1: Write the failing loader tests**

Cover:

- all `.ajson` files in the directory are discovered
- raw JSON is normalized into vault-relative POSIX note paths
- note vectors are loaded as numeric arrays
- blocks are preserved for result display
- invalid `.ajson` files fail startup immediately with a clear error instead of being skipped silently

Fixture data should be intentionally small and deterministic, for example:

```json
{
  "path": "Folder/note-a.md",
  "embedding": [1, 0, 0],
  "blocks": [{ "text": "alpha concept" }]
}
```

- [ ] **Step 2: Run loader tests to verify failure**

Run: `npm test -- test/smart-connections-loader.test.ts`
Expected: fail because loader implementation does not exist

- [ ] **Step 3: Write minimal implementation**

Implement a loader with:

- directory existence validation
- `.ajson` discovery
- JSON parsing
- normalization into `Map<string, SmartSource>`
- stats helpers for total notes, blocks, and embedding dimension
- fail-fast behavior when a file cannot be parsed or does not contain a usable note path or embedding vector
- fail-fast behavior when the final corpus contains zero usable notes

Keep raw Smart Connections parsing isolated in one function so future format drift is localized.

- [ ] **Step 4: Run tests to verify pass**

Run:
- `npm test -- test/smart-connections-loader.test.ts`
- `npm run lint`

Expected: all green

- [ ] **Step 5: Commit**

```bash
git add src/smart-connections-loader.ts test/smart-connections-loader.test.ts test/fixtures/vault/.smart-env/multi
git commit -m "feat: add smart connections data loader"
```

### Task 4: Build the search engine

**Files:**
- Create: `src/search-engine.ts`
- Test: `test/search-engine.test.ts`

- [ ] **Step 1: Write the failing search-engine tests**

Cover:

- cosine similarity for identical, orthogonal, and opposite vectors
- `findNeighbors` returns sorted results above threshold
- `findNeighbors` respects `limit`
- `findNeighbors` can exclude the source note path
- `findDuplicates` returns only pairs above threshold

Example expectations:

```ts
expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
```

- [ ] **Step 2: Run search-engine tests to verify failure**

Run: `npm test -- test/search-engine.test.ts`
Expected: fail because search engine implementation does not exist

- [ ] **Step 3: Write minimal implementation**

Implement:

- `cosineSimilarity(a, b)`
- `findNeighbors({ queryVector, sources, threshold, limit, excludePath })`
- `findDuplicates({ sources, threshold })`

Behavior constraints:

- reject mismatched vector dimensions
- never return the excluded note
- sort descending by similarity
- slice after sorting

- [ ] **Step 4: Run tests to verify pass**

Run:
- `npm test -- test/search-engine.test.ts`
- `npm run lint`

Expected: all green

- [ ] **Step 5: Commit**

```bash
git add src/search-engine.ts test/search-engine.test.ts
git commit -m "feat: add vector search engine"
```

### Task 5: Add the embedding service abstraction

**Files:**
- Create: `src/embedding-service.ts`
- Modify: `src/types.ts`
- Create: `test/embedding-service.test.ts`

- [ ] **Step 1: Write the failing embedding-service tests**

Cover:

- the service exposes `initialize()` and `embed(text)`
- blank query text is rejected before model invocation
- the transformers pipeline dependency is called with `pooling: "mean"` and normalized output
- model initialization happens once even if `initialize()` is called repeatedly

Mock the transformers pipeline instead of loading a real model:

```ts
const pipelineFactory = vi.fn()
pipelineFactory.mockResolvedValue(mockPipeline)
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/embedding-service.test.ts`
Expected: fail because `src/embedding-service.ts` does not exist

- [ ] **Step 3: Write minimal implementation**

Implement `EmbeddingService` as a thin wrapper that:

- exposes `initialize()`
- exposes `embed(text)`
- loads Smart Connections-compatible `bge-micro-v2` through `@xenova/transformers`
- centralizes pooling and normalization settings

Design it so tests can inject a mock `EmbeddingProvider` and avoid model downloads.

- [ ] **Step 4: Run targeted tests to verify pass**

Run:
- `npm test -- test/embedding-service.test.ts`
- `npm run lint`

Expected: embedding-service tests pass without downloading a real model

- [ ] **Step 5: Commit**

```bash
git add src/embedding-service.ts src/types.ts test/embedding-service.test.ts
git commit -m "feat: add embedding service abstraction"
```

### Task 6: Implement MCP tool handlers

**Files:**
- Create: `src/tool-handlers.ts`
- Modify: `src/types.ts`
- Test: `test/tool-handlers.test.ts`

- [ ] **Step 1: Expand failing handler tests**

Cover:

- `search_notes` returns ranked note results
- `search_notes` rejects empty query
- `search_notes` surfaces embedding-provider failures as structured tool errors
- `get_similar_notes` rejects unknown `note_path`
- `get_similar_notes` excludes the source note from results
- `find_duplicates` returns matching pairs
- `get_stats` returns `totalNotes`, `totalBlocks`, `embeddingDimension`, and `modelKey`

Use fixture loader data and a mocked embedding provider.

- [ ] **Step 2: Run handler tests to verify failure**

Run: `npm test -- test/tool-handlers.test.ts`
Expected: fail because tool handler functions are incomplete

- [ ] **Step 3: Write minimal implementation**

Implement pure handler functions with explicit inputs:

```ts
createToolHandlers({
  loader,
  embeddingProvider,
  searchEngine,
  modelKey,
})
```

Each handler should:

- validate inputs
- call the correct service(s)
- return stable JSON-serializable output
- throw typed, user-facing errors for invalid requests

- [ ] **Step 4: Run tests to verify pass**

Run:
- `npm test -- test/tool-handlers.test.ts`
- `npm run lint`

Expected: all green

- [ ] **Step 5: Commit**

```bash
git add src/tool-handlers.ts src/types.ts test/tool-handlers.test.ts
git commit -m "feat: add neuro vault MCP tool handlers"
```

### Task 7: Wire the MCP stdio server and CLI entrypoint

**Files:**
- Create: `src/server.ts`
- Create: `src/cli.ts`
- Test: `test/server-smoke.test.ts`

- [ ] **Step 1: Write the failing server smoke test**

Cover:

- CLI parses `--vault`
- startup creates loader, embedding service, and handlers
- MCP server registers exactly four tools with the expected names
- startup fails fast when Smart Connections data directory is missing
- startup fails fast when loading finishes with an empty corpus

For the smoke test, prefer constructing the server in-process instead of spawning a real child process.

- [ ] **Step 2: Run smoke test to verify failure**

Run: `npm test -- test/server-smoke.test.ts`
Expected: fail because the server bootstrap does not exist

- [ ] **Step 3: Write minimal implementation**

Implement:

- `createNeuroVaultServer(deps)`
- MCP tool registration for `search_notes`, `get_similar_notes`, `find_duplicates`, `get_stats`
- CLI bootstrap with shebang and `main()` wrapper
- startup sequence: parse config, load corpus, initialize model, start stdio server
- fail-fast startup error when the loaded corpus is empty

Keep `src/server.ts` testable by separating server construction from process startup.

- [ ] **Step 4: Run tests and build to verify pass**

Run:
- `npm test -- test/server-smoke.test.ts`
- `npm run test`
- `npm run build`

Expected: all green and `dist/cli.js` emitted

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/cli.ts test/server-smoke.test.ts
git commit -m "feat: add stdio MCP server bootstrap"
```

### Task 8: Write README and package polish

**Files:**
- Create: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Write the failing documentation checklist**

Before editing, verify the README must cover:

- what the package does
- prerequisites: Obsidian vault with Smart Connections data
- install via `npm install -g neuro-vault-mcp`
- launch via `npx -y neuro-vault-mcp --vault /absolute/path/to/vault`
- launch via command line
- MCP client configuration examples
- tool list and parameter reference
- first-run model download note
- first-run model download may add noticeable startup latency

- [ ] **Step 2: Run final quality gate to identify missing docs**

Run:
- `npm run build`
- `npm run lint`
- `npm run format`
- `npm run test`

Expected: if any of these fail, fix code before documenting release usage

- [ ] **Step 3: Write minimal implementation**

Add `README.md` sections:

- Overview
- Requirements
- Installation
- MCP configuration example
- CLI usage
- Available tools
- Development commands
- Limitations for v1

Example MCP config snippet:

```json
{
  "command": "neuro-vault-mcp",
  "args": ["--vault", "/absolute/path/to/vault"]
}
```

Also ensure `package.json` metadata is release-friendly:

- description
- keywords
- license
- repository

- [ ] **Step 4: Run final verification**

Run:
- `npm run format:write`
- `npm run lint`
- `npm run test`
- `npm run build`

Expected: all green, ready for manual publish flow

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "docs: add usage guide for neuro vault MCP"
```

### Task 9: Pre-publish verification

**Files:**
- Modify as needed: any files touched in earlier tasks

- [ ] **Step 1: Verify package contents**

Run:
- `npm pack --dry-run`

Expected:
- tarball contains `dist/`, `README.md`, and package metadata
- tarball does not contain tests or raw fixture vault data unless intentionally included

- [ ] **Step 2: Verify CLI help and startup path**

Run:
- `node dist/cli.js --vault /tmp/nonexistent`

Expected:
- clean startup error explaining that the vault or `.smart-env/multi` path is missing

- [ ] **Step 3: Verify end-to-end repo quality**

Run:
- `npm run lint`
- `npm run test`
- `npm run build`

Expected: all green

- [ ] **Step 4: Write release notes draft**

Capture:

- package purpose
- supported MCP tools
- requirement for Smart Connections-generated `.ajson` files
- first-run model download behavior

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: finalize neuro vault mcp v1 release prep"
```

## Implementation Notes

- Keep path handling platform-safe internally, but always expose vault-relative POSIX paths in tool APIs.
- Do not let raw Smart Connections JSON shape leak beyond the loader boundary.
- Do not load the real transformers model in unit tests.
- Prefer small pure functions in loader, search, and handlers so failures stay localized.
- If Smart Connections fixture shape differs from the concept doc, update the loader normalization tests first, then adapt the implementation.

## Verification Checklist

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm pack --dry-run`

## Definition of Done

- Public package layout is publishable
- CLI binary can be launched by an MCP host over stdio
- All four tools behave as specified in the approved design
- README explains installation, MCP configuration, and tool usage
- Tests, lint, and build pass locally
