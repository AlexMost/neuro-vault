# headless-vault-operations Specification

## Purpose

Vault operations (`create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, `list_properties`, and the tag/property sections of `get_vault_overview`) run headless: the server reads and writes the vault directory on disk directly, with no dependency on the Obsidian application or the `obsidian` CLI. This capability pins the disk-direct behavior contract — error codes, frontmatter round-trip guarantees, and the conveniences deliberately dropped with the CLI (template expansion, `types.json` maintenance).
## Requirements
### Requirement: Vault operations run without Obsidian

Every vault operation — creating a note, editing a note in place, reading the daily note, setting and removing frontmatter properties, and aggregating tags and properties — SHALL execute against the vault directory on disk, requiring neither the `obsidian` CLI binary nor a running Obsidian instance.

#### Scenario: Vault operation tools work on a machine without Obsidian

- **WHEN** the server runs where no `obsidian` binary exists and `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, or `list_properties` is called with valid input
- **THEN** the call succeeds, and any failure is a tool-contract error (e.g. `NOTE_EXISTS`, `DAILY_NOTES_NOT_CONFIGURED`), never `CLI_NOT_FOUND` or `CLI_UNAVAILABLE`

#### Scenario: get_vault_overview is fully populated headless

- **WHEN** `get_vault_overview` runs where no `obsidian` binary exists
- **THEN** the `top_tags` and `properties` sections are populated from disk alongside `folders` and `top_by_backlinks`

### Requirement: Daily note resolution reads daily-notes.json

`readDaily` SHALL resolve today's daily note path from the vault's `.obsidian/daily-notes.json` (folder and format) and read the note from disk, and a missing or unconfigured daily-notes setup SHALL fail with `DAILY_NOTES_NOT_CONFIGURED`.

#### Scenario: Configured daily note is read from disk

- **WHEN** `.obsidian/daily-notes.json` defines folder and format and today's note exists
- **THEN** `readDaily` returns `{ path, frontmatter, content }` for that file without invoking any external process

#### Scenario: Missing configuration fails with the contract error

- **WHEN** `.obsidian/daily-notes.json` is absent or does not define a usable configuration
- **THEN** `readDaily` fails with `DAILY_NOTES_NOT_CONFIGURED`

#### Scenario: A folder or format that escapes the vault is refused

- **WHEN** `.obsidian/daily-notes.json` defines a `folder` or `format` whose resolved path leaves the vault root (e.g. `folder: "../outside"`)
- **THEN** `readDaily` fails with `DAILY_NOTES_NOT_CONFIGURED` and reads no file outside the vault

#### Scenario: Missing today-note behavior is preserved

- **WHEN** the configuration is valid but today's daily note file does not exist
- **THEN** the outcome (error code and the resolved path made available to the caller) matches the pre-migration `read_daily` tool contract, so the documented follow-up — `create_note` at the returned path — keeps working

### Requirement: Write methods edit vault files directly

`create_note` SHALL write the note file at the resolved vault-relative path (failing with `NOTE_EXISTS` when the file exists and `overwrite` is not set); `set_property` and `remove_property` SHALL rewrite only the YAML frontmatter block, preserving the note body byte-for-byte; and `edit_note` SHALL rewrite only the body, preserving the frontmatter block byte-for-byte. All of these SHALL be performed by a single module bound to the vault root, so that the read → split frontmatter → mutate → write sequence has one implementation.

#### Scenario: Creating over an existing note requires overwrite

- **WHEN** `createNote` targets a path that already exists and `overwrite` is not set
- **THEN** the call fails with `NOTE_EXISTS`

#### Scenario: Property writes leave the body untouched

- **WHEN** `setProperty` or `removeProperty` runs against a note with a body
- **THEN** the body bytes are identical before and after; only the frontmatter block differs

#### Scenario: Body edits leave the frontmatter untouched

- **WHEN** `edit_note` runs against a note with a frontmatter block, in either its targeted-replace or whole-body mode
- **THEN** the frontmatter bytes are identical before and after; only the body differs

#### Scenario: Removing an absent property is idempotent

- **WHEN** `removeProperty` names a key the note's frontmatter does not contain
- **THEN** the call succeeds without modifying the file

#### Scenario: Ambiguous name is rejected, never silently resolved

- **WHEN** `setProperty` or `removeProperty` is addressed by `name` and more than one note shares that basename
- **THEN** the call fails with `AMBIGUOUS_MATCH` listing the matching paths (the same behavior as `edit_note`), and no file is written

### Requirement: Dropped Obsidian conveniences are explicit non-behavior

`createNote` SHALL persist exactly the provided content without template expansion, and `setProperty` SHALL NOT create or modify `.obsidian/types.json`.

#### Scenario: Content is written verbatim

- **WHEN** `createNote` receives content
- **THEN** the file on disk contains exactly that content, with no template applied

#### Scenario: types.json is never touched

- **WHEN** `setProperty` writes a property name the vault has never used, with an explicit `type`
- **THEN** `.obsidian/types.json` is not created or modified

### Requirement: No external process dependency remains

After the migration completes, the operations module SHALL NOT invoke any external process, and the server SHALL NOT accept the `--obsidian-cli` option or surface the `CLI_NOT_FOUND`, `CLI_UNAVAILABLE`, or `CLI_TIMEOUT` error codes.

#### Scenario: The CLI flag is rejected at startup

- **WHEN** the server is launched with `--obsidian-cli /some/path`
- **THEN** startup fails with an unknown-option error (yargs strict mode)

#### Scenario: No CLI error codes in the dictionary

- **WHEN** the operations test suite asserts the set of producible error codes
- **THEN** `CLI_NOT_FOUND`, `CLI_UNAVAILABLE`, and `CLI_TIMEOUT` are absent

### Requirement: Tag and property listings aggregate from the vault scan

`listTags` and `listProperties` SHALL return `{ name, count }` entries aggregated from the same scoped disk scan that powers `query_notes` — notes excluded by the vault's scope (see the `vault-scope` capability) contribute to neither listing; property counting SHALL include frontmatter keys only, and tag counting SHALL include the per-note union of frontmatter `tags:` values and inline body `#tags`, counting each distinct tag at most once per note. Inline tags SHALL follow the Obsidian-documented grammar — `#` preceded by start-of-text or whitespace, tag characters `[A-Za-z0-9_/-]`, at least one non-numeric character, nested tags counted verbatim — and SHALL NOT be extracted from code fences, inline code, URL fragments, or markdown heading markers. The `tags` filter of `query_notes` and `search_notes` remains frontmatter-only; `list_tags` MAY therefore report tags that a `tags` filter cannot match, and both tool descriptions SHALL state this asymmetry.

#### Scenario: Frontmatter tags are counted

- **WHEN** three notes carry `alpha` in their frontmatter `tags:` field
- **THEN** `list_tags` reports `{ name: "alpha", count: 3 }`

#### Scenario: Inline body tags are counted

- **WHEN** a note contains `#beta` in its body but not in frontmatter `tags:`
- **THEN** `beta` contributes 1 to `list_tags` counts, and `get_vault_overview.top_tags` reflects it

#### Scenario: A tag is counted once per note

- **WHEN** a note carries `gamma` in frontmatter `tags:` and also writes `#gamma` (twice) in its body
- **THEN** `list_tags` reports `{ name: "gamma", count: 1 }` for that note's contribution

#### Scenario: Duplicated frontmatter entries count once

- **WHEN** a note's frontmatter is `tags: [alpha, alpha]`
- **THEN** that note contributes 1 to `alpha`'s count

#### Scenario: Non-tag `#` sequences are excluded

- **WHEN** a note body contains `#123`, a fenced code block with `#fenced`, inline code `` `#inline` ``, a URL `https://example.com/#section`, and a heading line `## Heading`
- **THEN** none of `123`, `fenced`, `inline`, `section`, or `Heading` appear in `list_tags`

#### Scenario: Nested inline tags count verbatim

- **WHEN** a note body contains `#project/alpha`
- **THEN** `list_tags` reports `project/alpha` (no split into `project`)

#### Scenario: Inline-only tags are not filterable

- **WHEN** a tag exists only inline in note bodies
- **THEN** `list_tags` reports it while `query_notes` with `filter: { tags: <tag> }` matches no notes, and the `list_tags` and `query_notes` descriptions state this asymmetry

#### Scenario: Property names are counted across notes

- **WHEN** a frontmatter key `status` appears in five notes
- **THEN** `list_properties` reports `{ name: "status", count: 5 }`

#### Scenario: An out-of-scope note contributes no tags or properties

- **WHEN** a note under a scope-excluded folder (e.g. `Templates/`) carries frontmatter `tags: [delta]` and a `status` property
- **THEN** `delta` does not appear in `list_tags` and that note contributes nothing to `list_properties`

### Requirement: Note writes resolve one identifier rule at one depth

Every tool that writes a note (`create_note`, `edit_note`, `set_property`, `remove_property`) SHALL accept its target as exactly one of `name` or `path`, and SHALL fail with `INVALID_ARGUMENT` naming the offending field when both or neither is supplied. Each SHALL hand that target to the disk layer as an unresolved identifier rather than a pre-resolved path, so that turning a `name` into a vault-relative path happens in exactly one place. Resolution SHALL distinguish two cases and no others: a target that must already exist (`edit_note`, `set_property`, `remove_property`), which resolves through the scoped basename index; and a target being created (`create_note`), which resolves through the vault's new-note-location convention. A `name` matching more than one existing note SHALL NOT be resolved silently.

#### Scenario: Both name and path is refused by every write tool

- **WHEN** `create_note`, `edit_note`, `set_property`, or `remove_property` is called with both `name` and `path`
- **THEN** the call fails with `INVALID_ARGUMENT`, the error details name the offending field, and no file is written

#### Scenario: Neither name nor path is refused by every write tool

- **WHEN** any of those four tools is called with neither `name` nor `path`
- **THEN** the call fails with `INVALID_ARGUMENT` and no file is written

#### Scenario: An ambiguous name is refused wherever the target must exist

- **WHEN** `edit_note`, `set_property`, or `remove_property` is addressed by a `name` shared by more than one note
- **THEN** the call fails with `AMBIGUOUS_MATCH` listing the matching paths, and no file is written

#### Scenario: Creating by name uses the new-note-location convention

- **WHEN** `create_note` is called with a `name` and the vault configures a new-note folder
- **THEN** the note is created inside that folder, and a `name` that would resolve outside the vault fails with `INVALID_ARGUMENT` naming the `name` field

### Requirement: Operations on an existing note share one failure taxonomy

Every operation that opens a note which must already exist — `edit_note` in both its modes, `set_property`, and `remove_property` — SHALL report a missing note as `NOT_FOUND`, an unreadable note as `READ_FAILED`, and a failed write as `WRITE_FAILED`, each carrying the resolved vault-relative path in its error details. No filesystem failure on these paths SHALL reach the caller as an uncoded error. This taxonomy is distinct from, and SHALL NOT replace, the create-time taxonomy of `create_note` (`NOTE_EXISTS`, `CREATE_FAILED`).

#### Scenario: A missing note is NOT_FOUND on every path

- **WHEN** `edit_note`, `set_property`, or `remove_property` targets a vault-relative path with no file
- **THEN** the call fails with `NOT_FOUND` and the details carry that path

#### Scenario: A failed write is a coded WRITE_FAILED

- **WHEN** the underlying filesystem write fails during `edit_note`, `set_property`, or `remove_property`
- **THEN** the call fails with `WRITE_FAILED` carrying the path, never as an error without a code

#### Scenario: The create-time taxonomy is unchanged

- **WHEN** `create_note` targets an existing path without `overwrite`, or its write fails for another reason
- **THEN** the call fails with `NOTE_EXISTS` or `CREATE_FAILED` respectively, unaffected by the shared existing-note taxonomy

---

