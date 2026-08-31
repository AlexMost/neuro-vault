## Context

Since ADR-0009 the server writes the vault directory straight from disk, with no
external process anywhere in the path. That migration deleted the CLI adapter
but left its silhouette: `VaultProvider` is an interface with exactly one
`implements`, and note writes are split across two modules that share a
sequence and never share code.

- `FsVaultWriter` (`src/lib/obsidian/vault-writer.ts`, 90 lines) serves exactly
  one tool, `edit_note`, and takes an already-resolved vault-relative path.
- `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`, 317 lines)
  serves every other write tool and resolves a `NoteIdentifier` itself.

Both implement read → `splitRawFrontmatter` → mutate → write with their own
fs-error mapping. That divergence shipped #113 (an `edit_note` write failure
escaping as a bare `Error`, violating ADR-0003); #113 is closed, so this change
consolidates onto a correct mapping rather than introducing one.

The "exactly one of name or path" rule has four implementations —
`resolveIdentifier` (`tool-helpers.ts:17`), inline XORs in `create-note.ts` and
`edit-note.ts`, and `FsVaultProvider.createNote`'s guard, which checks only
both-missing and lets `path` silently win when both are supplied. Resolution
happens at two depths: `edit_note` resolves in the tool, the property tools
resolve in the provider.

`listTags` / `listProperties` are pure read-aggregates over `reader.scan()`
hanging off a write interface, which is why `computeVaultOverview` needs four
deps for one snapshot. Three independently written `makeProvider` test helpers
keep the interface's shape in sync by hand.

**Constraints.**

- ADR-0003: every failure crossing the tool boundary carries a structured code.
  The fs-error mapping is contract surface, not an implementation detail.
- ADR-0005: parameter names are a dictionary; none may move here.
- ADR-0015 / #112: tool tests reach a tool through `registerTool` and the
  `test/_gate.ts` helpers, never `buildXTool(deps).handler`.
- Nothing under `src/lib/` imports from `src/modules/` (verified by grep). Any
  code `computeVaultOverview` calls must live under `src/lib/`.
- `npm run typecheck` is authoritative (`isolatedModules`); a `tsup` build is
  not sufficient.

## Goals / Non-Goals

**Goals:**

- One module performs every note write over a vault root.
- One implementation of the name ⊕ path rule; every write tool resolves at the
  same depth.
- One `NOT_FOUND` / `READ_FAILED` / `WRITE_FAILED` mapping for operations on
  notes that already exist.
- `IVaultEntry` carries no `writer`.
- `VaultProvider` is resized to a cohesive set: every operation that opens one
  note file. `computeVaultOverview` takes three deps.
- Three hand-synced `makeProvider` stubs become one, alongside the real-module
  builder over temp vaults.
- No client-visible contract change.

**Non-Goals:**

- Tool input/output schemas, parameter names, or the documented error-code set.
- Revisiting ADR-0009. Both halves are already disk-direct; this resizes the
  interface its migration left behind.
- `FsVaultReader`'s errors-as-data convention. It is a third convention over the
  same vault root, and reconciling it is a batch-read concern with its own
  callers — out of scope here, and named as such so a reader does not read
  "one module over the vault root" as covering reads too.
- Renaming `VaultProvider`. The name is referenced from ADR-0009 and five
  architecture docs; the shape is the problem, not the label.
- Moving the operations tool suite onto temp vaults (see D2).

## Decisions

### D1 — Fold `FsVaultWriter` into `FsVaultProvider`, do not introduce a third module

- **Choice**: delete `src/lib/obsidian/vault-writer.ts`. `replaceInNote` and
  `replaceFullBody` become `VaultProvider` methods implemented by
  `FsVaultProvider`. `IVaultEntry.writer`, `IVaultEntryDeps.writerFactory`, and
  the `writerFactory` wiring in `src/server.ts` are deleted.
- **Rationale**: `FsVaultWriter` fails the deletion test — one consumer, and
  nothing reappears when it is folded in. Its interface exists because ADR-0007
  needed a CLI-free edit path, not because a second implementation was ever
  plausible.
