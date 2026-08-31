Tracked by: #114

## Why

Two modules own disk writes over the same vault root and never call each other: `FsVaultWriter` (one consumer, `edit_note`) and `FsVaultProvider` (every other write tool). Each independently implements read → split frontmatter → mutate → write with its own fs-error mapping, and that divergence already shipped a bug — #113, an `edit_note` write failure escaping without an error code. The "exactly one of name or path" rule has four implementations across two resolution depths, and one of them is not an XOR at all. Now is the moment: #113 is closed, so this consolidates onto a correct mapping instead of introducing one, and no tool contract has to move to do it.

## What Changes

**One disk module**

- From: `FsVaultWriter` (`src/lib/obsidian/vault-writer.ts`) performs `edit_note`'s in-place edits over an already-resolved path; `FsVaultProvider` performs every other note write and resolves identifiers itself.
- To: `FsVaultProvider` owns all note writes. `replaceInNote` / `replaceFullBody` move onto `VaultProvider` taking a `NoteIdentifier`. `vault-writer.ts` is deleted, along with `IVaultEntry.writer`, `IVaultEntryDeps.writerFactory`, and the `writerFactory` wiring in `src/server.ts`.
- Reason: two owners of one sequence diverge; the divergence produced #113. `FsVaultWriter` fails the deletion test — it has a single consumer and nothing reappears when it is folded in.
- Impact: non-breaking, internal. No tool schema, output shape, or error code changes.

**One name ⊕ path rule, one resolution depth**

- From: four implementations — `resolveIdentifier` (`tool-helpers.ts`), an inline XOR in `create-note.ts`, another in `edit-note.ts`, and `FsVaultProvider.createNote`'s guard, which only checks both-missing and lets `path` silently win when both are supplied. `edit_note` resolves name→path in the tool; the property tools pass a `NoteIdentifier` the provider resolves.
- To: `resolveIdentifier` is the only implementation. Every write tool hands down a `NoteIdentifier`; resolution happens once, inside the disk module, in two named modes — `resolveExisting` (basename index → `NOT_FOUND` / `AMBIGUOUS_MATCH`) for edits and property writes, and `resolveNew` (`.obsidian/app.json` `newFileLocation`) for `create_note`, whose target does not exist yet.
- Reason: an ambiguity-policy change currently has to find four copies at two depths.
- Impact: non-breaking in code and status. Two error *details* normalize: `create_note` with both `name` and `path` reports `details.field: "path"` rather than `"name"`, and its both-missing message becomes "Provide exactly one of name or path" — matching what the other three write tools already say. Same `INVALID_ARGUMENT` code; no test pins either string today.

**One fs-error mapping over existing notes**

- From: `FsVaultWriter.readRaw`/`writeRaw` and `FsVaultProvider.editFrontmatter` each map `ENOENT` → `NOT_FOUND`, other read failures → `READ_FAILED`, and write failures → `WRITE_FAILED`, in separately written copies.
- To: one private `readRaw` / `writeRaw` pair in the disk module, shared by the edit and property paths. `createNote` keeps its own `NOTE_EXISTS` / `CREATE_FAILED` mapping — different flags (`wx` / `w`) and a taxonomy the `headless-vault-operations` spec mandates.
- Reason: the codes are contract surface (ADR-0003); one mapping cannot drift from another that does not exist.
- Impact: non-breaking. `set_property` / `remove_property` become reachable-by-test for `WRITE_FAILED` for the first time, via the injectable `readFile` / `writeFile` seam carried over from `FsVaultWriter`.

**`VaultProvider` resized to the world after ADR-0009**

- From: a six-method interface with exactly one implementation, mixing note writes with `listTags` / `listProperties` — pure read-aggregates over `reader.scan()` that happen to hang off a write interface. `computeVaultOverview` therefore takes four deps (`reader`, `provider`, `graph`, `readConventions`) to produce one snapshot.
- To: `listTags` / `listProperties` become free functions over a `VaultReader` in a new `src/lib/obsidian/vault-aggregates.ts`. `ComputeVaultOverviewDeps` drops to `{ reader, graph, readConventions }`. `VaultProvider` keeps six methods, all of them "open one note file over the vault root": `createNote`, `readDaily`, `setProperty`, `removeProperty`, `replaceInNote`, `replaceFullBody`.
- Reason: the interface's shape is historical, not cohesive — it is the silhouette the deleted CLI adapter left behind.
- Impact: non-breaking. `list_tags`, `list_properties`, and `get_vault_overview` return byte-identical results; only where the aggregation is called from changes.

