## MODIFIED Requirements

### Requirement: The index subcommand reconciles a vault corpus on demand

The CLI SHALL provide an `index` subcommand that, for each vault named by
`--vault`, runs the internal corpus reconcile and exits — constructing no MCP
server, connecting no stdio transport, and starting no watcher. The subcommand
SHALL contain no indexing logic of its own: membership, hashing, rename
detection, failure containment, legacy-layout migration and the cross-process
reconcile lock come from the internal reconcile function, so the corpus it
produces is the one that function produces. It SHALL embed with the profile
selected by `--model`, building one embedding provider from that profile for
the whole run, and SHALL reconcile that profile's own corpus directory.

#### Scenario: Cold index builds the corpus

- **WHEN** `index --vault <path>` runs against a vault with no
  `.neuro-vault/corpus/`
- **THEN** the corpus is created under
  `.neuro-vault/corpus/harrier-270m/` with a shard per in-scope note and a
  manifest recording the default profile, and the process exits with code 0

#### Scenario: A second run is an idempotent no-op

- **WHEN** `index --vault <path>` runs again immediately, with the vault
  untouched
- **THEN** the summary reports every note reused, nothing embedded and nothing
  deleted, and the exit code is 0

#### Scenario: No server surface is touched

- **WHEN** the `index` subcommand runs
- **THEN** no MCP server is constructed and no stdio transport is connected;
  stdout carries only progress, rebuild, summary and prune output

#### Scenario: Multiple vaults reconcile sequentially

- **WHEN** `index` is invoked with several `--vault` paths
- **THEN** each vault is reconciled in the order given, each with its own
  progress and summary, sharing one embedding provider instance built from
  the selected profile

#### Scenario: A selected profile builds the corpus

- **WHEN** `index --vault <path> --model granite-97m` runs against a vault
  with no corpus
- **THEN** the manifest it writes, under `.neuro-vault/corpus/granite-97m/`,
  names `granite-97m` and 384 dimensions

#### Scenario: A wait for another process is reported on stderr

- **WHEN** `index` starts on a vault whose reconcile lock is held by another
  running process
- **THEN** one line on stderr names that process id and the vault, stdout
  carries no such line, and the vault is reconciled once the lock is free

#### Scenario: A lock held past the bound fails the vault

- **WHEN** another process holds a vault's reconcile lock for longer than the
  wait bound
- **THEN** an error naming the lock file and the holder's process id is
  written to stderr for that vault, later vaults still run, and the process
  exits non-zero

---

### Requirement: A corpus rebuild is announced before it runs

The `index` subcommand SHALL print one line on stdout for a vault whose
selected model's corpus directory was built with a different identity than
the selected profile, before that vault's progress output, naming the stored
model and embedding version and the active ones and stating that the corpus is
being rebuilt. Selecting a profile whose directory does not exist yet, while
other profiles' directories exist, SHALL NOT be announced as a rebuild, since
nothing is discarded.

#### Scenario: An identity change within the profile announces the rebuild

- **WHEN** `index --vault <path> --model harrier-270m` runs against a vault
  whose `harrier-270m` corpus was built at a different embedding version
- **THEN** stdout carries a line for that vault naming `harrier-270m` with the
  stored embedding version and `harrier-270m` with the active one, followed by
  its progress and summary

#### Scenario: Switching profiles is not a rebuild

- **WHEN** `index --vault <path> --model granite-97m` runs against a vault
  whose only corpus was built with `harrier-270m`
- **THEN** no rebuild line is printed, the `granite-97m` corpus is built in
  its own directory, and the `harrier-270m` corpus is unchanged

#### Scenario: A matching corpus is not announced

- **WHEN** `index` runs against a vault whose corpus matches the selected
  profile
- **THEN** no rebuild line is printed for that vault

## ADDED Requirements

### Requirement: The index subcommand prunes other models' corpora on request

The `index` subcommand SHALL accept a boolean `--prune` option, absent from
the server invocation, defaulting to off. With `--prune`, after a vault's
reconcile returns having indexed at least one in-scope note, or with no
in-scope notes at all, the subcommand SHALL, while holding that vault's
reconcile lock, delete every directory directly under
`<vault>/.neuro-vault/corpus/` other than the selected profile's, including a
legacy root-level `notes/`, and a legacy root-level `manifest.json`. It SHALL
NOT delete the selected profile's directory, the reconcile lock file, or any
other file. It SHALL NOT prune a vault whose reconcile threw, nor one whose
reconcile failed every in-scope note — an offline first run of a new profile
must never cost the vault the corpora it can still be served from — and SHALL
then say on stderr that the vault was not pruned and why. It SHALL print one line per pruned vault on stdout naming
every removed entry in sorted order, or stating that there was nothing to
remove. It SHALL delete nothing when, at prune time, the selected profile's
directory holds no manifest — a concurrent prune by another profile may have
removed it — so a vault is never left with no corpus to serve; that vault
SHALL then fail with an error naming the profile. A failure to prune SHALL be
that vault's fatal error. Without `--prune`, the subcommand SHALL delete
nothing outside the selected profile's directory.

#### Scenario: Other models' corpora are removed and reported

- **WHEN** `index --vault <path> --model harrier-270m --prune` runs against a
  vault holding `granite-97m/` and `harrier-270m/` corpora
- **THEN** `granite-97m/` no longer exists, `harrier-270m/` is intact and
  reconciled, and stdout carries `pruned <vault>: removed granite-97m`

#### Scenario: A leftover legacy corpus is removed

- **WHEN** `--prune` runs against a vault whose root-level `manifest.json`
  and `notes/` were left in place because the model directory already had a
  manifest
- **THEN** both root-level entries are deleted and named in the prune line

#### Scenario: Nothing to prune

- **WHEN** `--prune` runs against a vault that holds only the selected
  profile's corpus
- **THEN** stdout carries `pruned <vault>: nothing to remove` and the exit
  code is 0

#### Scenario: A failed reconcile is not pruned

- **WHEN** `--prune` runs and the vault's reconcile throws
- **THEN** no corpus directory of that vault is deleted, the error is written
  to stderr, and the process exits non-zero

#### Scenario: A reconcile that failed every note is not pruned

- **WHEN** `--prune` runs for a profile whose model cannot be loaded, so the
  vault's reconcile returns with every in-scope note failed, while another
  profile's corpus exists
- **THEN** that other corpus is not deleted, stderr says the vault was not
  pruned because no note was indexed, and the process exits non-zero

#### Scenario: The kept model's corpus vanished before the prune

- **WHEN** `index --vault <path> --model harrier-270m --prune` reconciles the
  vault, and before its prune takes the lock a concurrent
  `index --model granite-97m --prune` deletes `harrier-270m/`
- **THEN** nothing is removed, so `granite-97m/` is intact; stderr carries an
  error for that vault naming `harrier-270m`, and the process exits non-zero

#### Scenario: The server rejects the option

- **WHEN** the server is invoked with `--prune`
- **THEN** argument parsing fails and no server starts