- **Alternative considered**: extract a new `FsNoteStore` owning writes and
  leave `FsVaultProvider` as read-aggregates. Rejected: it churns every write
  tool and every provider test to arrive at the same one-module-one-root
  property, and it would leave `readDaily` homeless.

### D2 — `VaultProvider` survives as a stubbable interface

- **Choice**: keep `VaultProvider` as an interface, resized to
  `{ createNote, readDaily, setProperty, removeProperty, replaceInNote,
  replaceFullBody }`. `IVaultEntry.provider` stays typed as the interface.
- **Rationale**: what the operations tool tests assert is *what the tool passes
  down* — that `set_property` hands over `identifier: { kind: 'name', value }`,
  that `create_note` forwards merged frontmatter. Against a temp vault those
  assertions become inferences from which bytes changed.
- **Alternative considered**: `IVaultEntry.provider: FsVaultProvider`, tests
  against temp vaults. More honest about there being one implementation, but
  `FsVaultProvider` has private fields, so `Partial<>` stubbing stops
  type-checking and every operations tool test has to move — a far larger
  change, and one that cuts against the gate-routed convention just landed in
  #112.

### D3 — One validation rule, two named resolution modes

- **Choice**: `resolveIdentifier(name, path)` in `tool-helpers.ts` is the only
  implementation of the rule (exactly one of the two; non-empty trimmed `name`;
  `normalizeNotePath` on the path branch). Every write tool calls it and hands
  a `NoteIdentifier` down. Inside `FsVaultProvider`, resolving that identifier
  to a concrete path has two private modes:
  - `resolveExisting(identifier)` — `kind: 'path'` normalizes; `kind: 'name'`
    goes through `resolveNoteName` (basename index over the scoped scan →
    `NOT_FOUND` on zero matches, `AMBIGUOUS_MATCH` on more than one, never a
    silent first-match write). Used by `replaceInNote`, `replaceFullBody`,
    `setProperty`, `removeProperty`.
  - `resolveNew(identifier)` — `kind: 'path'` normalizes; `kind: 'name'`
    prefixes `.obsidian/app.json`'s `newFileLocation` folder and normalizes,
    mapping a normalize failure to `INVALID_ARGUMENT` on field `name`. Used by
    `createNote`.
- **Rationale**: `create_note`'s target does not exist yet, so `kind: 'name'`
  genuinely means something different there — *place a new note*, not *find the
  existing one*. Collapsing both onto one resolver would either break
  `create_note` or reintroduce a silent branch. Splitting *validation* (once, at
  the tool layer) from *resolution* (two modes, one layer down) is what makes
  "one rule" true without lying about the two meanings.
- **Alternative considered**: a single `resolveIdentifierPath` with an
  `allowMissing` flag. Rejected — a boolean parameter that switches which of two
  error taxonomies applies is the shape this change exists to remove.

### D4 — Keep two edit methods rather than collapsing to one `editNote`

- **Choice**: `replaceInNote({ identifier, find, content })` and
  `replaceFullBody({ identifier, content })`. `ReplaceInNoteInput` /
  `ReplaceFullBodyInput` move from `vault-writer.ts` into `vault-provider.ts`,
  with `identifier: NoteIdentifier` replacing `path: string`.
- **Rationale**: the two have different error surfaces —
  only `replaceInNote` can fail with `NOT_FOUND` (find text absent) or
  `AMBIGUOUS_MATCH` (find text repeated, with line numbers). One method with an
  optional `replace` would push that branch, and the tool's existing
  non-empty-`replace` check, down a layer for no gain.
- **Alternative considered**: `editNote({ identifier, content, replace? })`
  mirroring the tool's own input. Rejected as above.

### D5 — One fs mapping over existing notes; `createNote` keeps its own

- **Choice**: private `readRaw(relPath)` → `NOT_FOUND` (`ENOENT`) /
  `READ_FAILED`, and `writeRaw(relPath, data)` → `WRITE_FAILED`, both carrying
  `details: { path }` and `cause`. Shared by `replaceInNote`,
  `replaceFullBody`, and the frontmatter path (`setProperty` /
  `removeProperty`). `createNote` keeps its `mkdir` → `CREATE_FAILED`,
  `EEXIST` → `NOTE_EXISTS`, other → `CREATE_FAILED` mapping.
