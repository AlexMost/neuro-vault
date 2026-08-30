## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Vault operations run without Obsidian

Every vault operation — creating a note, editing a note in place, reading the daily note, setting and removing frontmatter properties, and aggregating tags and properties — SHALL execute against the vault directory on disk, requiring neither the `obsidian` CLI binary nor a running Obsidian instance.

#### Scenario: Vault operation tools work on a machine without Obsidian

- **WHEN** the server runs where no `obsidian` binary exists and `create_note`, `edit_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, or `list_properties` is called with valid input
- **THEN** the call succeeds, and any failure is a tool-contract error (e.g. `NOTE_EXISTS`, `DAILY_NOTES_NOT_CONFIGURED`), never `CLI_NOT_FOUND` or `CLI_UNAVAILABLE`

#### Scenario: get_vault_overview is fully populated headless

- **WHEN** `get_vault_overview` runs where no `obsidian` binary exists
- **THEN** the `top_tags` and `properties` sections are populated from disk alongside `folders` and `top_by_backlinks`

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
