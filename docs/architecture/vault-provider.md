# Vault Provider

The abstraction the operations module uses to talk to a vault, decoupled from how that vault is actually accessed.

## What it is

`src/modules/operations/vault-provider.ts` defines `VaultProvider`:

```typescript
interface VaultProvider {
  // Note body
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
}
```

Note-body **batch reads** have moved out of `VaultProvider` to a separate `VaultReader` abstraction (`FsVaultReader`) that reads files directly from disk without going through the Obsidian CLI. See [`./vault-reader.md`](./vault-reader.md) for details.

The default implementation, `ObsidianCLIProvider`, shells out to the `obsidian` CLI via `child_process.execFile`. The mapping from interface methods to CLI subcommands is straightforward: notes use `read` / `create` / `edit` / `daily` / `append`; properties use `property:set` / `property:read` / `property:remove` / `properties`; tags use `tags`. Listing notes that carry a specific tag is no longer a provider concern — clients use `query_notes` with a `tags` filter, which reads from disk directly via `VaultReader`.

## Why it exists

The MCP tools speak the same language: read or write something inside a vault. Putting that language behind an interface means:

- Tool handlers do not import `child_process` or build CLI tokens. They call `provider.createNote(...)`, `provider.editNote(...)`, etc. and stay focused on input validation.
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
- It does not normalize paths. Path normalization happens one layer above (in the per-tool handler files under `src/modules/operations/tools/`) so the provider can stay a thin shell.
- It does not validate business rules (empty content, etc.). Handlers do that before calling.

There are three deliberate exceptions:

1. `set_property`'s ISO format check for `date` / `datetime` types. That validation lives in the handler (not the provider) but happens _before_ the CLI is invoked, because the CLI silently accepts non-ISO values and writes nothing — a pure pass-through would surface as a phantom success.
2. `readDaily` returns `{ path, frontmatter, content }`: the YAML frontmatter block is split out of the CLI's read output and parsed into an object (or `null` for missing/malformed YAML). Frontmatter is structured metadata, not free-form markdown, and every consumer wants it parsed; embedding raw YAML in `content` would just push the same parser into each caller. The CLI's `daily` subcommand does not echo the file path, so the provider derives `path` via `obsidian daily:path`. The split itself lives in `src/modules/operations/frontmatter.ts` so the provider does not own the YAML parser directly.

3. `createNote`: when constructed with `vaultRoot`, the provider stats the target path after a successful CLI return and throws `CREATE_FAILED` on `ENOENT`. The check exists because obsidian-cli's `create` subcommand has been observed to return exit 0 without writing — most reproducibly when a `template=` token references a template the CLI cannot resolve. The provider no longer forwards `template=` at all; template rendering happens in the `create_note` tool handler (see [`./daily-notes-and-templates.md`](./daily-notes-and-templates.md)). The post-stat is defense-in-depth against any future regression in this code path.

All three exceptions are explicit precisely because they violate the "no parsing / no validation" rule.

## Vault binding

Each `VaultEntry` in the `VaultRegistry` carries its own `ObsidianCLIProvider`, bound to that vault's name — always `path.basename` of the `--vault` directory; there is no prefix syntax or override flag. `ObsidianCLIProvider.buildArgs` appends `vault=<name>` to every CLI invocation, so writes go to the configured vault regardless of which vault Obsidian considers "active". If the basename does not match any vault Obsidian knows about (i.e. the user renamed one side in Obsidian's "Manage vaults" UI), the provider returns `VAULT_NOT_FOUND` and the remediation is to rename one side so the two agree.