- **Rationale**: the create-time taxonomy is mandated by the
  `headless-vault-operations` spec and driven by different flags (`wx` / `w`).
  Stating this scoping explicitly is load-bearing: without it, the issue's
  acceptance grep ("a single write-error mapping") reads as "delete
  `CREATE_FAILED`", which would be a breaking contract change.
- **Acceptance, stated precisely**: one `WRITE_FAILED` mapping and one
  `NOT_FOUND` / `READ_FAILED` read mapping for existing notes, plus the distinct
  create-time mapping. Three `ToolHandlerError` construction sites for these
  codes in the module, not six.

### D6 — Carry the injection seam over from `FsVaultWriter`

- **Choice**: `FsVaultProviderOptions` gains optional `readFile` / `writeFile`
  defaulting to `node:fs/promises`, used by `readRaw` / `writeRaw`.
  `createNote`'s write and the config reads (`newNoteDir`,
  `readDailyNotesConfig`) keep their direct calls.
- **Rationale**: it is how `test/operations/tools/edit-note.test.ts:150` — the
  #113 regression test — provokes `WRITE_FAILED` today. Carrying the seam keeps
  that test alive essentially unchanged and, for the first time, makes
  `WRITE_FAILED` reachable by test on the property path.
- **Trade-off accepted**: the seam is asymmetric — it covers the existing-note
  read/write helpers but not `createNote`. That asymmetry is deliberate and
  matches D5: those are two taxonomies, and the create path is already covered
  end-to-end against temp vaults.
- **Alternative considered**: drop the seam, provoke real fs errors by
  `chmod`-ing a temp vault path. Rejected — unreliable when tests run as root
  and on some CI filesystems.

### D7 — Aggregates live in `src/lib/obsidian/vault-aggregates.ts`

- **Choice**: `listTags(reader)` and `listProperties(reader)` become free
  functions in a new `src/lib/obsidian/vault-aggregates.ts`, taking the
  `READ_BATCH_SIZE` batching with them.
- **Rationale**: `computeVaultOverview` lives under `src/lib/`, and nothing
  under `src/lib/` imports `src/modules/`. Putting the aggregates in the
  operations module would force that inversion. `extractTags` and
  `extractInlineTags`, which they compose, are already under
  `src/lib/obsidian/`.
- **Alternative considered**: `src/modules/operations/aggregates.ts` with
  `computeVaultOverview` taking them as injected functions. Rejected — it
  re-adds a dep to the signature this decision exists to shrink.

### D8 — `computeVaultOverview` takes `{ reader, graph, readConventions }`

- **Choice**: drop the `provider` dep; call the D7 functions directly.
  `get_vault_overview` and the `vault-overview` resource stop passing
  `entry.provider`.
- **Rationale**: the snapshot is entirely reader- and graph-derived. Its fourth
  dep existed only to reach two functions that never needed a write interface.
- **Consequence**: `test/lib/obsidian/vault-overview.test.ts`'s inline
  `makeProvider` is deleted rather than reworked — it exists solely to control
  `listTags` / `listProperties`. Those tests drive the reader instead. This is
  what takes the stub count from three to one.

### D9 — Record ADR-0016

- **Choice**: `docs/adr/0016-<slug>.md`, status Accepted, plus its
  `docs/adr/INDEX.md` row.
- **Rationale**: the change deletes an interface seam that
  `docs/architecture/vault-provider.md` currently justifies in prose, and
  narrows what `VaultProvider` is responsible for after ADR-0009. The repo wrote
  ADR-0015 for the comparable gate decision. Without it, the reasoning for
  deleting the seam lives only in an archived change directory.
