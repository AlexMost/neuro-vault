# Brainstorm — consolidate disk writes into one module over the vault root

Raw capture. Source: issue #114 (itself the output of a 2026-08-28 architecture
review). Classified **architectural** — it restructures the
`VaultProvider` / `VaultWriter` seam that `IVaultEntry` and every write tool
depend on, and reverses prose that `docs/architecture/vault-provider.md`
currently states as rationale.

## Background — what the code looks like today

Two modules own disk writes over the same vault root and never call each other:

- `FsVaultWriter` (`src/lib/obsidian/vault-writer.ts`, 90 lines). Consumed by
  exactly one tool, `edit_note`. Takes an already-resolved vault-relative
  `path`.
- `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`, 317 lines).
  Every other write tool. Takes a `NoteIdentifier` and resolves it itself.

Both independently implement read → `splitRawFrontmatter` → mutate → write,
each with its own fs-error mapping. `FsVaultReader` adds a third convention
(errors returned as data rather than thrown). The divergence already produced
one shipped bug: #113, an `edit_note` write failure escaping as a bare `Error`
without a code, in violation of ADR-0003. #113 is closed, so the refactor
preserves a correct mapping rather than introducing one.

**Four implementations of "exactly one of name or path":**

1. `resolveIdentifier` (`src/modules/operations/tool-helpers.ts:17`) — the real
   one. Rejects both-missing and both-present, trims `name`, runs
   `normalizeNotePath` on the path branch (which appends `.md` when the final
   segment has no extension — intended, per
   `docs/architecture/note-path-resolution.md`).
2. An inline XOR in `create-note.ts:61-66`.
3. Another inline XOR in `edit-note.ts:53-61`.
4. `FsVaultProvider.createNote`'s guard at `fs-vault-provider.ts:64-66` — not
   an XOR at all. It only checks both-missing; when both are supplied, `path`
   silently wins. Unreachable from the tool today (copy 2 rejects first), but
   it is the copy a future caller would trust.

**Two resolution depths.** `edit_note` resolves name→path in the tool
(`resolveToPath`) and hands the writer a concrete path; `set_property` /
`remove_property` pass a `NoteIdentifier` the provider resolves
(`resolveIdentifierPath`). A change to ambiguity policy has to find all four
copies across both depths.

**`VaultProvider` is a hypothetical seam.** Exactly one `implements
VaultProvider` since ADR-0009 deleted the CLI adapter. Its shape is historical
rather than cohesive: `listTags` / `listProperties` are pure read-aggregates
over `reader.scan()` that happen to hang off a write interface, which is why
`computeVaultOverview` needs four deps (`reader`, `provider`, `graph`,
`readConventions`) to produce one snapshot.

**Deletion test on `FsVaultWriter`:** fold it into the one disk module and
nothing reappears — it has a single consumer.

## Decision chain

### Q1 — Scope: one slice or two?

Issue #114 proposes half A (fold the writer in) and marks half B (resize
`VaultProvider`, make the aggregates reader-derived) as "may be its own slice".

**Decided: both halves, one opsx change, delivered as separate PRs.**

Reasoning: half B is what actually satisfies the issue's own acceptance bullet
about the three `makeProvider` helpers collapsing to one.
`test/lib/obsidian/vault-overview.test.ts` carries an inline provider stub
*only* to control `listTags` / `listProperties`; once the overview derives
those from the reader, that stub is deleted outright rather than kept in sync.
Half A alone takes three helpers to two.

Rejected: half A only (leaves the four-dep overview and the third stub);
half B only (inverts the issue's stated order and leaves the divergence that
produced #113 in place).

### Q2 — Record an ADR?

**Decided: yes, ADR-0016.**

The change deletes an interface seam whose existence
`docs/architecture/vault-provider.md` currently justifies in prose, and narrows
what `VaultProvider` is for in the world ADR-0009 left behind. The repo wrote
ADR-0015 for the comparable gate decision. Without an ADR the reasoning for
deleting the seam would live only in an archived change directory.

Rejected: docs-only. Cheaper, but a future reader finding one `implements`
and a six-method interface has no record of why the seventh module went away.

### Q3 — Does `VaultProvider` survive as an interface?

The issue's acceptance leaves this open: "collapse to one (or to the real
module against temp vaults)".

**Decided: keep the interface, resized.**

`VaultProvider` becomes `{ createNote, readDaily, setProperty, removeProperty,
replaceInNote, replaceFullBody }` — every operation that opens one note file
over the vault root.

