# Vault Provider

The abstraction the operations module uses to talk to a vault, decoupled from how that vault is actually accessed.

## What it is

`src/modules/operations/vault-provider.ts` defines `VaultProvider`:

```typescript
interface VaultProvider {
  // Note body
  readNote(input): Promise<ReadNoteResult>;
  createNote(input): Promise<CreateNoteResult>;
  editNote(input): Promise<void>;
  readDaily(): Promise<DailyNoteResult>;
  appendDaily(input): Promise<void>;
  // Frontmatter properties
  setProperty(input): Promise<void>;
  readProperty(input): Promise<ReadPropertyResult>;
  removeProperty(input): Promise<void>;
  listProperties(): Promise<PropertyListEntry[]>;
  // Tags
  listTags(): Promise<TagListEntry[]>;
  getTag(input): Promise<GetTagResult>;
}
```

The default implementation, `ObsidianCLIProvider`, shells out to the `obsidian` CLI via `child_process.execFile`. The mapping from interface methods to CLI subcommands is straightforward: notes use `read` / `create` / `edit` / `daily` / `append`; properties use `property:set` / `property:read` / `property:remove` / `properties`; tags use `tags` / `tag`. `getTag` parses the CLI's `#<tag><whitespace><count>` first-line header with a regex that extracts the trailing integer, so tag names containing digits round-trip cleanly.

## Why it exists

The MCP tools speak the same language: read or write something inside a vault. Putting that language behind an interface means:

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

- It does not parse markdown body or block structure. Clients receive raw content.
- It does not normalize paths. Path normalization happens one layer above (in `tool-handlers.ts`) so the provider can stay a thin shell.
- It does not validate business rules (empty content, etc.). Handlers do that before calling.

There are two deliberate exceptions:

1. `set_property`'s ISO format check for `date` / `datetime` types. That validation lives in the handler (not the provider) but happens _before_ the CLI is invoked, because the CLI silently accepts non-ISO values and writes nothing — a pure pass-through would surface as a phantom success.
2. `readNote` and `readDaily` return `{ path, frontmatter, content }`: the YAML frontmatter block is split out of the CLI's read output and parsed into an object (or `null` for missing/malformed YAML). Frontmatter is structured metadata, not free-form markdown, and every consumer wants it parsed; embedding raw YAML in `content` would just push the same parser into each caller. The CLI's `read` does not echo the file path, so the provider derives `path` from the input (`{ kind: 'path' }`) or via `obsidian file file=<name>` / `obsidian daily:path` when only a name is known. The split itself lives in `src/modules/operations/frontmatter.ts` so the provider does not own the YAML parser directly.

Both exceptions are explicit precisely because they violate the "no parsing / no validation" rule.
