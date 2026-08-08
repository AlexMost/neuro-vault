# headless-vault-operations Specification

## Purpose

Vault operations (`create_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, `list_properties`, and the tag/property sections of `get_vault_overview`) run headless: the server reads and writes the vault directory on disk directly, with no dependency on the Obsidian application or the `obsidian` CLI. This capability pins the disk-direct behavior contract — error codes, frontmatter round-trip guarantees, and the conveniences deliberately dropped with the CLI (template expansion, `types.json` maintenance).
## Requirements
### Requirement: Vault operations run without Obsidian

Every `VaultProvider` method (`createNote`, `readDaily`, `setProperty`, `removeProperty`, `listTags`, `listProperties`) SHALL execute against the vault directory on disk, requiring neither the `obsidian` CLI binary nor a running Obsidian instance.

#### Scenario: Provider-backed tools work on a machine without Obsidian

- **WHEN** the server runs where no `obsidian` binary exists and `create_note`, `read_daily`, `set_property`, `remove_property`, `list_tags`, or `list_properties` is called with valid input
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

`createNote` SHALL write the note file at the resolved vault-relative path (failing with `NOTE_EXISTS` when the file exists and `overwrite` is not set), and `setProperty` / `removeProperty` SHALL rewrite only the YAML frontmatter block, preserving the note body byte-for-byte.

#### Scenario: Creating over an existing note requires overwrite

- **WHEN** `createNote` targets a path that already exists and `overwrite` is not set
- **THEN** the call fails with `NOTE_EXISTS`

#### Scenario: Property writes leave the body untouched

- **WHEN** `setProperty` or `removeProperty` runs against a note with a body
- **THEN** the body bytes are identical before and after; only the frontmatter block differs

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

`listTags` and `listProperties` SHALL return `{ name, count }` entries aggregated from the same disk scan that powers `query_notes`; property counting SHALL include frontmatter keys only, and tag counting SHALL include the per-note union of frontmatter `tags:` values and inline body `#tags`, counting each distinct tag at most once per note. Inline tags SHALL follow the Obsidian-documented grammar — `#` preceded by start-of-text or whitespace, tag characters `[A-Za-z0-9_/-]`, at least one non-numeric character, nested tags counted verbatim — and SHALL NOT be extracted from code fences, inline code, URL fragments, or markdown heading markers. The `tags` filter of `query_notes` and `search_notes` remains frontmatter-only; `list_tags` MAY therefore report tags that a `tags` filter cannot match, and both tool descriptions SHALL state this asymmetry.

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

