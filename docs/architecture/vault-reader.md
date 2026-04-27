# Vault Reader

The abstraction the operations module uses to read note bodies from the file
system, decoupled from the Obsidian app.

## What it is

`src/modules/operations/vault-reader.ts` defines `VaultReader`:

```typescript
interface VaultReader {
  readNotes(input: { paths: string[]; fields: ReadNotesField[] }): Promise<ReadNotesItem[]>;
}
```

The default implementation, `FsVaultReader`, reads files from the vault root via
`node:fs/promises.readFile` and parses YAML frontmatter via the shared
`splitFrontmatter`. The vault root comes from the existing `--vault` startup
flag.

## Why it exists separately from `VaultProvider`

`VaultProvider` describes operations that go through the Obsidian app (CLI):
creates, edits, daily notes, properties, tags. Reads do not need the Obsidian
app — files on disk are the source of truth — so they belong on a different
backend. Splitting the abstractions keeps each one honest: implementers do not
have to stub a backend they do not own, and tests do not have to fake CLI calls
when they only care about reads.

The two abstractions are siblings: the operations module's `index.ts`
constructs both and injects them into the handlers. The handlers depend on each
explicitly.

## Per-item failure model

`readNotes` returns one entry per input path. Successful entries carry
`frontmatter` and `content` (the reader does not project — projection happens
in the tool handler so the reader stays a thin fs adapter). Failed entries
carry an `error: { code, message }` with one of:

- `NOT_FOUND` — `fs.readFile` returned `ENOENT`.
- `READ_FAILED` — any other fs error (`EACCES`, `EISDIR`, `EIO`, …).
- `INVALID_ARGUMENT` — never produced by the reader; reserved for handler-side
  per-item validation (e.g. path traversal).

## What it deliberately does not do

- It does not normalize paths. The handler runs `normalizePath` before calling
  the reader; invalid paths never reach `readFile`.
- It does not cache. Caching is deferred to a future `VaultIndex`.
- It does not bound concurrency. `Promise.all` over up to 50 reads is safe on
  any modern OS; the kernel handles the parallelism.
- It does not project fields. The handler decides which of `frontmatter` /
  `content` to include in each successful item.

## What changes for v2

When `VaultIndex` lands, `readNotes` with `fields: ['frontmatter']` can be
served from the in-memory index without touching disk. The handler interface
will not change; only the reader's implementation will.
