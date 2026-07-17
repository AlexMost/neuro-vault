# Vault Provider

The abstraction the operations module uses to write to (and resolve) a vault, decoupled from the concrete storage mechanism.

## What it is

`src/lib/obsidian/vault-provider.ts` defines `VaultProvider`:

```typescript
interface VaultProvider {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  readDaily(): Promise<DailyNoteResult>;
  setProperty(input: SetPropertyInput): Promise<void>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  listProperties(): Promise<PropertyListEntry[]>;
  listTags(): Promise<TagListEntry[]>;
}
```

Note-body **batch reads** and **in-place edits** are not `VaultProvider` concerns: `read_notes`/`query_notes` go through `VaultReader` (`FsVaultReader`, see [`./vault-reader.md`](./vault-reader.md)) and `edit_note` goes through `VaultWriter` (`FsVaultWriter`). `VaultProvider` covers the remaining note-body and metadata operations that do not fit either of those: creating a note, resolving/reading the daily note, and frontmatter properties/tags.

The sole implementation, `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`), operates directly on the vault directory via `node:fs/promises` — no external process. It takes a `vaultRoot` and a `VaultReader` (used to resolve `name`-style identifiers and to scan frontmatter for `listTags`/`listProperties`).

## Why it exists

The MCP tools speak the same language: read or write something inside a vault. Putting that language behind an interface means:

- Tool handlers do not import `node:fs` directly or build paths themselves. They call `provider.createNote(...)`, `provider.setProperty(...)`, etc. and stay focused on input validation.
- Tests can hand in a fake provider without touching the real filesystem.
- An alternative backend (a REST API, an Obsidian plugin bridge) could replace `FsVaultProvider` without changing handlers — the interface predates the disk-direct implementation and outlives any one backend.

See [ADR-0009](../adr/0009-disk-direct-vault-operations.md) for why the implementation is disk-direct rather than routed through the `obsidian` CLI (the prior design, ADR-0007, now superseded).

## Identifier shape

`NoteIdentifier` is a tagged union:

```typescript
type NoteIdentifier = { kind: 'name'; value: string } | { kind: 'path'; value: string };
```

`kind: 'name'` resolves like a wikilink (via `buildBasenameIndex` over a vault scan); `kind: 'path'` is exact. Encoding the choice in the type forces every call site to be explicit instead of relying on a runtime XOR check.

## What it deliberately does not do

- It does not parse markdown body or block structure. Clients receive raw content.
- It does not normalize paths. Path normalization happens one layer above (in the per-tool handler files under `src/modules/operations/tools/`) so the provider can stay a thin shell; `resolveIdentifierPath` still runs `normalizeNotePath` defensively on `kind: 'path'` identifiers, mirroring what the tool layer already guarantees.
- It does not validate business rules (empty content, etc.). Handlers do that before calling.

There are two deliberate exceptions:

1. `set_property`'s ISO format check for `date` / `datetime` types. That validation lives in the handler (not the provider) but happens _before_ the write, because writing a non-ISO value for those types would be silently wrong rather than rejected.
2. `readDaily` returns `{ path, frontmatter, content }`: the YAML frontmatter block is split out of the note's raw contents and parsed into an object (or `null` for missing/malformed YAML). Frontmatter is structured metadata, not free-form markdown, and every consumer wants it parsed; embedding raw YAML in `content` would just push the same parser into each caller. `readDaily` resolves today's path itself — `readDailyNotesConfig` reads `.obsidian/daily-notes.json` for the folder/format, and `formatDailyDate` renders the basename — rather than deferring to an external daily-notes implementation. See [`./disk-write-path.md`](./disk-write-path.md).

Both exceptions are explicit precisely because they violate the "no parsing / no validation" rule.

## Vault binding

Each `VaultEntry` in the `VaultRegistry` carries its own `FsVaultProvider`, constructed with that entry's `vaultRoot` and `reader`. There is no vault-name token passed anywhere — the provider only ever touches the one directory it was constructed with, so there is no possibility of the writes-vs-reads name mismatch ADR-0007's provider had to guard against (`VAULT_NOT_FOUND` today means only "no `--vault name:path` was registered under that name").
