## ADDED Requirements

### Requirement: A vault's conventions survive the instructions truncation budget

Composed MCP `instructions` SHALL place every per-vault conventions block — the contents of
`<vaultPath>/.neuro-vault/for-external-agents.md` — ahead of all server-authored prose, so that
the blocks occupy the beginning of the string. The server-authored preamble that follows SHALL be
small enough that a representative conventions file of roughly 1,200 characters appears in full,
together with the complete preamble, within the first 2048 characters of the composed output.
Ordering is normative: a client that renders only a leading slice of `instructions` MUST receive
the vault-specific content, because it is the only content no tool description can supply.

#### Scenario: a representative vault block is intact inside the budget

- **WHEN** instructions are composed for a vault whose `for-external-agents.md` is ~1,200 characters
- **THEN** the first 2048 characters of the result contain that file's content in full, and also
  contain the server-authored preamble in full

#### Scenario: conventions precede server prose

- **WHEN** instructions are composed for a vault that has a conventions file
- **THEN** the conventions block starts at a lower character offset than any server-authored section

#### Scenario: no conventions file leaves the preamble alone

- **WHEN** instructions are composed for a vault with no `for-external-agents.md`
- **THEN** the result is the server-authored preamble with no conventions heading and no empty block

### Requirement: Composed instructions do not restate tool descriptions

The server-authored portion of `instructions` SHALL carry only guidance that no tool description
carries: the vault's role as a second brain, the routing heuristic between vault operations and
semantic search, and the order in which to discover the current project's scope. Per-tool usage
sections and the multi-vault fan-out section SHALL NOT appear in `instructions`, because tool
descriptions already deliver that content over a channel that is neither truncated nor withheld
from sub-agents. Guidance removed from `instructions` that is not already present in a tool
description MUST be moved into the relevant description rather than dropped.

#### Scenario: multi-vault prose is not duplicated into instructions

- **WHEN** instructions are composed for a registry holding more than one vault
- **THEN** the output contains no multi-vault fan-out section, and the fan-out contract remains
  described by each multi-vault-aware tool's own description

#### Scenario: the preamble stays within its budget

- **WHEN** the server-authored preamble is measured
- **THEN** its length leaves room for a representative conventions block inside 2048 characters

### Requirement: get_vault_overview carries the vault's conventions

The vault overview payload SHALL include a `conventions` field holding the raw contents of that
vault's `.neuro-vault/for-external-agents.md`. The field SHALL be produced by the shared overview
computation so that both surfaces — the `get_vault_overview` tool and the `vault://overview`
resource — carry it from one implementation and keep one response shape. The tool's description
SHALL state that the response carries the vault owner's conventions for how the vault is organised
and that they are to be followed when reading, writing, or organising notes there, so that an agent
reaching the field over the description channel knows it is authoritative rather than decorative,
scoped to vault organisation rather than an unconditional directive over arbitrary file content.

#### Scenario: the tool returns the file's content

- **WHEN** `get_vault_overview` is called for a vault whose conventions file has content
- **THEN** the response's `conventions` field equals that file's trimmed content

#### Scenario: the resource returns the same field

- **WHEN** the `vault://overview` resource is read for the same vault
- **THEN** its payload carries `conventions` with the same content as the tool's response

#### Scenario: the description advertises the field

- **WHEN** `get_vault_overview`'s advertised description is inspected
- **THEN** it states that the response carries the vault owner's conventions for how the vault is
  organised, and that they are to be followed when reading, writing, or organising notes there

### Requirement: The conventions field is absent rather than empty

The overview payload SHALL omit `conventions` entirely when the vault has no
`.neuro-vault/for-external-agents.md`, when the file is empty, or when it contains only
whitespace. An absent file MUST NOT produce an empty string, a null, or a placeholder, so that a
vault without the feature returns exactly the payload it returned before this capability existed.

#### Scenario: no file

- **WHEN** `get_vault_overview` is called for a vault with no conventions file
- **THEN** the response has no `conventions` key

#### Scenario: whitespace-only file

- **WHEN** the conventions file contains only whitespace
- **THEN** the response has no `conventions` key

### Requirement: Conventions are read at call time

The conventions file SHALL be read when the overview is computed, not cached from server startup,
so that an edit to `for-external-agents.md` is reflected in the next overview call without
restarting the MCP server. This freshness guarantee applies to the overview channel only; the
`instructions` channel is composed once at startup and MUST NOT be expected to reflect later edits.

#### Scenario: an edit between two calls is visible

- **WHEN** `get_vault_overview` is called, the conventions file is then modified, and the tool is
  called again — with no server restart in between
- **THEN** the second response's `conventions` reflects the modified content

### Requirement: Oversized conventions are truncated visibly

When a vault's conventions file exceeds the capability's character cap, the overview payload SHALL
carry a bounded slice in `conventions` and SHALL set `conventions_truncated` to `true`. When the
file fits, `conventions_truncated` SHALL be absent. Truncation MUST never be silent: a consumer
reading `conventions` without the flag MUST be able to treat it as the complete file.

#### Scenario: an oversized file is trimmed and flagged

- **WHEN** the conventions file is longer than the cap
- **THEN** `conventions` holds a slice bounded at the cap plus a single-character truncation
  marker, and `conventions_truncated` is `true`

#### Scenario: a normal file carries no flag

- **WHEN** the conventions file is shorter than the cap
- **THEN** `conventions` holds the whole file and the response has no `conventions_truncated` key

### Requirement: Each vault's conventions travel with that vault

In multi-vault mode every per-vault result SHALL carry its own vault's conventions. When
`get_vault_overview` fans out, each entry in `results_by_vault` SHALL carry the `conventions` of
the vault named by that entry, following the same present/absent and truncation rules as the
single-vault path. Each per-vault `vault://<vault-name>/overview` resource SHALL likewise carry
only its own vault's conventions. Composed `instructions` SHALL emit one conventions block per
vault, each attributed to its vault by name.

#### Scenario: fan-out entries carry their own conventions

- **WHEN** `get_vault_overview` is called with `vault` omitted against two vaults that both have
  conventions files with different contents
- **THEN** each `results_by_vault` entry carries the `conventions` of the vault it names

#### Scenario: one vault without a file does not affect the other

- **WHEN** one of two registered vaults has no conventions file
- **THEN** that vault's entry omits `conventions` and the other vault's entry still carries its own

### Requirement: An unreadable conventions file never fails a call

Reading the conventions file SHALL be best-effort on both channels. A missing, unreadable, or
permission-denied `for-external-agents.md` SHALL be treated as absent: `get_vault_overview` MUST
still return its full structural snapshot, and instructions composition MUST still produce the
server-authored preamble. An optional conventions file MUST NOT be able to turn a working overview
call into an error or a failed vault.

#### Scenario: an unreadable file degrades to absent

- **WHEN** the conventions file exists but cannot be read
- **THEN** `get_vault_overview` returns its structural snapshot with no `conventions` key and
  reports no error

#### Scenario: fan-out is not poisoned by one vault's unreadable file

- **WHEN** one vault of several has an unreadable conventions file during a fan-out
- **THEN** that vault appears in `results_by_vault` with its snapshot and without `conventions`,
  and is not reported in `failed_vaults`