- **Content**: one module owns note writes over a vault root; the `VaultWriter`
  seam is deleted rather than kept (single consumer, deletion test, and its
  divergence produced #113); what the surviving `VaultProvider` seam is for
  (a stub point for tool tests, not a plausible second backend); and the
  explicit non-goal that `FsVaultReader`'s errors-as-data convention is
  untouched. ADR-0009 stays Accepted; 0016 refines rather than supersedes it.

### D10 — Three PRs, sequential, with review between

- **Choice**: PR 1 folds the writer in (D1, D3, D4, D5, D6). PR 2 does the
  resize (D7, D8) and the test-helper collapse. PR 3 is docs + ADR-0016 +
  archive. `Refs #114` on 1 and 2, `Closes #114` on 3.
- **Rationale**: PR 1 is the risky one — it touches the write path every tool
  depends on and changes two error details. It should be reviewed against a
  green suite before the aggregate move lands on top of it. The repo's
  convention is that one opsx change is not one PR.

## Risks / Trade-offs

**[Risk] `edit_note` error ordering changes in one narrow combination.** Today
`edit-note.ts` resolves the identifier *before* checking `replace !== ''`, so an
unresolvable name plus `replace: ''` fails `NOT_FOUND`. After the change,
`resolveIdentifier` runs at the tool and resolution moves into the module, so
the same call fails `INVALID_ARGUMENT` first. → **Mitigation**: this is the
correct order — reject a malformed argument before touching disk — and no test
pins the combination (`edit-note.test.ts:43` uses a `path`, which never hits
disk). Add a test that pins the new order deliberately, and name the change in
the PR body rather than letting it land unremarked.

**[Risk] `create_note`'s `INVALID_ARGUMENT` details shift.** With both `name`
and `path` supplied, `details.field` goes from `"name"` to `"path"`; the
both-missing message goes from "Provide name or path" to "Provide exactly one of
name or path". → **Mitigation**: intentional unification — the other three write
tools already report exactly this. Same error code; no test or doc pins either
string (verified by grep across `src/`, `docs/`, `openspec/specs/`). Called out
in the proposal's Impact.

**[Risk] The `WRITE_FAILED`-over-`.md` grep acceptance is ambiguous as the issue
states it.** Read literally it would delete `CREATE_FAILED`. → **Mitigation**:
D5 states the acceptance precisely, and the tasks encode the sharpened version.

**[Risk] Deleting `IVaultEntry.writer` breaks construction sites the typecheck
finds only after the interface changes.** `src/server.ts`,
`test/lib/vault-registry.test.ts`, `test/operations/tools.test.ts`,
`test/operations/operations-module.test.ts`, and
`test/operations/tools/_helpers.ts` all build entries. → **Mitigation**: the
interface change and every construction site ship in one commit — a type change
never gets split from the call sites it breaks, because the typecheck gate makes
that boundary unsatisfiable.

**[Trade-off] `FsVaultProvider` grows before it shrinks.** PR 1 adds ~80 lines
(the edit path) to a 317-line file; PR 2 removes ~50 (the aggregates). Net it is
larger than either module was alone. → Accepted: the file's size was never the
complaint. Two owners of one sequence was, and the aggregate move is what makes
the remaining size cohesive rather than incidental.

**[Trade-off] The injection seam is a testing affordance in production code.** →
Accepted: it already exists in `FsVaultWriter` for exactly this reason, it
defaults to the real fs, and D6 records why the alternative is worse.

## Migration Plan

No deployment change: no new dependency, no config, no persisted format, no
network surface. The MCP tool surface is byte-identical apart from the two
`INVALID_ARGUMENT` details noted above.

Order:

1. **PR 1** — fold `FsVaultWriter` in; one rule, one depth, one mapping; delete
   `IVaultEntry.writer` and `writerFactory`. `test/lib/obsidian/vault-writer.test.ts`
   moves into `test/operations/fs-vault-provider/`. Gate: `npm test && npm run
   lint && npm run typecheck`. **Pause for review.**
2. **PR 2** — `vault-aggregates.ts`; `computeVaultOverview` to three deps;
   `list_tags` / `list_properties` / `get_vault_overview` / the overview
   resource rewired; the three `makeProvider` stubs collapse to one. Same gate.
   **Pause for review.**
3. **PR 3** — ADR-0016 + INDEX row; the six architecture docs; a full `docs/`
   sweep (an architecture-scoped grep misses `docs/guide/`); `openspec validate
   --all`; verify → retrospective → archive.

Rollback: each PR is an independent revert. Nothing is persisted, so a revert
needs no data migration.

## Open Questions

None. The four forks — scope, ADR, whether the interface survives, and how the
`WRITE_FAILED` test stays reachable — were settled during brainstorming and are
recorded as D1/D9, D2, and D6.