**Test seam**

- From: three independently written, hand-synced `makeProvider` stubs — `test/operations/tools/_helpers.ts`, an inline one in `test/lib/obsidian/vault-overview.test.ts`, and the real-module builder in `test/operations/fs-vault-provider/_helpers.ts`.
- To: one stub helper plus the real-module builder. The overview stub is deleted outright: it exists only to control tags and properties, which come from the reader afterwards. `test/lib/obsidian/vault-writer.test.ts` folds into the provider suite.
- Reason: three copies of one interface's shape is three chances to disagree about it.
- Impact: test-only.

**Decision recorded**

- `docs/adr/0016-*.md`: one disk module owns note writes; the `VaultWriter` seam is deleted rather than kept, and `VaultProvider` is narrowed to what ADR-0009 actually left it responsible for.

## Capabilities

### New Capabilities

None. Every client-visible behaviour this change touches already ships; the deltas pin properties that were previously incidental to how the code happened to be arranged.

### Modified Capabilities

- `headless-vault-operations`: two requirements are restated so the disk-direct contract is phrased as a property of every note write rather than as a list of `VaultProvider` methods — "Vault operations run without Obsidian" stops enumerating an interface whose membership this change alters, and "Write methods edit vault files directly" takes in `edit_note`'s in-place edits, which the capability previously mentioned only in passing. Two requirements are added, pinning properties that were previously incidental to how the code happened to be arranged: one identifier rule resolved at one depth across all four write tools, and one `NOT_FOUND` / `READ_FAILED` / `WRITE_FAILED` taxonomy for operations on notes that already exist — explicitly distinct from `create_note`'s `NOTE_EXISTS` / `CREATE_FAILED`. The tag/property listing requirement is untouched: it already describes an aggregate over the scoped scan and never named the interface the functions hang off.

## Impact

**Production code** — deleted: `src/lib/obsidian/vault-writer.ts`. Changed: `src/modules/operations/fs-vault-provider.ts` (absorbs the edit path, both resolution modes, the shared fs helpers, the injection seam; loses the aggregates), `src/lib/obsidian/vault-provider.ts` (interface + input types), `src/lib/vault-registry.ts` (`IVaultEntry`, `IVaultEntryDeps`), `src/server.ts` (drops `writerFactory`), `src/lib/obsidian/vault-overview.ts` (three deps), `src/modules/operations/tools/{create-note,edit-note,list-tags,list-properties,get-vault-overview}.ts`, `src/modules/operations/resources/vault-overview.ts`. Added: `src/lib/obsidian/vault-aggregates.ts`.

**Tests** — `test/lib/obsidian/vault-writer.test.ts` folds into `test/operations/fs-vault-provider/`; `test/operations/tools/_helpers.ts` (drop `makeWriter`, resize `makeProvider`); `test/lib/obsidian/vault-overview.test.ts` (inline stub deleted, reader-driven instead); `test/lib/vault-registry.test.ts` (`writer` assertions); `test/operations/tools/{edit-note,create-note,list-tags,list-properties,get-vault-overview}.test.ts`; `test/operations/{tools,operations-module}.test.ts`; `test/operations/resources/vault-overview.test.ts`; new `test/lib/obsidian/vault-aggregates.test.ts`.

**Docs** — new `docs/adr/0016-*.md` plus its `docs/adr/INDEX.md` row; `docs/architecture/vault-provider.md` (its "`edit_note` goes through `VaultWriter`" paragraph becomes wrong), `disk-write-path.md`, `note-path-resolution.md`, `vault-registry.md` (the `writer` table row), `obsidian-lib.md`, `module-structure.md` (mermaid node and prose). A full `docs/` sweep, not an architecture-scoped one.

**Not touched** — tool input/output schemas, parameter names (ADR-0005), client-visible error codes, `FsVaultReader` and its errors-as-data convention, the semantic module, ADR-0009 itself.