Reasoning: what the operations tool tests assert is *what the tool passes
down* (e.g. `set_property` hands over `identifier: { kind: 'name' }`). A temp
vault would make that assertion indirect — you would infer the identifier from
which file changed. Keeping a stubbable interface keeps those tests direct.

Rejected: `IVaultEntry.provider: FsVaultProvider`. Honest about there being one
implementation, but `FsVaultProvider` has private fields, so `Partial<>`
stubbing stops type-checking and every operations tool test would have to move
to temp vaults — a much larger change, and one that cuts against the
gate-routed test convention just landed in #112 / ADR-0015.

### Q4 — How does the merged module keep the #113 regression test reachable?

`FsVaultWriter` accepts injectable `readFile` / `writeFile`; that is how
`test/operations/tools/edit-note.test.ts:150` provokes `WRITE_FAILED`.
`FsVaultProvider` uses the module imports directly.

**Decided: carry the injection seam over.**

The merged module takes optional `readFile` / `writeFile` defaulting to
`node:fs/promises`, used by the shared `readRaw` / `writeRaw` helpers that the
edit and property paths both go through. The #113 regression test survives
essentially unchanged, and `set_property` / `remove_property` gain the same
`WRITE_FAILED` coverage for the first time.

`createNote`'s write keeps its own direct call: different flags (`wx` / `w`)
and a different, spec-mandated taxonomy (`NOTE_EXISTS` / `CREATE_FAILED`).

Rejected: provoke real fs errors by `chmod`-ing a temp vault path unwritable.
No injection wart, but unreliable when tests run as root and on some CI
filesystems.

## Design trade-offs settled during the discussion

### One validation rule, two resolution modes

A single `resolveIdentifierPath` cannot serve every write tool, and pretending
otherwise would be the bug this change is supposed to prevent:

- For `edit_note` / `set_property` / `remove_property`, `kind: 'name'` means
  *find the existing note* — basename index over a scoped scan, `NOT_FOUND` on
  zero matches, `AMBIGUOUS_MATCH` on more than one, never a silent first-match
  write (`resolve-note-name.ts`).
- For `create_note`, `kind: 'name'` means *place a new note* — the note does
  not exist yet, so resolution reads `.obsidian/app.json`'s `newFileLocation`
  convention and normalizes.

So: the *validation* rule (exactly one of name or path; non-empty trimmed name;
normalized path) is implemented once, in `resolveIdentifier` at the tool layer.
The *resolution* of a `NoteIdentifier` to a concrete path has two named modes,
both inside the disk module. Four copies of the rule become one; two resolution
depths become one.

### What "a single write-error mapping" means

`createNote` must keep `NOTE_EXISTS` / `CREATE_FAILED` — the
`headless-vault-operations` spec mandates that taxonomy, and the flags differ.
So the acceptance grep has to be stated precisely, or it is unsatisfiable: one
`WRITE_FAILED` mapping and one `NOT_FOUND` / `READ_FAILED` read mapping, shared
by every path that opens an existing note, plus the distinct create-time
mapping. Naming this up front stops a reviewer from reading the acceptance
bullet as "delete `CREATE_FAILED`".

### Where the reader-derived aggregates live

`src/lib/obsidian/vault-aggregates.ts`, not the operations module.
`computeVaultOverview` lives under `src/lib/`, and nothing under `src/lib/`
imports from `src/modules/` today (verified by grep). Putting `listTags` /
`listProperties` in the operations module would force that inversion.
`extractTags` and `extractInlineTags`, which they compose, already live under
`src/lib/obsidian/`.

### Tool contracts are untouched

No input schema, output shape, parameter name (ADR-0005), or client-visible
error code changes. The one behavioural difference — `createNote`'s guard going
from "path silently wins" to a real XOR — is unreachable from the tool layer,
which already rejects both-supplied. That makes this an internal consolidation
whose spec deltas describe properties that were previously incidental.

## Delivery

Three PRs against `main`, pausing for review between each: fold the writer in;
reader-derived aggregates and the resized overview deps; docs, ADR-0016, and
archive. `Refs #114` on the first two, `Closes #114` on the last.

## Acceptance (from the issue, sharpened)

- `npm test`, `npm run lint`, `npm run typecheck` pass.
- One module performs all note writes; `grep` finds a single implementation of
  the name ⊕ path rule and a single `WRITE_FAILED` mapping over existing notes
  (create-time mapping excepted, per above).
- All write tools resolve identifiers at the same depth; `IVaultEntry` has no
  `writer` field.
- The three hand-maintained `makeProvider` stubs collapse to one, alongside the
  real-module helper that builds `FsVaultProvider` over a temp vault.
