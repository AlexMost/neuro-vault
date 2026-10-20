# shared-vault-entry Specification

## Purpose
The vault entry: the shared per-vault state for one vault directory (keyed by its realpath), held by the shared-services daemon or, in the in-process fallback, by the session. Covers `vault.attach` / `vault.status`, the scope and `semantic` key re-read on attach, one scope-aware watcher and one reconcile loop per entry over every attached profile, idle timers per entry and per corpus, the error codes, and the entry lines of `daemon status`. Rationale: ADR-0020; mechanism: `docs/architecture/vault-entry.md`.
## Requirements
### Requirement: The daemon keeps one vault entry per vault directory, keyed by its realpath

The daemon SHALL keep at most one vault entry per vault directory, keyed by the directory's realpath as the daemon resolves it, holding that vault's scope, one reconcile loop, one lexical cache, one wikilink graph, one corpus per attached profile, and one watcher while at least one profile with a corpus is attached. Every method that addresses a vault after `vault.attach` (`vault.status`, `corpus.*`, `lexical.search`, `graph.*`) SHALL carry that realpath key. The same vault-entry module SHALL serve the in-process fallback of a session.

#### Scenario: Two paths to one directory share an entry

- **WHEN** one connection attaches `/vaults/notes` and another attaches a symlink that resolves to it
- **THEN** both receive the same realpath key, and the daemon runs one watcher, one reconcile loop, one lexical cache and one wikilink graph for that directory

#### Scenario: Two directories get two entries

- **WHEN** two connections attach two different vault directories
- **THEN** the daemon holds two entries, each with its own watcher, reconcile loop, lexical cache, wikilink graph and corpora

### Requirement: vault.attach attaches a connection to an entry and its profiles

The daemon SHALL serve `vault.attach { vault, profiles }`, where `vault` is an absolute path and `profiles` is a possibly empty list of profile keys, and SHALL answer `{ vault: <realpath>, profiles: { [profile]: BackendStatus } }` within 10 seconds, without waiting for any corpus load, reconcile pass or lexical refresh, which SHALL run in the background. Attach SHALL be idempotent and additive per connection: attaching again adds profiles and changes nothing else. A profile SHALL report `disabled` when the vault's own config sets `"semantic": false`. An unknown profile key SHALL be answered `UNKNOWN_PROFILE`; a path that cannot be resolved, or that is not a directory, SHALL be answered `VAULT_UNAVAILABLE` with the reason. The params SHALL carry nothing else: no scope, no exclusions, no corpus identity.

#### Scenario: A cold vault attaches at once

- **WHEN** a connection attaches a vault with no corpus for `harrier-270m`
- **THEN** the answer arrives before indexing starts, reporting `harrier-270m` as `{ state: "indexing", indexed: 0, total: 0 }`, and the corpus is built in the background

#### Scenario: A vault with a compatible corpus becomes ready after attach

- **WHEN** a connection attaches a vault whose `harrier-270m` corpus matches the current identity, and then polls `vault.status`
- **THEN** the status becomes `ready` once the corpus is loaded, while a reconcile pass runs behind it

#### Scenario: An empty profile list attaches the vault alone

- **WHEN** a connection attaches a vault with `profiles: []`
- **THEN** the answer carries the realpath and no profile, no corpus is loaded or built, no watcher is started, and the entry's lexical cache warms in the background

#### Scenario: A vault that disabled semantics

- **WHEN** a connection attaches a vault whose config contains `{ "semantic": false }` with `profiles: ["harrier-270m"]`
- **THEN** `harrier-270m` is reported `disabled`, nothing is read from or written under `.neuro-vault/corpus/`, and the entry serves `lexical.search`

#### Scenario: Attaching twice adds a profile

- **WHEN** a connection attaches a vault with `["harrier-270m"]` and later with `["granite-97m"]`
- **THEN** the entry holds both corpora and the connection is a client of both

#### Scenario: A missing directory

- **WHEN** a connection attaches a path that does not exist
- **THEN** it receives `VAULT_UNAVAILABLE` naming the reason, and no entry is created

---

### Requirement: Scope is re-read on every attach and applies at once

On every `vault.attach` the daemon SHALL re-read the vault's scope from the vault's own files (the root `.gitignore` and `.neuro-vault/config.json`). When the scope differs from the entry's, the entry SHALL restart its watcher if one is running (an entry with no corpus has none), queue a reconcile pass, and apply the new scope to every later read. Nothing SHALL watch those files.

#### Scenario: A new exclusion takes effect on the next attach

- **WHEN** a vault's config gains `"exclusions": ["Archive"]` and a session then attaches the vault
- **THEN** notes under `Archive/` are absent from every later corpus read on that entry, and the next pass sweeps their shards

#### Scenario: Editing the config alone changes nothing

- **WHEN** a vault's config changes and no connection attaches afterwards
- **THEN** the entry keeps its previous scope

---

### Requirement: vault.status reports one profile's state to an attached connection

The daemon SHALL serve `vault.status { vault, profile }` within 10 seconds, answering the profile's `BackendStatus` (`ready`, `indexing` with `indexed` and `total`, `unavailable` with a reason, or `disabled`). A call for a vault and profile that this connection did not attach SHALL be answered `NOT_ATTACHED`. The entry, not the corpus, SHALL own that state.

#### Scenario: Progress is visible

- **WHEN** a profile is indexing and 120 of 840 notes are done
- **THEN** `vault.status` answers `{ state: "indexing", indexed: 120, total: 840 }`

#### Scenario: Another connection's vault

- **WHEN** connection A attached a vault and connection B, which did not, calls `vault.status` for it
- **THEN** B receives `NOT_ATTACHED`

