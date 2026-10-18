## MODIFIED Requirements

### Requirement: A vault can turn semantics off in its own config

A vault SHALL be able to opt out of semantics with `"semantic": false` in its `.neuro-vault/config.json`. Such a vault SHALL NOT be indexed, SHALL NOT be watched, and SHALL have nothing written under `.neuro-vault/corpus/`; its lexical surfaces SHALL work normally and its state SHALL be `disabled`. With the shared daemon, such a vault SHALL still be attached with `profiles: []`, so its lexical leg is served from the daemon's vault entry, which SHALL hold no corpus and run no watcher for it. A missing key SHALL mean enabled; a non-boolean value SHALL warn on stderr and be treated as enabled. The global `--no-semantic` flag SHALL continue to disable the semantic module for the whole process, SHALL take precedence over any per-vault value, and SHALL attach no vault and start no daemon. Semantic tools SHALL remain registered while any vault has semantics enabled.

#### Scenario: a disabled vault is never indexed

- **WHEN** a vault's config contains `{ "semantic": false }` and the server starts
- **THEN** no corpus directory is created for it, no watcher is started for it, and it reports `disabled`

#### Scenario: a disabled vault still answers lexically

- **WHEN** `search_notes` targets a vault with semantics disabled
- **THEN** the call succeeds with lexical matches

#### Scenario: a disabled vault's lexical leg is shared

- **WHEN** two shared sessions register a vault with `{ "semantic": false }` and each runs `search_notes` in `mode: "lexical"`
- **THEN** the daemon holds one vault entry for it with `clients 2`, no profile and a warm lexical cache

#### Scenario: one vault's opt-out does not affect its neighbours

- **WHEN** one of two registered vaults disables semantics
- **THEN** the semantic tools stay registered and the other vault is indexed and served as usual

#### Scenario: a malformed value falls back to enabled

- **WHEN** a vault's config contains `{ "semantic": "no" }`
- **THEN** the vault is treated as semantically enabled and a warning naming the config key is written to stderr
