---
status: accepted
date: 2026-04-29
---

# Extract `src/lib/obsidian/`

## Goal

Consolidate Obsidian-vault-format-aware code (frontmatter parsing, vault I/O abstractions, Smart Connections corpus loader, query engine internals, path normalization) into a single library directory `src/lib/obsidian/`. **Zero behavior change.** The MCP public API is untouched.

This spec is a foundation for [`2026-04-29-get-similar-notes-graph-signals-design.md`](./2026-04-29-get-similar-notes-graph-signals-design.md), which adds wikilink parsing and forward-link resolution. Those new utilities land in `lib/obsidian/` from day one — but only after this refactor lands first.

## Motivation

Obsidian-format knowledge is currently scattered:

- `src/modules/operations/frontmatter.ts` — YAML frontmatter splitter
- `src/modules/operations/vault-reader.ts` — `VaultReader` interface + `FsVaultReader`
- `src/modules/operations/vault-provider.ts` — `VaultProvider` interface + types
- `src/modules/operations/query/{types,note-record,whitelist,query-notes}.ts` — query engine
- `src/modules/semantic/smart-connections-loader.ts` — `.ajson` corpus parser
- Vault path normalization scattered across **four** files with inconsistent names but overlapping semantics: `normalizePath` (operations/tool-helpers.ts), `normalizeNotePath` (semantic/tool-helpers.ts), `toPosix` + `normalizeScanPrefix` (operations/vault-reader.ts), `toPosixPath` (semantic/smart-connections-loader.ts)

Putting all of this in `src/lib/obsidian/` makes the boundary explicit (vault-format vs. MCP tool layer), de-duplicates path utilities, and gives Spec 2 a clean home for new wikilink code without it leaking into `semantic/` or `operations/`.

## Principle: what moves

A file moves to `lib/obsidian/` if **all** of these are true:

1. Its concerns are purely about the Obsidian vault format (parsing, types, I/O abstraction).
2. It has no MCP-server coupling — does not throw `ToolHandlerError`, does not bind input schemas, does not register tools.
3. It does not own DI wiring for a module.

A file stays where it is if any of these is true:

1. It is an MCP tool handler (`tools/*.ts`).
2. It is module wiring (`createXxxModule`, registration aggregation).
3. It throws `ToolHandlerError` (MCP-error mapping is not Obsidian-format knowledge).
4. It binds together vault-format logic with non-format concerns (e.g. subprocess orchestration).

## Scope — file-by-file

### Moves (verbatim, only path changes)

| From                                               | To                                             |
| -------------------------------------------------- | ---------------------------------------------- |
| `src/modules/operations/frontmatter.ts`            | `src/lib/obsidian/frontmatter.ts`              |
| `src/modules/operations/vault-reader.ts`           | `src/lib/obsidian/vault-reader.ts`             |
| `src/modules/operations/vault-provider.ts`         | `src/lib/obsidian/vault-provider.ts`           |
| `src/modules/operations/query/types.ts`            | `src/lib/obsidian/query/types.ts`              |
| `src/modules/operations/query/note-record.ts`      | `src/lib/obsidian/query/note-record.ts`        |
| `src/modules/operations/query/whitelist.ts`        | `src/lib/obsidian/query/whitelist.ts`          |
| `src/modules/operations/query/query-notes.ts`      | `src/lib/obsidian/query/query-notes.ts`        |
| `src/modules/operations/query/index.ts`            | `src/lib/obsidian/query/index.ts`              |
| `src/modules/semantic/smart-connections-loader.ts` | `src/lib/obsidian/smart-connections-loader.ts` |

### New file: `src/lib/obsidian/paths.ts`

Single source of truth for vault path normalization. Absorbs and unifies the helpers currently scattered across four files:

| Source                                 | Function              | Canonical name in `paths.ts` |
| -------------------------------------- | --------------------- | ---------------------------- |
| `operations/tool-helpers.ts`           | `normalizePath`       | `normalizeVaultPath`         |
| `semantic/tool-helpers.ts`             | `normalizeNotePath`   | `normalizeVaultPath`         |
| `operations/vault-reader.ts`           | `toPosix`             | `toPosixPath`                |
| `semantic/smart-connections-loader.ts` | `toPosixPath`         | `toPosixPath`                |
| `operations/vault-reader.ts`           | `normalizeScanPrefix` | `normalizeScanPrefix`        |

The two `normalize*Path` helpers do conceptually the same job (validate vault-relative POSIX path: reject empty, absolute, Windows drive, `..` segments) — they merge into one canonical `normalizeVaultPath`. The two `toPosix*` helpers likewise merge.

