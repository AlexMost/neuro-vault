## MODIFIED Requirements

### Requirement: The daemon keeps one vault entry per vault directory, keyed by its realpath

The daemon SHALL keep at most one vault entry per vault directory, keyed by the directory's realpath as the daemon resolves it, holding that vault's scope, one reconcile loop, one lexical cache with its tie-break graph, one corpus per attached profile, and one watcher while at least one profile with a corpus is attached. Every method that addresses a vault after `vault.attach` (`vault.status`, `corpus.*`, `lexical.search`) SHALL carry that realpath key. The same vault-entry module SHALL serve the in-process fallback of a session.

#### Scenario: Two paths to one directory share an entry

- **WHEN** one connection attaches `/vaults/notes` and another attaches a symlink that resolves to it
- **THEN** both receive the same realpath key, and the daemon runs one watcher, one reconcile loop and one lexical cache for that directory

#### Scenario: Two directories get two entries

- **WHEN** two connections attach two different vault directories
- **THEN** the daemon holds two entries, each with its own watcher, reconcile loop, lexical cache and corpora

---

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
