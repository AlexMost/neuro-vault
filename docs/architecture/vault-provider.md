# Vault Provider

The abstraction the operations module uses to talk to a vault, decoupled from how that vault is actually accessed.

## What it is

`src/modules/operations/vault-provider.ts` defines `VaultProvider`:

```typescript
interface VaultProvider {
  readNote(input): Promise<ReadNoteResult>;
  createNote(input): Promise<CreateNoteResult>;
  editNote(input): Promise<void>;
  readDaily(): Promise<DailyNoteResult>;
  appendDaily(input): Promise<void>;
}
```

The default implementation, `ObsidianCLIProvider`, shells out to the `obsidian` CLI via `child_process.execFile`.

## Why it exists

The five MCP tools speak the same language: read or write a note. Putting that language behind an interface means:

- Tool handlers do not import `child_process` or build CLI tokens. They call `provider.readNote(...)` and stay focused on input validation.
- Tests can hand in a fake provider without mocking process spawning.
- An alternative backend (REST API, Obsidian plugin bridge, file-system-only) could replace the implementation without changing handlers.

## Identifier shape

`NoteIdentifier` is a tagged union:

```typescript
type NoteIdentifier = { kind: 'name'; value: string } | { kind: 'path'; value: string };
```

Obsidian distinguishes `file=` (resolves like a wikilink) from `path=` (exact). Encoding the choice in the type forces every call site to be explicit instead of relying on a runtime XOR check.

## What it deliberately does not do

- It does not parse markdown, frontmatter, or block structure. Clients receive raw content.
- It does not normalize paths. Path normalization happens one layer above (in `tool-handlers.ts`) so the provider can stay a thin shell.
- It does not validate business rules (empty content, etc.). Handlers do that before calling.