Existing call-sites in `operations/tool-helpers.ts`, `semantic/tool-helpers.ts`, `vault-reader.ts`, `smart-connections-loader.ts` import from this module. The merge is the **one** behavior-adjacent change in this refactor; if the two source implementations differ in edge cases (e.g. handling of an empty string), the spec resolves to the **stricter** behavior and adds a test pinning the behavior. `paths.ts` itself throws a generic `Error`; tool-layer wrappers translate to `ToolHandlerError` exactly as today.

### New file: `src/lib/obsidian/index.ts`

Barrel re-export of the public surface of this lib. Convenience for downstream consumers; not load-bearing.

### Stays put (residual)

| File                                                                         | Why                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/modules/operations/tools/*.ts` (11 handlers)                            | MCP tool handlers — schema binding + `ToolHandlerError` mapping                             |
| `src/modules/operations/index.ts`                                            | Module wiring (DI, `ToolRegistration` aggregation)                                          |
| `src/modules/operations/obsidian-cli-provider.ts`                            | Subprocess orchestration entangled with parsing; splitting is its own task                  |
| `src/modules/operations/types.ts`                                            | Has `OperationsErrorCode` (MCP) + tool-facing input types                                   |
| `src/modules/operations/tool-helpers.ts`                                     | Residual: input validators that throw `ToolHandlerError`. Path normalization removed        |
| `src/modules/semantic/tool-helpers.ts`                                       | Residual: `readPositiveInteger`, `readThreshold` (generic, not Obsidian). Path bits removed |
| `src/modules/semantic/{embedding-service,search-engine,retrieval-policy}.ts` | ML/math, not format-aware                                                                   |
| `src/modules/semantic/index.ts`, `semantic/types.ts`, `semantic/tools/*.ts`  | Module wiring + tool handlers                                                               |

## Tests

- All existing tests run unchanged in behavior; only import paths update.
- Tests that exercise utilities now in `lib/obsidian/` move to a mirrored layout under `test/lib/obsidian/`:
  - `test/operations/frontmatter.test.ts` → `test/lib/obsidian/frontmatter.test.ts`
  - `test/operations/query/{whitelist,note-record}.test.ts` → `test/lib/obsidian/query/...`
  - `test/semantic/smart-connections-loader.test.ts` → `test/lib/obsidian/smart-connections-loader.test.ts`
  - Path-normalization tests currently embedded in `test/operations/tool-helpers.test.ts` and `test/semantic/tool-helpers.test.ts` get **extracted** into a new `test/lib/obsidian/paths.test.ts`. The originals lose only the path-normalization assertions; their domain-specific assertions stay.
- Tool-handler integration tests stay where they are (`test/operations/tools/`, `test/semantic/tools/`).
- Test count must not drop. Each extraction is a move + import update, not a delete.

## Definition of Done

1. `npm test` — green; total test count is **the same or higher** (extracted `paths.test.ts` may add specific cases, but no test is dropped silently).
2. `npm run lint` — clean.
3. `npx tsc --noEmit` — clean (source of truth for typechecking; `tsup` alone is insufficient).
4. Each of `normalizeVaultPath`, `toPosixPath`, `normalizeScanPrefix` has exactly one definition site (in `src/lib/obsidian/paths.ts`). The old names (`normalizePath`, `normalizeNotePath`, `toPosix`) are gone from the codebase. Verify with `grep -nE "function (normalizePath|normalizeNotePath|toPosix)\b" src/` returning empty.
5. `src/lib/obsidian/index.ts` exports the public surface of the lib (frontmatter, vault-reader, vault-provider, smart-connections-loader, query, paths).
6. No MCP public-API change. The README and `docs/architecture/` stay accurate; if any architecture doc named a moved file by path, that doc is updated as part of this change.
7. Single PR to `main`. After merge: `npm run release` on `main` produces a minor version bump (internal restructure, no public-API change).

## Out of scope

- Splitting `obsidian-cli-provider.ts` into a parsing layer + subprocess wrapper.
- Moving `OperationsErrorCode` or any MCP error-code definitions into `lib/obsidian/`.
- Any behavior change in any tool.
- Wikilink parsing, forward-link resolution, or any `get_similar_notes` extension — those are Spec 2.

## Architecture doc

Add `docs/architecture/obsidian-lib.md` as part of this change, describing:

- What `lib/obsidian/` is (vault-format library, no MCP coupling).
- The boundary rule (the "what moves" principle above, in 1–2 paragraphs).
- The public surface (one bullet per top-level export).
- How `src/modules/operations/` and `src/modules/semantic/` consume it.
