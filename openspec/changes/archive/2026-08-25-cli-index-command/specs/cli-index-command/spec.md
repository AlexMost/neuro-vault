## ADDED Requirements

### Requirement: The index subcommand reconciles a vault corpus on demand

The CLI SHALL provide an `index` subcommand that, for each vault named by
`--vault`, runs the internal corpus reconcile and exits — constructing no MCP
server, connecting no stdio transport, and starting no watcher. The subcommand
SHALL contain no indexing logic of its own: membership, hashing, rename
detection and failure containment come from the internal reconcile function,
so the corpus it produces is the one that function produces.

#### Scenario: Cold index builds the corpus

- **WHEN** `index --vault <path>` runs against a vault with no
  `.neuro-vault/corpus/`
- **THEN** the corpus is created with a shard per in-scope note and a
  manifest, and the process exits with code 0

#### Scenario: A second run is an idempotent no-op

- **WHEN** `index --vault <path>` runs again immediately, with the vault
  untouched
- **THEN** the summary reports every note reused, nothing embedded and nothing
  deleted, and the exit code is 0

#### Scenario: No server surface is touched

- **WHEN** the `index` subcommand runs
- **THEN** no MCP server is constructed and no stdio transport is connected;
  stdout carries only progress and summary output

#### Scenario: Multiple vaults reconcile sequentially

- **WHEN** `index` is invoked with several `--vault` paths
- **THEN** each vault is reconciled in the order given, each with its own
  progress and summary, sharing one embedding service instance

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
