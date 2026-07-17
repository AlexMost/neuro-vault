# Vault Reader

The abstraction the operations module uses to read note bodies from the file
system, decoupled from the Obsidian app.

## What it is

`src/modules/operations/vault-reader.ts` defines `VaultReader`:

```typescript
interface VaultReader {
  readNotes(input: { paths: string[]; fields: ReadNotesField[] }): Promise<ReadNotesItem[]>;
  scan(opts?: { pathPrefix?: string }): Promise<string[]>;
}
```

The default implementation, `FsVaultReader`, reads files from the vault root via
`node:fs/promises.readFile` and parses YAML frontmatter via the shared
`splitFrontmatter`. The vault root comes from the existing `--vault` startup
flag.

`scan` enumerates `.md` paths under the vault (or under an optional vault-relative
`pathPrefix`) using `fast-glob`. It returns vault-relative POSIX paths, sorted.
A missing `pathPrefix` directory throws `ScanPathNotFoundError`; an existing
prefix with no `.md` files returns an empty array (not an error). The handler
layer catches `ScanPathNotFoundError` and translates it to a `PATH_NOT_FOUND`
`ToolHandlerError`. Like `readNotes`, `scan` does not cache; a caching reader is
deferred to a future `VaultIndex`-style implementation.

## Why it exists separately from `VaultProvider`

Both `VaultReader` and `VaultProvider` are disk-direct today (see [ADR-0009](../adr/0009-disk-direct-vault-operations.md)), so the split is no longer about which backend a call goes through — it is about shape. `VaultReader` is a narrow, read-only, batch-oriented interface (`readNotes` over up to 50 paths, `scan`) built for the high-volume read paths (`read_notes`, `query_notes`, the lexical search leg). `VaultProvider` is single-note, mutation-oriented, and owns a few pieces of note-format knowledge reads don't need (frontmatter YAML mutation, Daily Notes config resolution). Splitting the abstractions keeps each one honest: implementers do not have to stub mutation behavior they do not own, and tests that only care about reads do not have to fake writes.

The two abstractions are siblings: the operations module's `index.ts`
constructs both and injects them into the handlers — `FsVaultProvider` is even
constructed with a `VaultReader` instance, since resolving a `name`-style
`NoteIdentifier` and scanning frontmatter for `listTags`/`listProperties`
reuse the reader's `scan`/`readNotes`. The handlers depend on each
explicitly.

## Per-item failure model

`readNotes` returns one entry per input path. Successful entries carry
`frontmatter` and `content`. The reader honours `fields` only coarsely: when
`fields` omits `'content'` it drops the body (returns `content: ''`) rather than
retaining every note's full text — the finer projection (full / preview /
frontmatter shaping) still happens in the tool handler. Failed entries
carry an `error: { code, message }` with one of:

- `NOT_FOUND` — `fs.readFile` returned `ENOENT`.
- `READ_FAILED` — any other fs error (`EACCES`, `EISDIR`, `EIO`, …).
- `INVALID_ARGUMENT` — never produced by the reader; reserved for handler-side
  per-item validation (e.g. path traversal).

## What it deliberately does not do

- It does not normalize paths. The handler runs `normalizePath` before calling
  the reader; invalid paths never reach `readFile`. `scan` similarly assumes a
  pre-validated `pathPrefix`; the handler rejects absolute paths and `..` up
  front and translates `ScanPathNotFoundError` into the tool error envelope.
- It does not cache. Caching is deferred to a future `VaultIndex`.
- It does not bound concurrency. `Promise.all` over up to 50 reads is safe on
  any modern OS; the kernel handles the parallelism.
- It does not finely project fields. It drops the body when `fields` omits
  `'content'` (a memory-retention guard for whole-vault frontmatter scans), but
  the handler still decides how much of `content` (full / preview / none) to
  include in each successful item.
- It does not normalise tags or interpret frontmatter. `query_notes` builds a
  `NoteRecord` (path / frontmatter / tags) from the reader's raw output in its
  own module — the reader stays a thin fs adapter.

## What changes for v2

When `VaultIndex` lands, `readNotes` with `fields: ['frontmatter']` can be
served from the in-memory index without touching disk. The handler interface
will not change; only the reader's implementation will.