---

### Requirement: A closed connection detaches, and entries idle out

The daemon SHALL NOT offer `vault.detach`; a connection closing SHALL detach it from every entry and profile it attached. When an entry or a profile within it has no attached connection left, it SHALL be kept for the daemon's `--idle-timeout`, each with its own timer; an attach before the timer fires SHALL cancel it. When a profile's timer fires, that corpus SHALL leave the reconcile loop and free its vectors; when an entry's timer fires, its watcher and loop SHALL stop and the entry SHALL be dropped. With `--idle-timeout 0` nothing SHALL idle out. There SHALL be no cap on the number of entries or corpora.

#### Scenario: A short session gap keeps the corpus warm

- **WHEN** the only session on a vault disconnects and another attaches it within the idle timeout
- **THEN** the entry and its corpus are reused, and nothing is reloaded

#### Scenario: An idle entry is dropped

- **WHEN** the last connection on a vault closes and no connection attaches it for the idle timeout
- **THEN** the entry's watcher is closed and the entry no longer appears in `daemon.info`

#### Scenario: An unused profile is freed on its own

- **WHEN** two connections share a vault, one with `harrier-270m` and one with `granite-97m`, and the `granite-97m` connection closes
- **THEN** after the idle timeout the `granite-97m` corpus is gone while the entry and the `harrier-270m` corpus stay

---

### Requirement: One reconcile loop per entry walks every attached profile under one lock

Each entry SHALL run exactly one reconcile loop. A pass SHALL acquire the vault's reconcile lock once and SHALL reconcile every attached, enabled profile in attach order before releasing it. Passes of one entry SHALL NOT overlap; a request during a pass, including an attach that adds a profile, SHALL be served by the next pass. A pass that had to wait for another holder of the lock SHALL refresh every profile's corpus from the shard files before reconciling it. Each profile SHALL keep the state rules of a semantic backend: a failed pass makes it `unavailable` with a retry on a doubling backoff, a lock timeout restores its previous state, and `ready` is never reported over an empty corpus that indexing failed to produce.

#### Scenario: Two profiles, one lock acquisition

- **WHEN** an entry has `harrier-270m` and `granite-97m` attached and a note changes
- **THEN** one pass takes the lock once, re-embeds the note for both profiles in attach order, and releases it

#### Scenario: A profile attached mid-pass

- **WHEN** a second profile is attached while a pass is running for the first
- **THEN** the running pass finishes unchanged and the next pass builds the second profile's corpus

#### Scenario: A pass that waited for index

- **WHEN** `neuro-vault-mcp index` holds the vault's lock and re-embeds a note while the entry's pass waits
- **THEN** after acquiring the lock the entry refreshes its corpus and serves the note's new vectors without embedding it again

---

### Requirement: The entry's watcher follows the vault scope

Each entry SHALL watch its vault directory with one watcher while at least one profile with a corpus is attached to it: started when the first such profile is attached, closed when the last one leaves, and restarted when the scope changes while it runs. An entry with no corpus (attached with `profiles: []`, or a vault that set `"semantic": false`) SHALL run no watcher. The watcher SHALL prune a directory only when the scope proves the whole subtree excluded — a dot segment, or a match against a scope pattern ending in `/**` — and SHALL schedule a pass, after the debounce interval of quiet, only for an add, change or unlink of a `.md` path the scope does not exclude. Paths SHALL be judged relative to the vault root with `/` separators. A watcher that fails to start or fails later SHALL be logged and SHALL leave the entry on reconcile-on-attach without failing any request.

#### Scenario: An edit in an excluded subtree schedules nothing

- **WHEN** a vault excludes `Archive/**` and a note under `Archive/` changes
- **THEN** no pass is scheduled, and the watcher never descends into `Archive/`

#### Scenario: A one-level glob is filtered, not pruned

- **WHEN** a vault excludes `Archive/*` and a note at `Archive/2024/note.md` changes
- **THEN** a pass is scheduled, because that note is in scope

#### Scenario: The server's own writes are ignored

- **WHEN** a pass writes shards under `.neuro-vault/corpus/`
- **THEN** no pass is scheduled as a result

#### Scenario: Windows paths

- **WHEN** the watcher receives `C:\vault\Archive\note.md` for a vault rooted at `C:\vault` that excludes `Archive/**`
- **THEN** it judges the path as `Archive/note.md` and schedules nothing

#### Scenario: No corpus, no watcher

- **WHEN** an entry is attached with `profiles: []` only
- **THEN** no watcher is started for it, and attaching a profile afterwards starts one

#### Scenario: The last corpus leaves

- **WHEN** an entry's only profile idles out while a connection still holds the entry with `profiles: []`
- **THEN** the watcher is closed and the entry keeps serving `lexical.search`

### Requirement: An entry's corpus is written per note and read with the scope folded in

Each corpus in an entry SHALL be the note and block vectors of that vault under one profile with their change-detection metadata, kept durably as the per-profile shard files. Each write (a note embedded, touched or deleted) SHALL be visible to reads as soon as it completes. A change of corpus identity SHALL empty the corpus before the first write under the new identity, so vectors of two identities are never read together. On every read the entry SHALL fold the scope's exclusions into the read's path restriction before any limit applies.

#### Scenario: A re-embedded note is served once written

- **WHEN** a pass re-embeds one of 900 notes
- **THEN** a read made after that note's write ranks it by its new vectors, while the pass is still running

#### Scenario: An excluded note never ranks

- **WHEN** the scope excludes a note whose shard has not yet been swept
- **THEN** no read on the entry returns that note

