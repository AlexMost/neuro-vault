# cli-index-command Specification

## Purpose
TBD - created by archiving change cli-index-command. Update Purpose after archive.
## Requirements
### Requirement: The index subcommand reconciles a vault corpus on demand

The CLI SHALL provide an `index` subcommand that, for each vault named by
`--vault`, runs the internal corpus reconcile and exits — constructing no MCP
server, connecting no stdio transport, and starting no watcher. The subcommand
SHALL contain no indexing logic of its own: membership, hashing, rename
detection and failure containment come from the internal reconcile function,
so the corpus it produces is the one that function produces. It SHALL embed
with the profile selected by `--model`, building one embedding provider from
that profile for the whole run.

#### Scenario: Cold index builds the corpus

- **WHEN** `index --vault <path>` runs against a vault with no
  `.neuro-vault/corpus/`
- **THEN** the corpus is created with a shard per in-scope note and a
  manifest recording the default profile, and the process exits with code 0

#### Scenario: A second run is an idempotent no-op

- **WHEN** `index --vault <path>` runs again immediately, with the vault
  untouched
- **THEN** the summary reports every note reused, nothing embedded and nothing
  deleted, and the exit code is 0

#### Scenario: No server surface is touched

- **WHEN** the `index` subcommand runs
- **THEN** no MCP server is constructed and no stdio transport is connected;
  stdout carries only progress, rebuild and summary output

#### Scenario: Multiple vaults reconcile sequentially

- **WHEN** `index` is invoked with several `--vault` paths
- **THEN** each vault is reconciled in the order given, each with its own
  progress and summary, sharing one embedding provider instance built from
  the selected profile

#### Scenario: A selected profile builds the corpus

- **WHEN** `index --vault <path> --model granite-97m` runs against a vault
  with no corpus
- **THEN** the manifest it writes names `granite-97m` and 384 dimensions

---

### Requirement: The index subcommand's vault option matches server semantics

The `--vault` option of the `index` subcommand SHALL accept the same values
the server invocation accepts and reject the same values it rejects — an
absolute path to an existing directory whose basename satisfies the vault
identifier rules, repeatable, with case-insensitive basename uniqueness — via
the same validation code path, so a vault argument is copyable between the two
invocations unchanged.

#### Scenario: A relative path is rejected

- **WHEN** `index --vault ./vault` is invoked
- **THEN** the process exits non-zero with the same absolute-path error the
  server invocation gives

#### Scenario: A missing vault option is rejected

- **WHEN** `index` is invoked with no `--vault`
- **THEN** the process exits non-zero and the error names `--vault` as
  required

---

### Requirement: Progress and summary are reported on stdout

The `index` subcommand SHALL report reconcile progress on stdout — updating a
single line in place when stdout is a TTY, and emitting a line per 10%-step
otherwise — and SHALL always end each vault with a summary line carrying the
reconcile counts (total, embedded, reused, renamed, deleted, failed).
Warnings SHALL stay on stderr.

#### Scenario: Non-TTY output is bounded

- **WHEN** `index` runs with stdout not attached to a TTY
- **THEN** progress produces at most one line per 10%-step per vault, followed
  by the summary line

#### Scenario: The summary reports the reconcile counts

- **WHEN** a vault's reconcile completes
- **THEN** stdout receives a summary line containing the total, embedded,
  reused, renamed, deleted, and failed counts for that vault

---

### Requirement: The exit code reflects corpus completeness

The `index` subcommand SHALL exit 0 only when every named vault reconciled
with zero failed notes. Any contained per-note failure or any fatal error
SHALL produce a non-zero exit, with the summary still printed for every vault
that completed and fatal errors written to stderr.

#### Scenario: A contained per-note failure is visible in the exit code

- **WHEN** a reconcile completes with a failed count greater than zero
- **THEN** the summary line reports the failed count and the process exits
  non-zero

#### Scenario: A fatal error exits non-zero

- **WHEN** a vault path fails validation or the reconcile aborts
- **THEN** the error is written to stderr and the process exits non-zero

#### Scenario: Complete reconciles exit zero

- **WHEN** every named vault reconciles with zero failed notes
- **THEN** the process exits with code 0

### Requirement: The index subcommand's model option matches server semantics

The `--model` option of the `index` subcommand SHALL accept the same profile
keys the server invocation accepts, default to the same profile, and reject
the same values with the same message, via the same option definition, so a
model argument is copyable between the two invocations unchanged.

#### Scenario: An unknown model is rejected with the allowed keys

- **WHEN** `index --vault <path> --model bge-m3` is invoked
- **THEN** the process exits non-zero, nothing is indexed, and the error lists
  `harrier-270m`, `granite-97m` and `harrier-0.6b`

#### Scenario: Omitting the option selects the server's default

- **WHEN** `index --vault <path>` is invoked without `--model`
- **THEN** the corpus is built with the same profile a server started without
  `--model` would serve

---

### Requirement: A corpus rebuild is announced before it runs

The `index` subcommand SHALL print one line on stdout for a vault whose stored
corpus was built with a different identity than the selected profile, before
that vault's progress output, naming the stored model and embedding version
and the active ones and stating that the corpus is being rebuilt.

#### Scenario: Switching profiles announces the rebuild

- **WHEN** `index --vault <path> --model granite-97m` runs against a vault
  whose corpus was built with `harrier-270m`
- **THEN** stdout carries a line for that vault naming `harrier-270m` as the
  stored model and `granite-97m` as the active one, followed by its progress
  and summary

#### Scenario: A matching corpus is not announced

- **WHEN** `index` runs against a vault whose corpus matches the selected
  profile
- **THEN** no rebuild line is printed for that vault

