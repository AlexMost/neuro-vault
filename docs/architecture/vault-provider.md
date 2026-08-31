# Vault Provider

The interface the operations module uses to act on a single note file inside a vault — create it, read today's daily, set or remove a frontmatter property, rewrite its body.

## What it is

`src/lib/obsidian/vault-provider.ts` defines `VaultProvider`:

```typescript
interface VaultProvider {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  readDaily(): Promise<DailyNoteResult>;
  setProperty(input: SetPropertyInput): Promise<void>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  replaceInNote(input: ReplaceInNoteInput): Promise<void>;
  replaceFullBody(input: ReplaceFullBodyInput): Promise<void>;
}
```

These six are exactly the operations that act on **one note file, addressed by a `NoteIdentifier`**. Two neighbours are deliberately outside: note-body **batch reads** (`read_notes`/`query_notes`) go through `VaultReader` (`FsVaultReader`, see [`./vault-reader.md`](./vault-reader.md)), and the vault-wide **aggregate scans** behind `list_tags` / `list_properties` are free functions over a reader in `src/lib/obsidian/vault-aggregates.ts` — they only read, and they never address a single note. `edit_note` is *not* one of the exclusions: `replaceInNote` / `replaceFullBody` are its two modes, and the separate `VaultWriter` interface they used to live behind is gone (see [ADR-0016](../adr/0016-one-disk-module-owns-note-writes.md)).

The sole implementation, `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`), operates directly on the vault directory via `node:fs/promises` — no external process. It takes a `vaultRoot` and a `VaultReader`, used to resolve `name`-style identifiers. That resolution is `scan`-backed, so it inherits the vault's scope (see [`vault-scope.md`](./vault-scope.md)): a note excluded by scope is not a `kind: 'name'` resolution target.

## Why it exists

The MCP tools speak the same language: read or write something inside a vault. Putting that language behind an interface means:

- Tool handlers do not import `node:fs` directly or build paths themselves. They call `provider.createNote(...)`, `provider.setProperty(...)`, etc. and stay focused on input validation.
- Tests can hand in a fake provider without touching the real filesystem. This is the seam's actual job today: the operations tool tests assert *what a tool passes down* — that `set_property` hands over `identifier: { kind: 'name', … }`, that `create_note` forwards merged frontmatter — and against a temp vault those assertions would degrade into inferences from which bytes changed.

The interface is **not** kept against a plausible second backend. There is one implementation and none is anticipated; adding a method to `VaultProvider` is a claim that a tool test needs to stub that behaviour. [ADR-0016](../adr/0016-one-disk-module-owns-note-writes.md) records both that narrowing and why the parallel `VaultWriter` seam was deleted instead. See [ADR-0009](../adr/0009-disk-direct-vault-operations.md) for why the implementation is disk-direct rather than routed through the `obsidian` CLI (the prior design, ADR-0007, now superseded).

## Identifier shape

`NoteIdentifier` is a tagged union:

```typescript
type NoteIdentifier = { kind: 'name'; value: string } | { kind: 'path'; value: string };
```

`kind: 'name'` resolves like a wikilink (via `buildBasenameIndex` over a scoped vault scan — a note excluded by [vault scope](./vault-scope.md) has no basename entry and cannot be resolved by name); `kind: 'path'` is exact and bypasses scope entirely, same as `read_notes` (see [vault-scope.md's discovery-vs-ACL section](./vault-scope.md#discovery-not-access-control)). Encoding the choice in the type forces every call site to be explicit instead of relying on a runtime XOR check.

Every write tool builds its identifier through the single `resolveIdentifier(name, path)` in `src/modules/operations/tool-helpers.ts` — the one implementation of the "exactly one of `name` or `path`" rule. Turning that identifier into a concrete relative path is the provider's job, and it has **two private modes**, because `kind: 'name'` genuinely means different things on either side of a note's existence:

- `resolveExisting(identifier)` — used by `replaceInNote`, `replaceFullBody`, `setProperty`, `removeProperty`. `kind: 'name'` goes through the basename index: zero matches is `NOT_FOUND`, more than one is `AMBIGUOUS_MATCH`, and there is never a silent first-match write.
- `resolveNew(identifier)` — used by `createNote`. The target does not exist yet, so `kind: 'name'` instead *places* the note: it prefixes the `newFileLocation` folder from `.obsidian/app.json` and normalizes, mapping a normalization failure to `INVALID_ARGUMENT` on field `name`.

## What it deliberately does not do

- It does not parse markdown body or block structure. Clients receive raw content.
- It does not own path validation. Every write tool normalizes through `resolveIdentifier` before the provider is called, so an escaping path fails `INVALID_ARGUMENT` before any disk I/O; both provider-side modes still run `normalizeNotePath` defensively on `kind: 'path'` identifiers, mirroring what the tool layer already guarantees.
- It does not validate business rules (empty content, etc.). Handlers do that before calling.

There are two deliberate exceptions:

1. `set_property`'s ISO format check for `date` / `datetime` types. That validation lives in the handler (not the provider) but happens _before_ the write, because writing a non-ISO value for those types would be silently wrong rather than rejected.
2. `readDaily` returns `{ path, frontmatter, content }`: the YAML frontmatter block is split out of the note's raw contents and parsed into an object (or `null` for missing/malformed YAML). Frontmatter is structured metadata, not free-form markdown, and every consumer wants it parsed; embedding raw YAML in `content` would just push the same parser into each caller. `readDaily` resolves today's path itself — `readDailyNotesConfig` reads `.obsidian/daily-notes.json` for the folder/format, and `formatDailyDate` renders the basename — rather than deferring to an external daily-notes implementation. See [`./disk-write-path.md`](./disk-write-path.md).

Both exceptions are explicit precisely because they violate the "no parsing / no validation" rule.

## Vault binding

Each `VaultEntry` in the `VaultRegistry` carries its own `FsVaultProvider`, constructed with that entry's `vaultRoot` and `reader`. There is no vault-name token passed anywhere — the provider only ever touches the one directory it was constructed with, so there is no possibility of the writes-vs-reads name mismatch ADR-0007's provider had to guard against (`VAULT_NOT_FOUND` today means only "no `--vault name:path` was registered under that name").
