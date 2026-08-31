# ADR-0016 — One disk module owns note writes; `VaultProvider` survives only as a test seam

- **Status**: Accepted
- **Date**: 2026-08-31

## Context

[ADR-0009](0009-disk-direct-vault-operations.md) moved every vault operation off the `obsidian` CLI and onto `node:fs/promises`. What it did not settle is *how many* modules may own that disk path. Two ended up doing so over the same vault root, and they never called each other:

- `FsVaultWriter` (`src/lib/obsidian/vault-writer.ts`), behind a `VaultWriter` interface, with exactly one consumer — `edit_note`;
- `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`), behind `VaultProvider`, serving every other write tool.

Each independently implemented the same sequence — read the file, split frontmatter from body, mutate the body, write it back — with its own mapping from fs errors to tool errors. That divergence is not hypothetical: it shipped #113, an `edit_note` write failure escaping as a bare `Error` with no code, in violation of [ADR-0003](0003-structured-errors-toolhandlererror.md). The provider's property path had the coded mapping; the writer did not.

The `VaultWriter` seam also failed the deletion test. It had one consumer, one implementation, and no second implementation was ever plausible: the reason to talk to a vault directory through an interface is to stub it in tests, and `edit_note`'s tests already had a provider stub sitting next to it.

At the same time `VaultProvider` had drifted wider than "operations on a note file". `listTags` and `listProperties` are aggregate scans over the whole vault — they read, they never write, and they need only a `VaultReader`. They sat on a write interface because that is where the CLI-era provider had put them, and their presence forced a `provider` dep onto `computeVaultOverview`, which is otherwise entirely reader- and graph-derived.

## Decision

**One module owns note writes over a vault root.** `FsVaultProvider` is that module. Every write tool — `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property` — reaches the disk through it, over shared private `readRaw` / `writeRaw` helpers that carry a single fs-error mapping (`NOT_FOUND`, `READ_FAILED`, `WRITE_FAILED`, each with `details: { path }` and a `cause`).

**The `VaultWriter` seam is deleted, not kept.** `src/lib/obsidian/vault-writer.ts` and `IVaultEntry.writer` are gone; `ReplaceInNoteInput` and `ReplaceFullBodyInput` moved onto `VaultProvider` with `path: string` replaced by `identifier: NoteIdentifier`.

**`VaultProvider` survives, resized to the six note-file operations**: `createNote`, `readDaily`, `setProperty`, `removeProperty`, `replaceInNote`, `replaceFullBody`. It survives *as a stub point for the operations tool tests*, not as an abstraction over a plausible second backend — there is one implementation, `FsVaultProvider`, and no second one is anticipated. What those tests assert is what a tool *passes down* (that `set_property` hands over `identifier: { kind: 'name', … }`, that `create_note` forwards merged frontmatter); against a temp vault the same assertions degrade into inferences from which bytes changed. An interface with private fields cannot be `Partial<>`-stubbed, so typing `IVaultEntry.provider` as the concrete class would move every operations tool test.

**The two aggregate scans leave the write interface.** `listTags(reader)` and `listProperties(reader)` are free functions in `src/lib/obsidian/vault-aggregates.ts`, taking a `VaultReader`. `list_tags`, `list_properties`, and `computeVaultOverview` call them directly; `computeVaultOverview`'s deps narrow to `{ reader, graph, readConventions }`.

**Non-goal: `FsVaultReader`'s errors-as-data convention is untouched.** The reader reports a per-note failure as an `error` field on that note's result item and keeps going, so one unreadable note does not fail a batch read. The write path throws `ToolHandlerError`. These are different conventions for different jobs — a batch read is partial by nature, a write is not — and this change deliberately does not unify them.

## Consequences

- One fs-error mapping for note writes, so a #113-shaped bug has one place to be fixed and one place to regress. `edit_note` keeps its coded-`WRITE_FAILED` assertions, and they now exercise the same `writeRaw` helper the property tools do.
- The "exactly one of `name` or `path`" rule has one implementation, `resolveIdentifier` in `src/modules/operations/tool-helpers.ts`. Tools validate; the provider resolves, in two named private modes (`resolveExisting` for the four methods that require an existing note, `resolveNew` for `createNote`, whose `kind: 'name'` means *place a note* rather than *find one*). Two normalized error details follow from that: supplying both `name` and `path` now reports `details.field: "path"`, and supplying neither reports "Provide exactly one of name or path".
- `edit_note` gained name-addressing and lost a silent branch: a `name` matching two notes now fails `AMBIGUOUS_MATCH` with no file written, where the old writer took a path only.
- Refines [ADR-0009](0009-disk-direct-vault-operations.md) without superseding it. 0009's decision — vault operations go direct to disk, no external process — holds unchanged. Only its enumeration of `VaultProvider` methods is narrowed: `listTags` and `listProperties` still run against the same disk scan, just not from that interface. 0009 stays Accepted.
- `VaultProvider` is now a seam with a stated purpose rather than an assumed one. Adding a method to it is a claim that a tool test needs to stub that behaviour; a vault operation that needs no stub, or that only reads, does not belong there. The aggregates are the worked example.
- `src/lib/` still must not import `src/modules/`, which is why `vault-aggregates.ts` lives under `src/lib/obsidian/` rather than beside the provider.

## Alternatives considered

- **Keep `VaultWriter` and make `FsVaultProvider` implement it** — preserves a seam nothing consumes twice, and leaves the two error mappings free to drift again behind one interface.
- **Delete `VaultProvider` too and type `IVaultEntry.provider` as `FsVaultProvider`** — more honest about there being one implementation, but its private fields break `Partial<>` stubbing, so every operations tool test moves to temp-vault assertions in the same change. Rejected as disproportionate, and as cutting against the gate-routed test convention just landed by [ADR-0015](0015-input-gate-owns-schema-validation.md).
- **Move the aggregates onto `VaultReader`** — they are derived counts, not a read primitive; putting them there would widen the interface that `read_notes` and `query_notes` depend on to serve two tools that only ever compose its existing methods.
