## MODIFIED Requirements

### Requirement: The daemon keeps one vault entry per vault directory, keyed by its realpath

The daemon SHALL keep at most one vault entry per vault directory, keyed by the directory's realpath as the daemon resolves it, holding that vault's scope, one reconcile loop, one lexical cache, one wikilink graph, one corpus per attached profile, and one watcher while at least one profile with a corpus is attached. Every method that addresses a vault after `vault.attach` (`vault.status`, `corpus.*`, `lexical.search`, `graph.*`) SHALL carry that realpath key. The same vault-entry module SHALL serve the in-process fallback of a session.

#### Scenario: Two paths to one directory share an entry

- **WHEN** one connection attaches `/vaults/notes` and another attaches a symlink that resolves to it
- **THEN** both receive the same realpath key, and the daemon runs one watcher, one reconcile loop, one lexical cache and one wikilink graph for that directory

#### Scenario: Two directories get two entries

- **WHEN** two connections attach two different vault directories
- **THEN** the daemon holds two entries, each with its own watcher, reconcile loop, lexical cache, wikilink graph and corpora
