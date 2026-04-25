# Vault Operations Module — Design

**Date:** 2026-04-25
**Status:** Draft
**Source task:** `Add core vault operations to neuro-vault`

## Goal

Add a first release of vault operations to `neuro-vault-mcp`: a minimal set of MCP tools for daily Obsidian work. The release introduces a modular architecture so semantic search and vault operations are independent and individually toggleable.

## Scope

### In scope

- New `operations` module with 5 MCP tools: `read_note`, `create_note`, `edit_note`, `read_daily`, `append_daily`.
- `VaultProvider` interface plus `ObsidianCLIProvider` implementation that shells out to the `obsidian` CLI via `child_process.execFile`.
- Restructure existing semantic code under `src/modules/semantic/`.
- Config flags `--operations` / `--semantic` (both default `true`) and `--obsidian-cli` for binary path override.
- Per-call graceful errors when the Obsidian CLI is unavailable. No startup probe.
- Unit tests for `ObsidianCLIProvider`, operations tool handlers, and module-level integration smoke tests.
- README updates: new operations section, updated tools matrix, updated config table.

### Out of scope

- Other operations (delete, rename, search, properties, tags, backlinks, etc.) — separate future tasks.
- Frontmatter parsing or structured note objects — clients receive raw markdown.
- Real end-to-end tests against a live Obsidian instance.
- Dynamic enable/disable of modules at runtime.

## Architecture

### File layout

```
src/
  cli.ts                          # entrypoint, unchanged
  config.ts                       # extended with module flags + obsidian-cli path
  server.ts                       # loads only enabled modules
  types.ts                        # shared types (ServerConfig, MCP wiring)
  lib/
    tool-response.ts              # extracted invokeTool/toToolResponse helpers
  modules/
    semantic/                     # existing code, moved here
      embedding-service.ts
      retrieval-policy.ts
      search-engine.ts
      smart-connections-loader.ts
      tool-handlers.ts
      tools.ts                    # tool registrations
      types.ts
      index.ts                    # createSemanticModule(config, deps)
    operations/                   # new module
      vault-provider.ts           # VaultProvider interface + input/result types
      obsidian-cli-provider.ts    # implementation via execFile
      tool-handlers.ts            # 5 handlers
      tools.ts                    # tool registrations
      types.ts                    # operations-only types, error codes
      index.ts                    # createOperationsModule(config, deps)

test/
  semantic/                       # existing tests, moved here
  operations/
    obsidian-cli-provider.test.ts
    tool-handlers.test.ts
    tools.test.ts                 # registration smoke
  server-modules.test.ts          # extended integration test
```

Each module exports `createXModule(config, deps) → { tools: ToolRegistration[] }`. `server.ts` aggregates registrations and wires them onto a single `McpServer` instance.

### Data flow

```
LLM → MCP tool call
       │
       ▼
   tool-handlers.ts (input validation, normalization)
       │
       ▼
   VaultProvider (operations) | searchEngine + corpus (semantic)
       │
       ▼
   execFile("obsidian", [...]) | in-memory cosine search
       │
       ▼
   structured response | structured error
```

## VaultProvider Interface

```typescript
// src/modules/operations/vault-provider.ts

export type NoteIdentifier =
  | { kind: 'name'; value: string }   // wikilink-style, resolves like Obsidian
  | { kind: 'path'; value: string };  // exact vault-relative path

export interface ReadNoteInput {
  identifier: NoteIdentifier;
}

export interface ReadNoteResult {
  path: string;     // vault-relative POSIX path
  content: string;  // raw markdown
}

export interface CreateNoteInput {
  name?: string;
  path?: string;
  content?: string;
  template?: string;
  overwrite?: boolean;
}

export interface CreateNoteResult {
  path: string;
}

export type EditPosition = 'append' | 'prepend';

export interface EditNoteInput {
  identifier: NoteIdentifier;
  content: string;
  position: EditPosition;
}

export interface DailyNoteResult {
  path: string;
  content: string;
}

export interface AppendDailyInput {
  content: string;
}

export interface VaultProvider {
  readNote(input: ReadNoteInput): Promise<ReadNoteResult>;
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  editNote(input: EditNoteInput): Promise<void>;
  readDaily(): Promise<DailyNoteResult>;
  appendDaily(input: AppendDailyInput): Promise<void>;
}
```

**Why a tagged union for `NoteIdentifier`:** Obsidian CLI distinguishes `file=` (resolves like a wikilink) from `path=` (exact). Encoding the choice in a tagged union makes intent explicit at every call site instead of two optional fields with a runtime XOR check.

