## ADDED Requirements

### Requirement: Instructions point at the overview channel for conventions

Composed MCP `instructions` SHALL carry a pointer stating that a vault's owner-authored conventions
are delivered on the `get_vault_overview` response rather than in `instructions`, and that the tool
is to be called before reading, writing, or organising notes in the vault. The pointer SHALL name
`get_vault_overview` explicitly, so that an agent reading only `instructions` learns both that
conventions exist for this vault and which single call retrieves them. The pointer is a reference,
not a copy: it MUST NOT reproduce any part of a vault's conventions file.

#### Scenario: the pointer names the tool

- **WHEN** the composed `instructions` string is inspected
- **THEN** it contains the literal tool name `get_vault_overview` in a statement that the vault's
  conventions are delivered there

#### Scenario: the pointer is present with no conventions file anywhere

- **WHEN** instructions are composed for a registry in which no vault has a conventions file
- **THEN** the pointer is still present and unchanged, because it describes where conventions would
  arrive rather than reporting whether any exist

---

## MODIFIED Requirements

### Requirement: Composed instructions do not restate tool descriptions

Composed MCP `instructions` SHALL be a constant that is independent of vault configuration, and
SHALL carry only guidance that no tool description carries: the vault's role as a second brain, the
routing heuristic between vault operations and semantic search, the order in which to discover the
current project's scope, and the pointer to `get_vault_overview` for that vault's conventions. The
composed string MUST NOT contain the content of any vault's `.neuro-vault/for-external-agents.md`,
in whole or in part, and MUST NOT vary with the number of registered vaults, their names, their
order, or the presence, absence, or size of any file on disk. Its length SHALL be under 2048
characters unconditionally, so that no vault owner's action can push server-authored guidance past
a truncating client's cap. Per-tool usage sections and the multi-vault fan-out section SHALL NOT
appear, because tool descriptions already deliver that content over a channel that is neither
truncated nor withheld from sub-agents. Guidance removed from `instructions` that is not already
present in a tool description MUST be moved into the relevant description rather than dropped.

#### Scenario: no vault content reaches the instructions string

- **WHEN** instructions are composed for a vault whose `for-external-agents.md` has distinctive
  content
- **THEN** no part of that file appears anywhere in the composed string

#### Scenario: the string does not vary with the registry

- **WHEN** instructions are composed for a single-vault registry and for a multi-vault registry
  whose vaults have conventions files of differing sizes
- **THEN** both results are byte-identical

#### Scenario: the budget holds unconditionally

- **WHEN** the composed `instructions` string is measured for any registry
- **THEN** its length is under 2048 characters

#### Scenario: multi-vault prose is not duplicated into instructions

- **WHEN** instructions are composed for a registry holding more than one vault
- **THEN** the output contains no multi-vault fan-out section, and the fan-out contract remains
  described by each multi-vault-aware tool's own description

---

### Requirement: Conventions are read at call time

The conventions file SHALL be read when the overview is computed, not cached from server startup,
so that an edit to `for-external-agents.md` is reflected in the next overview call without
restarting the MCP server. The overview channel is the only channel that carries conventions, so
this freshness guarantee covers every delivery of them: there is no second, staler copy composed at
startup that a consumer might read instead.

#### Scenario: an edit between two calls is visible

- **WHEN** `get_vault_overview` is called, the conventions file is then modified, and the tool is
  called again — with no server restart in between
- **THEN** the second response's `conventions` reflects the modified content

#### Scenario: no startup-composed copy competes with it

- **WHEN** a vault's conventions file is modified after the server starts
- **THEN** no server-held string composed at startup carries the stale content, because none carries
  conventions at all

---

### Requirement: Each vault's conventions travel with that vault

In multi-vault mode every per-vault result SHALL carry its own vault's conventions. When
`get_vault_overview` fans out, each entry in `results_by_vault` SHALL carry the `conventions` of
the vault named by that entry, following the same present/absent and truncation rules as the
single-vault path. Each per-vault `vault://<vault-name>/overview` resource SHALL likewise carry
only its own vault's conventions.

#### Scenario: fan-out entries carry their own conventions

- **WHEN** `get_vault_overview` is called with `vault` omitted against two vaults that both have
  conventions files with different contents
- **THEN** each `results_by_vault` entry carries the `conventions` of the vault it names

#### Scenario: one vault without a file does not affect the other

- **WHEN** one of two registered vaults has no conventions file
- **THEN** that vault's entry omits `conventions` and the other vault's entry still carries its own

#### Scenario: registration order does not decide who gets conventions

- **WHEN** several vaults with conventions files are registered in any order
- **THEN** every vault's own conventions reach the caller through that vault's overview result, with
  no vault's delivery depending on how many vaults precede it

---

### Requirement: An unreadable conventions file never fails a call

Reading the conventions file SHALL be best-effort. A missing, unreadable, or permission-denied
`for-external-agents.md` SHALL be treated as absent: `get_vault_overview` MUST still return its
full structural snapshot. An optional conventions file MUST NOT be able to turn a working overview
call into an error or a failed vault.

#### Scenario: an unreadable file degrades to absent

- **WHEN** the conventions file exists but cannot be read
- **THEN** `get_vault_overview` returns its structural snapshot with no `conventions` key and
  reports no error

#### Scenario: fan-out is not poisoned by one vault's unreadable file

- **WHEN** one vault of several has an unreadable conventions file during a fan-out
- **THEN** that vault appears in `results_by_vault` with its snapshot and without `conventions`,
  and is not reported in `failed_vaults`

#### Scenario: server startup does not depend on the file

- **WHEN** the server starts against a vault whose conventions file is unreadable
- **THEN** startup composes its `instructions` and registers its tools without consulting that file

---

## REMOVED Requirements

### Requirement: A vault's conventions survive the instructions truncation budget

**Reason**: The requirement's premise was measured false, and the behaviour it mandated is being
removed rather than corrected. It required conventions blocks to lead the composed `instructions`
so a truncating client would receive them. Claude Code applies its 2048-character cap **per server,
not per vault**, so with several vaults registered the first consumes the budget and later blocks
arrive as nothing. Worse, the mandated ordering made the server-authored preamble the casualty
instead: any conventions file over roughly 1,316 characters deleted it entirely, while the project's
own documentation recommended files up to 8,000. The requirement's guard scenario pinned a
1,227-character fixture and varied only the preamble, so the free variable in production was the
constant in CI. Conventions no longer appear in `instructions` at all, leaving this requirement with
no subject.

**Migration**: No consumer action is required — the conventions file stays exactly where it is and
`get_vault_overview` returns the same payload as before. Conventions now reach an agent solely
through the overview channel, which is unaffected by this change and is governed by the
`get_vault_overview carries the vault's conventions`, `Conventions are read at call time`,
`Oversized conventions are truncated visibly`, and `Each vault's conventions travel with that vault`
requirements. An agent that previously read conventions out of `instructions` follows the pointer
mandated by `Instructions point at the overview channel for conventions` and calls
`get_vault_overview` instead — a channel that additionally reaches sub-agents, reflects edits
without a restart, and flags its own truncation via `conventions_truncated`. Vault owners who sized
their file against a 2048-character `instructions` budget may now use the full 8,000-character
`CONVENTIONS_CHAR_CAP`, which always belonged to the overview channel.
