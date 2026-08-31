# Disk-direct vault writes

How `create_note`, `edit_note`, and `read_daily` behave now that every `VaultProvider` method (`FsVaultProvider`) writes and reads the vault directory directly via `node:fs/promises`, with no external process in the path. See [ADR-0009](../adr/0009-disk-direct-vault-operations.md) for why this replaced the `obsidian-cli`-backed path (formerly ADR-0007), and [ADR-0016](../adr/0016-one-disk-module-owns-note-writes.md) for why one module — not two — owns that path.

## `create_note`: writes the exact path it was asked for

`FsVaultProvider.createNote` resolves the target path itself (from `path`, or from `name` plus `.obsidian/app.json`'s `newFileLocation` convention) and calls `fs.writeFile` on that exact absolute path, with flag `wx` (fails on an existing file) or `w` when `overwrite: true`. There is no intermediate process that could report success while writing nothing, or writing somewhere else — the call either lands at the resolved path or throws.

This retires the failure mode ADR-0007 guarded against: the old `ObsidianCLIProvider.createNote` shelled out to `obsidian-cli`, which could return exit 0 without writing (most reproducibly on a vault-name mismatch between `--vault` and what Obsidian showed under "Manage vaults"), so the provider added a post-write `fs.stat` as a defense against a silent lie from the CLI. `FsVaultProvider` has no CLI to lie to it, so that defense — and the `CREATE_FAILED` path it existed to catch — no longer applies; `CREATE_FAILED` is now only reachable from a genuine `fs.writeFile` error (e.g. `EACCES`, a bad path).

`EEXIST` (from the `wx` flag) is translated to `NOTE_EXISTS`, the same code callers already handled.

## `edit_note`: rewrites an existing body, frontmatter untouched

`edit_note` is the same module's other write. `replaceInNote` (targeted find/replace) and `replaceFullBody` (whole-body rewrite) both resolve the note, read it, split the raw frontmatter prefix off, mutate only the body, and write `prefix + body` back — so the frontmatter block survives byte-for-byte, including comments and key order that a YAML round-trip would lose. `applyReplace` (`src/lib/obsidian/in-place-edit.ts`) is what refuses an ambiguous anchor rather than replacing a first match.

These two used to live in a separate `FsVaultWriter` behind its own `VaultWriter` interface, with its own fs-error mapping. That second mapping is what shipped #113 — an `edit_note` write failure escaping with no error code. Both methods now share the provider's `readRaw` / `writeRaw` helpers, so there is one mapping to be correct.

## Two error taxonomies, split by whether the note exists

Every write in this module goes through one of two resolution modes (see [`vault-provider.md`](./vault-provider.md#identifier-shape)), and each has its own codes. They do not overlap:

| Path                                                                          | Codes                                                                                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing note** — `edit_note`, `set_property`, `remove_property`             | `NOT_FOUND` (no such file, or a `name` matching nothing), `AMBIGUOUS_MATCH` (a `name` matching several notes, or a find-anchor matching several lines), `READ_FAILED`, `WRITE_FAILED` |
| **New note** — `create_note`                                                   | `NOTE_EXISTS` (`EEXIST` under the `wx` flag), `CREATE_FAILED` (any other write or parent-directory failure)                                    |

`create_note` therefore never reports `NOT_FOUND` or `WRITE_FAILED`, and the existing-note path never reports `CREATE_FAILED` or `NOTE_EXISTS` — the code tells a caller which side of the note's existence it was on. Both taxonomies carry `details: { path }` and the originating `cause`. `read_daily` sits with the existing-note reads, with one deliberate exception: its `NOT_FOUND` message wording is pinned by the `headless-vault-operations` spec, so it maps `ENOENT` itself rather than routing through `readRaw`.

Ahead of both, an identifier that cannot be validated at all — neither `name` nor `path`, both of them, an empty `name`, or a path escaping the vault root — fails `INVALID_ARGUMENT` at the tool layer, before any disk I/O.

## `read_daily`: Daily Notes preflight, now for a different reason

`read_daily` still preflights `.obsidian/daily-notes.json` before touching the note, but the reason has shifted. Under ADR-0007, the preflight existed because `obsidian-cli daily:path`/`daily:read` delegated to Obsidian's Daily Notes core plugin, and on an unconfigured vault the plugin's default behavior was to materialize a 0-byte stub at the vault root — the preflight stopped the CLI from ever being invoked in that state.

There is no CLI to invoke anymore. `FsVaultProvider.readDaily` resolves today's path itself:

1. `readDailyNotesConfig(vaultRoot)` (`src/lib/obsidian/daily-notes-config.ts`) reads `.obsidian/daily-notes.json` directly and throws `DAILY_NOTES_NOT_CONFIGURED` when the file is missing, malformed, or its `folder` is empty — there is no fallback or auto-create.
2. `formatDailyDate(config.format, new Date())` (`src/lib/obsidian/daily-note-path.ts`) is a minimal moment.js-compatible renderer covering the tokens Obsidian's default configs use (`YYYY`, `YY`, `MM`, `M`, `DD`, `D`, bracketed literals, and passthrough separators). A format token it cannot render also throws `DAILY_NOTES_NOT_CONFIGURED` — the server cannot resolve that vault's daily-note path headlessly.
3. The provider joins `config.folder` and the rendered basename into today's path and reads it directly; a missing note surfaces as `NOT_FOUND` with the resolved path, so the caller can `create_note` at exactly that location.

The preflight is still the only thing standing between an unconfigured vault and a confusing error — it just guards a self-contained path-resolution step now instead of a CLI delegation.

## Why `create_note` does not handle templates

`create_note` accepts only `content` — raw markdown for the note body and frontmatter. If a caller wants a template applied, it renders the template itself (Obsidian Core Templates, Templater, or anything else) and passes the result as `content`. This was already true under the CLI-backed path and remains true here: the MCP server stays narrowly responsible for "write this content to this path" rather than reimplementing pieces of Obsidian's plugin ecosystem. See [ADR-0009](../adr/0009-disk-direct-vault-operations.md) for this as an accepted divergence.