**What `VaultProvider` deliberately does not do:**
- Does not parse frontmatter — clients receive raw markdown.
- Does not normalize paths — that happens one layer up in `tool-handlers.ts`, matching the semantic module's pattern.
- Does not validate business rules (empty content etc.) — also one layer up.

## ObsidianCLIProvider

```typescript
// src/modules/operations/obsidian-cli-provider.ts

export interface ObsidianCLIProviderOptions {
  binaryPath?: string;     // default: 'obsidian'
  vaultName?: string;      // appended as `vault=<name>` if set
  timeoutMs?: number;      // default: 10_000
  exec?: ExecFn;           // injectable for tests
}

type ExecFn = (
  binary: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;
```

### Argument construction

`obsidian` CLI takes `key=value` tokens. Each token is one element of the `args` array; spaces inside values are fine because `execFile` does not invoke a shell.

```
readNote({ identifier: { kind: 'name', value: 'My Note' } })
  → execFile('obsidian', ['read', 'file=My Note'])

createNote({ path: 'Inbox/idea.md', content: 'hello\nworld', overwrite: true })
  → execFile('obsidian', ['create', 'path=Inbox/idea.md', 'content=hello\nworld', 'overwrite'])

editNote({ identifier: { kind: 'path', value: 'Daily/foo.md' }, content: '...', position: 'prepend' })
  → execFile('obsidian', ['prepend', 'path=Daily/foo.md', 'content=...'])

appendDaily({ content: '- new task' })
  → execFile('obsidian', ['daily:append', 'content=- new task'])
```

If `vaultName` is set, `vault=<name>` is appended to every call.

### Output parsing

`read` and `daily:read` print:

```
<vault-relative-path>
---
<raw markdown>
```

Parser splits on the first `\n---\n`. If the separator is absent, the whole stdout becomes `content` and `path` is empty (with a warning logged). The fallback covers CLI versions that change the format without a hard failure.

### Error mapping

| Signal | Error code | Message |
|---|---|---|
| spawn `ENOENT` | `CLI_NOT_FOUND` | `"Obsidian CLI binary not found at '<binary>'. Install it and ensure Obsidian is running."` |
| stderr matches `not running` or `URI handler` | `CLI_UNAVAILABLE` | `"Obsidian is not running. Start Obsidian and try again."` |
| timeout | `CLI_TIMEOUT` | `"Obsidian CLI timed out after <timeoutMs>ms."` |
| `create` non-zero + stderr matches `already exists` | `NOTE_EXISTS` | `"Note already exists at <path>. Pass overwrite: true after confirming with the user."` |
| `read`/`edit` non-zero + stderr matches `not found` | `NOT_FOUND` | `"Note not found: <identifier>"` |
| Other non-zero exit | `CLI_ERROR` | `"Obsidian CLI failed: <stderr>"` |

The pattern list lives next to a comment that flags it as fragile by design — Obsidian CLI returns exit codes only, with human-readable stderr.

### Security

- `execFile` with an array of arguments — never `exec`. No shell, no interpolation, no command injection from LLM-controlled `name`/`content`/`path`.
- No path normalization at the provider level — the handlers above reject `..` traversal and absolute paths before reaching the provider.

## MCP Tools

Each tool input uses zod with a refinement enforcing exactly one of `name` or `path` where both are accepted.

### `read_note`

```
inputSchema: {
  name?: string,
  path?: string,
}  // exactly one
```

Description: *"Read a note's contents. Provide either `name` (wikilink-style, resolves like Obsidian) or `path` (vault-relative, exact). Returns `{ path, content }`."*

### `create_note`

```
inputSchema: {
  name?: string,        // exactly one of name/path
  path?: string,
  content?: string,
  template?: string,
  overwrite?: boolean,
}
```

Description: *"Create a new note. Provide `name` or `path`. Optional `content` and `template`. **If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive.** Default behavior fails when the note exists."*

### `edit_note`

```
inputSchema: {
  name?: string,
  path?: string,
  content: string,
  position: 'append' | 'prepend',
}
```

Description: *"Add content to an existing note at the start (`prepend`) or end (`append`). Use `\n` for newlines."*

### `read_daily`

```
inputSchema: {}
```

Description: *"Read today's daily note. Returns `{ path, content }`. Useful for 'what's on my agenda?'-style questions."*

### `append_daily`

```
inputSchema: {
  content: string,
}
```

Description: *"Append content to today's daily note. Use `\n` for newlines. Common uses: log a thought, add a task, mark progress."*

### Shared response wiring

`invokeTool`, `toToolResponse`, `toToolErrorResponse` move from `server.ts` into `src/lib/tool-response.ts` so both modules use the same wrappers.

## Configuration

CLI flags in `src/config.ts`:

| Flag | Default | Purpose |
|---|---|---|
| `--vault <path>` | required | absolute vault path (unchanged) |
| `--operations` / `--no-operations` | `true` | enable/disable operations module |
| `--semantic` / `--no-semantic` | `true` | enable/disable semantic module |
| `--obsidian-cli <path>` | `obsidian` | override path to the `obsidian` binary |

Resulting `ServerConfig`:

```typescript
export interface ServerConfig {
  vaultPath: string;
  operations: { enabled: boolean; binaryPath?: string };
  semantic: { enabled: boolean; smartEnvPath: string; modelKey: string; modelId: string };
}
```

`server.ts` loads only enabled modules:

- Both default-on → backwards compatible with `1.4.x` for users already on semantic.
- `--no-operations` → operations tools not registered, no `obsidian` spawn ever.
- `--no-semantic` → no corpus load, no embedding model download — server starts instantly.
- Both off → startup fails fast with a clear error.
- `semantic.enabled && missing .smart-env/multi` → fail fast (current behaviour).
- `operations.enabled` → no startup probe (per-call graceful error).

The MCP `serverInstructions` text gains a short section explaining when to reach for operations tools versus semantic search.

## Error Handling

Existing `ToolHandlerErrorCode` union extends to:

```
'INVALID_ARGUMENT' | 'NOT_FOUND' | 'DEPENDENCY_ERROR'
| 'CLI_NOT_FOUND' | 'CLI_UNAVAILABLE' | 'CLI_TIMEOUT' | 'CLI_ERROR'
| 'NOTE_EXISTS'
```

`ToolHandlerError` is reused for both modules. The existing `toToolErrorResponse` already handles arbitrary error codes via `structuredContent`. Handlers do not retry; they propagate the error and let the LLM decide.

## Testing

### Unit: `obsidian-cli-provider.test.ts`

Mock `exec` via DI:

- `readNote` parses `<path>\n---\n<content>` format
- `readNote` falls back to whole-stdout when separator missing
- `createNote` builds `['create', 'name=...', 'content=...']`
- `createNote({ overwrite: true })` adds `'overwrite'` token
- `editNote({ position: 'append' })` invokes `append`; `prepend` invokes `prepend`
- `appendDaily` invokes `daily:append`; `readDaily` invokes `daily:read`
- ENOENT → `CLI_NOT_FOUND`
- stderr `Obsidian is not running` → `CLI_UNAVAILABLE`
- stderr `already exists` on `create` → `NOTE_EXISTS`
- stderr `not found` on `read` → `NOT_FOUND`
- timeout → `CLI_TIMEOUT`
- `vaultName` option appends `vault=<name>` to args

### Unit: `tool-handlers.test.ts` (operations)

Mock `VaultProvider` directly:

- Each handler invokes the right provider method with correctly mapped args
- Missing both `name` and `path` → `INVALID_ARGUMENT`
- Both `name` and `path` set → `INVALID_ARGUMENT`
- Path traversal (`../../etc/passwd`) → `INVALID_ARGUMENT` (reuses semantic's normalizer)
- Provider throws `CLI_NOT_FOUND` → handler propagates without re-wrapping

### Unit: `tools.test.ts` (operations registration smoke)

- `createOperationsModule(...)` returns 5 registrations with the expected names
- Tool descriptions include the key behavioural strings (e.g. "ask the user before passing `overwrite`")

### Integration: `server-modules.test.ts`

Extends the existing smoke test:

- Both modules on → `listTools` returns 4 semantic + 5 operations = 9 tools
- `--no-operations` → 4 tools, no operations
- `--no-semantic` → 5 tools, no embedding service spawned
- Both off → startup fails with a clear message

### Not tested

- Real interaction with a live Obsidian instance (out of scope for v1).
- Concurrent operations on the same note (CLI serialises; LLM does not parallelise on one note).

## README updates

- New top-level section "Vault operations" describing the operations module, requirements (Obsidian + CLI), and the 5 tools.
- Updated tools reference table to include the 5 new entries.
- Configuration section adds `--operations`, `--semantic`, `--obsidian-cli` rows.
- Quick Start example for `Add to AGENTS.md / CLAUDE.md` snippet updated to mention vault operations alongside vault search.
- "Limitations" section notes per-call CLI dependency for operations.

## Definition of Done

- 5 operations tools work through `neuro-vault-mcp` MCP server
- Both modules pass through `--operations` / `--semantic` flags correctly
- All new and existing tests pass; lint and format pass
- README reflects the new architecture and tools
- New version bumped via `commit-and-tag-version` and published to npm
- Manual smoke test from Claude Code: read a note, create a note, edit a note, read+append daily
